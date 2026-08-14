/**
 * Focused experiment: how do you reliably submit a LONG message?
 *
 * Short messages submit fine with `write(text)` then `write('\r')`. A 215-char
 * message does not - the Enter is inserted as a newline inside the input box
 * instead of submitting, which suggests the CLI is treating a large single
 * write as a paste.
 *
 * Tries each strategy against the same live session and reports which submit.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import * as pty from 'node-pty';

import { detectClaude } from '../src/detect';
import { PTY_COLS, PTY_ROWS } from '../src/constants';
import { buildSessionEnv, sessionArgs } from '../src/env';
import { ScreenBuffer } from '../src/screen';
import { keysToSelect, parseMenu } from '../src/parse/menu';
import { findInputBox, isReady, wasSubmitted } from '../src/parse/chrome';

const PROJECT_DIR = path.resolve(
  __dirname,
  '..',
  '.probe-out',
  'submit',
  `p-${process.pid}`,
);

const LONG =
  'Reply with only the word ACK and nothing else. This sentence exists purely to ' +
  'make the message long enough to trigger whatever paste heuristic the input box ' +
  'applies to bulk input, so please ignore it entirely.';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const detected = await detectClaude();
  if (!detected.installed || !detected.path) throw new Error('CLI not found');

  // node-pty reports a missing cwd as an opaque "error code: 267"
  // (ERROR_DIRECTORY), so the directory must exist before we spawn.
  await mkdir(PROJECT_DIR, { recursive: true });

  const screen = new ScreenBuffer({ cols: PTY_COLS, rows: PTY_ROWS });
  let exited = false;
  const child = pty.spawn(detected.path, sessionArgs(), {
    name: 'xterm-256color',
    cols: PTY_COLS,
    rows: PTY_ROWS,
    cwd: PROJECT_DIR,
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

  // reach ready
  const t0 = Date.now();
  for (;;) {
    if (exited) throw new Error('exited during startup');
    if (Date.now() - t0 > 90_000) throw new Error('never ready');
    await delay(300);
    const v = await view();
    const menu = parseMenu(v);
    if (menu) {
      const target =
        menu.options.find((o) => /trust this folder/i.test(o.label)) ??
        menu.options.find((o) => /not now|continue without|keep browser/i.test(o.label)) ??
        menu.options[menu.options.length - 1];
      if (target) {
        console.log(`[interstitial] -> ${target.label}`);
        child.write(keysToSelect(menu, target.index));
        await delay(700);
      }
      continue;
    }
    if (isReady(v)) break;
  }
  console.log('READY\n');

  const quiesce = async (): Promise<void> => {
    let last = '';
    for (let i = 0; i < 40; i += 1) {
      await delay(200);
      const now = (await view()).join('|');
      if (now === last) return;
      last = now;
    }
  };

  const boxText = async (): Promise<string> => (findInputBox(await view())?.text ?? '');

  const clearBox = async (): Promise<boolean> => {
    for (let i = 0; i < 6; i += 1) {
      child.write(''); // Ctrl+U
      await delay(400);
      if ((await boxText()).length === 0) return true;
    }
    // Fall back to backspacing the whole thing.
    const len = (await boxText()).length;
    child.write(''.repeat(len + 10));
    await delay(600);
    return (await boxText()).length === 0;
  };

  const tryStrategy = async (
    name: string,
    type: () => Promise<void>,
    enter: string,
  ): Promise<boolean> => {
    console.log(`--- strategy: ${name}`);
    await type();
    await quiesce();
    const typed = await boxText();
    console.log(`    box now holds ${typed.length} chars`);

    child.write(enter);
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      await delay(250);
      if (wasSubmitted(await view(), LONG)) {
        console.log(`    SUBMITTED ✔`);
        return true;
      }
    }
    console.log(`    not submitted ✘ (box still: ${(await boxText()).length} chars)`);
    return false;
  };

  const results: Record<string, boolean> = {};

  results['bulk-write + CR'] = await tryStrategy(
    'bulk write, then \\r',
    async () => {
      child.write(LONG);
    },
    '\r',
  );

  if (!results['bulk-write + CR']) {
    console.log(`    clearing box: ${(await clearBox()) ? 'ok' : 'FAILED'}`);
    results['bulk-write + LF'] = await tryStrategy(
      'bulk write, then \\n',
      async () => {
        child.write(LONG);
      },
      '\n',
    );
  }

  if (!Object.values(results).some(Boolean)) {
    console.log(`    clearing box: ${(await clearBox()) ? 'ok' : 'FAILED'}`);
    results['chunked-write + CR'] = await tryStrategy(
      'chunked write (16 chars / 25ms), then \\r',
      async () => {
        for (let i = 0; i < LONG.length; i += 16) {
          child.write(LONG.slice(i, i + 16));
          await delay(25);
        }
      },
      '\r',
    );
  }

  console.log('\n=== RESULTS ===');
  for (const [k, v] of Object.entries(results)) console.log(`  ${v ? 'PASS' : 'fail'}  ${k}`);

  child.kill();
  await delay(500);
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
