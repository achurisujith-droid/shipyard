import { constants as fsConstants } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { DetectResult, DetectSource } from '@shipyard/shared';

import { CLI_EXEC_TIMEOUT_MS, MIN_SUPPORTED_CLI_VERSION } from './constants';
import { runBinary } from './exec';

const IS_WINDOWS = process.platform === 'win32';

/** A PATH entry we found, before we know whether it is spawnable. */
interface Candidate {
  shimPath: string;
  source: DetectSource;
}

export interface DetectOptions {
  /**
   * Previously cached shim path (from SQLite). Tried first; if it no longer
   * resolves we fall through to a full search rather than reporting missing.
   */
  cachedShimPath?: string;
}

/**
 * Locate the Claude Code CLI.
 *
 * Order: cached shim -> which/where -> PATH scan -> known install locations.
 * Every hit is verified by actually running `--version`; we never trust a path
 * because it exists.
 */
export async function detectClaude(opts: DetectOptions = {}): Promise<DetectResult> {
  const seen = new Set<string>();
  const candidates: Candidate[] = [];

  const push = (shimPath: string, source: DetectSource): void => {
    const key = path.normalize(shimPath).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ shimPath, source });
  };

  if (opts.cachedShimPath) push(opts.cachedShimPath, 'cache');
  for (const p of await whichClaude()) push(p, 'which');
  for (const p of await scanPath()) push(p, 'path-scan');
  for (const p of knownLocations()) push(p, 'known-location');

  let lastProblem: string | undefined;
  /** bin/ directories where we expected an executable and found none. */
  const missingExeDirs: string[] = [];

  for (const candidate of candidates) {
    if (!(await isFile(candidate.shimPath))) continue;

    const executable = await resolveExecutable(candidate.shimPath);
    if (!executable) {
      lastProblem =
        `Found ${candidate.shimPath} but could not resolve it to a directly ` +
        `spawnable executable.`;
      missingExeDirs.push(
        path.join(
          path.dirname(candidate.shimPath),
          'node_modules',
          '@anthropic-ai',
          'claude-code',
          'bin',
        ),
      );
      continue;
    }

    const version = await probeVersion(executable);
    if (!version) {
      lastProblem = `${executable} did not report a usable version string.`;
      continue;
    }

    return {
      installed: true,
      path: executable,
      shimPath: candidate.shimPath,
      version,
      supported: compareVersions(version, MIN_SUPPORTED_CLI_VERSION) >= 0,
      source: candidate.source,
      ...(compareVersions(version, MIN_SUPPORTED_CLI_VERSION) < 0
        ? { problem: `Claude Code ${version} is older than the minimum supported ${MIN_SUPPORTED_CLI_VERSION}.` }
        : {}),
    };
  }

  // Distinguish "not installed" from "installed but mid-upgrade". Windows
  // cannot delete a running .exe, so the updater renames it to
  // `claude.exe.old.<timestamp>` before writing the replacement; in that window
  // there is no claude.exe on disk. Telling a signed-in user to install Claude
  // Code at that moment would be wrong.
  const pending = await anyPendingUpdate(missingExeDirs);
  if (pending.inProgress) {
    return {
      installed: false,
      supported: false,
      updateInProgress: true,
      problem:
        'Claude Code appears to be updating itself right now (found a renamed ' +
        'previous binary with no replacement yet). Retry shortly.',
    };
  }
  if (pending.abandoned) {
    // Waiting will not fix this one, so say what will.
    return {
      installed: false,
      supported: false,
      problem:
        'Claude Code looks half-installed: an update removed the old version and ' +
        'never finished writing the new one. Reinstalling it will fix this.',
    };
  }

  return {
    installed: false,
    supported: false,
    ...(lastProblem ? { problem: lastProblem } : {}),
  };
}

/**
 * How long a renamed binary can sit there before we stop calling it an update.
 *
 * An update takes seconds. A `claude.exe.old.*` with no replacement beside it
 * three days later is not in progress, it is a broken install — observed in the
 * wild, where the updater reported success but wrote the new binary somewhere
 * else entirely, leaving this directory holding only the renamed old one.
 *
 * The distinction matters because the two states need opposite advice. "Retry
 * shortly" is right for a real update and is a dead end for a failed one, and
 * a dead end is the thing PRODUCT.md rules out.
 */
const UPDATE_STALE_AFTER_MS = 10 * 60 * 1_000;

interface PendingUpdate {
  /** A rename happened recently enough to still be an update in flight. */
  inProgress: boolean;
  /** A rename happened, but long ago: the install is broken. */
  abandoned: boolean;
}

