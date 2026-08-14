import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type {
  ComponentEnv,
  InstallConflict,
  ComponentInstallPlan,
  LibraryComponent,
} from '@shipyard/shared';

import { protectedPathsOf } from './load';
import {
  declaredModels,
  installedVersions,
  majorOf,
  readInstallRecord,
  readJson,
  type PackageJson,
} from './project';
import { compareVersions, find } from './registry';

/**
 * Work out what installing something would do, before doing any of it.
 *
 * Two-step install — plan, then apply — exists because the founder using this
 * cannot read the diff. They are being asked to approve a change to their
 * codebase on the strength of a description, so the description has to be
 * complete: every file, every dependency, every table, every key they will have
 * to go and fetch.
 *
 * It is also the only honest way to refuse. "This would overwrite the sign-in
 * page you already have" is a useful sentence. Discovering it afterwards is not.
 */

async function exists(file: string): Promise<boolean> {
  return Boolean(await stat(file).catch(() => null));
}

/** Resolve `requires` into install order, dependencies first. */
function resolveOrder(components: readonly LibraryComponent[], rootId: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();

  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const component = find(components, id);
    for (const required of component?.manifest.requires ?? []) visit(required);
    order.push(id);
  };

  visit(rootId);
  return order;
}

export interface PlanOptions {
  /** Components the founder has already agreed to install in this batch. */
  alsoInstalling?: readonly string[];
}

/** What installing `componentId` into `projectPath` would do. */
export async function planInstall(
  components: readonly LibraryComponent[],
  componentId: string,
  projectPath: string,
  options: PlanOptions = {},
): Promise<ComponentInstallPlan> {
  const target = find(components, componentId);
  const conflicts: InstallConflict[] = [];

  if (!target) {
    return {
      componentId,
      version: '0.0.0',
      order: [],
      creates: [],
      skips: [],
      addsDependencies: {},
      addsModels: [],
      needsEnv: [],
      protects: [],
      conflicts: [
        {
          kind: 'not_installable',
          message: `There is no component called "${componentId}" in the library.`,
          blocking: true,
        },
      ],
      installable: false,
    };
  }

  const record = await readInstallRecord(projectPath);
  const installed = installedVersions(record);
  const pkg = (await readJson<PackageJson>(path.join(projectPath, 'package.json'))) ?? {};
  const schemaPath = path.join(projectPath, 'prisma', 'schema.prisma');
  const schema = await readFile(schemaPath, 'utf8').catch(() => '');
  const existingModels = declaredModels(schema);

  const order = resolveOrder(components, componentId).filter(
    (id) => !installed[id] || id === componentId,
  );

  // Already here, and not an upgrade.
  const installedVersion = installed[componentId];
  if (installedVersion) {
    const newer = compareVersions(installedVersion, target.manifest.version) < 0;
    conflicts.push({
      kind: 'already_installed',
      message: newer
        ? `${target.manifest.name} is already installed at ${installedVersion}. Upgrading to ${target.manifest.version} is not built yet.`
        : `${target.manifest.name} is already installed.`,
      blocking: true,
    });
  }

  // Something that solves the same problem a different way.
  const batch = new Set([...(options.alsoInstalling ?? []), ...order]);
  for (const id of order) {
    const manifest = find(components, id)?.manifest;
    for (const conflicting of manifest?.conflictsWith ?? []) {
      if (installed[conflicting] || batch.has(conflicting)) {
        conflicts.push({
          kind: 'conflicting_component',
          message: `${manifest?.name} and ${find(components, conflicting)?.manifest.name ?? conflicting} do the same job in different ways. Install one or the other.`,
          blocking: true,
        });
      }
    }
  }

  const creates: string[] = [];
  const skips: string[] = [];
  const addsDependencies: Record<string, string> = {};
  const addsModels: string[] = [];
  const needsEnv: ComponentEnv[] = [];
  const protects: string[] = [];

  // Paths another component already owns. Two components writing the same file
  // is the failure that makes a library untrustworthy: the second install
  // silently breaks the first, and the contract tests for the first component
  // are the ones that go red.
  const alreadyProtected = new Map<string, string>();
  for (const installation of record.components) {
    if (installation.status === 'removed') continue;
    for (const protectedPath of installation.protectedPaths) {
      alreadyProtected.set(protectedPath, installation.componentId);
    }
  }

  const seenTargets = new Map<string, string>();

  for (const id of order) {
    const component = find(components, id);
    if (!component) {
      conflicts.push({
        kind: 'missing_requirement',
        message: `${target.manifest.name} needs "${id}", which is not in the library.`,
        blocking: true,
      });
      continue;
    }
    const { manifest } = component;

    for (const file of manifest.files) {
      const relative = file.to.replace(/\\/g, '/');

      const owner = seenTargets.get(relative);
      if (owner && owner !== id) {
        conflicts.push({
          kind: 'file_exists',
          message: `${manifest.name} and ${find(components, owner)?.manifest.name ?? owner} both want to write ${relative}.`,
          blocking: true,
        });
        continue;
      }
      seenTargets.set(relative, id);

      const ownedBy = alreadyProtected.get(relative);
      if (ownedBy) {
        conflicts.push({
          kind: 'protected_path_overlap',
          message: `${relative} belongs to ${find(components, ownedBy)?.manifest.name ?? ownedBy}, which is already installed.`,
          blocking: true,
        });
        continue;
      }

      if (await exists(path.join(projectPath, relative))) {
        if (file.skipIfExists) {
          skips.push(relative);
        } else {
          conflicts.push({
            kind: 'file_exists',
            message: `${relative} already exists in your project and this would replace it.`,
            detail: `From ${manifest.name}.`,
            blocking: true,
          });
        }
        continue;
      }
      creates.push(relative);
    }

    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      const current = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
      const currentMajor = current ? majorOf(current) : null;
      const wantedMajor = majorOf(range);
      if (current && currentMajor !== null && wantedMajor !== null && currentMajor !== wantedMajor) {
        conflicts.push({
          kind: 'dependency_version_clash',
          message: `${manifest.name} was built against ${name} ${range}, and your project uses ${current}.`,
          detail: 'Installing anyway would probably break one of them.',
          blocking: true,
        });
        continue;
      }
      if (!current) addsDependencies[name] = range;
    }

    for (const model of [...(manifest.schema?.models ?? []), ...(manifest.schema?.enums ?? [])]) {
      if (existingModels.has(model) || addsModels.includes(model)) {
        conflicts.push({
          kind: 'schema_model_exists',
          message: `Your database already has a table called ${model}.`,
          detail: `${manifest.name} wants to create its own.`,
          blocking: true,
        });
        continue;
      }
      addsModels.push(model);
    }

    for (const variable of manifest.env ?? []) {
      if (!needsEnv.some((existing) => existing.name === variable.name)) needsEnv.push(variable);
    }

    protects.push(...protectedPathsOf(manifest));
  }

  return {
    componentId,
    version: target.manifest.version,
    order,
    creates,
    skips,
    addsDependencies,
    addsModels,
    needsEnv,
    protects: [...new Set(protects)].sort(),
    conflicts,
    installable: !conflicts.some((conflict) => conflict.blocking),
  };
}
