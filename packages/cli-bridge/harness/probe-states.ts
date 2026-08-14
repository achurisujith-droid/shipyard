/**
 * Second discovery probe: what the screen looks like DURING a turn.
 *
 * probe.ts captured the resting states (idle, permission menu). This one samples
 * rapidly while a long answer streams, to answer:
 *   1. What distinguishes `thinking` from `streaming` on screen?
 *   2. Does the transcript actually scroll (baseY growing), so committed-line
 *      extraction has something to consume?
 *   3. Do code blocks and tables survive the screen buffer intact?
 *
 * Output goes to .probe-out/states/.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import * as pty from 'node-pty';

import { detectClaude } from '../src/detect';
import { PTY_COLS, PTY_ROWS } from '../src/constants';
import { buildSessionEnv, sessionArgs } from '../src/env';
import { ScreenBuffer } from '../src/screen';
import { keysToSelect, parseMenu } from '../src/parse/menu';
import { isReady } from '../src/parse/chrome';
import { typeAndSubmit } from '../src/input';

const OUT_DIR = path.resolve(__dirname, '..', '.probe-out', 'states');
const PROJECT_DIR = path.join(OUT_DIR, `project-${process.pid}`);

const SAMPLE_MS = 300;


interface Sample {
  t: number;
  baseY: number;
  totalLines: number;
  /** Bottom of the screen - where spinners and the input box live. */
  tail: string[];
}

async function main(): Promise<void> {
  await mkdir(PROJECT_DIR, { recursive: true });

  const detected = await detectClaude();
  if (!detected.installed || !detected.path) {
    console.error('Claude Code not found.');
    process.exitCode = 1;
    return;
  }

  const screen = new ScreenBuffer({ cols: PTY_COLS, rows: PTY_ROWS });
  let lastOutputAt = Date.now();
  let exited = false;

  const child = pty.spawn(detected.path, sessionArgs(), {
    name: 'xterm-256color',
    cols: PTY_COLS,
    rows: PTY_ROWS,
    cwd: PROJECT_DIR,
    env: buildSessionEnv(),
  });

  let writeChain: Promise<void> = Promise.resolve();
  child.onData((d) => {
    lastOutputAt = Date.now();
    writeChain = writeChain.then(() => screen.write(d));
  });
  child.onExit(() => {
    exited = true;
  });

  const snap = async () => {
    await writeChain;
    return screen.snapshot();
  };
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // --- reach a usable prompt ---------------------------------------------
  const t0 = Date.now();
  for (;;) {
    if (exited) throw new Error('CLI exited during startup');
    if (Date.now() - t0 > 90_000) throw new Error('never became ready');
    await delay(300);
    const s = await snap();

    const menu = parseMenu(s.viewport);
    if (menu) {
      const trust = menu.options.find((o) => /trust this folder/i.test(o.label));
      const decline = menu.options.find((o) => /not now|continue without|keep browser/i.test(o.label));
      const target = trust ?? decline ?? menu.options[menu.options.length - 1];
      if (target) {
        console.log(`[interstitial] -> ${target.index}. ${target.label}`);
        child.write(keysToSelect(menu, target.index));
        await delay(700);
      }
      continue;
    }
    if (isReady(s.viewport)) break;
  }
  console.log('READY\n');

  // --- ask for something long, with a code block and a table --------------
  const PROMPT =
    'Write a short markdown section that contains exactly two things: ' +
    'a fenced TypeScript code block defining an interface named Widget with three fields, ' +
    'and a markdown table with 3 columns and 4 rows of example data. No other commentary.';

  console.log(`>>> ${PROMPT}\n`);
  const result = await typeAndSubmit(
    { write: (d) => child.write(d), viewport: async () => (await snap()).viewport },
    PROMPT,
  );
  console.log(
    result.submitted
      ? `[send] submitted after ${result.attempts} Enter(s)\n`
      : '[send] FAILED TO SUBMIT\n',
  );
  lastOutputAt = Date.now();

  // --- sample rapidly until the screen goes quiet -------------------------
  const samples: Sample[] = [];
  const started = Date.now();
  let lastTail = '';
  for (;;) {
    if (exited) break;
    if (Date.now() - started > 180_000) break;
    if (Date.now() - lastOutputAt > 4_000) break;

    const s = await snap();
    const tail = s.viewport.slice(-8);
    const key = tail.join('|');
    if (key !== lastTail) {
      lastTail = key;
      samples.push({
        t: Date.now() - started,
        baseY: s.baseY,
        totalLines: s.totalLines,
        tail,
      });
    }
    await delay(SAMPLE_MS);
  }

  const final = await snap();

  // --- report -------------------------------------------------------------
  console.log(`captured ${samples.length} distinct screens over ${Date.now() - started}ms`);
  console.log(`baseY: ${samples[0]?.baseY ?? 0} -> ${final.baseY}  (scrolled: ${final.baseY > 0})`);
  console.log(`totalLines: ${final.totalLines}\n`);

  console.log('=== distinct bottom-of-screen states (dedup by last line) ===');
  const seenLast = new Set<string>();
  for (const s of samples) {
    const last = s.tail.filter((l) => l.trim()).pop() ?? '';
    const norm = last.replace(/\d+/g, 'N');
    if (seenLast.has(norm)) continue;
    seenLast.add(norm);
    console.log(`  [t=${String(s.t).padStart(6)}ms baseY=${String(s.baseY).padStart(3)}] ${last}`);
  }

  console.log('\n=== final screen ===');
  for (const l of final.viewport) console.log(`| ${l}`);

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, 'samples.json'), JSON.stringify(samples, null, 2), 'utf8');
  await writeFile(path.join(OUT_DIR, 'all-lines.txt'), screen.allLines().join('\n'), 'utf8');
  console.log(`\nWrote ${OUT_DIR}`);

  child.kill();
  await delay(500);
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});

