import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  ComponentInstallation,
  LibraryComponent,
  UpgradePlan,
  UpgradeResult,
} from '@shipyard/shared';

import { checkProtectedPaths, PROTECTED_FILE, type ProtectedRecord } from './install';
import { protectedPathsOf } from './load';
import {
  INSTALL_RECORD,
  declaredModels,
  insertIntoSchema,
  mergeDependency,
  mergeEnvExample,
  readInstallRecord,
  readJson,
  removeFromSchema,
  writeJson,
  type InstallRecordFile,
  type PackageJson,
} from './project';
import { compareVersions, find } from './registry';

/**
 * Moving an installed component to a newer version.
 *
 * The hard question is not how to copy the new files over. It is what to do
 * about the ones somebody has edited, and the answer here is **refuse**.
 *
 * An upgrade that silently overwrites a change a founder made is worse than no
 * upgrade at all: they will not read the diff, they will find out weeks later
 * when the behaviour they added is gone, and they will not connect it to
 * pressing a button that said "update". Refusing, and naming the files, leaves
 * them a decision they can actually make.
 *
 * Files marked `example` are exempt — they were handed over on purpose, and a
 * template somebody has customised is the expected state rather than a problem.
 */

async function exists(file: string): Promise<boolean> {
  return readFile(file).then(
    () => true,
    () => false,
  );
}

/** What upgrading would do. Writes nothing. */
export async function planUpgrade(
  components: readonly LibraryComponent[],
  componentId: string,
  projectPath: string,
): Promise<UpgradePlan> {
  const component = find(components, componentId);
  const record = await readInstallRecord(projectPath);
  const installed = record.components.find(
    (entry) => entry.componentId === componentId && entry.status !== 'removed',
  );

  const plan: UpgradePlan = {
    componentId,
    from: installed?.version ?? '0.0.0',
    to: component?.manifest.version ?? '0.0.0',
    replaces: [],
    adds: [],
    drops: [],
    leaves: [],
    addsTables: [],
    orphanedTables: [],
    blockedBy: [],
    problems: [],
    upgradable: false,
  };

  if (!component) {
    plan.problems.push(`There is no component called "${componentId}" in the library.`);
    return plan;
  }
  if (!installed) {
    plan.problems.push('That is not installed yet, so there is nothing to update.');
    return plan;
  }

  const direction = compareVersions(installed.version, component.manifest.version);
  if (direction === 0) {
    plan.problems.push('You already have the newest version.');
    return plan;
  }
  if (direction > 0) {
    // Going backwards is a different operation with different risks — an older
    // version may not understand tables the newer one created.
    plan.problems.push(
      `Your project has version ${installed.version}, which is newer than the ${component.manifest.version} in the library. Going back is not something this can do safely.`,
    );
    return plan;
  }

  const modified = new Set(
    (await checkProtectedPaths(projectPath))
      .filter((change) => change.componentId === componentId && change.status === 'modified')
      .map((change) => change.path),
  );

  const nextFiles = new Map(
    component.manifest.files.map((file) => [file.to.replace(/\\/g, '/'), file] as const),
  );
  const previous = new Set(installed.files);

  for (const [relative, file] of nextFiles) {
    if (file.role === 'example' && (await exists(path.join(projectPath, relative)))) {
      plan.leaves.push(relative);
      continue;
    }
    if (modified.has(relative)) {
      plan.blockedBy.push(relative);
      continue;
    }
    if (previous.has(relative)) plan.replaces.push(relative);
    else plan.adds.push(relative);
  }

  for (const relative of previous) {
    if (nextFiles.has(relative)) continue;
    if (modified.has(relative)) plan.leaves.push(relative);
    else plan.drops.push(relative);
  }

  if (plan.blockedBy.length > 0) {
    plan.problems.push(
      `${plan.blockedBy.length} file${plan.blockedBy.length === 1 ? ' has' : 's have'} been changed since they were installed. Updating would overwrite those changes.`,
    );
  }

  // Work out the schema difference by reading what is actually in the project
  // rather than remembering what the old version declared.
  if (component.manifest.schema) {
    const schemaPath = path.join(projectPath, 'prisma', 'schema.prisma');
    const schema = await readFile(schemaPath, 'utf8').catch(() => '');
    const currentBlock = blockFor(schema, componentId);
    const before = declaredModels(currentBlock);
    const after = declaredModels(
      await readFile(path.join(component.directory, component.manifest.schema.file), 'utf8').catch(() => ''),
    );
    plan.addsTables = [...after].filter((model) => !before.has(model));
    plan.orphanedTables = [...before].filter((model) => !after.has(model));
  }

  plan.upgradable = plan.problems.length === 0;
  return plan;
}

/** The slice of the schema this component wrote, or an empty string. */
function blockFor(schema: string, componentId: string): string {
  const marker = `// --- ${componentId} ---`;
  const start = schema.indexOf(marker);
  if (start === -1) return '';
  const rest = schema.slice(start + marker.length);
  const next = rest.indexOf('// --- ');
  const close = rest.indexOf('// <<< shipyard:components');
  const candidates = [next, close].filter((index) => index !== -1);
  return candidates.length > 0 ? rest.slice(0, Math.min(...candidates)) : rest;
}

