/**
 * Does the app actually pick up Claude's edits?
 *
 * A plain `node server.js` reads its files once and never again. Before this,
 * Claude would change the code, the user would look at the preview, and see
 * exactly what they saw before — the single most convincing way to make a
 * working product look broken.
 *
 * So this drives the real ProjectRunner against a real server, rewrites the
 * file the way Claude would, and asserts the browser sees the new version. It
 * also asserts the opposite case: a dev server that watches its own files is
 * left alone, because two watchers on one project restart it twice per edit.
 *
 *   npx tsx scripts/test-restart.mts
 *
 * No dependencies are installed — the fixture uses only Node's own http module
 * — so this runs in seconds and does not need the network.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { PostgresManager } from '../main/postgres';
import { ProjectRunner } from '../main/project-runner';
import { Toolchain } from '../main/toolchain';

const root = path.join(os.tmpdir(), `shipyard-restart-${process.pid}`);
const PORT = 3479;
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS  ${name}`);
  else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

/** A server that reads nothing but its own source: no watching, no reloading. */
function server(marker: string): string {
  return `
const http = require('node:http');
http
  .createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(${JSON.stringify(marker)});
  })
  .listen(${PORT}, '127.0.0.1', () => {
    console.log('Server listening on port ${PORT}');
  });
`;
}

/** Poll until the server answers with what we expect, or give up. */
async function waitForBody(url: string, expected: string, ms: number): Promise<string> {
  const deadline = Date.now() + ms;
  let last = '(never answered)';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      last = await res.text();
      if (last === expected) return last;
    } catch (err) {
      last = `(${err instanceof Error ? err.message : String(err)})`;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return last;
}

async function waitForState(
  runner: ProjectRunner,
  wanted: string[],
  ms: number,
): Promise<string> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const state = runner.current().state;
    if (wanted.includes(state)) return state;
    await new Promise((r) => setTimeout(r, 200));
  }
  return runner.current().state;
}

async function main(): Promise<void> {
  const toolchain = new Toolchain({
    root: path.resolve(import.meta.dirname, '..', 'resources', 'toolchain', `${process.platform}-${process.arch}`),
    cacheDir: path.join(root, 'npm-cache'),
  });
  const runner = new ProjectRunner(
    () => {
      /* events ignored */
    },
    toolchain,
    {} as PostgresManager,
  );

  const project = path.join(root, 'plain-server');
  // A node_modules directory, so the runner does not try to install anything:
  // this fixture has no dependencies and npm install would only cost a minute.
  await mkdir(path.join(project, 'node_modules'), { recursive: true });
  await writeFile(
    path.join(project, 'package.json'),
    JSON.stringify({ name: 'plain', private: true, scripts: { dev: 'node server.js' } }, null, 2),
    'utf8',
  );
  await writeFile(path.join(project, 'server.js'), server('first version'), 'utf8');

  const info = await runner.inspect(project);
  check(
    'a plain node server is recognised as needing our help',
    info.scripts?.[0]?.selfReloading === false,
    JSON.stringify(info.scripts),
  );

  void runner.start(project);
  const state = await waitForState(runner, ['running', 'failed'], 60_000);
  check('the app starts', state === 'running', `ended in "${state}": ${runner.current().message ?? ''}`);

  const url = runner.current().url;
  check('the preview has an address to point at', Boolean(url), `url=${url ?? '(none)'}`);
  check(
    'the user is told their app will restart itself',
    runner.current().watching === true,
    JSON.stringify(runner.current()),
  );

  if (url) {
    check('serves the first version', (await waitForBody(url, 'first version', 15_000)) === 'first version');

    // Exactly what Claude does when the user asks for a change.
    await writeFile(path.join(project, 'server.js'), server('second version'), 'utf8');

    const body = await waitForBody(url, 'second version', 30_000);
    check('the edit reaches the browser without the user doing anything', body === 'second version', body);
    check('and the app is still running afterwards', runner.current().state === 'running');
  }

  runner.stop();

  // --- a dev server that watches itself is left alone ---------------------
  const watched = path.join(root, 'self-watching');
  await mkdir(path.join(watched, 'node_modules'), { recursive: true });
  await writeFile(
    path.join(watched, 'package.json'),
    JSON.stringify(
      { name: 'watched', private: true, scripts: { dev: 'node --watch server.js' } },
      null,
      2,
    ),
    'utf8',
  );
  await writeFile(path.join(watched, 'server.js'), server('watched version'), 'utf8');

  const watchedInfo = await runner.inspect(watched);
  check(
    'a self-watching script is recognised',
    watchedInfo.scripts?.[0]?.selfReloading === true,
    JSON.stringify(watchedInfo.scripts),
  );

  void runner.start(watched);
  const watchedState = await waitForState(runner, ['running', 'failed'], 60_000);
  check('the self-watching app starts', watchedState === 'running', `ended in "${watchedState}"`);
  check(
    'Shipyard does not also watch it',
    runner.current().watching !== true,
    JSON.stringify(runner.current()),
  );
  runner.stop();

  // node-pty's teardown needs a moment before the temp directory will delete.
  await new Promise((r) => setTimeout(r, 500));
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
  console.log(`\n${failed === 0 ? 'All restart cases pass.' : `${failed} case(s) failed.`}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
