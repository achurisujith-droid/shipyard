import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * What gets uploaded when Shipyard hosts somebody's app.
 *
 * This is the most consequential file in the hosting layer, and it is
 * consequential in one direction: **things that must never be uploaded.**
 *
 * Up to now Shipyard has never held anybody's code or credentials. Hosting ends
 * that — the code goes onto a server we run, and everything that goes with it is
 * ours to have lost. So the rule is inverted from a normal build: nothing is
 * included unless it is meant to be, and the things that must never travel are
 * refused rather than filtered.
 *
 * `.env` is the one that matters. It holds the founder's live keys, and it sits
 * in the project root next to everything that should be uploaded. Excluding it
 * by pattern is not enough on its own — a copy called `.env.backup`, or a key
 * pasted into a source file during debugging, reaches our disk just as easily.
 * So the bundle is filtered *and* scanned, and a secret found in the payload
 * stops the upload rather than being stripped from it.
 *
 * Stopping rather than stripping is deliberate. A stripped secret is a broken
 * deploy the founder cannot explain; a refused one is a sentence telling them
 * exactly which file to fix.
 */

/** Never uploaded, whatever else is true. */
export const NEVER_UPLOAD = [
  // Secret material. The whole reason this list exists.
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.env.backup',
  // Anything the user is signed in to.
  '.npmrc',
  '.netrc',
  '.git-credentials',
  '.aws',
  '.ssh',
  // Shipyard's own record of the project, which is not the app.
  '.shipyard',
  // Rebuilt on the server, and enormous.
  'node_modules',
  '.next',
  'dist',
  'build',
  'out',
  'coverage',
  '.turbo',
  // History, which can contain secrets that were committed and later removed.
  '.git',
  // Local databases and dumps.
  '*.sqlite',
  '*.sqlite3',
  '*.db',
  '*.dump',
  '*.sql.gz',
  // Editor and OS noise.
  '.DS_Store',
  'Thumbs.db',
  '.idea',
  '.vscode',
] as const;

/**
 * Templates, which hold variable names and no values.
 *
 * These have to be excepted explicitly. `.env.example` is the file that tells
 * the server which settings it needs, so refusing it would block every deploy —
 * and the pattern for "is this a secret file" catches it otherwise.
 */
const ENV_TEMPLATE = /(^|[/\\])\.env\.(example|sample|template|dist)$/i;

/** Anything matching these is a secret file whatever it is called. */
const SECRET_FILE = /(^|[/\\])\.env(\.|$)|\.pem$|\.p12$|\.pfx$|\.key$|id_rsa|id_ed25519|credentials\.json$|serviceaccount.*\.json$/i;

function isSecretFile(relativePath: string): boolean {
  if (ENV_TEMPLATE.test(relativePath)) return false;
  return SECRET_FILE.test(relativePath);
}

export interface BundleFile {
  /** Path inside the project, POSIX separators. */
  path: string;
  bytes: number;
}

export interface Refusal {
  path: string;
  /** Written for the founder. */
  reason: string;
  /** What they do about it. */
  fix: string;
}

export interface Bundle {
  files: BundleFile[];
  totalBytes: number;
  /** Excluded quietly, because excluding them is normal and expected. */
  excluded: string[];
  /**
   * Found in something that would have been uploaded. Blocks the deploy.
   * Never a list of the values — only where they are.
   */
  refusals: Refusal[];
  ok: boolean;
  summary: string;
}

export const MAX_BUNDLE_BYTES = 100 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

function matches(name: string, pattern: string): boolean {
  if (pattern.startsWith('*')) return name.endsWith(pattern.slice(1));
  return name === pattern;
}

export function isExcluded(relativePath: string): boolean {
  const segments = relativePath.split('/');
  return segments.some((segment) => NEVER_UPLOAD.some((pattern) => matches(segment, pattern)));
}

/**
 * Secrets hardcoded into a file that is about to be uploaded.
 *
 * Deliberately narrower than a general secret scanner. Its job is not to find
 * every possible credential — it is to catch the specific, common case of a key
 * pasted into source while debugging and never taken out again, before that key
 * lands on infrastructure somebody else runs.
 */
