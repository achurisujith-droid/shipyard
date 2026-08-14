/**
 * Tests for project detection and the static preview server.
 *
 * Runs without Electron: neither module touches the app object, which is
 * deliberate so this logic stays testable.
 *
 *   npx tsx scripts/test-runner.mts
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { PostgresManager } from '../main/postgres';
import { candidateUrl, ProjectRunner, selfReloading } from '../main/project-runner';
import { detectNeeds } from '../main/stack';
import { startStaticServer } from '../main/static-server';
import { Toolchain } from '../main/toolchain';

const root = path.join(os.tmpdir(), `shipyard-runner-test-${process.pid}`);
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  // These cases only exercise detection and URL parsing, so nothing here ever
  // starts a runtime; the toolchain and database are stubs.
  const toolchain = new Toolchain({ root: path.join(root, 'toolchain'), cacheDir: root });
  const postgres = {} as PostgresManager;

  // Stands in for the SQLite-backed Store, so remembering a script choice can
  // be asserted without an Electron app directory.
  const settings = new Map<string, string>();
  const store = {
    getSetting: (key: string) => settings.get(key),
    setSetting: (key: string, value: string) => void settings.set(key, value),
  };

  const runner = new ProjectRunner(
    () => {
      /* events ignored for these tests */
    },
    toolchain,
    postgres,
    store,
  );

  // --- empty project ------------------------------------------------------
  const empty = path.join(root, 'empty');
  await mkdir(empty, { recursive: true });
  const emptyInfo = await runner.inspect(empty);
  check('empty folder cannot run', emptyInfo.canRun === false, JSON.stringify(emptyInfo));
  check(
    'empty folder explains itself in plain language',
    /nothing to run yet/i.test(emptyInfo.reason ?? ''),
    emptyInfo.reason,
  );

  // --- static site (what "plain HTML/CSS/JS" produces) --------------------
  const staticDir = path.join(root, 'static');
  await mkdir(staticDir, { recursive: true });
  await writeFile(
    path.join(staticDir, 'index.html'),
    '<!doctype html><title>Phone cases</title><h1>Cases</h1>',
    'utf8',
  );
  const staticInfo = await runner.inspect(staticDir);
  check('static site is runnable', staticInfo.canRun === true, JSON.stringify(staticInfo));

  const server = await startStaticServer(staticDir);
  try {
    const res = await fetch(`${server.url}/`);
    const body = await res.text();
    check('static server serves index.html', res.status === 200 && body.includes('Cases'));

    const missing = await fetch(`${server.url}/nope.html`);
    check('static server 404s missing files', missing.status === 404);

    // The server must never reach outside the project directory.
    const escaped = await fetch(`${server.url}/../../../../Windows/win.ini`);
    check(
      'static server blocks path traversal',
      escaped.status === 403 || escaped.status === 404,
      `got ${escaped.status}`,
    );

    check('static server binds to localhost only', server.url.includes('localhost'));
  } finally {
    server.close();
  }

  // --- node project, dependencies not installed ---------------------------
  const nodeDir = path.join(root, 'node-app');
  await mkdir(nodeDir, { recursive: true });
  await writeFile(
    path.join(nodeDir, 'package.json'),
    JSON.stringify({ name: 'x', scripts: { dev: 'vite' } }),
    'utf8',
  );
  const needsInstall = await runner.inspect(nodeDir);
  check('node project is runnable', needsInstall.canRun === true);
  check('node project reports needing install', needsInstall.needsInstall === true);
  check('node project uses its dev script', needsInstall.command === 'npm run dev');

  // --- node project with dependencies present -----------------------------
  await mkdir(path.join(nodeDir, 'node_modules'), { recursive: true });
  const installed = await runner.inspect(nodeDir);
  check('installed project does not ask to install', installed.needsInstall === false);

  // --- package.json with no usable script, but an index.html --------------
  const hybrid = path.join(root, 'hybrid');
  await mkdir(hybrid, { recursive: true });
  await writeFile(path.join(hybrid, 'package.json'), JSON.stringify({ name: 'y' }), 'utf8');
  await writeFile(path.join(hybrid, 'index.html'), '<h1>hi</h1>', 'utf8');
  const hybridInfo = await runner.inspect(hybrid);
  check('falls back to previewing index.html', hybridInfo.canRun === true, JSON.stringify(hybridInfo));

  // --- more than one way to start the project -----------------------------
  // "First of dev/start/serve wins" is a guess, and for a project where `start`
  // runs the real server and `dev` only rebuilds assets it is the wrong one.
  const multi = path.join(root, 'multi-script');
  await mkdir(path.join(multi, 'node_modules'), { recursive: true });
  await writeFile(
    path.join(multi, 'package.json'),
    json({ scripts: { dev: 'vite build --watch', start: 'node server.js', lint: 'eslint .' } }),
    'utf8',
  );

  const multiInfo = await runner.inspect(multi);
  check(
    'both start scripts are offered',
    multiInfo.scripts?.map((s) => s.name).join(',') === 'dev,start',
    JSON.stringify(multiInfo.scripts),
  );
  check(
    'scripts that cannot start an app are not offered',
    multiInfo.scripts?.some((s) => s.name === 'lint') === false,
  );
  check(
    'each choice carries the command that explains it',
    multiInfo.scripts?.find((s) => s.name === 'start')?.command === 'node server.js',
  );
  check('dev is picked by default', multiInfo.script === 'dev', JSON.stringify(multiInfo.script));

  // The user says "no, it's start" once and it has to stick — otherwise every
  // run needs the same correction.
  settings.set(`runner.script:${path.resolve(multi).toLowerCase()}`, 'start');
  const remembered = await runner.inspect(multi);
  check('a remembered choice wins over our ordering', remembered.script === 'start');
  check('the command follows the remembered choice', remembered.command === 'npm run start');

  // Projects get rewritten. A remembered name that no longer exists must not
  // strand the Run button on a script npm would refuse.
  await writeFile(
    path.join(multi, 'package.json'),
    json({ scripts: { dev: 'vite build --watch' } }),
    'utf8',
  );
  const orphaned = await runner.inspect(multi);
  check('a remembered choice that no longer exists falls back', orphaned.script === 'dev');
  settings.clear();

  // --- does this script restart itself? -----------------------------------
  // Wrong in one direction: the user edits a file and nothing happens. Wrong in
  // the other: two watchers fight and the app restarts twice per edit.
  const reloadCases: Array<[string, boolean]> = [
    ['vite', true],
    ['next dev', true],
    ['nuxt dev', true],
    ['astro dev', true],
    ['nodemon server.js', true],
    ['react-scripts start', true],
    ['ng serve', true],
    ['vue-cli-service serve', true],
    ['webpack serve --mode development', true],
    ['webpack-dev-server', true],
    ['tsx watch src/index.ts', true],
    ['node --watch server.js', true],
    ['nest start --watch', true],
    ['vite build --watch', true],
    // The ones that need our help: a plain process that reads its files once.
    ['node server.js', false],
    ['node dist/index.js', false],
    ['tsx src/index.ts', false],
    ['npm run build && node server.js', false],
    ['python -m http.server', false],
    // Must not fire on a name that merely contains a watching tool's name.
    ['node next-steps.js', false],
    ['node vite-config-check.js', false],
  ];
  for (const [command, expected] of reloadCases) {
    check(
      `${expected ? 'self-reloading' : 'needs a restart'}: ${command}`,
      selfReloading(command) === expected,
    );
  }

  // --- finding the app's address in dev-server output ---------------------
  // Frameworks print a URL; hand-written servers print only a port. Missing the
  // second kind means the app starts fine and the preview never appears.
  const urlCases: [string, string | null][] = [
    ['  ➜  Local:   http://localhost:5173/', 'http://localhost:5173'],
    ['- Local:        http://localhost:3000', 'http://localhost:3000'],
    ['Server listening on port 3001', 'http://localhost:3001'],
    ['App running on port 8080', 'http://localhost:8080'],
    ['Server started on port: 4000', 'http://localhost:4000'],
    ['ready - started server on 0.0.0.0:3000, url: http://localhost:3000', 'http://localhost:3000'],
    // Must not fire on unrelated prose that happens to contain a number.
    ['Compiled 42 modules in 300ms', null],
    ['warning: 3 vulnerabilities found', null],
    ['import the port module', null],
  ];
  for (const [line, expected] of urlCases) {
    const got = candidateUrl(line);
    check(`url from: "${line.trim().slice(0, 46)}"`, got === expected, `got ${got ?? 'null'}`);
  }

  // --- does this project need a database? ---------------------------------
  // Getting this wrong is expensive in both directions: a false positive adds
  // seconds and 40 MB to a project that stores nothing, and a false negative
  // starts an app that fails every request it serves.
  const stackCases: Array<[string, Record<string, string>, boolean]> = [
    ['plain frontend', { 'package.json': json({ dependencies: { react: '^18' } }) }, false],
    [
      'json file storage',
      { 'package.json': json({ dependencies: { express: '^4', lowdb: '^7' } }) },
      false,
    ],
    ['sqlite', { 'package.json': json({ dependencies: { 'better-sqlite3': '^13' } }) }, false],
    ['node-postgres', { 'package.json': json({ dependencies: { pg: '^8' } }) }, true],
    [
      'prisma',
      { 'package.json': json({ dependencies: { '@prisma/client': '^6' } }) },
      true,
    ],
    ['drizzle', { 'package.json': json({ dependencies: { 'drizzle-orm': '^0.38' } }) }, true],
    // Configured for Postgres before any driver has been installed, which is
    // exactly where a half-written project sits.
    [
      'env file only',
      { 'package.json': json({}), '.env': 'DATABASE_URL=postgresql://localhost:5432/app\n' },
      true,
    ],
    // "postgres" appearing in prose must not be enough.
    [
      'readme mentions postgres',
      { 'package.json': json({ description: 'later we will add postgres' }) },
      false,
    ],
  ];

  for (const [name, files, expected] of stackCases) {
    const dir = path.join(root, `stack-${name.replace(/\W+/g, '-')}`);
    await mkdir(dir, { recursive: true });
    for (const [file, contents] of Object.entries(files)) {
      await writeFile(path.join(dir, file), contents, 'utf8');
    }
    const needs = await detectNeeds(dir);
    check(
      `${name}: ${expected ? 'needs' : 'does not need'} a database`,
      needs.database === expected,
      JSON.stringify(needs),
    );
  }

  // Prisma has to be told to create the tables; nothing else is touched.
  const prismaDir = path.join(root, 'stack-prisma');
  const prismaNeeds = await detectNeeds(prismaDir);
  check(
    'prisma projects generate the client before touching the database',
    prismaNeeds.prepare?.[0] === 'npx prisma generate',
    JSON.stringify(prismaNeeds.prepare),
  );
  check(
    'prisma projects then create their tables',
    prismaNeeds.prepare?.[1]?.includes('db push') === true,
    JSON.stringify(prismaNeeds.prepare),
  );
  const pgDir = path.join(root, 'stack-node-postgres');
  check(
    'plain pg projects are left to manage their own schema',
    (await detectNeeds(pgDir)).prepare === undefined,
  );

  await rm(root, { recursive: true, force: true }).catch(() => undefined);
  console.log(`\n${failed === 0 ? 'All runner cases pass.' : `${failed} case(s) failed.`}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

/** Minimal package.json for a detection fixture. */
function json(pkg: Record<string, unknown>): string {
  return JSON.stringify({ name: 'fixture', private: true, ...pkg }, null, 2);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
