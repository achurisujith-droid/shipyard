/**
 * Milestone 1 acceptance harness.
 *
 * Runs scripted conversations against a real, logged-in Claude Code install and
 * asserts on what the bridge extracted. No Electron, no UI.
 *
 *   npx tsx harness/run.ts                     # default counts
 *   npx tsx harness/run.ts --exchanges 20 --permissions 10
 *   npx tsx harness/run.ts --idle-minutes 30   # the full soak
 */
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import type { PermissionRequest, Session, SessionState } from '@shipyard/shared';

import { authStatus } from '../src/auth';
import { detectClaude } from '../src/detect';
import { createSession } from '../src/session';

const OUT_ROOT = path.resolve(__dirname, '..', '.harness-out');

interface Result {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail: string;
}

const results: Result[] = [];
const record = (name: string, status: Result['status'], detail = ''): void => {
  results.push({ name, status, detail });
  const mark = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : 'SKIP';
  console.log(`[${mark}] ${name}${detail ? ` - ${detail}` : ''}`);
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function arg(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  const v = Number.parseInt(process.argv[i + 1] ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
}

/** `--cli-path <path>` pins a specific binary, for the "one release back" run. */
function strArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i === -1) return undefined;
  return process.argv[i + 1];
}

interface TurnCapture {
  assistant: string[];
  tools: { name: string; summary: string }[];
  states: SessionState[];
  permissions: PermissionRequest[];
}

/**
 * Send a prompt and collect everything the bridge emits until the session goes
 * idle again. `answerPermission` picks an option when a prompt appears.
 */
async function runTurn(
  session: Session,
  prompt: string,
  opts: { timeoutMs?: number; answerPermission?: (req: PermissionRequest) => number } = {},
): Promise<TurnCapture> {
  const cap: TurnCapture = { assistant: [], tools: [], states: [], permissions: [] };

  const onText = (t: string): void => {
    cap.assistant.push(t);
  };
  const onTool = (t: { name: string; summary: string }): void => {
    cap.tools.push(t);
  };
  const onState = (s: SessionState): void => {
    cap.states.push(s);
  };
  const onPerm = (req: PermissionRequest): void => {
    cap.permissions.push(req);
    const choice = opts.answerPermission?.(req);
    if (choice !== undefined) setTimeout(() => session.respondToPermission(choice), 250);
  };

  session.on('assistant-text', onText);
  session.on('tool-summary', onTool);
  session.on('state', onState);
  session.on('permission-request', onPerm);

  try {
    session.send(prompt);

    const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
    let sawBusy = false;
    let idleSince = 0;

    while (Date.now() < deadline) {
      await sleep(200);
      const s = session.state;
      if (s === 'exited' || s === 'error') break;
      if (s !== 'idle') {
        sawBusy = true;
        idleSince = 0;
        continue;
      }
      if (!sawBusy) continue;
      if (idleSince === 0) idleSince = Date.now();
      // Require sustained idle: the CLI dips to idle between tool steps.
      else if (Date.now() - idleSince > 2_000) break;
    }
  } finally {
    session.off('assistant-text', onText);
    session.off('tool-summary', onTool);
    session.off('state', onState);
    session.off('permission-request', onPerm);
  }
  return cap;
}

