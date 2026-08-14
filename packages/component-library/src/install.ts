import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ComponentInstallation, ComponentInstallResult, LibraryComponent } from '@shipyard/shared';

import { protectedPathsOf } from './load';
import {
  INSTALL_RECORD,
  insertIntoSchema,
  installedVersions,
  mergeDependency,
  mergeEnvExample,
  readInstallRecord,
  readJson,
  writeJson,
  type InstallRecordFile,
  type PackageJson,
} from './project';
import { planInstall } from './plan';
import { find } from './registry';

/**
 * Actually put the component in the project.
 *
 * Two rules govern everything below. **Never write over something the founder
 * already has** — the planner refuses first, and this refuses again rather than
 * trusting a plan that may have been computed minutes ago. And **leave nothing
 * half-done**: if any step fails, every file written by this call is removed
 * again, because a partial install is worse than no install and much harder to
 * notice.
 */

export const PROTECTED_FILE = path.join('.shipyard', 'protected.json');

export interface ProtectedRecord {
  version: 1;
  /** Path → the component that owns it and the hash it was installed with. */
  paths: Record<string, { componentId: string; sha256: string }>;
}

async function sha256(file: string): Promise<string> {
  const contents = await readFile(file);
  return createHash('sha256').update(contents).digest('hex');
}

/** Install one component, with everything it needs, or nothing at all. */
export async function install(
  components: readonly LibraryComponent[],
  componentId: string,
  projectPath: string,
): Promise<ComponentInstallResult> {
  const target = find(components, componentId);
  const result: ComponentInstallResult = {
    componentId,
    version: target?.manifest.version ?? '0.0.0',
    installed: false,
    filesWritten: [],
    nextSteps: [],
    errors: [],
  };

  if (!target) {
    result.errors.push(`There is no component called "${componentId}" in the library.`);
    return result;
  }

  const plan = await planInstall(components, componentId, projectPath);
  if (!plan.installable) {
    result.errors.push(...plan.conflicts.filter((c) => c.blocking).map((c) => c.message));
    return result;
  }

  const written: string[] = [];
  // Anything mutated rather than created is snapshotted so the rollback can put
  // it back exactly as it was.
  const restore: { file: string; contents: string | null }[] = [];

  const snapshot = async (relative: string): Promise<void> => {
    const absolute = path.join(projectPath, relative);
    const contents = await readFile(absolute, 'utf8').catch(() => null);
    restore.push({ file: absolute, contents });
  };

  try {
    const record = await readInstallRecord(projectPath);
    const installedAt = new Date().toISOString();
    const installations: ComponentInstallation[] = [];

    for (const id of plan.order) {
      const component = find(components, id);
      if (!component) throw new Error(`"${id}" disappeared from the library mid-install`);
      const { manifest, directory } = component;
      const componentFiles: string[] = [];

      // --- files ----------------------------------------------------------
      for (const file of manifest.files) {
        const relative = file.to.replace(/\\/g, '/');
        const absolute = path.join(projectPath, relative);
        if (plan.skips.includes(relative)) continue;
        await mkdir(path.dirname(absolute), { recursive: true });
        await copyFile(path.join(directory, file.from), absolute);
        written.push(absolute);
        componentFiles.push(relative);
      }

      // --- package.json ----------------------------------------------------
      const packagePath = path.join(projectPath, 'package.json');
      const pkg = (await readJson<PackageJson>(packagePath)) ?? {};
      if (manifest.dependencies || manifest.devDependencies || manifest.scripts) {
        await snapshot('package.json');

        for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
          pkg.dependencies ??= {};
          const merged = mergeDependency(pkg.dependencies[name] ?? pkg.devDependencies?.[name], range);
          if (merged.clash) throw new Error(`${name} ${range} clashes with what the project already uses`);
          if (!pkg.devDependencies?.[name]) pkg.dependencies[name] = merged.value;
        }
        for (const [name, range] of Object.entries(manifest.devDependencies ?? {})) {
          pkg.devDependencies ??= {};
          const merged = mergeDependency(pkg.devDependencies[name] ?? pkg.dependencies?.[name], range);
          if (merged.clash) throw new Error(`${name} ${range} clashes with what the project already uses`);
          if (!pkg.dependencies?.[name]) pkg.devDependencies[name] = merged.value;
        }
        for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
          pkg.scripts ??= {};
          // Never replace a script the project already defines. `npm test`
          // meaning something different after an install is exactly the kind of
          // surprise that makes people distrust the tool.
          if (!pkg.scripts[name]) pkg.scripts[name] = command;
        }

        // Sorted, so an install is a readable diff rather than a reshuffle.
        if (pkg.dependencies) pkg.dependencies = sortKeys(pkg.dependencies);
        if (pkg.devDependencies) pkg.devDependencies = sortKeys(pkg.devDependencies);
        await writeJson(packagePath, pkg);
      }

      // --- prisma schema ----------------------------------------------------
      if (manifest.schema) {
        const schemaPath = path.join(projectPath, 'prisma', 'schema.prisma');
        const current = await readFile(schemaPath, 'utf8').catch(() => null);
        if (current === null) {
          throw new Error('this component needs a database, and the project has no prisma/schema.prisma');
        }
        await snapshot(path.join('prisma', 'schema.prisma'));
        const fragment = await readFile(path.join(directory, manifest.schema.file), 'utf8');
        await writeFile(schemaPath, insertIntoSchema(current, fragment, manifest.id), 'utf8');
      }

      // --- .env.example -----------------------------------------------------
      if (manifest.env?.length) {
        const envPath = path.join(projectPath, '.env.example');
        const current = await readFile(envPath, 'utf8').catch(() => '');
        await snapshot('.env.example');
        await writeFile(envPath, mergeEnvExample(current, manifest.env), 'utf8');
      }

      installations.push({
        componentId: manifest.id,
        version: manifest.version,
        installedAt,
        files: componentFiles,
        protectedPaths: protectedPathsOf(manifest),
        status: 'installed',
      });

      for (const step of manifest.postInstall ?? []) result.nextSteps.push(step);
      for (const variable of manifest.env ?? []) {
        if (variable.required && variable.secret) {
          result.nextSteps.push(
            `Put your ${variable.name} in the .env file${variable.obtainFrom ? ` — get it from ${variable.obtainFrom}` : ''}.`,
          );
        }
      }
    }

    // --- what is now off limits --------------------------------------------
    await snapshot(PROTECTED_FILE);
    await writeProtectedRecord(projectPath, installations);

    // --- the install record --------------------------------------------------
    await snapshot(INSTALL_RECORD);
    const next: InstallRecordFile = {
      version: 1,
      components: [
        ...record.components.filter(
          (existing) => !installations.some((added) => added.componentId === existing.componentId),
        ),
        ...installations,
      ],
    };
    await writeJson(path.join(projectPath, INSTALL_RECORD), next);

    result.installed = true;
    result.filesWritten = written.map((file) => path.relative(projectPath, file).replace(/\\/g, '/'));
    result.contractCommand = target.manifest.contractTest?.command;
    if (plan.addsModels.length > 0) {
      result.nextSteps.unshift('Update your database so it has the new tables — Shipyard can do this for you.');
    }
    return result;
  } catch (error) {
    // Put the project back the way it was. An install that fails halfway and
    // leaves debris is the reason people stop trusting installers.
    for (const file of written) await rm(file, { force: true }).catch(() => undefined);
    for (const entry of restore.reverse()) {
      if (entry.contents === null) await rm(entry.file, { force: true }).catch(() => undefined);
      else await writeFile(entry.file, entry.contents, 'utf8').catch(() => undefined);
    }
    result.installed = false;
    result.filesWritten = [];
    result.errors.push((error as Error).message);
    return result;
  }
}

