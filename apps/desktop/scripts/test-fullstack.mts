/**
 * Can Shipyard actually run a Node + database app and show it?
 *
 * Builds a real one (Express + better-sqlite3, a table, a seeded row, a page
 * that renders the query result), drives it through the real ProjectRunner, and
 * fetches the served page to confirm the data made it to the browser.
 *
 * Deliberately prints "Server listening on port 3001" rather than a full URL,
 * because that is what most hand-written Node servers actually print.
 *
 *   npx tsx scripts/test-fullstack.mts
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { RunnerStatus } from '@shipyard/shared';

import { ProjectRunner } from '../main/project-runner';

const root = path.join(os.tmpdir(), `shipyard-fullstack-${process.pid}`);
const PORT = 3457;
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS  ${name}`);
  else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

const SERVER = `
const express = require('express');
const Database = require('better-sqlite3');

const db = new Database('shop.db');
db.exec('CREATE TABLE IF NOT EXISTS cases (id INTEGER PRIMARY KEY, name TEXT, price REAL)');
db.prepare('DELETE FROM cases').run();
db.prepare('INSERT INTO cases (name, price) VALUES (?, ?)').run('Clear Silicone', 14.99);
db.prepare('INSERT INTO cases (name, price) VALUES (?, ?)').run('Leather Folio', 39.5);

const app = express();
app.get('/', (req, res) => {
  const rows = db.prepare('SELECT name, price FROM cases ORDER BY id').all();
  res.send(
    '<!doctype html><title>Cases</title><ul>' +
      rows.map((r) => '<li>' + r.name + ' - $' + r.price + '</li>').join('') +
      '</ul>'
  );
});

const PORT = ${PORT};
app.listen(PORT, () => {
  // The realistic case: a port, no URL.
  console.log('Server listening on port ' + PORT);
});
`;

async function main(): Promise<void> {
  const project = path.join(root, 'shop');
  await mkdir(project, { recursive: true });
  await writeFile(
    path.join(project, 'package.json'),
    JSON.stringify(
      {
        name: 'phone-case-shop',
        private: true,
        scripts: { dev: 'node server.js' },
        dependencies: { express: '^4.21.2', 'better-sqlite3': '^11.7.0' },
      },
      null,
      2,
    ),
    'utf8',
  );
  await writeFile(path.join(project, 'server.js'), SERVER, 'utf8');

  const statuses: RunnerStatus[] = [];
  const runner = new ProjectRunner(((event: string, payload: unknown) => {
    if (event === 'runner:status') statuses.push(payload as RunnerStatus);
  }) as never);

  const info = await runner.inspect(project);
  check('detects the Node app', info.canRun === true && info.command === 'npm run dev');
  check('knows dependencies are missing', info.needsInstall === true);

  console.log('\n  installing + starting (this takes a minute)...\n');
  void runner.start(project);

  // Wait for it to reach running, or give up.
  const deadline = Date.now() + 300_000;
  let status = runner.current();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1_000));
    status = runner.current();
    if (status.state === 'running' || status.state === 'failed') break;
  }

  check(
    'installed dependencies',
    statuses.some((s) => s.state === 'installing'),
    `states seen: ${statuses.map((s) => s.state).join(' -> ')}`,
  );
  check(
    'reached running',
    status.state === 'running',
    `ended in "${status.state}"${status.message ? `: ${status.message}` : ''}`,
  );
  check('found the app URL', Boolean(status.url), `url=${status.url ?? '(none)'}`);

  if (status.url) {
    try {
      const res = await fetch(status.url);
      const body = await res.text();
      check('serves the page', res.status === 200);
      check(
        'page shows data read from the database',
        body.includes('Clear Silicone') && body.includes('39.5'),
        body.slice(0, 200),
      );
    } catch (err) {
      check('serves the page', false, String(err));
    }
  }

  runner.shutdown();
  await new Promise((r) => setTimeout(r, 1_000));
  await rm(root, { recursive: true, force: true }).catch(() => undefined);

  console.log(`\n${failed === 0 ? 'Full-stack app runs and renders DB data.' : `${failed} case(s) failed.`}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
