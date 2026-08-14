/**
 * What does Codex's terminal interface actually look like?
 *
 * Every parser in this package was written against Claude Code's TUI. Before
 * designing a provider abstraction we need to know which parts of that grammar
 * are shared terminal mechanics and which are Claude-specific — guessing would
 * produce an interface shaped around one CLI that the other cannot satisfy.
 *
 * Captures four moments: startup, ready, a reply arriving, and an approval
 * prompt. Read-only; it never signs in, signs out, or writes to ~/.codex.
 *
 *   npx tsx harness/probe-codex.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as pty from 'node-pty';

import { PTY_COLS, PTY_ROWS } from '../src/constants';
import { keysToSelect, parseMenu } from '../src/parse/menu';
import { ScreenBuffer } from '../src/screen';

const CODEX =
  process.env['CODEX_PATH'] ??
  path.join(
    os.homedir(),
    'AppData',
    'Local',
    'OpenAI',
    'Codex',
    'bin',
    'cfac6bda2d141e07',
    'codex.exe',
  );

const OUT = path.resolve(__dirname, '..', '.probe-out', 'codex');
/** Chosen to force a write, which is what surfaces the approval prompt. */
const PROMPT = 'Create a file called hello.txt containing the word hello. Do it now.';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const cwd = path.join(OUT, `p-${process.pid}`);
  await mkdir(cwd, { recursive: true });

  const screen = new ScreenBuffer({ cols: PTY_COLS, rows: PTY_ROWS });
  let exited = false;
  const steps: { name: string; screen: string[]; buffer: string }[] = [];

  // No arguments: bare `codex` is the interactive TUI. `codex exec` is the
  // non-interactive path and is refused on the same grounds as `claude -p`.
  const child = pty.spawn(CODEX, [], {
    name: 'xterm-256color',
    cols: PTY_COLS,
    rows: PTY_ROWS,
    cwd,
    env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
  });

  let chain: Promise<void> = Promise.resolve();
  child.onData((d) => {
    chain = chain.then(() => screen.write(d));
  });
  child.onExit(() => {
    exited = true;
  });

  const snapshot = async () => {
    await chain;
    return screen.snapshot();
  };

  const record = async (name: string): Promise<string[]> => {
    const snap = await snapshot();
    steps.push({ name, screen: snap.viewport, buffer: snap.bufferType });
    console.log(`\n${'='.repeat(80)}`);
    console.log(`STEP: ${name}`);
    console.log(
      `  buffer=${snap.bufferType}  totalLines=${snap.totalLines}  baseY=${snap.baseY}  cursor=(${snap.cursorX},${snap.cursorAbsY})`,
    );
    console.log('='.repeat(80));
    for (const line of snap.viewport.slice(-26)) console.log(`| ${line}`);
    return snap.viewport;
  };

  const settle = async (quietMs = 2_500, maxMs = 45_000): Promise<void> => {
    let last = '';
    let stable = 0;
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      await delay(400);
      const view = (await snapshot()).viewport.join('|');
      if (view === last) {
        stable += 400;
        if (stable >= quietMs) return;
      } else {
        stable = 0;
        last = view;
      }
    }
  };

  try {
    await delay(1_200);
    await record('01-startup');

    await settle();
    await record('02-settled');

    // Answer the trust dialog before anything else. The first run of this probe
    // typed its prompt straight into that dialog, which ate the keystrokes and
    // left every later capture blank.
    for (let round = 0; round < 3; round += 1) {
      const view = (await snapshot()).viewport;
      const menu = parseMenu(view);
      if (!menu) break;
      const target =
        menu.options.find((o) => /trust|yes, continue|allow/i.test(o.label)) ?? menu.options[0];
      if (!target) break;
      console.log(`\n>>> answering startup menu: "${target.label}"`);
      child.write(keysToSelect(menu, target.index));
      await settle(2_000, 30_000);
    }
    await record('02b-past-trust-dialog');

    // The single most important question: does it use the ALTERNATE screen
    // buffer? If it does, there is no scrollback, and the committed-line
    // strategy that all of our text extraction depends on cannot work here.
    const snap = await snapshot();
    console.log(
      `\n>>> BUFFER TYPE: ${snap.bufferType}  ${
        snap.bufferType === 'alternate'
          ? '— committed-line harvesting will NOT work as-is'
          : '— scrollback available, same strategy applies'
      }\n`,
    );

    console.log('>>> typing a prompt that forces a file write');
    for (let i = 0; i < PROMPT.length; i += 16) {
      child.write(PROMPT.slice(i, i + 16));
      await delay(25);
    }
    await delay(800);
    await record('03-typed');

    child.write('\r');
    await delay(2_500);
    await record('04-submitted');

    await settle(3_000, 90_000);
    await record('05-after-reply');

    if (exited) console.log('\n(the process exited during the probe)');
  } finally {
    await writeFile(path.join(OUT, 'steps.json'), JSON.stringify(steps, null, 2), 'utf8');
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }

  console.log(`\nWrote ${OUT}`);
}

main().catch((err: unknown) => {
  console.error('THREW:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
