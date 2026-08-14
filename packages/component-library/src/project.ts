import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { ComponentEnv, ComponentInstallation } from '@shipyard/shared';

/**
 * What the installer needs to know about the project it is writing into.
 *
 * Everything here is read from the project itself rather than remembered by
 * Shipyard. A user who edits their own `package.json` or deletes a file has not
 * corrupted anything — the next plan is computed from what is actually on disk.
 */

/** The file that records what has been installed, kept in the project. */
export const INSTALL_RECORD = 'shipyard.components.json';

/** The markers the installer writes Prisma models between. */
export const SCHEMA_OPEN = '// >>> shipyard:components';
export const SCHEMA_CLOSE = '// <<< shipyard:components';

export interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

export interface InstallRecordFile {
  /** Bumped when the shape of this file changes. */
  version: 1;
  components: ComponentInstallation[];
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  const raw = await readFile(file, 'utf8').catch(() => undefined);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function readInstallRecord(projectPath: string): Promise<InstallRecordFile> {
  const found = await readJson<InstallRecordFile>(path.join(projectPath, INSTALL_RECORD));
  if (!found || !Array.isArray(found.components)) return { version: 1, components: [] };
  return found;
}

/** Installed component ids mapped to their versions. Removed ones are excluded. */
export function installedVersions(record: InstallRecordFile): Record<string, string> {
  const map: Record<string, string> = {};
  for (const installation of record.components) {
    if (installation.status === 'removed') continue;
    map[installation.componentId] = installation.version;
  }
  return map;
}

/**
 * Model and enum names already declared in the project's Prisma schema.
 *
 * A regex rather than a parser, and that is a real limitation: it reads
 * declarations, not the whole language. It is enough for the one question being
 * asked — is this name already taken — and being wrong in the cautious
 * direction produces a refusal to install, not a corrupted schema.
 */
export function declaredModels(schema: string): Set<string> {
  const names = new Set<string>();
  const declaration = /^[^\S\n]*(model|enum|type|view)\s+([A-Za-z_]\w*)\s*\{/gm;
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(schema)) !== null) {
    const name = match[2];
    if (name) names.add(name);
  }
  return names;
}

/** The major version of a dependency range, or null when it cannot be read. */
export function majorOf(range: string): number | null {
  const match = /(\d+)\.\d+\.\d+/.exec(range);
  if (!match?.[1]) return null;
  return Number.parseInt(match[1], 10);
}

/**
 * Merge a dependency into an existing set.
 *
 * Same major: keep the higher of the two, because a component tested against
 * 6.6 will not work on 6.2 and the project has no reason to prefer the older.
 * Different major: refuse, and say so. Silently upgrading somebody's ORM
 * because a component asked for it is how an install breaks unrelated code.
 */
export function mergeDependency(
  existing: string | undefined,
  wanted: string,
): { value: string; clash: boolean } {
  if (!existing) return { value: wanted, clash: false };
  if (existing === wanted) return { value: existing, clash: false };

  const existingMajor = majorOf(existing);
  const wantedMajor = majorOf(wanted);
  if (existingMajor === null || wantedMajor === null) {
    // One of them is a tag, a git URL or a workspace protocol. Leave the
    // project's choice alone rather than guessing at it.
    return { value: existing, clash: false };
  }
  if (existingMajor !== wantedMajor) return { value: existing, clash: true };

  const existingRest = /\d+\.(\d+)\.(\d+)/.exec(existing);
  const wantedRest = /\d+\.(\d+)\.(\d+)/.exec(wanted);
  const existingScore = Number(existingRest?.[1] ?? 0) * 1000 + Number(existingRest?.[2] ?? 0);
  const wantedScore = Number(wantedRest?.[1] ?? 0) * 1000 + Number(wantedRest?.[2] ?? 0);
  return { value: wantedScore > existingScore ? wanted : existing, clash: false };
}

/**
 * Put a component's models into the schema, between the markers.
 *
 * A schema with no markers gets them appended, so the installer works on a
 * project that was not created from the Shipyard template — importing an
 * existing app is a supported path and it will not have them.
 */
export function insertIntoSchema(schema: string, fragment: string, componentId: string): string {
  const block = [`\n// --- ${componentId} ---`, fragment.trim(), ''].join('\n');

  const open = schema.indexOf(SCHEMA_OPEN);
  const close = schema.indexOf(SCHEMA_CLOSE);
  if (open === -1 || close === -1 || close < open) {
    return `${schema.trimEnd()}\n\n${SCHEMA_OPEN}${block}${SCHEMA_CLOSE}\n`;
  }

  const before = schema.slice(0, close);
  const after = schema.slice(close);
  return `${before.trimEnd()}\n${block}${after}`;
}

/**
 * Take a component's models back out of the schema.
 *
 * Only the block the installer wrote, identified by its marker comment. A model
 * the user added underneath it stays; so does everything below the closing
 * marker, which is where their own tables live.
 *
 * Removing the declaration does **not** drop the table. That is deliberate and
 * it is the caller's job to say so — dropping a table takes the data in it, and
 * uninstalling a component is not a sentence anybody means as "delete my
 * customers".
 */
export function removeFromSchema(schema: string, componentId: string): string {
  const marker = `// --- ${componentId} ---`;
  const start = schema.indexOf(marker);
  if (start === -1) return schema;

  // The block runs to the next component's marker, or to the closing marker.
  const rest = schema.slice(start + marker.length);
  const nextComponent = rest.indexOf('// --- ');
  const closing = rest.indexOf(SCHEMA_CLOSE);
  const candidates = [nextComponent, closing].filter((index) => index !== -1);
  const end = candidates.length > 0 ? start + marker.length + Math.min(...candidates) : schema.length;

  return `${schema.slice(0, start).trimEnd()}\n${schema.slice(end)}`;
}

/**
 * Add variables to `.env.example`, never to `.env`.
 *
 * `.env` is the founder's secret material. Shipyard writes the template that
 * says what is needed and leaves the values to them — which is also why a
 * variable marked secret gets an empty placeholder rather than a default.
 */
export function mergeEnvExample(existing: string, vars: readonly ComponentEnv[]): string {
  const present = new Set(
    existing
      .split('\n')
      .map((line) => /^\s*(?:#\s*)?([A-Z][A-Z0-9_]*)\s*=/.exec(line)?.[1])
      .filter((name): name is string => Boolean(name)),
  );

  const additions: string[] = [];
  for (const variable of vars) {
    if (present.has(variable.name)) continue;
    additions.push(`# ${variable.description}${variable.required ? '' : ' (optional)'}`);
    if (variable.obtainFrom) additions.push(`# Get it from: ${variable.obtainFrom}`);
    // A secret gets an empty placeholder. Shipping a working default for a
    // credential is how a development key ends up in production.
    additions.push(`${variable.name}=${variable.secret ? '' : (variable.devDefault ?? '')}`);
    additions.push('');
  }

  if (additions.length === 0) return existing;
  return `${existing.trimEnd()}\n\n${additions.join('\n').trimEnd()}\n`;
}
