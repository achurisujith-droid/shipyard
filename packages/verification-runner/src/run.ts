import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';

import { redacted } from '@shipyard/security';
import type { Evidence, GateDefinition, GateResult, VerificationRun } from '@shipyard/shared';

import { gate, runnableGates } from './gates';

/**
 * Run the checks, independently of the thing that wrote the code.
 *
 * This is the piece that makes the rest true. Rules can say what a project owes
 * its users and readiness can score it, but until something other than the
 * agent goes and looks, every number is arithmetic over an empty list.
 *
 * Nothing here trusts the agent's account of anything. It runs a command in the
 * project directory and reads the exit code.
 */

export interface RunnerOptions {
  projectPath: string;
  projectId: string;
  /** Which capabilities the project has, so irrelevant gates are not run. */
  capabilities: string[];
  trigger: VerificationRun['trigger'];
  /** PATH-decorated environment, so the bundled Node and npm are used. */
  env?: NodeJS.ProcessEnv;
  /** Per-gate ceiling. A hung test must not hold the whole run forever. */
  timeoutMs?: number;
  /** Called as each gate finishes, so the UI can fill in rather than freeze. */
  onGate?: (result: GateResult) => void;
  /** Handlers for the checks Shipyard performs itself rather than shelling out. */
  internal?: Record<string, () => Promise<Omit<GateResult, 'gateId' | 'durationMs'>>>;
}

/** How much output to keep. Enough to diagnose, not enough to bury. */
const KEEP_LINES = 60;

/**
 * A missing npm script is not a failure.
 *
 * A project with no `test:permissions` script has not failed its permission
 * tests — it has not got any. Reporting that as a failure would put a red card
 * in front of someone whose project is fine, and reporting it as a pass would
 * be a lie. `pending` is the honest third answer.
 */
const MISSING_SCRIPT_RE = /missing script:|Unknown command|command not found|ENOENT/i;

function runCommand(
  command: string,
  options: RunnerOptions,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const shell = isWindows
      ? path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'cmd.exe')
      : '/bin/sh';
    // Every command here comes from the gate registry, which is a compile-time
    // constant. Nothing the user or the agent wrote reaches this line.
    const args = isWindows ? ['/d', '/s', '/c', command] : ['-lc', command];

    const child = spawn(shell, args, {
      cwd: options.projectPath,
      env: { ...(options.env ?? process.env), FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' },
      windowsHide: true,
    });

    const lines: string[] = [];
    const collect = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) lines.push(line.trimEnd());
      }
      if (lines.length > KEEP_LINES * 4) lines.splice(0, lines.length - KEEP_LINES * 4);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const timer = setTimeout(() => {
      lines.push(`Shipyard: gave up after ${(options.timeoutMs ?? 600_000) / 1000}s.`);
      child.kill();
    }, options.timeoutMs ?? 600_000);

    const finish = (code: number): void => {
      clearTimeout(timer);
      resolve({ code, output: lines.slice(-KEEP_LINES).join('\n') });
    };
    child.on('error', () => finish(127));
    child.on('close', (code) => finish(code ?? 1));
  });
}

/** Run one gate and turn it into a result. */
export async function runGate(
  definition: GateDefinition,
  options: RunnerOptions,
): Promise<GateResult> {
  const started = Date.now();

  // Checks Shipyard performs itself — the scanners — rather than shelling out.
  const internal = definition.command?.startsWith('shipyard:')
    ? options.internal?.[definition.command]
    : undefined;
  if (definition.command?.startsWith('shipyard:')) {
    if (!internal) {
      return {
        gateId: definition.id,
        status: 'pending',
        durationMs: 0,
        failureSummary: 'This check is not wired up in this build.',
      };
    }
    const outcome = await internal();
    return { gateId: definition.id, durationMs: Date.now() - started, ...outcome };
  }

  if (!definition.command) {
    return {
      gateId: definition.id,
      status: 'pending',
      durationMs: 0,
      failureSummary: 'Nothing has confirmed this yet.',
    };
  }

  const { code, output } = await runCommand(definition.command, options);
  const safe = redacted(output);
  const durationMs = Date.now() - started;

  if (code !== 0 && MISSING_SCRIPT_RE.test(output)) {
    return {
      gateId: definition.id,
      status: 'pending',
      durationMs,
      failureSummary: 'This check has not been set up in your project yet.',
      output: safe,
    };
  }

  if (code === 0) return { gateId: definition.id, status: 'passed', durationMs, output: safe };

  return {
    gateId: definition.id,
    status: 'failed',
    durationMs,
    failureSummary: summarise(safe, definition),
    output: safe,
  };
}

/**
 * One line a founder can act on, from a wall of tool output.
 *
 * Prefers the first line that looks like a real error over the last line, which
 * on most runners is a summary of how many things failed rather than what.
 */
function summarise(output: string, definition: GateDefinition): string {
  const lines = output.split('\n').filter((l) => l.trim());
  const interesting = lines.find((line) =>
    /\b(error|failed|expected|cannot|not found|refused)\b/i.test(line),
  );
  const chosen = (interesting ?? lines[lines.length - 1] ?? '').trim();
  if (!chosen) return `${definition.label} did not pass.`;
  return chosen.length > 200 ? `${chosen.slice(0, 197)}...` : chosen;
}

/**
 * Run every requested gate that applies, in order.
 *
 * Sequential on purpose. These are builds and browser tests on the user's own
 * machine while they are watching a preview of their app; running four at once
 * makes both slower and the machine unusable.
 */
export async function verify(
  wanted: string[],
  options: RunnerOptions,
): Promise<VerificationRun> {
  const definitions = runnableGates(wanted, options.capabilities);
  const run: VerificationRun = {
    id: randomUUID(),
    projectId: options.projectId,
    trigger: options.trigger,
    startedAt: new Date().toISOString(),
    status: 'running',
    gates: [],
  };

  for (const definition of definitions) {
    const result = await runGate(definition, options);
    run.gates.push(result);
    options.onGate?.(result);
  }

  run.finishedAt = new Date().toISOString();
  run.status = run.gates.some((g) => g.status === 'failed') ? 'failed' : 'passed';
  return run;
}

/**
 * Turn a run into evidence the rest of the system can read.
 *
 * `pending` results are deliberately included. A check that has never been set
 * up is a different thing from one that failed, and the readiness score needs
 * to know the difference to tell the user what to do next.
 */
export function toEvidence(run: VerificationRun): Evidence[] {
  return run.gates.map((result) => ({
    gateId: result.gateId,
    status: result.status,
    observedAt: run.finishedAt ?? run.startedAt,
    ...(result.failureSummary ? { summary: result.failureSummary } : {}),
    ref: run.id,
  }));
}

/**
 * Evidence a person or another system supplied.
 *
 * Manual and external gates cannot be run, but they can be observed — someone
 * confirms the backup restore worked, Sentry confirms it received the test
 * error. This is how that observation enters the same pipeline as a test.
 */
export function attest(
  gateId: string,
  status: Evidence['status'],
  summary?: string,
  ref?: string,
): Evidence {
  const definition = gate(gateId);
  if (!definition) throw new Error(`Unknown gate "${gateId}"`);
  if (definition.kind === 'command') {
    // The whole point of this layer is that claims are not evidence. A command
    // gate has a command; if someone wants it passed, they run it.
    throw new Error(`"${gateId}" is proved by running it, not by saying so`);
  }
  return {
    gateId,
    status,
    observedAt: new Date().toISOString(),
    ...(summary ? { summary } : {}),
    ...(ref ? { ref } : {}),
  };
}
