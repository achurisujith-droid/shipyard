import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { LibraryComponent, RemovalPlan, RemovalResult } from '@shipyard/shared';

import { checkProtectedPaths, PROTECTED_FILE, type ProtectedRecord } from './install';
import {
  INSTALL_RECORD,
  installedVersions,
  readInstallRecord,
  readJson,
  removeFromSchema,
  writeJson,
} from './project';
import { find } from './registry';

/**
 * Taking a component back out.
 *
 * Shipping an installer with no way back was the larger of the two gaps in this
 * package, because it makes trying something a one-way decision — and a library
 * you cannot back out of is one people stop experimenting with.
 *
 * Two things are deliberately *not* undone, and both are said out loud rather
 * than done quietly:
 *
 * **The database tables stay.** Removing the model from the schema does not drop
 * the table, and nothing here generates a migration that would. "Uninstall the
 * audit log component" is not a sentence anybody means as "delete the record of
 * everything that has happened".
 *
 * **The npm packages stay.** Another component, or the user's own code, may have
 * started using one. Removing a dependency to tidy up is how an uninstall breaks
 * something unrelated.
 */

/** What removing this would do. Writes nothing. */
export async function planRemoval(
  components: readonly LibraryComponent[],
  componentId: string,
  projectPath: string,
): Promise<RemovalPlan> {
  const record = await readInstallRecord(projectPath);
  const installed = record.components.find(
    (entry) => entry.componentId === componentId && entry.status !== 'removed',
  );
  const manifest = find(components, componentId)?.manifest;

  const plan: RemovalPlan = {
    componentId,
    version: installed?.version ?? '0.0.0',
    removes: [],
    modified: [],
    orphanedTables: manifest?.schema
      ? [...manifest.schema.models, ...(manifest.schema.enums ?? [])]
      : [],
    keptDependencies: Object.keys(manifest?.dependencies ?? {}),
    problems: [],
    removable: false,
  };

  if (!installed) {
    plan.problems.push('That is not installed, so there is nothing to take out.');
    return plan;
  }

  // Anything that needs this would stop working. Removing it and letting the
  // build break afterwards would be a worse answer than refusing now.
  const live = new Set(installedVersions(record) ? Object.keys(installedVersions(record)) : []);
  for (const other of components) {
    if (!live.has(other.manifest.id) || other.manifest.id === componentId) continue;
    if (other.manifest.requires?.includes(componentId)) {
      plan.problems.push(
        `${other.manifest.name} needs this and is also installed. Take that out first.`,
      );
    }
  }

  const changed = new Map(
    (await checkProtectedPaths(projectPath)).map((change) => [change.path, change.status]),
  );
  for (const file of installed.files) {
    if (changed.get(file) === 'modified') plan.modified.push(file);
    else plan.removes.push(file);
  }

  plan.removable = plan.problems.length === 0;
  return plan;
}

/** Take it out. */
export async function uninstall(
  components: readonly LibraryComponent[],
  componentId: string,
  projectPath: string,
): Promise<RemovalResult> {
  const result: RemovalResult = {
    componentId,
    removed: false,
    filesRemoved: [],
    filesKept: [],
    notes: [],
    errors: [],
  };

  const plan = await planRemoval(components, componentId, projectPath);
  if (!plan.removable) {
    result.errors.push(...plan.problems);
    return result;
  }

  const manifest = find(components, componentId)?.manifest;

  for (const relative of plan.removes) {
    await rm(path.join(projectPath, relative), { force: true }).catch(() => undefined);
    result.filesRemoved.push(relative);
  }

  // A file somebody edited is theirs now. Deleting it because it started life
  // as ours would throw away work that was deliberate.
  for (const relative of plan.modified) {
    result.filesKept.push(relative);
  }
  if (plan.modified.length > 0) {
    result.notes.push(
      `${plan.modified.length} file${plan.modified.length === 1 ? ' was' : 's were'} changed since they were installed, so they have been left alone.`,
    );
  }

  if (manifest?.schema) {
    const schemaPath = path.join(projectPath, 'prisma', 'schema.prisma');
    const current = await readFile(schemaPath, 'utf8').catch(() => null);
    if (current !== null) {
      await writeFile(schemaPath, removeFromSchema(current, componentId), 'utf8').catch(() => undefined);
    }
    result.notes.push(
      `The ${plan.orphanedTables.join(', ')} table${plan.orphanedTables.length === 1 ? '' : 's'} still exist in your database with the data in them. Nothing here deletes them — that is a decision for you.`,
    );
  }

  if (plan.keptDependencies.length > 0) {
    result.notes.push(
      'The extra packages it installed have been left in place, in case something else started using them.',
    );
  }

  // Free the protected paths, or nothing could ever be installed there again.
  const protectedFile = path.join(projectPath, PROTECTED_FILE);
  const protectedRecord = await readJson<ProtectedRecord>(protectedFile);
  if (protectedRecord) {
    for (const [relative, entry] of Object.entries(protectedRecord.paths)) {
      if (entry.componentId === componentId) delete protectedRecord.paths[relative];
    }
    await writeJson(protectedFile, protectedRecord);
  }

  const record = await readInstallRecord(projectPath);
  await writeJson(path.join(projectPath, INSTALL_RECORD), {
    version: 1 as const,
    // Dropped rather than marked `removed`. The record answers "what is in this
    // project", and a list of tombstones makes that question harder to read.
    components: record.components.filter((entry) => entry.componentId !== componentId),
  });

  result.removed = true;
  return result;
}

export type { RemovalPlan, RemovalResult };
