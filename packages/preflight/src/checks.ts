import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * The checks that find a local/live divergence before anybody deploys.
 *
 * Every one of these runs against files on disk, on the founder's own machine,
 * in a second or two. None of them need a server, an account or a network.
 *
 * They exist because the alternative is finding out from a customer. A build
 * that fails is annoying; a build that succeeds and produces a site where
 * sign-in silently stops working is the thing this is really for.
 */

export interface Finding {
  check: string;
  /** The divergence this belongs to. */
  divergence: string;
  severity: 'blocking' | 'warning';
  /** What is wrong, in the founder's words. */
  message: string;
  file?: string;
  line?: number;
  /** What to do. */
  fix: string;
}

const SOURCE = /\.(ts|tsx|js|jsx|mjs)$/;
const SKIP = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'out', 'coverage', '.shipyard']);

/** Every source file in the project, relative to its root. */
export async function sourceFiles(root: string, directory = ''): Promise<string[]> {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(root, relative)));
    else if (SOURCE.test(entry.name)) found.push(relative);
  }
  return found;
}

/** Pull the relative import paths out of a file, with their line numbers. */
export function relativeImports(contents: string): { specifier: string; line: number }[] {
  const found: { specifier: string; line: number }[] = [];
  const pattern = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](\.[^'"]*)['"]/g;
  const lines = contents.split('\n');
  for (const [index, text] of lines.entries()) {
    let match: RegExpExecArray | null;
    const perLine = new RegExp(pattern.source, 'g');
    while ((match = perLine.exec(text)) !== null) {
      if (match[1]) found.push({ specifier: match[1], line: index + 1 });
    }
  }
  return found;
}

/**
 * Does an import match the file on disk, letter for letter?
 *
 * The check most worth having, because it is invisible on Windows and macOS and
 * fatal on Linux. `import './Button'` where the file is `button.tsx` resolves
 * perfectly on a case-insensitive filesystem and throws a module-not-found on
 * the server, and nothing about the code looks wrong when you read it.
 *
 * Comparison is done against the real directory listing rather than by asking
 * the filesystem to resolve the path — on Windows, asking is exactly the thing
 * that gives the wrong answer.
 */
export async function checkImportCase(root: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  const listings = new Map<string, string[]>();

  const listing = async (directory: string): Promise<string[]> => {
    const cached = listings.get(directory);
    if (cached) return cached;
    const entries = await readdir(path.join(root, directory)).catch(() => [] as string[]);
    listings.set(directory, entries);
    return entries;
  };

  const EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js'];

  for (const file of await sourceFiles(root)) {
    const contents = await readFile(path.join(root, file), 'utf8').catch(() => '');
    for (const { specifier, line } of relativeImports(contents)) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      const directory = path.posix.dirname(resolved);
      const wanted = path.posix.basename(resolved);

      const entries = await listing(directory);
      if (entries.length === 0) continue;

      // Does anything match exactly, with any of the extensions a bundler tries?
      const exact = EXTENSIONS.some((extension) => {
        const target = `${wanted}${extension}`;
        return target.includes('/')
          ? entries.includes(wanted) // a directory import
          : entries.includes(target);
      });
      if (exact) continue;

      // Is there something that differs only in capitalisation? If so, this is
      // the bug. If not, it is an alias or a missing file — not our business.
      const lowered = wanted.toLowerCase();
      const nearMiss = entries.find((entry) => {
        const base = entry.replace(/\.(ts|tsx|js|jsx|mjs)$/, '').toLowerCase();
        return base === lowered && entry.replace(/\.(ts|tsx|js|jsx|mjs)$/, '') !== wanted;
      });

      if (nearMiss) {
        findings.push({
          check: 'imports_match_filenames',
          divergence: 'case_sensitive_paths',
          severity: 'blocking',
          message: `This imports "${specifier}", and the file is actually called "${nearMiss}". Your computer does not mind; the server will not find it.`,
          file,
          line,
          fix: `Change the import to match the file exactly, or rename the file.`,
        });
      }
    }
  }

  return findings;
}

/** Addresses that only mean anything on the machine the code was written on. */
export async function checkHardcodedAddresses(root: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  const pattern = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?/i;

  for (const file of await sourceFiles(root)) {
    // A test is meant to talk to localhost, and an example file is meant to be
    // edited. Flagging either is noise, and noise is what gets checks disabled.
    if (/\.(test|spec)\.[tj]sx?$/.test(file) || file.includes('/tests/')) continue;

    const contents = await readFile(path.join(root, file), 'utf8').catch(() => '');
    for (const [index, line] of contents.split('\n').entries()) {
      if (!pattern.test(line)) continue;
      // A default that falls back to an environment variable is correct.
      if (/process\.env|APP_URL|NEXT_PUBLIC/.test(line)) continue;
      findings.push({
        check: 'no_hardcoded_addresses',
        divergence: 'hardcoded_localhost',
        severity: 'warning',
        message: `This has your own computer's address written into it. On the server that address means the server itself.`,
        file,
        line: index + 1,
        fix: 'Use the APP_URL setting, which is different on your machine and on the server.',
      });
    }
  }
  return findings;
}