function sortKeys(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

async function writeProtectedRecord(
  projectPath: string,
  installations: readonly ComponentInstallation[],
): Promise<void> {
  const file = path.join(projectPath, PROTECTED_FILE);
  const current = (await readJson<ProtectedRecord>(file)) ?? { version: 1 as const, paths: {} };

  for (const installation of installations) {
    for (const relative of installation.protectedPaths) {
      const absolute = path.join(projectPath, relative);
      const hash = await sha256(absolute).catch(() => null);
      if (!hash) continue;
      current.paths[relative] = { componentId: installation.componentId, sha256: hash };
    }
  }

  await writeJson(file, current);
}

/** One file that no longer matches what was installed. */
export interface ProtectedPathChange {
  path: string;
  componentId: string;
  status: 'modified' | 'deleted';
}

/**
 * Has anything rewritten a verified component?
 *
 * Worth being precise about what this is: **detection, not prevention.**
 * Shipyard cannot stop an agent writing to a file — it drives Claude Code
 * through a terminal, and the agent has the same filesystem access the user
 * does. What it can do is notice, and refuse to keep calling the component
 * verified afterwards.
 *
 * That distinction is the honest version of "protected paths". The instruction
 * in the project's CLAUDE.md is what usually keeps the agent out; this is what
 * catches the times it does not.
 */
export async function checkProtectedPaths(projectPath: string): Promise<ProtectedPathChange[]> {
  const record = await readJson<ProtectedRecord>(path.join(projectPath, PROTECTED_FILE));
  if (!record) return [];

  const changed: ProtectedPathChange[] = [];
  for (const [relative, expected] of Object.entries(record.paths)) {
    const hash = await sha256(path.join(projectPath, relative)).catch(() => null);
    if (hash === null) {
      changed.push({ path: relative, componentId: expected.componentId, status: 'deleted' });
    } else if (hash !== expected.sha256) {
      changed.push({ path: relative, componentId: expected.componentId, status: 'modified' });
    }
  }
  return changed.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The paragraph the agent reads before it starts.
 *
 * Written into the project's CLAUDE.md, because the agent is Claude Code and
 * this is the mechanism it actually respects. Regenerated on every install so
 * it never lists a component that has been removed.
 */
export function protectedPathsInstruction(installations: readonly ComponentInstallation[]): string {
  const live = installations.filter((installation) => installation.status !== 'removed');
  if (live.length === 0) return '';

  const lines = [
    '## Installed components — do not rewrite these',
    '',
    'The files below came from the Shipyard component library. They are already',
    'tested and their tests are what proves this project is safe to launch.',
    'Rewriting them turns a verified component into an unverified one.',
    '',
    'If one of them is wrong, change the code that calls it, or say that the',
    'component itself needs fixing. Do not edit inside these paths:',
    '',
  ];
  for (const installation of live) {
    lines.push(`- **${installation.componentId}** ${installation.version}`);
    for (const protectedPath of installation.protectedPaths) lines.push(`  - \`${protectedPath}\``);
  }
  lines.push('', 'Everything else in the project is yours to change.', '');
  return lines.join('\n');
}

/** Which components a project has, for the browse list. */
export async function installedIn(projectPath: string): Promise<Record<string, string>> {
  return installedVersions(await readInstallRecord(projectPath));
}
