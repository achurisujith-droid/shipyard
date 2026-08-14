/**
 * Fetch the runtimes Shipyard ships to its users.
 *
 * A Shipyard user is not a developer. They will not install Node, they will not
 * install Postgres, and they cannot be walked through either. So the app carries
 * both, and this script puts them in place before packaging.
 *
 * Run at BUILD time, never at run time. The packaged app does no downloading:
 * first launch on a corporate laptop with a proxy and an antivirus must not be
 * where our install story fails.
 *
 *   node scripts/fetch-toolchain.mjs                 # this machine's platform
 *   node scripts/fetch-toolchain.mjs --platform darwin --arch arm64
 *   node scripts/fetch-toolchain.mjs --force         # re-fetch even if present
 *
 * Output: resources/toolchain/<platform>-<arch>/{node,postgres,toolchain.json}
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');

/**
 * Pinned deliberately. The whole point of shipping a runtime is that every user
 * gets the same one, so "latest" would defeat it.
 *
 * Node 24 is the active LTS line. It must be a REAL Node build, not Electron
 * running as Node: under ELECTRON_RUN_AS_NODE the module ABI is Electron's
 * (148), so any native dependency a user's project installs would be compiled
 * for Electron and then fail the moment that project is deployed to a server.
 */
const NODE_VERSION = '24.19.0';

/**
 * PostgreSQL binaries, taken from the npm packages published by the
 * embedded-postgres project. We take only the `native/` payload — real
 * PostgreSQL binaries — and not the JavaScript wrapper, which has never had a
 * stable release. Lifecycle is ours: see main/postgres.ts.
 */
const POSTGRES_PACKAGE_VERSION = '18.4.0-beta.17';
const POSTGRES_VERSION = '18.4';

/** Node's own naming for platform/arch, which differs from process.platform. */
const NODE_PLATFORM = { win32: 'win', darwin: 'darwin', linux: 'linux' };

/** @embedded-postgres publishes one package per target. */
const PG_TARGETS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm',
  'linux-arm64',
  'linux-ia32',
  'linux-x64',
  'linux-ppc64',
  'windows-x64',
]);

/**
 * Weight we refuse to ship, having confirmed the server runs without it.
 *  - wx*: wxWidgets, linked by pgAdmin's UI. The database never loads it. ~15 MB
 *  - share/locale: translated server messages. English is the source language
 *    and is not in here at all. ~24 MB
 *  - lib/*.lib, include/: for compiling C programs against libpq. ~3 MB
 * Together about 40% of the download.
 */
const PRUNE_DIRS = ['share/locale', 'include', 'share/doc', 'share/man'];
const PRUNE_FILE_RE = /^wx(base|msw)|\.lib$|^pgadmin/i;

/**
 * Executables the server lifecycle actually calls.
 *
 * Upstream ships only these three — no `psql`, no `pg_dump`, no `pg_isready`.
 * That is why main/postgres.ts uses the database `initdb` creates instead of
 * making its own, and why readiness comes from `pg_ctl start -w` rather than a
 * probe. Listing tools that are not in the package would silently do nothing,
 * so the list stays honest about what exists.
 */
