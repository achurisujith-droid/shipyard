/**
 * Pinpoint why a given CLI build behaves differently from the one we developed
 * against. Reaches a prompt, sends one short message, and dumps exactly what the
 * chrome parsers see at each step.
 *
 *   npx tsx harness/diag-version.ts --cli-path <path to claude.exe>
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import * as pty from 'node-pty';

import { detectClaude } from '../src/detect';
import { PTY_COLS, PTY_ROWS } from '../src/constants';
import { buildSessionEnv, sessionArgs } from '../src/env';
import { ScreenBuffer } from '../src/screen';
import { keysToSelect, parseMenu } from '../src/parse/menu';
import { findInputBox, isBusy, isReady, statusLine, wasSubmitted } from '../src/parse/chrome';
import { typeText } from '../src/input';

const MSG = 'Reply with exactly this and nothing else: DIAG-TOKEN-42';
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const i = process.argv.indexOf('--cli-path');
  const pinned = i === -1 ? undefined : process.argv[i + 1];
  const cliPath = pinned ?? (await detectClaude()).path;
  if (!cliPath) throw new Error('no CLI path');

  const cwd = path.resolve(__dirname, '..', '.probe-out', 'diag', `p-${process.pid}`);
  await mkdir(cwd, { recursive: true });
  console.log(`CLI: ${cliPath}\ncwd: ${cwd}\n`);

  const screen = new ScreenBuffer({ cols: PTY_COLS, rows: PTY_ROWS });
  let exited = false;
  const child = pty.spawn(cliPath, sessionArgs(), {
    name: 'xterm-256color',
    cols: PTY_COLS,
    rows: PTY_ROWS,
    cwd,
    env: buildSessionEnv(),
  });
  let chain: Promise<void> = Promise.resolve();
  child.onData((d) => {
    chain = chain.then(() => screen.write(d));
  });
  child.onExit(() => {
    exited = true;
  });

  const view = async (): Promise<string[]> => {
    await chain;
    return screen.snapshot().viewport;
  };

  const dump = async (label: string): Promise<void> => {
    const v = await view();
    const box = findInputBox(v);
    console.log(`--- ${label}`);
    console.log(`    isReady=${isReady(v)}  isBusy=${isBusy(v)}`);
    console.log(`    statusLine=${JSON.stringify(statusLine(v))}`);
    console.log(
      `    inputBox=${box ? `{top:${box.topRuleIndex}, empty:${box.empty}, text:${JSON.stringify(box.text.slice(0, 60))}}` : 'null'}`,
    );
    console.log(`    wasSubmitted(MSG)=${wasSubmitted(v, MSG)}`);
  };

  // startup
  const t0 = Date.now();
  for (;;) {
    if (exited) throw new Error('exited during startup');
    if (Date.now() - t0 > 90_000) break;
    await delay(300);
    const v = await view();
    const menu = parseMenu(v);
    if (menu) {
      const target =
        menu.options.find((o) => /trust this folder/i.test(o.label)) ??
        menu.options.find((o) => /not now|continue without|keep browser/i.test(o.label)) ??
        menu.options[menu.options.length - 1];
      if (target) {
        console.log(`[interstitial] ${target.index}. ${target.label}`);
        child.write(keysToSelect(menu, target.index));
        await delay(700);
      }
      continue;
    }
    if (isReady(v)) break;
  }
  await dump('at ready');

  await typeText({ write: (d) => child.write(d), viewport: view }, MSG);
  await dump('after typing (before Enter)');

  child.write('\r');
  for (const ms of [1000, 2000, 4000, 8000]) {
    await delay(ms);
    await dump(`after Enter +${ms}ms`);
  }

  console.log('\n--- final screen ---');
  for (const l of await view()) console.log(`| ${l}`);

  child.kill();
  await delay(500);
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
