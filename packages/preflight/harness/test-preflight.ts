/**
 * Does the preflight find the things that only break on a server?
 *
 * The case that earns this package is the capitalisation one. It is invisible
 * on Windows and macOS, fatal on Linux, and reads as perfectly correct code —
 * so it is the one a founder has no chance of finding themselves.
 *
 *   npx tsx harness/test-preflight.ts
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DIVERGENCES,
  allDivergences,
  blocking,
  checkDevOnlyImports,
  checkHardcodedAddresses,
  checkImportCase,
  checkLocalFileWrites,
  checkMigrations,
  divergence,
  onlyCheckableLive,
  preflight,
  relativeImports,
  settingsForDeploy,
} from '../src/index';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS  ${name}`);
  else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

/** A throwaway project on disk. */
async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shipyard-preflight-'));
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }
  return root;
}

const PKG = JSON.stringify({
  dependencies: { next: '^15.0.0', react: '^19.0.0' },
  devDependencies: { vitest: '^3.0.0', typescript: '^5.0.0' },
});

async function main(): Promise<void> {
  // -------------------------------------------------------- the list itself
  check('every divergence says what it costs', DIVERGENCES.every((entry) => entry.cost.length > 40));
  check('and what to do about it', DIVERGENCES.every((entry) => entry.fix.length > 20));
  check(
    'and is written for a founder, not a developer',
    DIVERGENCES.every((entry) => !/\b(CORS|SIGTERM|ENOENT|stdout|env var)\b/.test(entry.what)),
  );
  check(
    'anything checkable names the check that finds it',
    DIVERGENCES.filter((entry) => entry.checkableLocally).every((entry) => Boolean(entry.check)),
  );
  check('the ones that break everything are identified', blocking().length >= 4);
  check(
    'and the ones nothing local can find are too',
    onlyCheckableLive().length >= 3,
    `${onlyCheckableLive().length}`,
  );
  check(
    'those admit it rather than pretending',
    onlyCheckableLive().every((entry) => !entry.check),
  );
  check('a divergence can be looked up', divergence('case_sensitive_paths')?.severity === 'breaks_everything');
  check('and the whole list is available for the screen', allDivergences().length === DIVERGENCES.length);

  // ------------------------------------------------------------ parsing imports
  check(
    'relative imports are found',
    relativeImports(`import { a } from './Button';`)[0]?.specifier === './Button',
  );
  check(
    'and so are dynamic ones',
    relativeImports(`const x = await import('./Thing');`)[0]?.specifier === './Thing',
  );
  check('package imports are ignored', relativeImports(`import x from 'react';`).length === 0);
  check('line numbers are recorded', relativeImports(`\n\nimport a from './b';`)[0]?.line === 3);

  // ------------------------------------------- the case that only fails on Linux
  const wrongCase = await project({
    'package.json': PKG,
    'src/components/button.tsx': 'export const Button = () => null;\n',
    'src/app/page.tsx': `import { Button } from '../components/Button';\nexport default function Page() { return null; }\n`,
  });
  const caseFindings = await checkImportCase(wrongCase);
  check('an import with the wrong capitals is caught', caseFindings.length === 1, JSON.stringify(caseFindings));
  check('it is treated as blocking', caseFindings[0]?.severity === 'blocking');
  check('the file and line are given', caseFindings[0]?.file === 'src/app/page.tsx' && caseFindings[0]?.line === 1);
  check(
    'and the message says what the file is really called',
    /actually called "button.tsx"/.test(caseFindings[0]?.message ?? ''),
    caseFindings[0]?.message,
  );
  check(
    'and why the computer did not complain',
    /Your computer does not mind/.test(caseFindings[0]?.message ?? ''),
  );

  const rightCase = await project({
    'package.json': PKG,
    'src/components/Button.tsx': 'export const Button = () => null;\n',
    'src/app/page.tsx': `import { Button } from '../components/Button';\n`,
  });
  check('a correct import is not flagged', (await checkImportCase(rightCase)).length === 0);

  const missing = await project({
    'package.json': PKG,
    'src/app/page.tsx': `import { X } from '../components/NotThere';\n`,
  });
  check(
    'a file that simply does not exist is left alone, not misreported',
    (await checkImportCase(missing)).length === 0,
  );

  const indexImport = await project({
    'package.json': PKG,
    'src/lib/thing/index.ts': 'export const a = 1;\n',
    'src/app/page.tsx': `import { a } from '../lib/thing';\n`,
  });
  check('a folder import is understood', (await checkImportCase(indexImport)).length === 0);

  // ------------------------------------------------------- localhost in the code
  const hardcoded = await project({
    'package.json': PKG,
    'src/lib/email.ts': `const link = 'http://localhost:3000/reset';\n`,
    'src/lib/ok.ts': `const base = process.env.APP_URL ?? 'http://localhost:3000';\n`,
    'tests/thing.test.ts': `const base = 'http://localhost:3000';\n`,
  });
  const addressFindings = await checkHardcodedAddresses(hardcoded);
  check('a hardcoded address is found', addressFindings.some((f) => f.file === 'src/lib/email.ts'));
  check(
    'a fallback behind a setting is not',
    !addressFindings.some((f) => f.file === 'src/lib/ok.ts'),
  );
  check(
    'and a test is not, because a test is meant to',
    !addressFindings.some((f) => f.file?.includes('tests/')),
  );
  check('it is a warning rather than blocking', addressFindings[0]?.severity === 'warning');

  // ------------------------------------------- a tool the server will not install
  const devDep = await project({
    'package.json': PKG,
    'src/lib/thing.ts': `import { describe } from 'vitest';\nexport const x = describe;\n`,
  });
  const devFindings = await checkDevOnlyImports(devDep);
  check('a development tool used by the app is caught', devFindings.length === 1);
  check('and treated as blocking, because it crashes live', devFindings[0]?.severity === 'blocking');
  check('the fix names the package and where to move it', /Move "vitest"/.test(devFindings[0]?.fix ?? ''));

  const testOnly = await project({
    'package.json': PKG,
    'tests/thing.test.ts': `import { describe } from 'vitest';\n`,
  });
  check('a tool used only in tests is fine', (await checkDevOnlyImports(testOnly)).length === 0);

  // -------------------------------------------------------------- the database
  const noMigrations = await project({
    'package.json': PKG,
    'prisma/schema.prisma': 'model User {\n  id String @id\n}\n',
  });
  const migrationFindings = await checkMigrations(noMigrations);
  check('a schema with no migrations is caught', migrationFindings.length === 1);
  check(
    'and the message says the live database will be empty',
    /live database will be empty/.test(migrationFindings[0]?.message ?? ''),
  );

  const withMigrations = await project({
    'package.json': PKG,
    'prisma/schema.prisma': 'model User {\n  id String @id\n}\n',
    'prisma/migrations/20260815_init/migration.sql': 'CREATE TABLE users();\n',
  });
  check('a project with migrations is not', (await checkMigrations(withMigrations)).length === 0);
  check(
    'and a project with no database at all is left alone',
    (await checkMigrations(await project({ 'package.json': PKG }))).length === 0,
  );

  // ------------------------------------------------------------ files on disk
  const writesFiles = await project({
    'package.json': PKG,
    'src/lib/save.ts': `import { writeFile } from 'node:fs/promises';\nawait writeFile('./uploads/a.png', data);\n`,
  });
  check('writing to the server disk is flagged', (await checkLocalFileWrites(writesFiles)).length === 1);

  // ------------------------------------------------------------- the settings
  const withEnv = await project({
    'package.json': PKG,
    '.env.example': '# The database\nDATABASE_URL=\n\n# Sign-in\nSESSION_SECRET=\nAPP_URL=http://localhost:3000\n',
  });
  const settings = await settingsForDeploy(withEnv);
  check('every setting the server needs is listed', settings.names.length === 3);
  check('by name', settings.names.includes('SESSION_SECRET'));

  // The single most common first-deploy failure, and the reason it happens.
  check(
    'and the founder is told why none of them travel with the code',
    /never reads it and never uploads it/.test(settings.finding?.fix ?? ''),
  );
  check('it is blocking, because every page fails without them', settings.finding?.severity === 'blocking');

  // ------------------------------------------------------------ the whole run
  const messy = await project({
    'package.json': PKG,
    '.env.example': 'DATABASE_URL=\n',
    'src/components/button.tsx': 'export const Button = () => null;\n',
    'src/app/page.tsx': `import { Button } from '../components/Button';\nconst u = 'http://localhost:3000';\n`,
  });
  const result = await preflight(messy);
  check('a run finds several kinds of problem at once', result.findings.length >= 3);
  check('and is not clear', result.clear === false);
  check('blocking things are listed first', result.findings[0]?.severity === 'blocking');
  check(
    'the summary says what it means for them',
    /stop this working once it is live/.test(result.summary),
    result.summary,
  );
  check('the settings are carried through', result.settingsNeeded.includes('DATABASE_URL'));

  // The honest half.
  check('and what cannot be checked from here is said, not hidden', result.checkAfterDeploy.length >= 3);
  check(
    'each with what to do once it is live',
    result.checkAfterDeploy.every((entry) => entry.fix.length > 20),
  );

  const clean = await project({ 'package.json': PKG, 'src/app/page.tsx': 'export default function P() { return null; }\n' });
  const clear = await preflight(clean);
  check('a clean project comes back clear', clear.clear === true);
  check(
    'without claiming it will work',
    /Nothing found that we can check from here/.test(clear.summary),
    clear.summary,
  );

  await rm(path.dirname(wrongCase), { recursive: true, force: true }).catch(() => undefined);

  console.log(`\n${failed === 0 ? 'All preflight cases pass.' : `${failed} case(s) failed.`}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