const KEEP_EXECUTABLES = new Set([
  'initdb', // create the cluster
  'postgres', // the server
  'pg_ctl', // start / stop / status, and waits for readiness
]);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const platform = args.platform ?? process.platform;
  const arch = args.arch ?? process.arch;
  const target = `${platform}-${arch}`;
  const outDir = path.join(DESKTOP, 'resources', 'toolchain', target);
  const manifestPath = path.join(outDir, 'toolchain.json');

  if (!args.force && (await isCurrent(manifestPath))) {
    const size = await dirSize(outDir);
    console.log(`Toolchain for ${target} is already current (${mb(size)}). Use --force to refetch.`);
    return;
  }

  console.log(`Fetching toolchain for ${target}`);
  console.log(`  Node       ${NODE_VERSION}`);
  console.log(`  PostgreSQL ${POSTGRES_VERSION}\n`);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const work = await mkdtemp(path.join(os.tmpdir(), 'shipyard-toolchain-'));
  try {
    const node = await fetchNode(platform, arch, work, path.join(outDir, 'node'));
    const postgres = await fetchPostgres(platform, arch, work, path.join(outDir, 'postgres'));

    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          nodeVersion: NODE_VERSION,
          postgresVersion: POSTGRES_VERSION,
          postgresPackageVersion: POSTGRES_PACKAGE_VERSION,
          platform,
          arch,
          // Size is recorded so a truncated or half-pruned fetch is visible in
          // review rather than at a user's first launch.
          bytes: { node: node.bytes, postgres: postgres.bytes },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const total = node.bytes + postgres.bytes;
    console.log(`\n  node      ${mb(node.bytes).padStart(9)}`);
    console.log(`  postgres  ${mb(postgres.bytes).padStart(9)}`);
    console.log(`  total     ${mb(total).padStart(9)}`);
    console.log(`\nWrote ${path.relative(DESKTOP, outDir)}`);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/* ------------------------------------------------------------------ Node -- */

/**
 * Official builds from nodejs.org, verified against the release's own
 * SHASUMS256.txt. An unverified runtime is arbitrary code execution on every
 * user's machine, so the digest check is not optional and not skippable.
 */
async function fetchNode(platform, arch, work, dest) {
  const plat = NODE_PLATFORM[platform];
  if (!plat) throw new Error(`No Node build mapping for platform "${platform}"`);

  const isWindows = platform === 'win32';
  const name = `node-v${NODE_VERSION}-${plat}-${arch}`;
  const archive = `${name}.${isWindows ? 'zip' : 'tar.gz'}`;
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;

  console.log(`  downloading ${archive}`);
  const bytes = await download(`${base}/${archive}`);

  const sums = await downloadText(`${base}/SHASUMS256.txt`);
  const expected = sums
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1] === archive)?.[0];
  if (!expected) throw new Error(`${archive} is not listed in SHASUMS256.txt`);

  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${archive}\n  expected ${expected}\n  actual   ${actual}`);
  }
  console.log(`  sha256 verified`);

  const archivePath = path.join(work, archive);
  await writeFile(archivePath, bytes);
  await extract(archivePath, work);

  // Both archive shapes contain a single top-level directory.
  const extracted = path.join(work, name);
  await mkdir(path.dirname(dest), { recursive: true });
  await cp(extracted, dest, { recursive: true });

  // Headers ship for compiling native addons from source. node-gyp downloads
  // them on demand when it genuinely needs them, so carrying them is dead
  // weight in the installer.
  for (const junk of ['include', 'share/doc', 'share/man', 'CHANGELOG.md', 'README.md']) {
    await rm(path.join(dest, junk), { recursive: true, force: true });
  }

  return { bytes: await dirSize(dest) };
}

/* -------------------------------------------------------------- Postgres -- */

/**
 * Straight from the registry, checked against the `dist.integrity` digest the
 * registry publishes for that exact version. Same guarantee `npm install`
 * gives, without shelling out to npm.
 */
async function fetchPostgres(platform, arch, work, dest) {
  const target = platform === 'win32' ? `windows-${arch}` : `${platform}-${arch}`;
  if (!PG_TARGETS.has(target)) {
    throw new Error(
      `No PostgreSQL binaries published for "${target}". Available: ${[...PG_TARGETS].join(', ')}`,
    );
  }

  const name = `@embedded-postgres/${target}`;
  console.log(`  downloading ${name}@${POSTGRES_PACKAGE_VERSION}`);

  const meta = JSON.parse(
    await downloadText(
      `https://registry.npmjs.org/${name.replace('/', '%2f')}/${POSTGRES_PACKAGE_VERSION}`,
    ),
  );
  const tarballUrl = meta?.dist?.tarball;
  const integrity = meta?.dist?.integrity;
  if (typeof tarballUrl !== 'string' || typeof integrity !== 'string') {
    throw new Error(`Registry metadata for ${name} is missing dist.tarball or dist.integrity`);
  }

  const bytes = await download(tarballUrl);
  verifyIntegrity(bytes, integrity, name);
  console.log(`  ${integrity.split('-')[0]} verified`);

  const tarball = `${target}.tgz`;
  await writeFile(path.join(work, tarball), bytes);
  await extract(path.join(work, tarball), work);

  // npm tarballs always unpack into `package/`.
  const native = path.join(work, 'package', 'native');
  if (!(await exists(native))) throw new Error(`${spec} has no native/ payload`);

  await mkdir(path.dirname(dest), { recursive: true });
  await cp(native, dest, { recursive: true });

  const before = await dirSize(dest);
  await prunePostgres(dest, platform);
  const after = await dirSize(dest);
  console.log(`  pruned ${mb(before - after)} of client tooling and translations`);

  return { bytes: after };
}