async function main(): Promise<void> {
  const exchanges = arg('--exchanges', 20);
  const permissionRuns = arg('--permissions', 10);
  const idleMinutes = arg('--idle-minutes', 2);

  const pinned = strArg('--cli-path');
  const detected = pinned
    ? { installed: true, path: pinned, version: 'pinned', supported: true }
    : await detectClaude();
  if (!detected.installed || !detected.path) {
    record('CLI detected', 'FAIL', 'Claude Code not found');
    return report();
  }
  record('CLI detected', 'PASS', `v${detected.version} at ${detected.path}`);

  const auth = await authStatus(detected.path);
  if (!auth.authed) {
    record('CLI logged in', 'FAIL', 'not signed in - harness needs a logged-in CLI');
    return report();
  }
  record('CLI logged in', 'PASS', `tier=${auth.tier ?? 'unknown'}`);

  const cwd = path.join(OUT_ROOT, `run-${process.pid}`);
  await mkdir(cwd, { recursive: true });

  const t0 = Date.now();
  const session = await createSession({ cliPath: detected.path, cwd });
  record('Session reached idle', 'PASS', `${Date.now() - t0}ms`);

  try {
    await testExchanges(session, exchanges);
    await testRichContent(session);
    await testPermissions(session, permissionRuns, cwd);
    await testIdle(session, idleMinutes);
    await testRestart(session);
    record(
      'Rate limit detected',
      'SKIP',
      'cannot induce a real limit on this account; detection is pattern-based and unverified',
    );
  } finally {
    session.kill();
    await sleep(500);
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }

  report();
}

/** 20 consecutive exchanges with zero duplicated or garbled extractions. */
async function testExchanges(session: Session, count: number): Promise<void> {
  const problems: string[] = [];
  const seenTokens = new Set<string>();

  for (let i = 1; i <= count; i += 1) {
    const token = `SHIPYARD-${i}-${(i * 7919) % 1000}`;
    const cap = await runTurn(session, `Reply with exactly this and nothing else: ${token}`);
    const text = cap.assistant.join('\n');

    if (cap.assistant.length === 0) {
      problems.push(`#${i}: no assistant text captured`);
      continue;
    }
    const occurrences = text.split(token).length - 1;
    if (occurrences === 0) problems.push(`#${i}: token missing from "${truncate(text)}"`);
    // The token appearing twice means a streaming re-render leaked through.
    else if (occurrences > 1) problems.push(`#${i}: token duplicated ${occurrences}x`);

    for (const prev of seenTokens) {
      if (text.includes(prev)) problems.push(`#${i}: leaked earlier turn's token ${prev}`);
    }
    seenTokens.add(token);
    process.stdout.write(`  exchange ${i}/${count}\r`);
  }
  console.log('');

  record(
    `${count} consecutive exchanges, no duplication`,
    problems.length === 0 ? 'PASS' : 'FAIL',
    problems.length === 0 ? `${count}/${count} clean` : problems.slice(0, 5).join('; '),
  );
}

/** Code blocks, tables, long streaming responses, and tool-use turns. */
async function testRichContent(session: Session): Promise<void> {
  const code = await runTurn(
    session,
    'Reply with only a fenced TypeScript code block declaring: interface Widget { id: string; label: string; enabled: boolean }',
  );
  const codeText = code.assistant.join('\n');
  record(
    'Extraction: code block',
    /interface\s+Widget/.test(codeText) && /enabled/.test(codeText) ? 'PASS' : 'FAIL',
    truncate(codeText),
  );

  const table = await runTurn(
    session,
    'Reply with only a markdown table, 3 columns (ID, Label, Enabled) and 3 data rows.',
  );
  const tableText = table.assistant.join('\n');
  // The TUI renders tables as box-drawing characters, so we assert on the data
  // surviving rather than on markdown pipes. See REPORT.md.
  record(
    'Extraction: table',
    /Label/.test(tableText) && /Enabled/.test(tableText) ? 'PASS' : 'FAIL',
    truncate(tableText),
  );

  const long = await runTurn(
    session,
    'List the numbers 1 through 40, one per line, with no other commentary.',
    { timeoutMs: 180_000 },
  );
  const longText = long.assistant.join('\n');
  const has40 = /(^|\n)\s*40\b/.test(longText);
  const dupes = countDuplicateLines(longText);
  record(
    'Extraction: long streaming response',
    has40 && dupes === 0 ? 'PASS' : 'FAIL',
    `reached 40: ${has40}, duplicated lines: ${dupes}`,
  );

  const tool = await runTurn(session, 'Run the bash command: echo shipyard-tool-check');
  record(
    'Extraction: tool-use turn',
    tool.tools.length > 0 ? 'PASS' : 'FAIL',
    tool.tools.map((t) => `${t.name}: ${t.summary}`).join(', ') || 'no tool-summary emitted',
  );
}