/** Do it, or leave the project exactly as it was. */
export async function upgrade(
  components: readonly LibraryComponent[],
  componentId: string,
  projectPath: string,
): Promise<UpgradeResult> {
  const plan = await planUpgrade(components, componentId, projectPath);
  const component = find(components, componentId);

  const result: UpgradeResult = {
    componentId,
    from: plan.from,
    to: plan.to,
    upgraded: false,
    filesWritten: [],
    notes: [],
    errors: [],
  };

  if (!plan.upgradable || !component) {
    result.errors.push(...plan.problems);
    if (plan.blockedBy.length > 0) {
      result.errors.push(`The changed files are: ${plan.blockedBy.join(', ')}.`);
    }
    return result;
  }

  const restore: { file: string; contents: string | null }[] = [];
  const snapshot = async (relative: string): Promise<void> => {
    const absolute = path.join(projectPath, relative);
    restore.push({ file: absolute, contents: await readFile(absolute, 'utf8').catch(() => null) });
  };

  try {
    const { manifest, directory } = component;
    const byTarget = new Map(manifest.files.map((file) => [file.to.replace(/\\/g, '/'), file] as const));

    for (const relative of [...plan.replaces, ...plan.adds]) {
      const file = byTarget.get(relative);
      if (!file) continue;
      await snapshot(relative);
      const absolute = path.join(projectPath, relative);
      await mkdir(path.dirname(absolute), { recursive: true });
      await copyFile(path.join(directory, file.from), absolute);
      result.filesWritten.push(relative);
    }

    for (const relative of plan.drops) {
      await snapshot(relative);
      await rm(path.join(projectPath, relative), { force: true }).catch(() => undefined);
    }

    if (manifest.schema) {
      const schemaPath = path.join(projectPath, 'prisma', 'schema.prisma');
      const current = await readFile(schemaPath, 'utf8').catch(() => null);
      if (current === null) throw new Error('this component needs a database, and the project has no prisma/schema.prisma');
      await snapshot(path.join('prisma', 'schema.prisma'));
      const fragment = await readFile(path.join(directory, manifest.schema.file), 'utf8');
      await writeFile(schemaPath, insertIntoSchema(removeFromSchema(current, componentId), fragment, componentId), 'utf8');
    }

    if (manifest.dependencies || manifest.devDependencies) {
      const packagePath = path.join(projectPath, 'package.json');
      await snapshot('package.json');
      const pkg = (await readJson<PackageJson>(packagePath)) ?? {};
      for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
        pkg.dependencies ??= {};
        const merged = mergeDependency(pkg.dependencies[name], range);
        if (merged.clash) throw new Error(`the new version wants ${name} ${range}, which clashes with what the project uses`);
        pkg.dependencies[name] = merged.value;
      }
      for (const [name, range] of Object.entries(manifest.devDependencies ?? {})) {
        pkg.devDependencies ??= {};
        const merged = mergeDependency(pkg.devDependencies[name], range);
        if (merged.clash) throw new Error(`the new version wants ${name} ${range}, which clashes with what the project uses`);
        pkg.devDependencies[name] = merged.value;
      }
      await writeJson(packagePath, pkg);
    }

    if (manifest.env?.length) {
      await snapshot('.env.example');
      const envPath = path.join(projectPath, '.env.example');
      const current = await readFile(envPath, 'utf8').catch(() => '');
      await writeFile(envPath, mergeEnvExample(current, manifest.env), 'utf8');
    }

    // Re-hash, or the next tamper check would compare the new files against the
    // old version's hashes and report every one of them as modified.
    const protectedFile = path.join(projectPath, PROTECTED_FILE);
    await snapshot(PROTECTED_FILE);
    const protectedRecord = (await readJson<ProtectedRecord>(protectedFile)) ?? { version: 1 as const, paths: {} };
    for (const [relative, entry] of Object.entries(protectedRecord.paths)) {
      if (entry.componentId === componentId) delete protectedRecord.paths[relative];
    }
    const { createHash } = await import('node:crypto');
    for (const relative of protectedPathsOf(manifest)) {
      const contents = await readFile(path.join(projectPath, relative)).catch(() => null);
      if (!contents) continue;
      protectedRecord.paths[relative] = {
        componentId,
        sha256: createHash('sha256').update(contents).digest('hex'),
      };
    }
    await writeJson(protectedFile, protectedRecord);

    await snapshot(INSTALL_RECORD);
    const record = await readInstallRecord(projectPath);
    const updated: ComponentInstallation = {
      componentId,
      version: manifest.version,
      installedAt: new Date().toISOString(),
      files: manifest.files.map((file) => file.to.replace(/\\/g, '/')),
      protectedPaths: protectedPathsOf(manifest),
      status: 'installed',
    };
    const next: InstallRecordFile = {
      version: 1,
      components: [...record.components.filter((entry) => entry.componentId !== componentId), updated],
    };
    await writeJson(path.join(projectPath, INSTALL_RECORD), next);

    result.upgraded = true;
    if (plan.leaves.length > 0) {
      result.notes.push(
        `${plan.leaves.length} file${plan.leaves.length === 1 ? '' : 's'} you had customised ${plan.leaves.length === 1 ? 'was' : 'were'} left as ${plan.leaves.length === 1 ? 'it is' : 'they are'}.`,
      );
    }
    if (plan.addsTables.length > 0) {
      result.notes.push('Update your database so the new tables exist — Shipyard can do this for you.');
    }
    if (plan.orphanedTables.length > 0) {
      result.notes.push(
        `${plan.orphanedTables.join(', ')} ${plan.orphanedTables.length === 1 ? 'is' : 'are'} no longer part of this component. The table${plan.orphanedTables.length === 1 ? '' : 's'} and the data in ${plan.orphanedTables.length === 1 ? 'it' : 'them'} are untouched.`,
      );
    }
    return result;
  } catch (error) {
    for (const entry of restore.reverse()) {
      if (entry.contents === null) await rm(entry.file, { force: true }).catch(() => undefined);
      else await writeFile(entry.file, entry.contents, 'utf8').catch(() => undefined);
    }
    result.upgraded = false;
    result.filesWritten = [];
    result.errors.push((error as Error).message);
    return result;
  }
}

export type { UpgradePlan, UpgradeResult };