/** Look for a `claude.exe.old.*` the updater left behind, and how old it is. */
async function anyPendingUpdate(dirs: string[]): Promise<PendingUpdate> {
  let inProgress = false;
  let abandoned = false;

  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue; // Directory does not exist; nothing to infer.
    }

    for (const entry of entries) {
      if (!/^claude(\.exe)?\.old\./i.test(entry)) continue;
      let age = Number.POSITIVE_INFINITY;
      try {
        age = Date.now() - (await stat(path.join(dir, entry))).mtimeMs;
      } catch {
        // Unreadable: treat as abandoned rather than claim an update is running.
      }
      if (age < UPDATE_STALE_AFTER_MS) inProgress = true;
      else abandoned = true;
    }
  }

  return { inProgress, abandoned };
}

/**
 * Turn a PATH entry into something we can spawn without a shell.
 *
 * On Windows the thing on PATH is `claude.cmd`, an npm shim. Node refuses to
 * spawn `.cmd` without `shell: true` (CVE-2024-27980), and we will not enable
 * a shell. So we walk from the shim to the real binary the npm package ships
 * at `node_modules/@anthropic-ai/claude-code/bin/claude.exe`.
 *
 * That binary path is version-specific, which is exactly why we re-derive it
 * on every startup instead of caching it.
 */
export async function resolveExecutable(shimPath: string): Promise<string | undefined> {
  const ext = path.extname(shimPath).toLowerCase();

  // Already a real executable.
  if (!IS_WINDOWS && ext === '') {
    return (await isExecutable(shimPath)) ? shimPath : undefined;
  }
  if (ext === '.exe') return shimPath;

  if (IS_WINDOWS && (ext === '.cmd' || ext === '.ps1' || ext === '')) {
    const dir = path.dirname(shimPath);
    const packaged = path.join(
      dir,
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'bin',
      'claude.exe',
    );
    if (await isFile(packaged)) return packaged;

    // Native installer layout: the shim sits next to the binary.
    const sibling = path.join(dir, 'claude.exe');
    if (await isFile(sibling)) return sibling;
  }

  return undefined;
}

async function whichClaude(): Promise<string[]> {
  const tool = IS_WINDOWS
    ? path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'where.exe')
    : await firstExisting(['/usr/bin/which', '/bin/which']);
  if (!tool) return [];

  const result = await runBinary(tool, ['claude'], { timeoutMs: 5_000 });
  if (result.code !== 0) return [];

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function scanPath(): Promise<string[]> {
  const raw = process.env['PATH'] ?? process.env['Path'] ?? '';
  const dirs = raw.split(path.delimiter).filter((d) => d.trim().length > 0);
  const names = IS_WINDOWS ? ['claude.exe', 'claude.cmd'] : ['claude'];

  const found: string[] = [];
  for (const dir of dirs) {
    for (const name of names) {
      const full = path.join(dir, name);
      if (await isFile(full)) found.push(full);
    }
  }
  return found;
}

function knownLocations(): string[] {
  const home = os.homedir();
  if (IS_WINDOWS) {
    const appData = process.env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming');
    const localAppData =
      process.env['LOCALAPPDATA'] ?? path.join(home, 'AppData', 'Local');
    return [
      path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
      path.join(appData, 'npm', 'claude.cmd'),
      path.join(home, '.local', 'bin', 'claude.exe'),
      path.join(localAppData, 'Programs', 'claude', 'claude.exe'),
    ];
  }
  return [
    path.join(home, '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(home, '.npm-global', 'bin', 'claude'),
    '/usr/bin/claude',
  ];
}

/** Runs `--version` and extracts the semver. Returns undefined if it looks like a different `claude`. */
async function probeVersion(executable: string): Promise<string | undefined> {
  const result = await runBinary(executable, ['--version'], {
    timeoutMs: CLI_EXEC_TIMEOUT_MS,
  });
  if (result.timedOut) return undefined;

  const text = `${result.stdout}\n${result.stderr}`;
  // Observed on 2.1.215: "2.1.215 (Claude Code)"
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!match) return undefined;
  return `${match[1]}.${match[2]}.${match[3]}`;
}

/** Numeric semver-ish compare over major.minor.patch. Returns -1 / 0 / 1. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    (v.split('.').map((n) => Number.parseInt(n, 10)) as number[]).map((n) =>
      Number.isFinite(n) ? n : 0,
    );
  const av = parse(a);
  const bv = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const x = av[i] ?? 0;
    const y = bv[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

async function isFile(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function firstExisting(paths: string[]): Promise<string | undefined> {
  for (const p of paths) {
    if (await isFile(p)) return p;
  }
  return undefined;
}
