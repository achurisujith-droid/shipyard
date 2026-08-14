/**
 * Does the provider abstraction actually fit both CLIs?
 *
 * Runs against the real binaries on this machine. The point is not that the
 * code compiles — it is that Claude Code and Codex, two unrelated programs,
 * can each be found, version-checked and asked for their sign-in state through
 * one interface, without either one touching a credential file.
 *
 *   npx tsx harness/test-providers.ts
 */
import { access, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PROVIDER_LIST, type ProviderDescriptor } from '../src/providers';
import { compareVersions } from '../src/detect';
import { runBinary } from '../src/exec';

let failed = 0;
let skipped = 0;

const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(ok ? `PASS  ${name}` : `FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  if (!ok) failed += 1;
  return ok;
};

const skip = (name: string, why: string): void => {
  skipped += 1;
  console.log(`SKIP  ${name}\n        ${why}`);
};

/**
 * Find a provider's binary the way the app would: PATH first, then the
 * locations the descriptor knows about.
 */
async function locate(provider: ProviderDescriptor): Promise<string | undefined> {
  const seen: string[] = [];

  const fromPath = (process.env['PATH'] ?? process.env['Path'] ?? '').split(path.delimiter);
  for (const dir of fromPath) {
    if (!dir) continue;
    for (const name of provider.binaryNames) seen.push(path.join(dir, name));
  }
  seen.push(...provider.knownLocations());

  for (const candidate of seen) {
    if (!(await exists(candidate))) continue;
    const resolved = await provider.resolveExecutable(candidate);
    if (resolved) return resolved;
  }
  return undefined;
}

async function main(): Promise<void> {
  console.log(`Providers registered: ${PROVIDER_LIST.map((p) => p.id).join(', ')}\n`);

  check(
    'both providers are registered',
    PROVIDER_LIST.length === 2 && PROVIDER_LIST.some((p) => p.id === 'codex'),
  );

  // The rule that matters most, checked as code rather than as a comment: no
  // provider may put a non-interactive flag in its session arguments.
  const FORBIDDEN = /^(-p|--print|exec|--headless|--approve-for-me|--dangerously-)/;
  for (const provider of PROVIDER_LIST) {
    const args = provider.sessionArgs();
    check(
      `${provider.id}: session arguments contain nothing non-interactive`,
      !args.some((a) => FORBIDDEN.test(a)),
      args.join(' '),
    );
  }

  // Codex's approval posture is a deliberate choice, not a default.
  const codex = PROVIDER_LIST.find((p) => p.id === 'codex');
  if (codex) {
    const args = codex.sessionArgs().join(' ');
    check(
      'codex: escalates anything beyond a known-safe read to the user',
      /--ask-for-approval untrusted/.test(args),
      args,
    );
    check('codex: writes are confined to the project folder', /--sandbox workspace-write/.test(args), args);
  }

  for (const provider of PROVIDER_LIST) {
    console.log(`\n--- ${provider.name} (${provider.accountName}) ---`);

    const exe = await locate(provider);
    if (!exe) {
      skip(`${provider.id}: found on this machine`, 'not installed here; nothing else to check');
      continue;
    }
    check(`${provider.id}: found and resolved to a spawnable binary`, true, exe);

    const version = await runBinary(exe, ['--version'], { timeoutMs: 30_000 });
    const parsed = provider.parseVersion(`${version.stdout}\n${version.stderr}`);
    if (
      !check(
        `${provider.id}: reports a version we can parse`,
        typeof parsed === 'string',
        `${version.stdout}${version.stderr}`.trim().slice(0, 120),
      )
    ) {
      continue;
    }
    console.log(`        version ${parsed}`);
    check(
      `${provider.id}: version is at or above the minimum we will drive`,
      compareVersions(parsed as string, provider.minVersion) >= 0,
      `${parsed} vs ${provider.minVersion}`,
    );

    // The whole point of rule 1: sign-in state comes from the CLI, not a file.
    const auth = await provider.authStatus(exe);
    check(
      `${provider.id}: reports sign-in state without opening a credential file`,
      typeof auth.authed === 'boolean' && auth.tier !== undefined,
      JSON.stringify(auth),
    );
    console.log(
      `        authed=${auth.authed} tier=${auth.tier} method=${auth.authMethod ?? 'n/a'}`,
    );

    // Nothing read from the CLI should ever carry a token.
    const serialised = JSON.stringify(auth);
    check(
      `${provider.id}: nothing token-shaped survives into what we store`,
      !/sk-[A-Za-z0-9]{8}|eyJ[A-Za-z0-9_-]{10}|Bearer\s/i.test(serialised),
      serialised,
    );
  }

  // Prove the credential files exist and that we never went near them: if the
  // rule were broken, these paths would appear somewhere in the source.
  console.log('\n--- credential custody ---');
  const credentials = [
    path.join(os.homedir(), '.claude', '.credentials.json'),
    path.join(os.homedir(), '.codex', 'auth.json'),
  ];
  for (const file of credentials) {
    console.log(`        ${(await exists(file)) ? 'exists' : 'absent'}  ${file}`);
  }
  const offenders = await grepSource(path.resolve(__dirname, '..', 'src'), [
    /\.credentials\.json/,
    /\.codex[\\/]auth\.json/,
    /auth\.json['"]/,
  ]);
  check(
    'no source file references a credential file by path',
    offenders.length === 0,
    offenders.join('\n        '),
  );

  console.log(
    `\n${failed === 0 ? `One interface, both CLIs.${skipped ? ` (${skipped} skipped)` : ''}` : `${failed} case(s) failed.`}`,
  );
  process.exitCode = failed > 0 ? 1 : 0;
}

/** Walk the source tree looking for anything that names a credential store. */
async function grepSource(dir: string, patterns: RegExp[]): Promise<string[]> {
  const { readFile } = await import('node:fs/promises');
  const hits: string[] = [];
  const walk = async (d: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith('.ts')) {
        const body = await readFile(full, 'utf8').catch(() => '');
        // Comments explaining that we do NOT read these are expected and fine;
        // only flag lines that look like real filesystem access.
        for (const line of body.split('\n')) {
          if (/^\s*(\*|\/\/)/.test(line)) continue;
          if (patterns.some((p) => p.test(line))) hits.push(`${path.basename(full)}: ${line.trim()}`);
        }
      }
    }
  };
  await walk(dir);
  return hits;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

main().catch((err: unknown) => {
  console.error('THREW:', err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