/** Drop everything the server does not need to start, run, and be backed up. */
async function prunePostgres(root, platform) {
  for (const dir of PRUNE_DIRS) {
    await rm(path.join(root, ...dir.split('/')), { recursive: true, force: true });
  }

  const binDir = path.join(root, 'bin');
  const exeSuffix = platform === 'win32' ? '.exe' : '';
  for (const entry of await readdir(binDir, { withFileTypes: true })) {
    const name = entry.name;
    if (PRUNE_FILE_RE.test(name)) {
      await rm(path.join(binDir, name), { recursive: true, force: true });
      continue;
    }
    // Shared libraries stay: the executables we keep are linked against them.
    const isExecutable = exeSuffix ? name.endsWith(exeSuffix) : !name.includes('.');
    if (!isExecutable) continue;
    const stem = exeSuffix ? name.slice(0, -exeSuffix.length) : name;
    if (!KEEP_EXECUTABLES.has(stem)) {
      await rm(path.join(binDir, name), { force: true });
    }
  }

  // `lib` holds both runtime shared objects and link-time import libraries.
  const libDir = path.join(root, 'lib');
  if (await exists(libDir)) {
    for (const entry of await readdir(libDir, { withFileTypes: true })) {
      if (entry.isFile() && /\.(lib|a)$/i.test(entry.name)) {
        await rm(path.join(libDir, entry.name), { force: true });
      }
    }
  }
}

/* ----------------------------------------------------------------- util -- */

async function isCurrent(manifestPath) {
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    return (
      manifest.nodeVersion === NODE_VERSION &&
      manifest.postgresPackageVersion === POSTGRES_PACKAGE_VERSION
    );
  } catch {
    return false;
  }
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

async function downloadText(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  return await response.text();
}

/** `sha512-<base64>`, the format npm records in `dist.integrity`. */
function verifyIntegrity(bytes, integrity, label) {
  const [algorithm, expected] = integrity.split('-');
  if (!algorithm || !expected) throw new Error(`Malformed integrity string for ${label}`);
  const actual = createHash(algorithm).update(bytes).digest('base64');
  if (actual !== expected) {
    throw new Error(`Integrity mismatch for ${label}\n  expected ${expected}\n  actual   ${actual}`);
  }
}

/**
 * Windows ships bsdtar at a known absolute path, and it reads .zip as well as
 * .tar.gz. Resolving it explicitly matters twice over: the `tar` on PATH inside
 * Git Bash is GNU tar, which cannot open a zip at all and reads `C:\...` as a
 * remote host, and spawning by absolute path is the rule this project follows
 * everywhere else.
 *
 * The archive is passed as a bare filename with cwd set to its directory, so no
 * drive letter ever reaches the argument list.
 */
async function extract(archivePath, into) {
  const tar =
    process.platform === 'win32'
      ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : '/usr/bin/tar';

  await run(tar, ['-xf', path.basename(archivePath), '-C', into], {
    cwd: path.dirname(archivePath),
  });
}

function run(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    // No shell: every command here is an absolute path to a real executable.
    const child = spawn(command, args, { ...opts, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}\n${stderr || stdout}`));
    });
  });
}

async function dirSize(dir) {
  let total = 0;
  const walk = async (d) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) total += (await stat(full).catch(() => ({ size: 0 }))).size;
    }
  };
  await walk(dir);
  return total;
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

function parseArgs(argv) {
  const args = { force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--force') args.force = true;
    else if (flag === '--platform') args.platform = argv[(i += 1)];
    else if (flag === '--arch') args.arch = argv[(i += 1)];
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}

main().catch((err) => {
  console.error(`\nfetch-toolchain failed: ${err.message}`);
  process.exitCode = 1;
});
