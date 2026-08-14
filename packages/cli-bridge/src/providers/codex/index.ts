import { access, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AuthStatus } from '@shipyard/shared';

import { CLI_EXEC_TIMEOUT_MS } from '../../constants';
import { runBinary } from '../../exec';
import type { ProviderDescriptor } from '../types';

import { findInputBox, isBusy, isReady, wasSubmitted } from './chrome';

const IS_WINDOWS = process.platform === 'win32';

/**
 * OpenAI's Codex CLI.
 *
 * Verified against 0.147.0-alpha.6.5 on Windows 11. The two transport rules are
 * the same as for Claude Code and land on the same two commands:
 *
 *   drive          `codex`                 interactive terminal
 *   never          `codex exec`            non-interactive; no approval step
 *   auth state     `codex doctor --json`   redacted, machine-readable
 *
 * `~/.codex/auth.json` exists and is never opened.
 */
export const codexProvider: ProviderDescriptor = {
  id: 'codex',
  name: 'Codex',
  accountName: 'ChatGPT',
  binaryNames: IS_WINDOWS ? ['codex.exe', 'codex.cmd', 'codex'] : ['codex'],
  // Codex is pre-1.0 and moving quickly; below this the flag surface differs
  // enough that refusing beats guessing.
  minVersion: '0.40.0',

  knownLocations(): string[] {
    const home = os.homedir();
    const out: string[] = [];

    if (IS_WINDOWS) {
      const local = process.env['LOCALAPPDATA'] ?? path.join(home, 'AppData', 'Local');
      const appData = process.env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming');
      // The desktop installer's own tree. On the machine this was built against,
      // this was the ONLY copy — `where codex` found nothing, because that
      // installer never touches PATH.
      out.push(path.join(local, 'OpenAI', 'Codex', 'bin'));
      out.push(path.join(home, '.codex', 'bin'));
      out.push(path.join(appData, 'npm', 'codex.cmd'));
    } else {
      out.push('/usr/local/bin/codex');
      out.push('/opt/homebrew/bin/codex');
      out.push(path.join(home, '.local', 'bin', 'codex'));
      out.push(path.join(home, '.codex', 'bin', 'codex'));
    }
    return out;
  },

  /**
   * The desktop install puts the real binary one level below `bin/`, inside a
   * directory named after a build hash — `bin/cfac6bda2d141e07/codex.exe`. That
   * name changes with every update, which is exactly why it is re-derived on
   * every launch rather than stored. (Storing a resolved path is what produced
   * a `File not found` crash for the Claude provider after an update moved it.)
   */
  async resolveExecutable(shimPath: string): Promise<string | undefined> {
    const ext = path.extname(shimPath).toLowerCase();

    if (ext === '.exe') return (await isFile(shimPath)) ? shimPath : undefined;
    if (!IS_WINDOWS && ext === '') {
      return (await isFile(shimPath)) ? shimPath : undefined;
    }

    // A directory: look for the binary directly inside, then one hashed level down.
    if (ext === '') {
      const direct = path.join(shimPath, IS_WINDOWS ? 'codex.exe' : 'codex');
      if (await isFile(direct)) return direct;
      return await newestHashedBinary(shimPath);
    }

    // An npm shim: the sibling real binary, or the hashed tree beside it.
    if (IS_WINDOWS && (ext === '.cmd' || ext === '.ps1')) {
      const dir = path.dirname(shimPath);
      const sibling = path.join(dir, 'codex.exe');
      if (await isFile(sibling)) return sibling;
      return await newestHashedBinary(path.join(dir, 'bin'));
    }

    return undefined;
  },

  parseVersion(output: string): string | undefined {
    // `codex-cli 0.147.0-alpha.6.5`
    return /(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(output.trim())?.[1];
  },

  async authStatus(executable: string): Promise<AuthStatus> {
    const result = await runBinary(executable, ['doctor', '--json'], {
      timeoutMs: CLI_EXEC_TIMEOUT_MS,
    });

    if (result.timedOut) {
      return { authed: false, tier: 'unknown', problem: 'Timed out running `codex doctor`.' };
    }

    const report = extractJsonObject(`${result.stdout}\n${result.stderr}`);
    const details = readDetails(report);

    if (!details) {
      // Fall back to the plain-text command, which is stable and older.
      // `Logged in using ChatGPT` / `Not logged in`
      const plain = await runBinary(executable, ['login', 'status'], {
        timeoutMs: CLI_EXEC_TIMEOUT_MS,
      });
      const text = `${plain.stdout} ${plain.stderr}`;
      if (/not logged in|no credentials/i.test(text)) return { authed: false, tier: 'unknown' };
      if (/logged in/i.test(text)) {
        return {
          authed: true,
          tier: /chatgpt/i.test(text) ? 'subscription' : 'unknown',
          authMethod: /api key/i.test(text) ? 'api-key' : 'subscription',
        };
      }
      return {
        authed: false,
        tier: 'unknown',
        problem: 'Could not read Codex sign-in state. This CLI version may be too old.',
      };
    }

    // `stored auth mode` is "chatgpt" for a subscription, "apikey" for a key.
    const mode = String(details['stored auth mode'] ?? '').toLowerCase();
    const hasChatGpt = String(details['stored ChatGPT tokens'] ?? '') === 'true';
    const hasApiKey = String(details['stored API key'] ?? '') === 'true';

    if (!hasChatGpt && !hasApiKey && mode.length === 0) {
      return { authed: false, tier: 'unknown' };
    }

    const viaSubscription = mode === 'chatgpt' || (hasChatGpt && !hasApiKey);
    return {
      authed: true,
      tier: viaSubscription ? 'subscription' : 'unknown',
      authMethod: viaSubscription ? 'subscription' : 'api-key',
    };
  },

  /**
   * Interactive only, and with the strongest consent posture Codex offers.
   *
   * The two agents have different consent models. Claude asks before each edit.
   * Codex runs inside a sandbox and escalates by policy, so matching Shipyard's
   * "consent stays explicit" principle means choosing that policy deliberately:
   *
   *   --ask-for-approval untrusted   anything beyond a known-safe read comes
   *                                  back to the user
   *   --sandbox workspace-write      writes are confined to the project folder
   *
   * Never `--approve-for-me`, and never
   * `--dangerously-bypass-approvals-and-sandbox`: both hand the decision to
   * something other than the person whose computer it is.
   */
  sessionArgs(): string[] {
    return ['--ask-for-approval', 'untrusted', '--sandbox', 'workspace-write'];
  },

  buildSessionEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
    const out: Record<string, string> = {};
    // Markers a parent Codex process sets. Same reasoning as the Claude
    // provider: a session spawned from inside another session behaves
    // differently, and Shipyard should always look like a clean terminal.
    const drop = new Set(['CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_SESSION_ID']);

    for (const [key, value] of Object.entries(source)) {
      if (typeof value !== 'string') continue;
      if (drop.has(key)) continue;
      out[key] = value;
    }
    // Deliberately NOT dropped: OPENAI_API_KEY and CODEX_HOME. Those describe
    // how the user has chosen to authenticate and where their config lives.
    // We read auth state; we do not steer it.
    out['TERM'] = 'xterm-256color';
    return out;
  },

  chrome: { isReady, isBusy, findInputBox, wasSubmitted },
};