const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'a Stripe secret key', pattern: /\bsk_live_[A-Za-z0-9]{16,}/ },
  { name: 'a Stripe restricted key', pattern: /\brk_live_[A-Za-z0-9]{16,}/ },
  { name: 'an AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'a Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'a private key file', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'a database connection string with a password in it', pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:@/]+:[^\s@/]{3,}@/ },
  { name: 'a GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/ },
  { name: 'a Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'a SendGrid key', pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/ },
];

/** What is in this text that must not reach our servers? */
export function findSecrets(contents: string): string[] {
  return SECRET_PATTERNS.filter((entry) => entry.pattern.test(contents)).map((entry) => entry.name);
}

const SCANNABLE = /\.(ts|tsx|js|jsx|mjs|cjs|json|yml|yaml|toml|env|txt|md|sh|prisma)$/i;

/**
 * Work out what would be uploaded, and refuse if it should not be.
 *
 * Nothing is sent anywhere by this function. It reads the project and returns a
 * verdict, so the founder sees exactly what is about to leave their computer
 * before any of it does.
 */
export async function planBundle(projectPath: string): Promise<Bundle> {
  const files: BundleFile[] = [];
  const excluded: string[] = [];
  const refusals: Refusal[] = [];
  let totalBytes = 0;

  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(path.join(projectPath, directory), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const relative = directory ? `${directory}/${entry.name}` : entry.name;

      if (isExcluded(relative)) {
        excluded.push(relative);
        continue;
      }

      if (entry.isDirectory()) {
        await walk(relative);
        continue;
      }

      // A secret file that is not on the exclusion list by name. Refused rather
      // than skipped: its presence means somebody put a credential somewhere
      // unexpected, and they should know.
      if (isSecretFile(relative)) {
        refusals.push({
          path: relative,
          reason: 'This looks like a file holding a password, key or certificate.',
          fix: 'Move it out of the project folder. Settings belong in your host’s own variables, not in the code.',
        });
        continue;
      }

      const info = await stat(path.join(projectPath, relative)).catch(() => null);
      if (!info?.isFile()) continue;

      if (info.size > MAX_FILE_BYTES) {
        refusals.push({
          path: relative,
          reason: `This file is ${Math.round(info.size / 1024 / 1024)} MB, and single files are limited to ${MAX_FILE_BYTES / 1024 / 1024} MB.`,
          fix: 'Large files belong in file storage rather than in the code.',
        });
        continue;
      }

      if (SCANNABLE.test(relative) && info.size < 2 * 1024 * 1024) {
        const contents = await readFile(path.join(projectPath, relative), 'utf8').catch(() => '');
        for (const found of findSecrets(contents)) {
          refusals.push({
            path: relative,
            reason: `This contains what looks like ${found}.`,
            // Never quotes the value back. A refusal message ends up in logs and
            // screenshots, and repeating a live key there would be the same
            // mistake in a different place.
            fix: 'Take it out of the file and put it in your settings instead. Then change the key with the provider — anything written into a file should be treated as no longer secret.',
          });
        }
      }

      files.push({ path: relative, bytes: info.size });
      totalBytes += info.size;
    }
  };

  await walk('');

  if (totalBytes > MAX_BUNDLE_BYTES) {
    refusals.push({
      path: '.',
      reason: `Your project is ${Math.round(totalBytes / 1024 / 1024)} MB, and the limit is ${MAX_BUNDLE_BYTES / 1024 / 1024} MB.`,
      fix: 'Something large is probably being kept in the project that belongs in file storage.',
    });
  }

  const ok = refusals.length === 0 && files.length > 0;
  return {
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    totalBytes,
    excluded: excluded.sort(),
    refusals,
    ok,
    summary: describe(files.length, totalBytes, refusals, excluded.length),
  };
}

function describe(count: number, bytes: number, refusals: readonly Refusal[], excluded: number): string {
  if (count === 0) return 'There is nothing here to deploy yet.';
  if (refusals.length > 0) {
    const secrets = refusals.filter((refusal) => /password|key|certificate|looks like/.test(refusal.reason)).length;
    return secrets > 0
      ? `Not uploading anything yet: ${secrets} file${secrets === 1 ? ' appears' : 's appear'} to contain a password or key. Those must not go onto our servers.`
      : `Not uploading anything yet — see the ${refusals.length} problem${refusals.length === 1 ? '' : 's'} below.`;
  }
  return `${count.toLocaleString()} files, ${(bytes / 1024 / 1024).toFixed(1)} MB. ${excluded} kept back, including your .env — your settings never leave this computer.`;
}
