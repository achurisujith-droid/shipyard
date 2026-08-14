/**
 * Run a real project through Shipyard's runner and report what happened.
 *
 * Not a test with a fixture we wrote to pass. Point it at a repository someone
 * else built and find out whether the preview would actually show anything:
 *
 *   npx tsx scripts/try-project.mts C:\some\project
 *   npx tsx scripts/try-project.mts https://github.com/owner/repo
 *   npx tsx scripts/try-project.mts <url> --keep     # leave it running
 *
 * This is the same ProjectRunner the app uses, with the same environment, so a
 * pass here means the preview pane would fill in.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { RunnerStatus, ShipyardEventName, ShipyardEvents } from '@shipyard/shared';

import { PostgresManager } from '../main/postgres.js';
import { ProjectRunner } from '../main/project-runner.js';
import { detectNeeds } from '../main/stack.js';
import { Toolchain, toolchainRoot } from '../main/toolchain.js';

const exec = promisify(execFile);
const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const target = argv.find((a) => !a.startsWith('--'));
const keep = argv.includes('--keep');
const verbose = argv.includes('--verbose');

if (!target) {
  console.error('Usage: tsx scripts/try-project.mts <path-or-github-url> [--keep] [--verbose]');
  process.exit(2);
}

async function main(): Promise<number> {
  const toolchain = new Toolchain({
    root: toolchainRoot(DESKTOP),
    cacheDir: path.join(os.tmpdir(), 'shipyard-npm-cache'),
  });

  const status = await toolchain.status();
  if (!status.ready) {
    console.error(`Toolchain not ready: ${status.reason}`);
    return 2;
  }
  console.log(`Shipyard toolchain: Node ${status.nodeVersion}, PostgreSQL ${status.postgresVersion}`);

  let projectPath = target!;
  let temp: string | null = null;

  if (/^https?:\/\//.test(target!)) {
    temp = await mkdtemp(path.join(os.tmpdir(), 'shipyard-try-'));
    projectPath = path.join(temp, 'repo');
    console.log(`\nCloning ${target}...`);
    // git is a developer tool and Shipyard's users never see this path; it is
    // only how we fetch someone else's project to test against.
    await exec('git', ['clone', '--depth', '1', target!, projectPath], { maxBuffer: 1 << 24 });
  }

  const postgres = new PostgresManager(toolchain, path.join(os.tmpdir(), 'shipyard-try-databases'));

  let lastState: RunnerStatus['state'] | null = null;
  const emit = <K extends ShipyardEventName>(event: K, payload: ShipyardEvents[K]): void => {
    if (event === 'runner:status') {
      const s = payload as RunnerStatus;
      if (s.state !== lastState) {
        lastState = s.state;
        console.log(`  [${s.state}]${s.message ? ` ${s.message}` : ''}`);
      }
    } else if (event === 'runner:problem') {
      const p = payload as ShipyardEvents['runner:problem'];
      console.log(`  ! ${p.source}: ${p.message}`);
      // Always: a failure with no detail is the thing this harness exists to
      // avoid reproducing.
      for (const line of p.detail.split('\n').slice(0, verbose ? 40 : 14)) {
        console.log(`      ${line}`);
      }
    } else if (event === 'runner:log' && verbose) {
      process.stdout.write((payload as { chunk: string }).chunk);
    }
  };

  const runner = new ProjectRunner(emit, toolchain, postgres);

  console.log(`\nProject: ${projectPath}`);
  const info = await runner.inspect(projectPath);
  const needs = await detectNeeds(projectPath);

  console.log(`  can run:  ${info.canRun}${info.reason ? ` — ${info.reason}` : ''}`);
  console.log(`  command:  ${info.command ?? '(none)'}`);
  console.log(`  install:  ${info.needsInstall ? 'needed' : 'already there'}`);
  console.log(`  database: ${needs.database ? `yes — ${needs.reason}` : 'no'}`);
  if (needs.migrate) console.log(`  tables:   ${needs.migrate}`);

  if (!info.canRun) {
    console.log('\nShipyard would not offer to run this project.');
    return 1;
  }

  console.log('\nStarting (installing dependencies can take a few minutes)...\n');
  const started = Date.now();
  await runner.start(projectPath);

  // start() returns once the dev server is spawned; the URL arrives later, once
  // the address has been probed and answers.
  const final = await settle(runner, 300_000);
  const seconds = ((Date.now() - started) / 1000).toFixed(0);

  let verdict = 1;
  if (final.state === 'running' && final.url) {
    console.log(`\n  running at ${final.url} after ${seconds}s`);
    try {
      const response = await fetch(final.url);
      const body = await response.text();
      console.log(`  HTTP ${response.status}, ${body.length} bytes`);
      console.log(`  title: ${/<title[^>]*>([^<]*)</i.exec(body)?.[1]?.trim() ?? '(none)'}`);
      console.log('\nThe preview pane would show this app.');
      verdict = 0;
    } catch (err) {
      console.log(`\n  the URL did not answer: ${String(err)}`);
    }
  } else {
    console.log(`\n  ended in "${final.state}"${final.message ? `: ${final.message}` : ''}`);
    console.log(`  after ${seconds}s`);
  }

  if (keep && verdict === 0) {
    console.log('\n--keep: leaving it running. Press Ctrl+C to stop.');
    await new Promise(() => {});
  }

  runner.shutdown();
  await postgres.stopAll();
  if (temp) await rm(temp, { recursive: true, force: true }).catch(() => {});
  return verdict;
}

/** Wait until the runner reaches a state it will not leave on its own. */
function settle(runner: ProjectRunner, timeoutMs: number): Promise<RunnerStatus> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      const status = runner.current();
      const done =
        (status.state === 'running' && status.url) ||
        status.state === 'failed' ||
        status.state === 'stopped' ||
        Date.now() > deadline;
      if (done) {
        clearInterval(timer);
        resolve(status);
      }
    }, 500);
  });
}

main()
  .then((code) => {
    process.exitCode = code;
    // node-pty keeps handles open; the work is finished either way.
    setTimeout(() => process.exit(code), 500).unref();
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exitCode = 2;
  });
