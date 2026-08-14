/**
 * The claim this test exists to check:
 *
 *   Someone downloads one file, runs it, describes an app, and sees it working
 *   — having installed no Node, no Postgres, and no Docker.
 *
 * So it scaffolds a real React + Express + Prisma + Postgres project and runs it
 * through Shipyard's own toolchain with the machine's Node and Postgres stripped
 * out of PATH. Anything it manages to do, it did with what we ship.
 *
 *   npx tsx scripts/test-stack.mts
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgresManager } from '../main/postgres.js';
import { detectNeeds } from '../main/stack.js';
import { Toolchain, toolchainRoot } from '../main/toolchain.js';

const exec = promisify(execFile);
const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(os.tmpdir(), `shipyard-stack-${process.pid}`);
const projectDir = path.join(root, 'phone-cases');

let failed = 0;
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(ok ? `PASS  ${name}` : `FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  if (!ok) failed += 1;
  return ok;
};

/**
 * A PATH with every trace of Node, npm and Postgres removed.
 *
 * This is the whole point of the test. If it passes with this environment, it
 * passes on a machine that has never had a developer tool installed.
 */
function bareMachineEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env['ELECTRON_RUN_AS_NODE'];
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = (env[pathKey] ?? '')
    .split(path.delimiter)
    .filter((segment) => !/nodejs|node-versions|fnm|npm|nvm|postgres|pgsql/i.test(segment))
    .join(path.delimiter);
  return env;
}

/** The kind of project Claude produces when asked for a store with a database. */
async function scaffold(): Promise<void> {
  await mkdir(path.join(projectDir, 'prisma'), { recursive: true });
  await mkdir(path.join(projectDir, 'public'), { recursive: true });

  await writeFile(
    path.join(projectDir, 'package.json'),
    JSON.stringify(
      {
        name: 'phone-cases',
        private: true,
        type: 'module',
        scripts: { dev: 'node server.js' },
        dependencies: { '@prisma/client': '^6.1.0', express: '^4.21.2' },
        devDependencies: { prisma: '^6.1.0' },
      },
      null,
      2,
    ),
    'utf8',
  );

  await writeFile(
    path.join(projectDir, 'prisma', 'schema.prisma'),
    `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model PhoneCase {
  id    Int    @id @default(autoincrement())
  name  String
  price Float
}
`,
    'utf8',
  );

  // Express serving an API and a page, which is the shape of the "full stack"
  // apps users ask for.
  await writeFile(
    path.join(projectDir, 'server.js'),
    `import express from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const app = express();

if ((await prisma.phoneCase.count()) === 0) {
  await prisma.phoneCase.createMany({
    data: [
      { name: 'Clear Silicone', price: 14.99 },
      { name: 'Leather Folio', price: 39.5 },
    ],
  });
}

app.get('/api/cases', async (_req, res) => {
  res.json(await prisma.phoneCase.findMany({ orderBy: { id: 'asc' } }));
});

app.get('/', async (_req, res) => {
  const cases = await prisma.phoneCase.findMany({ orderBy: { id: 'asc' } });
  res.send(
    '<!doctype html><title>Phone Cases</title><ul>' +
      cases.map((c) => \`<li>\${c.name} - $\${c.price}</li>\`).join('') +
      '</ul>',
  );
});

const port = process.env.PORT ?? 3210;
app.listen(port, () => console.log(\`Server listening on port \${port}\`));
`,
    'utf8',
  );
}

