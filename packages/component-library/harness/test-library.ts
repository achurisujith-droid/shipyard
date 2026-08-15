/**
 * Does the library install things, and does it refuse the right things?
 *
 * The cases that matter most here are the refusals. An installer that copies
 * files is easy; an installer that will not quietly overwrite the sign-in page
 * somebody already wrote, will not half-install and leave debris, and will not
 * let two components fight over the same file is the difference between a
 * library and a pile of snippets.
 *
 *   npx tsx harness/test-library.ts
 */
import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GATES } from '@shipyard/verification-runner';
import { loadCatalog } from '@shipyard/capability-resolver';
import type { ComponentManifest, LibraryComponent } from '@shipyard/shared';

import {
  browse,
  catalogueMarkdown,
  checkProtectedPaths,
  compareVersions,
  coverage,
  declaredModels,
  find,
  install,
  installedIn,
  insertIntoSchema,
  loadLibrary,
  mergeDependency,
  mergeEnvExample,
  planInstall,
  planRemoval,
  planUpgrade,
  protectedPathsInstruction,
  protectedPathsOf,
  readInstallRecord,
  removeFromSchema,
  uninstall,
  upgrade,
} from '../src/index';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const libraryRoot = path.join(repoRoot, 'components');
const templateRoot = path.join(repoRoot, 'templates', 'nextjs-saas-postgres');

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS  ${name}`);
  else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

async function expectThrows(name: string, work: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await work();
    check(name, false, 'it did not refuse');
  } catch (error) {
    const message = (error as Error).message;
    check(name, pattern.test(message), `said: ${message}`);
  }
}

/** A scratch copy of the starter template to install into. */
async function freshProject(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shipyard-project-'));
  const project = path.join(dir, 'app');
  await cp(templateRoot, project, { recursive: true });
  return project;
}

/** A throwaway library on disk, for the cases the real one cannot produce. */
async function fakeLibrary(
  manifests: Partial<ComponentManifest>[],
  files: Record<string, string> = {},
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shipyard-library-'));
  for (const partial of manifests) {
    const manifest = {
      name: 'A thing',
      summary: 'Does a thing.',
      version: '1.0.0',
      category: 'foundation',
      trust: 'provisional',
      provenance: { origin: 'authored', license: 'MIT' },
      stack: { framework: 'nextjs' },
      provides: [],
      satisfies: [],
      files: [{ from: 'files/thing.ts', to: `src/components/${partial.id}/thing.ts`, role: 'source' }],
      ...partial,
    } as ComponentManifest;

    const directory = path.join(root, manifest.id);
    await mkdir(path.join(directory, 'files'), { recursive: true });
    for (const file of manifest.files) {
      await writeFile(
        path.join(directory, file.from),
        files[file.from] ?? `export const ${manifest.id} = true;\n`,
        'utf8',
      );
    }
    if (manifest.schema) {
      await writeFile(
        path.join(directory, manifest.schema.file),
        `model ${manifest.schema.models[0]} {\n  id String @id\n}\n`,
        'utf8',
      );
    }
    await writeFile(path.join(directory, 'component.json'), JSON.stringify(manifest, null, 2), 'utf8');
  }
  return root;
}

async function main(): Promise<void> {
  const gateIds = GATES.map((gate) => gate.id);
  const catalog = await loadCatalog(path.join(repoRoot, 'shipyard-catalog'));
  const capabilityIds = catalog.capabilities.map((capability) => capability.id);

  // ======================================================================
  // Loading the real library
  // ======================================================================
  const library = await loadLibrary(libraryRoot, {
    knownGates: gateIds,
    knownCapabilities: capabilityIds,
  });

  check('the library loads', library.length > 0, `${library.length} components`);
  check(
    'every component claims only gates that something runs',
    library.every((c) => c.manifest.satisfies.every((gate) => gateIds.includes(gate))),
  );
  check(
    'and only capabilities the catalog knows about',
    library.every((c) => c.manifest.provides.every((capability) => capabilityIds.includes(capability))),
  );
  check(
    'every component says where its code came from',
    library.every((c) => Boolean(c.manifest.provenance.license)),
  );
  check(
    'and anything not written here names its source',
    library
      .filter((c) => c.manifest.provenance.origin !== 'authored')
      .every((c) => Boolean(c.manifest.provenance.source && c.manifest.provenance.sourceUrl)),
  );
  check(
    'nothing is called verified without a contract test',
    library.filter((c) => c.manifest.trust === 'verified').every((c) => Boolean(c.manifest.contractTest)),
  );
  check(
    'every component says what it does not do',
    library.every((c) => (c.manifest.limitations?.length ?? 0) > 0),
  );
  check(
    'the summaries are written for a founder, not a developer',
    library.every((c) => !/\b(API|CRUD|ORM|middleware|JWT|RBAC)\b/.test(c.manifest.summary)),
    library.find((c) => /\b(API|CRUD|ORM|middleware|JWT|RBAC)\b/.test(c.manifest.summary))?.manifest.id,
  );

  // Every capability the catalog says a component provides should exist.
  const provided = new Set(library.flatMap((c) => c.manifest.provides));
  const promisedComponents = new Set(catalog.capabilities.flatMap((c) => c.components ?? []));
  const haveComponents = new Set(library.map((c) => c.manifest.id));
  check(
    'the catalog does not point at components that do not exist yet',
    [...promisedComponents].every((id) => haveComponents.has(id)),
    `missing: ${[...promisedComponents].filter((id) => !haveComponents.has(id)).join(', ')}`,
  );
  check('and the library covers real capabilities', provided.size > 0);

  // ======================================================================
  // Refusing a broken library
  // ======================================================================
  await expectThrows(
    'a component whose folder and id disagree is refused',
    async () => loadLibrary(await fakeLibrary([{ id: 'thing_a' }]).then(async (root) => {
      // Rename the folder so the id no longer matches.
      const { rename } = await import('node:fs/promises');
      await rename(path.join(root, 'thing_a'), path.join(root, 'thing_b'));
      return root;
    })),
    /lives in a folder/,
  );

  await expectThrows(
    'a component with no licence is refused',
    async () =>
      loadLibrary(
        await fakeLibrary([{ id: 'nolicence', provenance: { origin: 'authored', license: '' } as never }]),
      ),
    /no licence/,
  );

  await expectThrows(
    'code taken from somewhere else without saying where is refused',
    async () =>
      loadLibrary(
        await fakeLibrary([
          { id: 'borrowed', provenance: { origin: 'vendored', license: 'MIT' } as never },
        ]),
      ),
    /does not say from what/,
  );

  await expectThrows(
    'claiming a gate nothing runs is refused',
    async () => loadLibrary(await fakeLibrary([{ id: 'liar', satisfies: ['it_all_works'] }]), { knownGates: gateIds }),
    /which nothing runs/,
  );

  await expectThrows(
    'calling itself verified with nothing to have verified it is refused',
    async () => loadLibrary(await fakeLibrary([{ id: 'boaster', trust: 'verified' }])),
    /no contract test/,
  );

  await expectThrows(
    'a file that escapes the project directory is refused',
    async () =>
      loadLibrary(
        await fakeLibrary([
          { id: 'escaper', files: [{ from: 'files/thing.ts', to: '../../../etc/passwd', role: 'source' }] },
        ]),
      ),
    /escapes the project/,
  );

  await expectThrows(
    'a missing file is refused rather than discovered at install time',
    async () =>
      loadLibrary(
        await fakeLibrary([
          { id: 'ghost', files: [{ from: 'files/not-there.ts', to: 'src/x.ts', role: 'source' }] },
        ]).then(async (root) => {
          await rm(path.join(root, 'ghost', 'files', 'not-there.ts'), { force: true });
          return root;
        }),
      ),
    /is missing/,
  );

  await expectThrows(
    'a secret with a default value is refused',
    async () =>
      loadLibrary(
        await fakeLibrary([
          {
            id: 'leaky',
            env: [{ name: 'API_KEY', description: 'k', required: true, secret: true, devDefault: 'dev-key' }],
          },
        ]),
      ),
    /must not ship a default/,
  );

  await expectThrows(
    'components that need each other in a loop are refused',
    async () =>
      loadLibrary(
        await fakeLibrary([
          { id: 'left', requires: ['right'] },
          { id: 'right', requires: ['left'] },
        ]),
      ),
    /loop/,
  );

  await expectThrows(
    'needing something that is not in the library is refused',
    async () => loadLibrary(await fakeLibrary([{ id: 'lonely', requires: ['imaginary'] }])),
    /not in the library/,
  );

  // ======================================================================
  // Protected paths are derived, not declared
  // ======================================================================
  const auth = find(library, 'auth');
  check('a real component was found by id', Boolean(auth));
  if (auth) {
    const paths = protectedPathsOf(auth.manifest);
    check('its own implementation is protected without saying so', paths.includes('src/components/auth/session.ts'));
    check('and so are its tests', paths.some((p) => p.startsWith('tests/contracts/')));
    check(
      'but not its documentation',
      !paths.some((p) => p.startsWith('docs/')),
      paths.filter((p) => p.startsWith('docs/')).join(', '),
    );
  }

  const emailComponent = find(library, 'transactional_email');
  if (emailComponent) {
    check(
      'a file marked as an example is left editable',
      !protectedPathsOf(emailComponent.manifest).includes('src/components/transactional_email/templates.ts'),
    );
  }

  // ======================================================================
  // Browsing
  // ======================================================================
  const plan = {
    included: [
      {
        capability: { id: 'authentication', label: 'Signing in', category: 'identity' as const },
        status: 'included' as const,
        reason: 'Real people are going to use this, so they need to sign in.',
        gates: [],
        components: ['auth'],
        recipes: [],
      },
    ],
    deferred: [
      {
        capability: { id: 'audit_logging', label: 'A record of who did what', category: 'compliance' as const },
        status: 'deferred' as const,
        reason: 'Needed before a pilot, not before a prototype.',
        gates: [],
        components: ['audit_logging'],
        recipes: [],
      },
    ],
  };

  const listed = browse(library, { plan });
  check('what the project needs comes first', listed[0]?.manifest.id === 'auth', listed[0]?.manifest.id);
  check('and carries the reason the founder was given', /Real people/.test(listed[0]?.reason ?? ''));
  check(
    'something needed later is marked, not hidden',
    listed.find((entry) => entry.manifest.id === 'audit_logging')?.relevance === 'suggested',
  );
  check(
    'everything else is still browsable',
    listed.some((entry) => entry.relevance === 'available'),
  );

  const searched = browse(library, { search: 'sign in' });
  check('searching in the founder’s words finds it', searched.some((entry) => entry.manifest.id === 'auth'));
  check(
    'searching for the developer word finds it too',
    browse(library, { search: 'authentication' }).some((entry) => entry.manifest.id === 'auth'),
  );
  check(
    'two words narrow rather than widen',
    browse(library, { search: 'audit log' }).length < browse(library, { search: 'audit' }).length + 1,
  );
  check('a search that matches nothing returns nothing', browse(library, { search: 'blockchain nft' }).length === 0);
  check(
    'filtering by category works',
    browse(library, { category: 'identity' }).every((entry) => entry.manifest.category === 'identity'),
  );
  check(
    'an installed component is marked as installed',
    browse(library, { installed: { auth: '1.0.0' } }).find((e) => e.manifest.id === 'auth')?.installed === true,
  );
  check(
    'and an older install is offered the newer version',
    browse(library, { installed: { auth: '0.9.0' } }).find((e) => e.manifest.id === 'auth')?.updateAvailable === '1.0.0',
  );

  check('versions compare properly', compareVersions('1.2.3', '1.10.0') < 0 && compareVersions('2.0.0', '1.9.9') > 0);
  check('and equal versions are equal', compareVersions('1.0.0', '1.0.0') === 0);

  const covered = coverage(library, plan);
  check('coverage is reported as a percentage', covered.percent === 100, JSON.stringify(covered));

  // ======================================================================
  // Planning an install
  // ======================================================================
  const project = await freshProject();

  const authPlan = await planInstall(library, 'auth', project);
  check('a plan can be made against a real project', authPlan.installable, JSON.stringify(authPlan.conflicts));
  check('it pulls in what the component needs first', authPlan.order[0] === 'postgres_schema', authPlan.order.join(' → '));
  check('and installs the component itself last', authPlan.order.at(-1) === 'auth');
  check('it lists every file it would create', authPlan.creates.length > 5);
  check('it names the tables it would add', authPlan.addsModels.includes('User') && authPlan.addsModels.includes('Session'));
  check('it names the dependencies it would add', Object.keys(authPlan.addsDependencies).includes('bcryptjs'));
  check(
    'it says which keys the founder will have to supply',
    authPlan.needsEnv.some((variable) => variable.name === 'SESSION_SECRET'),
  );
  check('and what becomes off limits', authPlan.protects.includes('src/components/auth/session.ts'));

  const unknownPlan = await planInstall(library, 'time_machine', project);
  check('asking for something that does not exist is refused', !unknownPlan.installable);
  check('and says so in plain words', /no component called/.test(unknownPlan.conflicts[0]?.message ?? ''));

  // A file the founder already wrote.
  const collisionProject = await freshProject();
  await mkdir(path.join(collisionProject, 'src', 'app', 'api', 'auth', 'login'), { recursive: true });
  await writeFile(
    path.join(collisionProject, 'src', 'app', 'api', 'auth', 'login', 'route.ts'),
    'export async function POST() { return new Response("mine"); }\n',
    'utf8',
  );
  const collisionPlan = await planInstall(library, 'auth', collisionProject);
  check('a file the founder already has stops the install', !collisionPlan.installable);
  check(
    'and the refusal names the file',
    collisionPlan.conflicts.some((conflict) => conflict.message.includes('api/auth/login/route.ts')),
    JSON.stringify(collisionPlan.conflicts),
  );

  // A table name already taken.
  const schemaProject = await freshProject();
  const schemaFile = path.join(schemaProject, 'prisma', 'schema.prisma');
  await writeFile(
    schemaFile,
    `${await readFile(schemaFile, 'utf8')}\nmodel User {\n  id String @id\n}\n`,
    'utf8',
  );
  const schemaPlan = await planInstall(library, 'auth', schemaProject);
  check('a table name already in use stops the install', !schemaPlan.installable);
  check(
    'and says which one',
    schemaPlan.conflicts.some((conflict) => /already has a table called User/.test(conflict.message)),
  );

  // A dependency at a different major version.
  const depProject = await freshProject();
  const depPkgPath = path.join(depProject, 'package.json');
  const depPkg = JSON.parse(await readFile(depPkgPath, 'utf8')) as { dependencies: Record<string, string> };
  depPkg.dependencies['bcryptjs'] = '^2.4.3';
  await writeFile(depPkgPath, JSON.stringify(depPkg, null, 2), 'utf8');
  const depPlan = await planInstall(library, 'auth', depProject);
  check('a dependency at a different major version stops the install', !depPlan.installable);
  check(
    'and explains rather than upgrading it behind their back',
    depPlan.conflicts.some((conflict) => /would probably break/.test(conflict.detail ?? '')),
  );

  // ======================================================================
  // Installing
  // ======================================================================
  const result = await install(library, 'auth', project);
  check('the install succeeds', result.installed, result.errors.join('; '));
  check('files were written', result.filesWritten.length > 5);
  check('the contract test is reported back', result.contractCommand === 'npm run test:contracts');
  check(
    'the founder is told what only they can do',
    result.nextSteps.some((step) => /SESSION_SECRET/.test(step)),
    result.nextSteps.join(' | '),
  );

  const installedPkg = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
    scripts: Record<string, string>;
  };
  check('the dependency was added', Boolean(installedPkg.dependencies['bcryptjs']));
  check('the existing test script was left alone', installedPkg.scripts['test'] === 'vitest run');
  check(
    'and the dependencies stayed sorted',
    JSON.stringify(Object.keys(installedPkg.dependencies)) ===
      JSON.stringify([...Object.keys(installedPkg.dependencies)].sort()),
  );

  const installedSchema = await readFile(path.join(project, 'prisma', 'schema.prisma'), 'utf8');
  check('the tables were added to the schema', declaredModels(installedSchema).has('User'));
  check('inside the markers, not at the end', installedSchema.indexOf('model User') < installedSchema.indexOf('<<< shipyard:components'));
  check('and the datasource is untouched', installedSchema.includes('provider = "postgresql"'));

  const envExample = await readFile(path.join(project, '.env.example'), 'utf8');
  check('the new settings were explained in .env.example', envExample.includes('SESSION_SECRET'));
  check('a secret got no value', /SESSION_SECRET=\s*$/m.test(envExample));
  check('an existing variable was not duplicated', envExample.match(/^DATABASE_URL=/gm)?.length === 1);

  const record = await readInstallRecord(project);
  check('the install was recorded in the project', record.components.length === 2);
  check('with the version', record.components.find((c) => c.componentId === 'auth')?.version === '1.0.0');
  check('installed components can be read back', (await installedIn(project))['auth'] === '1.0.0');

  // Installing it twice.
  const again = await install(library, 'auth', project);
  check('installing it a second time is refused', !again.installed);
  check('and says it is already there', /already installed/.test(again.errors.join(' ')));

  // ======================================================================
  // Protected paths
  // ======================================================================
  check('nothing has been tampered with yet', (await checkProtectedPaths(project)).length === 0);

  const sessionFile = path.join(project, 'src', 'components', 'auth', 'session.ts');
  await writeFile(sessionFile, `${await readFile(sessionFile, 'utf8')}\n// the agent had an idea\n`, 'utf8');
  const tampered = await checkProtectedPaths(project);
  check('rewriting a verified component is noticed', tampered.length === 1, JSON.stringify(tampered));
  check('and attributed to the component it belongs to', tampered[0]?.componentId === 'auth');
  check('and described as modified', tampered[0]?.status === 'modified');

  await rm(sessionFile, { force: true });
  check('deleting one is noticed too', (await checkProtectedPaths(project))[0]?.status === 'deleted');

  const instruction = protectedPathsInstruction(record.components);
  check('the agent gets told what not to touch', /do not rewrite these/i.test(instruction));
  check('by name', instruction.includes('src/components/auth/session.ts'));
  check('and told what it may still change', /Everything else in the project is yours/.test(instruction));
  check('a project with nothing installed gets no instruction', protectedPathsInstruction([]) === '');

  // ======================================================================
  // Rolling back
  // ======================================================================
  const brokenLibraryRoot = await fakeLibrary([
    {
      id: 'half_broken',
      files: [{ from: 'files/thing.ts', to: 'src/components/half_broken/thing.ts', role: 'source' }],
      schema: { file: 'files/schema.prisma', models: ['Widget'] },
    },
  ]);
  const brokenLibrary = await loadLibrary(brokenLibraryRoot);
  const noSchemaProject = await freshProject();
  await rm(path.join(noSchemaProject, 'prisma'), { recursive: true, force: true });

  const rolledBack = await install(brokenLibrary, 'half_broken', noSchemaProject);
  check('an install that cannot finish reports failure', !rolledBack.installed);
  check('and says why', /no prisma\/schema\.prisma/.test(rolledBack.errors.join(' ')));
  const debris = await readFile(
    path.join(noSchemaProject, 'src', 'components', 'half_broken', 'thing.ts'),
    'utf8',
  ).catch(() => null);
  check('and leaves no half-written files behind', debris === null);
  check(
    'and the package.json is exactly as it was',
    (await readFile(path.join(noSchemaProject, 'package.json'), 'utf8')) ===
      (await readFile(path.join(templateRoot, 'package.json'), 'utf8')),
  );

  // Two components fighting over one file.
  const clashLibrary = await loadLibrary(
    await fakeLibrary([
      { id: 'first_one', files: [{ from: 'files/thing.ts', to: 'src/shared.ts', role: 'source' }] },
      {
        id: 'second_one',
        requires: ['first_one'],
        files: [{ from: 'files/thing.ts', to: 'src/shared.ts', role: 'source' }],
      },
    ]),
  );
  const clashPlan = await planInstall(clashLibrary, 'second_one', await freshProject());
  check('two components wanting the same file is refused', !clashPlan.installable);
  check(
    'and names both of them',
    clashPlan.conflicts.some((conflict) => /both want to write/.test(conflict.message)),
    JSON.stringify(clashPlan.conflicts),
  );

  // Installing over a path another component already owns.
  const ownedProject = await freshProject();
  await install(library, 'auth', ownedProject);
  const ownedPlan = await planInstall(
    await loadLibrary(
      await fakeLibrary([
        {
          id: 'intruder',
          files: [{ from: 'files/thing.ts', to: 'src/components/auth/session.ts', role: 'source' }],
        },
      ]),
    ),
    'intruder',
    ownedProject,
  );
  check('writing into a component someone else owns is refused', !ownedPlan.installable);
  check(
    'and says who owns it',
    ownedPlan.conflicts.some((conflict) => /belongs to/.test(conflict.message)),
  );

  // ======================================================================
  // The catalogue the agent reads
  // ======================================================================
  const catalogue = catalogueMarkdown(library, { url: 'https://example.com/library', planned: 44 });

  check('the catalogue lists every component', library.every((c) => catalogue.includes(c.manifest.name)));
  check('organised by problem rather than by id', /Use it when they ask to:/.test(catalogue));
  check(
    'because an agent will not search for a component id',
    /upload/.test(catalogue) && /sign in/.test(catalogue),
  );
  check('the two tiers are separated', /Things a product owes its users/.test(catalogue) && /Jobs of work/.test(catalogue));
  check(
    'and the difference between them is stated',
    /can stop a launch/.test(catalogue) && /somebody writes it by hand/.test(catalogue),
  );

  // The instruction this whole file exists to deliver.
  check('the agent is told to check before building', /before writing anything/.test(catalogue));
  check('and to say so rather than build its own', /say so rather than\s*building your own/.test(catalogue));
  check(
    'while being told that finding nothing is normal',
    /Not finding something is the normal case/.test(catalogue),
  );
  check(
    'and allowed to disagree, as long as it says so',
    /say which and why/.test(catalogue) && /quietly writing a parallel version/.test(catalogue),
  );

  check(
    'components that are not fully proven say so',
    /Not fully proven/.test(catalogue),
    'no provisional component was flagged',
  );
  check(
    'planned components are counted but never named',
    /44 more are planned and \*\*do not exist\*\*/.test(catalogue) && !/xlsx_import/.test(catalogue),
  );
  check('the page a person can browse is given', catalogue.includes('https://example.com/library'));
  check('and it is marked as generated, so nobody edits it', /regenerated whenever/.test(catalogue));

  const withInstalled = catalogueMarkdown(library, { installed: ['auth'] });
  check('what is already installed is marked', /\*\*\(already installed\)\*\*/.test(withInstalled));
  check(
    'with the reminder not to rewrite it',
    /Do not edit inside them/.test(withInstalled),
  );
  check(
    'and a project with nothing installed gets no such section',
    !/Already in this project/.test(catalogue),
  );

  // ======================================================================
  // Taking one back out
  // ======================================================================
  const removalProject = await freshProject();
  await install(library, 'audit_logging', removalProject);

  const dependentRemoval = await planRemoval(library, 'organization_tenancy', removalProject);
  check('removing something another component needs is refused', !dependentRemoval.removable);
  check(
    'and names what needs it',
    dependentRemoval.problems.some((problem) => /needs this and is also installed/.test(problem)),
    JSON.stringify(dependentRemoval.problems),
  );

  const removalPlan = await planRemoval(library, 'audit_logging', removalProject);
  check('a component nothing depends on can be removed', removalPlan.removable);
  check('the plan lists the files that would go', removalPlan.removes.length > 3);
  check(
    'and warns that the tables stay',
    removalPlan.orphanedTables.includes('AuditEvent'),
    JSON.stringify(removalPlan.orphanedTables),
  );

  const removed = await uninstall(library, 'audit_logging', removalProject);
  check('the removal succeeds', removed.removed, removed.errors.join('; '));
  check('the files are gone', removed.filesRemoved.length > 3);
  check(
    'and the schema no longer declares its tables',
    !declaredModels(await readFile(path.join(removalProject, 'prisma', 'schema.prisma'), 'utf8')).has('AuditEvent'),
  );
  check(
    'while the tables it left behind are called out',
    removed.notes.some((note) => /still exist in your database/.test(note)),
    removed.notes.join(' | '),
  );
  check(
    'the packages are left alone, and that is said',
    removed.notes.some((note) => /left in place/.test(note)) || removalPlan.keptDependencies.length === 0,
  );
  check('it is no longer listed as installed', !(await installedIn(removalProject))['audit_logging']);
  check(
    'and what it depended on is still there',
    Boolean((await installedIn(removalProject))['organization_tenancy']),
  );
  check(
    'its paths are free again, so it can be reinstalled',
    (await planInstall(library, 'audit_logging', removalProject)).installable,
  );

  // A file somebody edited is theirs now, whatever it started as.
  const editedProject = await freshProject();
  await install(library, 'audit_logging', editedProject);
  const auditFile = path.join(editedProject, 'src', 'components', 'audit_logging', 'audit.ts');
  await writeFile(auditFile, `${await readFile(auditFile, 'utf8')}\n// mine now\n`, 'utf8');
  const editedRemoval = await uninstall(library, 'audit_logging', editedProject);
  check('an edited file is kept rather than deleted', editedRemoval.filesKept.includes('src/components/audit_logging/audit.ts'));
  check('and the user is told', editedRemoval.notes.some((note) => /left alone/.test(note)));
  check('the file is still there', await readFile(auditFile, 'utf8').then(() => true, () => false));

  // ======================================================================
  // Moving to a newer version
  // ======================================================================
  const upgradeProject = await freshProject();
  await install(library, 'rbac', upgradeProject);

  const sameVersion = await planUpgrade(library, 'rbac', upgradeProject);
  check('upgrading to the version you already have is refused', !sameVersion.upgradable);
  check('and says so plainly', /already have the newest/.test(sameVersion.problems[0] ?? ''));

  const notInstalled = await planUpgrade(library, 'stripe_subscription_billing', upgradeProject);
  check('upgrading something you never installed is refused', !notInstalled.upgradable);

  // Pretend an older version is installed, so the real path can be exercised.
  const pretendOld = async (project: string, id: string, version: string): Promise<void> => {
    const file = path.join(project, 'shipyard.components.json');
    const contents = JSON.parse(await readFile(file, 'utf8')) as {
      version: 1;
      components: { componentId: string; version: string }[];
    };
    for (const entry of contents.components) if (entry.componentId === id) entry.version = version;
    await writeFile(file, JSON.stringify(contents, null, 2), 'utf8');
  };

  await pretendOld(upgradeProject, 'rbac', '0.9.0');
  const realUpgrade = await planUpgrade(library, 'rbac', upgradeProject);
  check('an older version can be updated', realUpgrade.upgradable, JSON.stringify(realUpgrade.problems));
  check('the plan says where it is going', realUpgrade.from === '0.9.0' && realUpgrade.to === '1.0.0');
  check('and which files it would replace', realUpgrade.replaces.length > 0);

  const upgraded = await upgrade(library, 'rbac', upgradeProject);
  check('the upgrade succeeds', upgraded.upgraded, upgraded.errors.join('; '));
  check('the recorded version moves', (await installedIn(upgradeProject))['rbac'] === '1.0.0');
  check(
    'and the tamper check is quiet afterwards',
    (await checkProtectedPaths(upgradeProject)).length === 0,
    JSON.stringify(await checkProtectedPaths(upgradeProject)),
  );

  // The case this whole operation is judged on.
  const editedUpgrade = await freshProject();
  await install(library, 'rbac', editedUpgrade);
  await pretendOld(editedUpgrade, 'rbac', '0.9.0');
  const permissionsFile = path.join(editedUpgrade, 'src', 'components', 'rbac', 'permissions.ts');
  const theirVersion = `${await readFile(permissionsFile, 'utf8')}\n// our finance team can read the audit log\n`;
  await writeFile(permissionsFile, theirVersion, 'utf8');

  const blocked = await planUpgrade(library, 'rbac', editedUpgrade);
  check('an upgrade that would overwrite an edit is refused', !blocked.upgradable);
  check('and names the file', blocked.blockedBy.includes('src/components/rbac/permissions.ts'));
  const blockedResult = await upgrade(library, 'rbac', editedUpgrade);
  check('applying it anyway does nothing', !blockedResult.upgraded);
  check(
    'and the edit survives untouched',
    (await readFile(permissionsFile, 'utf8')) === theirVersion,
  );

  // A file handed over on purpose is a different matter.
  const customisedExample = await freshProject();
  await install(library, 'transactional_email', customisedExample);
  await pretendOld(customisedExample, 'transactional_email', '0.9.0');
  const templatesFile = path.join(customisedExample, 'src', 'components', 'transactional_email', 'templates.ts');
  const customised = '// entirely rewritten by the founder\nexport const mine = true;\n';
  await writeFile(templatesFile, customised, 'utf8');
  const examplePlan = await planUpgrade(library, 'transactional_email', customisedExample);
  check('a customised example does not block the upgrade', examplePlan.upgradable, JSON.stringify(examplePlan.problems));
  check('it is listed as left alone', examplePlan.leaves.includes('src/components/transactional_email/templates.ts'));
  const exampleUpgrade = await upgrade(library, 'transactional_email', customisedExample);
  check('and the upgrade goes through', exampleUpgrade.upgraded, exampleUpgrade.errors.join('; '));
  check('with their version of the example intact', (await readFile(templatesFile, 'utf8')) === customised);

  // ======================================================================
  // The merge helpers, on their own
  // ======================================================================
  check('a new dependency is taken as offered', mergeDependency(undefined, '^1.2.3').value === '^1.2.3');
  check('the newer of two compatible versions wins', mergeDependency('^1.2.3', '^1.4.0').value === '^1.4.0');
  check('and the project keeps its newer one', mergeDependency('^1.9.0', '^1.4.0').value === '^1.9.0');
  check('a different major is a clash', mergeDependency('^1.2.3', '^2.0.0').clash === true);
  check(
    'something that is not a version is left alone',
    mergeDependency('workspace:*', '^1.0.0').value === 'workspace:*',
  );

  check(
    'a schema with no markers gets them',
    insertIntoSchema('generator client {}\n', 'model X { id String @id }', 'x').includes('>>> shipyard:components'),
  );
  check(
    'and a second component goes in after the first',
    (() => {
      const once = insertIntoSchema('generator client {}\n', 'model A { id String @id }', 'a');
      const twice = insertIntoSchema(once, 'model B { id String @id }', 'b');
      return twice.indexOf('model A') < twice.indexOf('model B') &&
        twice.indexOf('model B') < twice.indexOf('<<< shipyard:components');
    })(),
  );

  const merged = mergeEnvExample('EXISTING=1\n', [
    { name: 'EXISTING', description: 'already there', required: true, secret: false },
    { name: 'NEW_ONE', description: 'a new one', required: false, secret: false, devDefault: 'x' },
    { name: 'A_SECRET', description: 'a secret', required: true, secret: true, obtainFrom: 'somewhere' },
  ]);
  check('an existing variable is not written twice', merged.match(/^EXISTING=/gm)?.length === 1);
  check('a new one arrives with its explanation', merged.includes('# a new one') && merged.includes('NEW_ONE=x'));
  check('an optional one says so', merged.includes('(optional)'));
  check('a secret arrives empty, with instructions', merged.includes('# Get it from: somewhere') && /A_SECRET=\s*$/m.test(merged));

  // ======================================================================
  // Every component in the library plans cleanly into a fresh project
  // ======================================================================
  for (const component of library) {
    const scratch = await freshProject();
    const componentPlan = await planInstall(library, component.manifest.id, scratch);
    check(
      `${component.manifest.id} installs into an empty project`,
      componentPlan.installable,
      componentPlan.conflicts.map((conflict) => conflict.message).join('; '),
    );
    const outcome = await install(library, component.manifest.id, scratch);
    check(`${component.manifest.id} actually writes its files`, outcome.installed, outcome.errors.join('; '));
    await rm(path.dirname(scratch), { recursive: true, force: true }).catch(() => undefined);
  }

  console.log(`\n${failed === 0 ? 'All component library cases pass.' : `${failed} case(s) failed.`}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
