import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import type { SecurityFinding } from '@shipyard/shared';

import { redact } from './redact';

/**
 * Look at a project before an agent does, and before it launches.
 *
 * Two jobs that share one walk of the tree: find secrets that must not ship,
 * and find the things in someone else's code that run on their behalf the
 * moment you type `npm install`.
 *
 * The second is the one people forget. A lifecycle script in an imported
 * project executes with the user's privileges before any of our checks have
 * looked at anything.
 */

/** Directories with nothing worth scanning and everything worth skipping. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'coverage',
  '.venv',
  '__pycache__',
]);

/** Extensions worth reading as text. Everything else is treated as binary. */
const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.json', '.md', '.yml', '.yaml',
  '.env', '.txt', '.sh', '.bash', '.ps1', '.sql', '.prisma', '.html', '.css', '.toml',
]);

/** Files that are secret material by name, whatever is in them. */
const ENV_FILE_RE = /(^|[\\/])\.env(\.|$)/i;

/** Anything over this is not source, and reading it wastes the user's time. */
const MAX_BYTES = 512 * 1024;

async function* walk(root: string, rel = ''): AsyncGenerator<string> {
  const here = path.join(root, rel);
  const entries = await readdir(here, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = path.join(rel, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(root, child);
    } else if (entry.isFile()) {
      yield child;
    } else if (entry.isSymbolicLink()) {
      // Reported rather than followed: a symlink out of the project is how a
      // scan gets walked into somewhere it was never meant to read.
      yield child;
    }
  }
}

function finding(
  projectId: string,
  type: SecurityFinding['type'],
  severity: SecurityFinding['severity'],
  summary: string,
  location?: string,
): SecurityFinding {
  return {
    id: randomUUID(),
    projectId,
    type,
    severity,
    summary,
    ...(location ? { location } : {}),
    status: 'open',
    foundAt: new Date().toISOString(),
  };
}

/**
 * Secrets in the project's own files.
 *
 * A hit in `.env` is expected and is not a finding on its own — that is what
 * the file is for. A hit in tracked source is, because that is the one that
 * ends up in a public repository.
 */
export async function scanSecrets(
  projectPath: string,
  projectId: string,
): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];

  for await (const rel of walk(projectPath)) {
    const ext = path.extname(rel).toLowerCase();
    const isEnv = ENV_FILE_RE.test(rel);
    if (!isEnv && !TEXT_EXT.has(ext)) continue;

    const full = path.join(projectPath, rel);
    const info = await stat(full).catch(() => null);
    if (!info || info.size > MAX_BYTES) continue;

    const contents = await readFile(full, 'utf8').catch(() => null);
    if (contents === null) continue;

    const { redactions } = redact(contents);
    if (redactions.length === 0) continue;

    for (const hit of redactions) {
      if (isEnv) {
        // Expected here. Worth one note so the user knows it must not be
        // committed, not one finding per key.
        continue;
      }
      findings.push(
        finding(
          projectId,
          'secret',
          'critical',
          `A ${hit.name} appears in a source file. Anyone who sees this code can use it.`,
          rel,
        ),
      );
    }

    if (isEnv && redactions.length > 0) {
      findings.push(
        finding(
          projectId,
          'secret',
          'low',
          'This file holds live keys. It belongs in .gitignore and must never be shared.',
          rel,
        ),
      );
    }
  }

  return findings;
}

/**
 * What runs when you install someone else's project.
 *
 * `npm install` executes `preinstall`, `install` and `postinstall` with the
 * user's privileges. An agent config or a local MCP server definition is the
 * same problem one level up: it tells the coding agent what it may do, and it
 * arrived with the code rather than from the user.
 */
