/**
 * Walks Claude Code's multi-question form and records every intermediate state.
 *
 * The form is a tabbed set of questions plus a Submit step:
 *
 *   ←  ☐ Site type  ☐ Tech stack  ✔ Submit  →
 *
 * Answering one question is not enough; the session stays blocked until Submit
 * is triggered. This captures what changes after each answer so the bridge can
 * drive the whole form rather than the first question of it.
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

const OUT = path.resolve(__dirname, '..', '.probe-out', 'question-walk');
const PROMPT =
  'I want to build a small website. Before writing any code, use your question tool to ask ' +
  'me two multiple-choice questions about what I want. Ask now, do not write anything yet.';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const steps: { name: string; screen: string[] }[] = [];

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

  const settle = async (ms = 3_000, max = 60_000): Promise<string[]> => {
    let last = '';
    let stable = 0;
    const deadline = Date.now() + max;
    while (Date.now() < deadline) {
      await delay(400);
      const v = await view();
      const key = v.join('|');
      if (key === last) {
        stable += 400;
        if (stable >= ms) return v;
      } else {
        stable = 0;
        last = key;
      }
    }
    return view();
  };

  const record = async (name: string): Promise<string[]> => {
    const v = await view();
    steps.push({ name, screen: v });
    const menu = parseMenu(v);
    console.log(`\n${'='.repeat(76)}`);
    console.log(`STEP: ${name}   ready=${isReady(v)} busy=${isBusy(v)} menu=${menu ? menu.options.length + ' options' : 'null'}`);
    console.log('='.repeat(76));
    // Only the interesting tail: the form lives at the bottom of the screen.
    for (const line of v.slice(-22)) console.log(`| ${line}`);
    return v;
  };

  // --- startup -----------------------------------------------------------
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
  console.log('READY');

  await typeAndSubmit({ write: (d) => child.write(d), viewport: view }, PROMPT);
  await settle();
  await record('01-first-question');

  // --- answer whatever question is showing, repeatedly --------------------
  for (let round = 1; round <= 4; round += 1) {
    const v = await view();
    const menu = parseMenu(v);
    if (!menu) {
      await record(`${pad(round)}-no-menu`);
      break;
    }
    // Pick option 1 each time; we care about the form's mechanics, not answers.
    console.log(`\n>>> selecting option 1 ("${menu.options[0]?.label ?? ''}")`);
    child.write(keysToSelect(menu, 1));
    await settle(2_500, 40_000);
    await record(`${pad(round + 1)}-after-answer-${round}`);
  }

  // --- try to reach Submit ------------------------------------------------
  const before = (await view()).join('|');
  console.log('\n>>> pressing Tab (navigate toward Submit)');
  child.write('\t');
  await settle(2_000, 20_000);
  await record('90-after-tab');

  if ((await view()).join('|') !== before) {
    console.log('\n>>> pressing Enter (activate Submit)');
    child.write('\r');
    await settle(3_000, 90_000);
    await record('91-after-enter');
  }

  await mkdir(OUT, { recursive: true });
  await writeFile(path.join(OUT, 'steps.json'), JSON.stringify(steps, null, 2), 'utf8');
  console.log(`\nWrote ${OUT}`);

  child.kill();
  await delay(400);
  process.exit(0);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