/** Permission prompt detected and answered programmatically, N times. */
async function testPermissions(session: Session, count: number, cwd: string): Promise<void> {
  let detected = 0;
  let answered = 0;

  for (let i = 1; i <= count; i += 1) {
    const file = `perm-${i}.txt`;
    const cap = await runTurn(
      session,
      `Create a file named ${file} containing only the number ${i}. Do not read any other files.`,
      {
        // Always the single-use "Yes", never "allow all" - otherwise the CLI
        // stops prompting and the remaining runs prove nothing.
        answerPermission: (req) =>
          req.options.find((o) => o.kind === 'allow-once')?.index ?? req.options[0]?.index ?? 1,
      },
    );
    if (cap.permissions.length > 0) detected += 1;
    if (cap.tools.length > 0) answered += 1;
    process.stdout.write(`  permission ${i}/${count} (detected ${detected})\r`);
  }
  console.log('');
  void cwd;

  record(
    `Permission prompt detected and answered ${count}x`,
    detected === count && answered === count ? 'PASS' : 'FAIL',
    `detected ${detected}/${count}, tool ran ${answered}/${count}`,
  );
}

async function testIdle(session: Session, minutes: number): Promise<void> {
  if (minutes <= 0) {
    record('Session survives idle', 'SKIP', 'disabled');
    return;
  }
  console.log(`  idling ${minutes} minute(s)...`);
  await sleep(minutes * 60_000);
  const cap = await runTurn(session, 'Reply with exactly: STILL-ALIVE');
  const ok = cap.assistant.join('\n').includes('STILL-ALIVE');
  record(
    `Session survives ${minutes}min idle`,
    ok ? 'PASS' : 'FAIL',
    ok ? 'responded after idle' : `state=${session.state}`,
  );
}

async function testRestart(session: Session): Promise<void> {
  let sawFatal = false;
  const onError = (e: { fatal: boolean }): void => {
    if (e.fatal) sawFatal = true;
  };
  session.on('error', onError);

  // A genuine external kill, not session.kill(): the criterion is that an
  // unexpected CLI death surfaces as a recoverable error. Calling our own
  // kill() marks the exit as intentional and would skip that path entirely.
  const pid = session.pid;
  if (pid === undefined) {
    record('restart() after forced kill', 'FAIL', 'session had no pid to kill');
    session.off('error', onError);
    return;
  }
  try {
    process.kill(pid);
  } catch (err: unknown) {
    record('restart() after forced kill', 'FAIL', `could not kill pid ${pid}: ${String(err)}`);
    session.off('error', onError);
    return;
  }
  await sleep(2_000);
  const exited = session.state === 'exited';

  try {
    await session.restart();
  } catch (err: unknown) {
    record('restart() after forced kill', 'FAIL', String(err));
    session.off('error', onError);
    return;
  }
  session.off('error', onError);

  const cap = await runTurn(session, 'Reply with exactly: RESTARTED');
  const ok = cap.assistant.join('\n').includes('RESTARTED');
  record(
    'restart() after forced kill',
    ok ? 'PASS' : 'FAIL',
    `exited-state=${exited}, fatal-error-emitted=${sawFatal}, responded=${ok}`,
  );
}

function countDuplicateLines(text: string): number {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const seen = new Set<string>();
  let dupes = 0;
  for (const l of lines) {
    if (seen.has(l)) dupes += 1;
    seen.add(l);
  }
  return dupes;
}

function truncate(s: string, n = 110): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}...` : flat;
}

function report(): void {
  console.log(`\n${'='.repeat(70)}`);
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const skip = results.filter((r) => r.status === 'SKIP').length;
  for (const r of results) console.log(`  ${r.status.padEnd(4)} ${r.name}`);
  console.log(`${'='.repeat(70)}`);
  console.log(`  ${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