export async function quarantineImported(
  projectPath: string,
  projectId: string,
): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];

  const pkgRaw = await readFile(path.join(projectPath, 'package.json'), 'utf8').catch(() => null);
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
      for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
        const script = pkg.scripts?.[hook];
        if (!script) continue;
        findings.push(
          finding(
            projectId,
            'lifecycle_script',
            'high',
            `This project runs "${redact(script).text}" automatically when its dependencies are installed. Read it before continuing.`,
            'package.json',
          ),
        );
      }
    } catch {
      findings.push(
        finding(projectId, 'lifecycle_script', 'medium', 'package.json could not be read.', 'package.json'),
      );
    }
  }

  for await (const rel of walk(projectPath)) {
    const name = path.basename(rel).toLowerCase();
    const segments = rel.split(/[\\/]/);

    // Configuration that changes what the agent is allowed to do, shipped with
    // the code rather than chosen by the user.
    if (segments.includes('.claude') || name === '.mcp.json' || name === 'mcp.json') {
      findings.push(
        finding(
          projectId,
          'agent_config',
          'high',
          'This file tells the coding agent what it may do without asking. It came with the project, not from you.',
          rel,
        ),
      );
      continue;
    }

    if (['.sh', '.bash', '.ps1', '.bat', '.cmd'].includes(path.extname(rel).toLowerCase())) {
      findings.push(
        finding(projectId, 'lifecycle_script', 'medium', 'A script that can run commands on your computer.', rel),
      );
    }
  }

  return findings;
}

/**
 * Licences of the installed dependencies.
 *
 * Not a legal opinion. It answers one question a founder cannot answer
 * themselves: is there anything in here whose terms would oblige them to
 * publish their own source, or that nobody has stated terms for at all.
 */
const COPYLEFT_RE = /\b(AGPL|GPL-[23]|SSPL|CC-BY-NC|BUSL)/i;

export async function scanLicenses(
  projectPath: string,
  projectId: string,
): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];
  const modules = path.join(projectPath, 'node_modules');
  const entries = await readdir(modules, { withFileTypes: true }).catch(() => []);

  const packages: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('@')) {
      const scoped = await readdir(path.join(modules, entry.name), { withFileTypes: true }).catch(
        () => [],
      );
      for (const inner of scoped) {
        if (inner.isDirectory()) packages.push(path.join(entry.name, inner.name));
      }
    } else if (!entry.name.startsWith('.')) {
      packages.push(entry.name);
    }
  }

  for (const name of packages) {
    const raw = await readFile(path.join(modules, name, 'package.json'), 'utf8').catch(() => null);
    if (!raw) continue;
    let license: unknown;
    try {
      ({ license } = JSON.parse(raw) as { license?: unknown });
    } catch {
      continue;
    }

    const text =
      typeof license === 'string'
        ? license
        : typeof license === 'object' && license !== null
          ? String((license as { type?: unknown }).type ?? '')
          : '';

    if (!text) {
      findings.push(
        finding(
          projectId,
          'license',
          'medium',
          `${name} does not say what it may be used for. That has to be checked before you sell anything built on it.`,
          `node_modules/${name}`,
        ),
      );
    } else if (COPYLEFT_RE.test(text)) {
      findings.push(
        finding(
          projectId,
          'license',
          'high',
          `${name} is under ${text}, which can require you to publish your own source code. Worth a lawyer's five minutes before launch.`,
          `node_modules/${name}`,
        ),
      );
    }
  }

  return findings;
}

/** Everything, for a launch check. */
export async function scanAll(
  projectPath: string,
  projectId: string,
  options: { imported?: boolean } = {},
): Promise<SecurityFinding[]> {
  const [secrets, licenses, quarantine] = await Promise.all([
    scanSecrets(projectPath, projectId),
    scanLicenses(projectPath, projectId),
    options.imported ? quarantineImported(projectPath, projectId) : Promise.resolve([]),
  ]);
  return [...secrets, ...quarantine, ...licenses];
}

/** Does anything here stop a launch? */
export function blocksLaunch(findings: SecurityFinding[]): SecurityFinding[] {
  return findings.filter(
    (f) => f.status === 'open' && (f.severity === 'critical' || f.severity === 'high'),
  );
}
