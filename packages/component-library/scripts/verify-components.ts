/**
 * Earn the trust levels, or lower them.
 *
 * `verified` is supposed to mean the contract tests were run against a real
 * install and passed. This is the script that makes that claim true rather than
 * a label somebody typed into a manifest: it builds a project from the starter
 * template, installs every component into it, installs the dependencies, and
 * runs the tests.
 *
 * It takes several minutes and needs a network connection, which is exactly why
 * it is a separate script rather than part of the unit suite — and exactly why
 * running it is the only thing that should let a component be called verified.
 *
 *   npx tsx scripts/verify-components.mts
 *   npx tsx scripts/verify-components.mts --keep     (leave the project behind)
 */
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { install, loadLibrary } from '../src/index';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const libraryRoot = path.join(repoRoot, 'components');
const templateRoot = path.join(repoRoot, 'templates', 'nextjs-saas-postgres');
const keep = process.argv.includes('--keep');

function run(command: string, args: string[], cwd: string, timeoutMs = 15 * 60_000) {
  return new Promise<{ code: number; output: string }>((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: process.platform === 'win32',
      env: { ...process.env, CI: '1', NODE_ENV: 'test' },
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: 124, output: `${output}\n[timed out after ${timeoutMs / 1000}s]` });
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
  });
}

function tail(output: string, lines = 40): string {
  return output.split('\n').slice(-lines).join('\n');
}

async function main(): Promise<void> {
  const library = await loadLibrary(libraryRoot);
  console.log(`Library: ${library.length} components\n`);

  const dir = await mkdtemp(path.join(os.tmpdir(), 'shipyard-verify-'));
  const project = path.join(dir, 'app');
  await cp(templateRoot, project, { recursive: true });
  console.log(`Project: ${project}\n`);

  // Install everything. Order does not matter — each install pulls in what it
  // needs and skips what is already there.
  const installed: string[] = [];
  for (const component of library) {
    const outcome = await install(library, component.manifest.id, project);
    if (outcome.installed) {
      installed.push(component.manifest.id);
      console.log(`installed  ${component.manifest.id}`);
    } else if (outcome.errors.some((error) => /already installed/.test(error))) {
      console.log(`already    ${component.manifest.id} (pulled in as a dependency)`);
    } else {
      console.log(`FAILED     ${component.manifest.id}: ${outcome.errors.join('; ')}`);
    }
  }

  // The contract tests run without a database. Set the variables anyway so that
  // anything reading them at import time gets something well-formed rather than
  // undefined.
  await writeFile(
    path.join(project, '.env'),
    [
      'DATABASE_URL="postgresql://postgres:postgres@localhost:5432/verify?schema=public"',
      'APP_URL="http://localhost:3000"',
      'SESSION_SECRET="verification-only-not-a-real-secret"',
      'EMAIL_FROM="noreply@example.com"',
      '',
    ].join('\n'),
    'utf8',
  );

  console.log('\nInstalling dependencies…');
  const npmInstall = await run('npm', ['install', '--no-audit', '--no-fund'], project);
  if (npmInstall.code !== 0) {
    console.log(tail(npmInstall.output));
    console.log('\nCould not install dependencies, so nothing here is verified.');
    process.exitCode = 1;
    return;
  }

  // The tests import modules that import the Prisma client, which does not
  // exist until it is generated. No database is touched by generating it.
  console.log('Generating the database client…');
  const generate = await run('npx', ['prisma', 'generate'], project, 5 * 60_000);
  if (generate.code !== 0) {
    console.log(tail(generate.output, 25));
    console.log('\nThe schema the installer produced is not valid. That is a real failure.');
    process.exitCode = 1;
    return;
  }
  console.log('  the merged schema is valid\n');

  console.log('Checking the types agree…');
  const typecheck = await run('npm', ['run', 'typecheck'], project, 5 * 60_000);
  console.log(typecheck.code === 0 ? '  clean\n' : `${tail(typecheck.output, 30)}\n`);

  console.log('Running the contract tests…');
  const tests = await run('npm', ['run', 'test:contracts'], project, 10 * 60_000);
  console.log(tail(tests.output, 60));

  const report = {
    installed,
    schemaValid: generate.code === 0,
    typecheckPassed: typecheck.code === 0,
    contractsPassed: tests.code === 0,
  };
  await writeFile(
    path.join(repoRoot, 'components', 'VERIFICATION.json'),
    `${JSON.stringify({ ...report, ranAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );

  console.log('\n─────────────────────────────────────');
  console.log(`components installed   ${installed.length}`);
  console.log(`merged schema valid    ${report.schemaValid ? 'yes' : 'NO'}`);
  console.log(`types agree            ${report.typecheckPassed ? 'yes' : 'NO'}`);
  console.log(`contract tests pass    ${report.contractsPassed ? 'yes' : 'NO'}`);
  console.log('─────────────────────────────────────');

  if (keep) console.log(`\nProject left at ${project}`);
  else await rm(dir, { recursive: true, force: true }).catch(() => undefined);

  process.exitCode = report.schemaValid && report.contractsPassed ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