/** `bin/<build-hash>/codex.exe` — pick the most recently modified. */
async function newestHashedBinary(binDir: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await readdir(binDir);
  } catch {
    return undefined;
  }

  const name = IS_WINDOWS ? 'codex.exe' : 'codex';
  const found: { file: string; mtime: number }[] = [];
  for (const entry of entries) {
    const candidate = path.join(binDir, entry, name);
    const mtime = await mtimeOf(candidate);
    if (mtime !== undefined) found.push({ file: candidate, mtime });
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found[0]?.file;
}

async function mtimeOf(target: string): Promise<number | undefined> {
  try {
    const { stat } = await import('node:fs/promises');
    const info = await stat(target);
    return info.isFile() ? info.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

async function isFile(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** The `auth.credentials` check's details block from `codex doctor --json`. */
function readDetails(report: unknown): Record<string, unknown> | null {
  if (!report || typeof report !== 'object') return null;
  const checks = (report as { checks?: unknown }).checks;
  if (!checks || typeof checks !== 'object') return null;
  const auth = (checks as Record<string, unknown>)['auth.credentials'];
  if (!auth || typeof auth !== 'object') return null;
  const details = (auth as { details?: unknown }).details;
  return details && typeof details === 'object' ? (details as Record<string, unknown>) : null;
}

/** Pull the first balanced JSON object out of mixed output. */
function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
