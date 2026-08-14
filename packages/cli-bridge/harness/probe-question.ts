/**
 * Captures what Claude Code's *question* menu looks like on screen.
 *
 * Distinct from a tool permission prompt: when Claude asks the user to choose
 * between options ("What kind of build do you want?"), the TUI renders an
 * interactive selection the session blocks on. Observed in the wild rendering
 * as `→ Option (Recommended)` rather than `❯ 1. Option`, which the existing
 * numbered-menu parser does not match — so the session hangs.
 *
 *   npx tsx harness/probe-question.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import * as pty from 'node-pty';

import { PTY_COLS, PTY_ROWS } from '../src/constants';
import { detectClaude } from '../src/detect';
import { buildSessionEnv, sessionArgs } from '../src/env';
import { typeAndSubmit } from '../src/input';
import { isBusy, isReady } from '../src/parse/chrome';
import { keysToSelect, parseMenu } from '../src/parse/menu';
import { ScreenBuffer } from '../src/screen';

const OUT = path.resolve(__dirname, '..', '.probe-out', 'question');
const PROMPT =
  'I want to build a small website. Before writing any code, use your question tool to ask ' +
  'me two multiple-choice questions about what I want. Ask now, do not write anything yet.';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const cwd = path.join(OUT, `p-${process.pid}`);
  await mkdir(cwd, { recursive: true });

  const detected = await detectClaude();
  if (!detected.installed || !detected.path) throw new Error('CLI not found');

  const screen = new ScreenBuffer({ cols: PTY_COLS, rows: PTY_ROWS });
  let exited = false;
  const child = pty.spawn(detected.path, sessionArgs(), {
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

  // startup
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
        menu.options[menu.options.length - 1];
      if (target) {
        child.write(keysToSelect(menu, target.index));
        await delay(700);
      }
      continue;
    }
    if (isReady(v)) break;
  }
  console.log('READY\n');

  await typeAndSubmit({ write: (d) => child.write(d), viewport: view }, PROMPT);

  // Wait for the turn to finish OR for the screen to stop changing while still
  // busy - a blocked question menu looks exactly like the latter.
  let last = '';
  let stableFor = 0;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await delay(500);
    const v = await view();
    const key = v.join('|');
    if (key === last) {
      stableFor += 500;
      if (stableFor >= 4_000) break;
    } else {
      stableFor = 0;
      last = key;
    }
  }

  const v = await view();
  console.log(`isReady=${isReady(v)}  isBusy=${isBusy(v)}`);
  console.log(`parseMenu -> ${parseMenu(v) ? 'MATCHED' : 'NULL  <- this is the bug'}\n`);
  console.log('=== SCREEN ===');
  for (const line of v) console.log(`| ${line}`);

  await writeFile(path.join(OUT, 'screen.txt'), v.join('\n'), 'utf8');
  await writeFile(path.join(OUT, 'all-lines.txt'), screen.allLines().join('\n'), 'utf8');
  console.log(`\nWrote ${OUT}`);

  child.kill();
  await delay(400);
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