async function main(): Promise<void> {
  const toolchain = new Toolchain({
    root: toolchainRoot(DESKTOP),
    cacheDir: path.join(root, 'npm-cache'),
  });

  const status = await toolchain.status();
  if (
    !check('the bundled toolchain is present', status.ready, status.reason ?? '') // fetch it first
  ) {
    return;
  }
  console.log(`        Node ${status.nodeVersion}, PostgreSQL ${status.postgresVersion}\n`);

  const env = bareMachineEnv();

  // Sanity: confirm the stripped PATH really has nothing on it, or every other
  // result in this file is meaningless.
  const bare = await exec(process.platform === 'win32' ? 'where' : 'which', ['node'], {
    env,
    shell: false,
  }).then(
    () => true,
    () => false,
  );
  check('the test machine looks like a user machine (no Node on PATH)', !bare);

  const decorated = toolchain.decorateEnv(env);
  const nodeVersion = await exec(toolchain.nodeExe, ['--version'], { env: decorated });
  check(
    'the bundled Node runs',
    nodeVersion.stdout.trim().startsWith('v'),
    nodeVersion.stdout.trim(),
  );

  // The reason we ship real Node instead of Electron-as-Node: the module ABI
  // has to be Node's, or native dependencies compile for a runtime that only
  // exists on the user's laptop and the project breaks the moment it deploys.
  const abi = await exec(
    toolchain.nodeExe,
    ['-p', 'JSON.stringify({modules: process.versions.modules, electron: process.versions.electron ?? null})'],
    { env: decorated },
  );
  const versions = JSON.parse(abi.stdout.trim()) as { modules: string; electron: string | null };
  check(
    'it is real Node, not Electron in disguise (native modules would target the wrong runtime)',
    versions.electron === null,
    `electron=${versions.electron} modules=${versions.modules}`,
  );

  await scaffold();

  const needs = await detectNeeds(projectDir);
  check('recognised that this project needs Postgres', needs.database, JSON.stringify(needs));
  check(
    'chose the commands that create the tables',
    (needs.prepare?.length ?? 0) >= 2,
    (needs.prepare ?? []).join(' && '),
  );

  console.log('\n  installing dependencies with the bundled npm (this takes a minute)...\n');
  const npm = path.join(toolchain.nodeBinDir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const install = await exec(npm, ['install', '--no-audit', '--no-fund'], {
    cwd: projectDir,
    env: decorated,
    shell: process.platform === 'win32',
    maxBuffer: 32 * 1024 * 1024,
  }).then(
    () => ({ ok: true, out: '' }),
    (e: Error & { stdout?: string; stderr?: string }) => ({
      ok: false,
      out: (e.stderr || e.stdout || e.message).slice(-800),
    }),
  );
  if (!check('npm install succeeded with no system Node', install.ok, install.out)) return;

  const postgres = new PostgresManager(toolchain, path.join(root, 'databases'));
  let handle;
  try {
    const started = Date.now();
    handle = await postgres.ensure(projectDir, (m) => console.log(`        ${m}`));
    check('Postgres started with no installer and no admin rights', true);
    console.log(`        took ${Date.now() - started}ms, port ${handle.port}`);
  } catch (err) {
    check('Postgres started with no installer and no admin rights', false, String(err));
    return;
  }

  try {
    const withDb = toolchain.decorateEnv(env, { DATABASE_URL: handle.url });

    for (const command of needs.prepare ?? []) {
      const step = await exec(npm, ['exec', '--', ...command.split(' ').slice(1)], {
        cwd: projectDir,
        env: withDb,
        shell: process.platform === 'win32',
        maxBuffer: 16 * 1024 * 1024,
      }).then(
        () => ({ ok: true, out: '' }),
        (e: Error & { stdout?: string; stderr?: string }) => ({
          ok: false,
          out: (e.stderr || e.stdout || e.message).slice(-800),
        }),
      );
      if (!check(`ran: ${command}`, step.ok, step.out)) return;
    }

    // Run the app the way the runner does, and fetch what a user would see.
    const port = 3210;
    const server = execFile(
      process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      process.platform === 'win32' ? ['/d', '/s', '/c', 'npm run dev'] : ['-lc', 'npm run dev'],
      { cwd: projectDir, env: { ...withDb, PORT: String(port) } },
    );
    let output = '';
    server.stdout?.on('data', (d: Buffer) => (output += d));
    server.stderr?.on('data', (d: Buffer) => (output += d));

    try {
      const page = await waitForBody(`http://127.0.0.1:${port}/`, 45_000);
      check(
        'the app serves data that came out of Postgres',
        page.includes('Clear Silicone') && page.includes('39.5'),
        page.slice(0, 300) || output.slice(-600),
      );

      const api = await fetch(`http://127.0.0.1:${port}/api/cases`).then((r) => r.json());
      check(
        'its API returns the seeded rows',
        Array.isArray(api) && api.length === 2,
        JSON.stringify(api).slice(0, 300),
      );
    } catch (err) {
      check('the app serves data that came out of Postgres', false, `${err}\n${output.slice(-800)}`);
    } finally {
      server.kill();
    }
  } finally {
    await postgres.stopAll();
    check('the database stopped cleanly on shutdown', true);
  }
}

/** Poll until the dev server answers, the way ProjectRunner.confirmUrl does. */
async function waitForBody(url: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = 'never responded';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.text();
      last = `HTTP ${response.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url}: ${last}`);
}

main()
  .catch((err: unknown) => {
    console.error('THREW:', err instanceof Error ? err.stack : err);
    failed += 1;
  })
  .finally(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    console.log(
      failed === 0
        ? '\nA React + Node + Postgres app runs on a machine with none of them installed.'
        : `\n${failed} case(s) failed.`,
    );
    process.exitCode = failed > 0 ? 1 : 0;
  });
