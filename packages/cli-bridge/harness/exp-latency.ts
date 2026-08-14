/**
 * Measures perceived latency: how long after sending does the user SEE
 * something?
 *
 * Answers the question "is this slower than the CLI?" with numbers instead of
 * opinion. The model latency is identical - same CLI, same account - so the
 * only thing we control is how quickly extracted text reaches the UI.
 *
 *   timeToFirstPartial : first streamed text (what the user actually sees)
 *   timeToFirstText    : first committed, de-duplicated block
 *   timeToTurnEnd      : session back to idle
 */
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { authStatus } from '../src/auth';
import { detectClaude } from '../src/detect';
import { createSession } from '../src/session';

const PROMPT =
  'Write three short paragraphs about why small tools beat big frameworks. No preamble.';

async function main(): Promise<void> {
  const detected = await detectClaude();
  if (!detected.installed || !detected.path) throw new Error('CLI not found');
  if (!(await authStatus(detected.path)).authed) throw new Error('CLI not signed in');

  const cwd = path.resolve(__dirname, '..', '.harness-out', `latency-${process.pid}`);
  await mkdir(cwd, { recursive: true });

  const startup = Date.now();
  const session = await createSession({ cliPath: detected.path, cwd });
  console.log(`session ready in ${Date.now() - startup}ms\n`);

  let sentAt = 0;
  let firstPartial = 0;
  let firstText = 0;
  let partialCount = 0;
  let idleAt = 0;

  session.on('assistant-partial', () => {
    partialCount += 1;
    if (!firstPartial) firstPartial = Date.now();
  });
  session.on('assistant-text', () => {
    if (!firstText) firstText = Date.now();
  });

  const texts: string[] = [];
  session.on('assistant-text', (t) => texts.push(t));

  const transitions: string[] = [];
  session.on('state', (s) => {
    transitions.push(`${sentAt ? Date.now() - sentAt : 0}ms ${s}`);
  });

  sentAt = Date.now();
  session.send(PROMPT);

  let sawBusy = false;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    if (session.state !== 'idle') {
      sawBusy = true;
      continue;
    }
    if (sawBusy) {
      idleAt = Date.now();
      break;
    }
  }

  const rel = (t: number): string => (t ? `${t - sentAt}ms` : 'never');
  console.log(`timeToFirstPartial : ${rel(firstPartial)}   <- what the user sees`);
  console.log(`timeToFirstText    : ${rel(firstText)}`);
  console.log(`timeToTurnEnd      : ${rel(idleAt)}`);
  console.log(`partial updates    : ${partialCount}`);
  console.log(`state transitions  : ${transitions.join(' -> ')}`);

  // The dedup guarantee must survive streaming: committed text is emitted once.
  const joined = texts.join('\n');
  const lines = joined.split('\n').map((l) => l.trim()).filter(Boolean);
  const dupes = lines.length - new Set(lines).size;
  console.log(`committed blocks   : ${texts.length}, duplicate lines: ${dupes}`);

  session.kill();
  await new Promise((r) => setTimeout(r, 500));
  await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
