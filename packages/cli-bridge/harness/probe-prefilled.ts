/**
 * The bug this exists to prove fixed:
 *
 *   Claude ends a turn with a suggested reply. The CLI pre-fills its composer
 *   with that phrase. Shipyard then types the user's actual answer on top of it,
 *   producing a merged message — and the echo check, comparing against the
 *   wrong length, reports the send as failed. The user's answer never arrives
 *   and the session looks hung.
 *
 * Reproduces it directly by putting text in the box first, then sending a
 * message the normal way and checking what reached the transcript.
 *
 *   npx tsx harness/probe-prefilled.ts
 */
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as pty from 'node-pty';

import { PTY_COLS, PTY_ROWS } from '../src/constants';
import { detectClaude } from '../src/detect';
import { buildSessionEnv, sessionArgs } from '../src/env';
import { clearComposer, typeAndSubmit, typeText } from '../src/input';
import { findInputBox, isReady } from '../src/parse/chrome';
import { keysToSelect, parseMenu } from '../src/parse/menu';
import { ScreenBuffer } from '../src/screen';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** What the CLI would have left sitting in the box. */
const LEFTOVER = 'go with placeholders';
const MESSAGE = 'Reply with exactly the word BANANA and nothing else.';

let failed = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(ok ? `PASS  ${name}` : `FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  if (!ok) failed += 1;
};

async function main(): Promise<void> {
  const cwd = path.join(os.tmpdir(), `shipyard-prefill-${process.pid}`);
  await mkdir(cwd, { recursive: true });

  const detected = await detectClaude();
  if (!detected.installed || !detected.path) {
    throw new Error(`CLI not usable: ${detected.problem ?? 'not found'}`);
  }
  console.log(`CLI ${detected.version}\n`);

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

  const viewport = async (): Promise<string[]> => {
    await chain;
    return screen.snapshot().viewport;
  };
  const io = { write: (d: string) => child.write(d), viewport };

  /** Put LEFTOVER in the box, retrying because early keystrokes get dropped. */
  const fillBox = async (): Promise<ReturnType<typeof findInputBox>> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await typeText(io, LEFTOVER);
      await delay(400);
      const box = findInputBox(await viewport());
      if (box?.text.includes(LEFTOVER)) return box;
    }
    return findInputBox(await viewport());
  };

  try {
    // --- wait for a usable session ---------------------------------------
    const deadline = Date.now() + 90_000;
    for (;;) {
      if (exited) throw new Error('exited during startup');
      if (Date.now() > deadline) throw new Error('never became ready');
      await delay(300);
      const v = await viewport();
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

    // `isReady` means the status line has rendered, which is not the same as
    // the input accepting keystrokes — the first ones after startup get
    // dropped. Give it a moment, then insist the text really landed, because a
    // box that was never dirtied would make the next check pass for free.
    await delay(1_500);

    const dirty = await fillBox();
    check(
      'the box really is pre-filled before we start',
      dirty?.text.includes(LEFTOVER) === true,
      JSON.stringify(dirty?.text),
    );

    // --- the fix -----------------------------------------------------------
    const cleared = await clearComposer(io);
    const afterClear = findInputBox(await viewport());
    check(
      'clearComposer empties a box that had text in it',
      cleared && afterClear?.empty === true,
      JSON.stringify(afterClear?.text),
    );

    // --- and the whole path end to end ------------------------------------
    const redirtied = await fillBox();
    check(
      'the box is dirty again for the end-to-end run',
      redirtied?.text.includes(LEFTOVER) === true,
      JSON.stringify(redirtied?.text),
    );
    await delay(300);
    const result = await typeAndSubmit(io, MESSAGE);
    check('the message submits', result.submitted, `attempts=${result.attempts}`);

    // The real proof: what the CLI received is the message alone, with no trace
    // of the leftover text merged into it.
    await delay(1_500);
    const transcript = (await viewport()).join('\n');
    check(
      'the transcript shows the message we sent',
      transcript.includes('BANANA') || transcript.includes('Reply with exactly'),
      transcript.slice(-400),
    );
    check(
      'the leftover text did NOT get merged into it',
      !new RegExp(`${LEFTOVER}\\s*Reply with`, 'i').test(transcript.replace(/\s+/g, ' ')),
      transcript.slice(-400),
    );
  } finally {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }

  console.log(
    `\n${failed === 0 ? 'A pre-filled composer no longer swallows the user’s message.' : `${failed} case(s) failed.`}`,
  );
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err: unknown) => {
  console.error('THREW:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