/** Packages the app needs that the server will not install. */
export async function checkDevOnlyImports(root: string): Promise<Finding[]> {
  const pkg = await readFile(path.join(root, 'package.json'), 'utf8')
    .then((raw) => JSON.parse(raw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> })
    .catch(() => null);
  if (!pkg) return [];

  const runtime = new Set(Object.keys(pkg.dependencies ?? {}));
  const devOnly = Object.keys(pkg.devDependencies ?? {}).filter((name) => !runtime.has(name));
  if (devOnly.length === 0) return [];

  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const file of await sourceFiles(root)) {
    if (/\.(test|spec)\.[tj]sx?$/.test(file) || file.includes('/tests/')) continue;
    if (!file.startsWith('src/') && !file.startsWith('app/')) continue;

    const contents = await readFile(path.join(root, file), 'utf8').catch(() => '');
    for (const name of devOnly) {
      if (seen.has(name)) continue;
      const used = new RegExp(`from\\s+['"]${name.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}(?:/|['"])`).test(contents);
      if (!used) continue;
      seen.add(name);
      findings.push({
        check: 'no_dev_only_imports',
        divergence: 'dev_dependency_used_in_app',
        severity: 'blocking',
        message: `Your app uses "${name}", but it is listed as a development tool. Servers install without those, so this will crash live.`,
        file,
        fix: `Move "${name}" from devDependencies to dependencies in package.json.`,
      });
    }
  }
  return findings;
}

/** Writing files onto the server's own disk, which does not survive a restart. */
export async function checkLocalFileWrites(root: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  const pattern = /\b(writeFile|writeFileSync|createWriteStream|appendFile)\s*\(/;

  for (const file of await sourceFiles(root)) {
    if (/\.(test|spec)\.[tj]sx?$/.test(file) || file.includes('/tests/') || file.includes('/scripts/')) continue;
    const contents = await readFile(path.join(root, file), 'utf8').catch(() => '');
    for (const [index, line] of contents.split('\n').entries()) {
      if (!pattern.test(line)) continue;
      // Writing to a temporary directory is fine — nobody expects that to last.
      if (/tmpdir|os\.tmp|['"]\/tmp/.test(contents)) continue;
      findings.push({
        check: 'no_local_file_writes',
        divergence: 'files_on_disk',
        severity: 'warning',
        message: 'This writes a file onto the machine it is running on. On the server those disappear the next time it restarts.',
        file,
        line: index + 1,
        fix: 'Put anything that has to last in file storage rather than on the server.',
      });
    }
  }
  return findings;
}

/**
 * Which settings the live app will need.
 *
 * Names only. Shipyard reads `.env.example`, which is a template it wrote, and
 * never `.env`, which is the founder's. It therefore cannot tell anybody
 * whether a value is *right* — only that the server will need one.
 */
export async function settingsForDeploy(root: string): Promise<{ names: string[]; finding?: Finding }> {
  const template = await readFile(path.join(root, '.env.example'), 'utf8').catch(() => '');
  const names = [
    ...new Set(
      template
        .split('\n')
        .map((line) => /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line)?.[1])
        .filter((name): name is string => Boolean(name)),
    ),
  ];

  if (names.length === 0) return { names };
  return {
    names,
    finding: {
      check: 'settings_listed_for_deploy',
      divergence: 'env_not_uploaded',
      severity: 'blocking',
      message: `The live app needs ${names.length} setting${names.length === 1 ? '' : 's'}, and none of them travel with the code: ${names.join(', ')}.`,
      fix: 'Copy each one into your host’s own variables before the first deploy. Your .env file stays on this computer — Shipyard never reads it and never uploads it.',
    },
  };
}

/** Is there a migration for the current schema? */
export async function checkMigrations(root: string): Promise<Finding[]> {
  const schema = path.join(root, 'prisma', 'schema.prisma');
  const exists = await stat(schema).catch(() => null);
  if (!exists) return [];

  const migrations = await readdir(path.join(root, 'prisma', 'migrations')).catch(() => [] as string[]);
  const real = migrations.filter((name) => !name.startsWith('.') && name !== 'migration_lock.toml');

  if (real.length === 0) {
    return [
      {
        check: 'migrations_are_current',
        divergence: 'database_is_empty',
        severity: 'blocking',
        message:
          'Your app has a database design but no migrations. The live database will be empty — none of the tables will exist.',
        fix: 'Create a migration before deploying. Shipyard can do this for you.',
      },
    ];
  }
  return [];
}
