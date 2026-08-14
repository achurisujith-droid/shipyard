import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import type { ComponentManifest, LibraryComponent } from '@shipyard/shared';

/**
 * Read the component library off disk, and refuse to load a broken one.
 *
 * The validation here is deliberately unforgiving, for the same reason the
 * rulebook loader is. A component library is a promise that installing
 * something is safer than generating it. A manifest that points at a file which
 * is not there, or claims a gate nothing runs, or vendors code with no licence,
 * breaks that promise quietly — the install appears to work and the problem
 * surfaces later, in someone else's project, with no obvious cause.
 *
 * Loud at load time, in a repository, in front of whoever added it.
 */

const ID_RE = /^[a-z][a-z0-9_]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface LoadOptions {
  /**
   * Gate ids the verification runner knows how to run. When supplied, a
   * component claiming to satisfy an unknown gate is an error: readiness would
   * otherwise be scored against a check that does not exist.
   */
  knownGates?: readonly string[];
  /** Capability ids from the catalog, checked the same way. */
  knownCapabilities?: readonly string[];
}

function fail(id: string, message: string): never {
  throw new Error(`component "${id}": ${message}`);
}

/** A path that stays inside the project it is being written into. */
function safeTarget(id: string, to: string): void {
  if (!to) fail(id, 'a file has no destination');
  if (path.isAbsolute(to) || /^[A-Za-z]:/.test(to)) fail(id, `"${to}" is an absolute path`);
  const normalised = path.posix.normalize(to.replace(/\\/g, '/'));
  if (normalised.startsWith('..')) fail(id, `"${to}" escapes the project directory`);
  if (normalised.includes('\0')) fail(id, `"${to}" is not a usable path`);
}

/**
 * The paths the agent must not rewrite.
 *
 * Derived from the manifest rather than declared, so a component cannot forget
 * to protect its own implementation. Anything the manifest declares explicitly
 * is added on top — a component may protect more than its own files, never
 * fewer.
 */
export function protectedPathsOf(manifest: ComponentManifest): string[] {
  const derived = manifest.files
    .filter((file) => file.role === 'source' || file.role === 'test')
    .map((file) => file.to.replace(/\\/g, '/'));
  return [...new Set([...derived, ...(manifest.protectedPaths ?? [])])].sort();
}

function validate(manifest: ComponentManifest, options: LoadOptions): void {
  const id = manifest.id ?? '(no id)';
  if (!ID_RE.test(id)) fail(id, 'the id must be lower_snake_case');
  if (!SEMVER_RE.test(manifest.version ?? '')) fail(id, `"${manifest.version}" is not a version`);
  if (!manifest.name?.trim()) fail(id, 'needs a name a person would read');
  if (!manifest.summary?.trim()) fail(id, 'needs a one-line summary');

  // --- provenance ---------------------------------------------------------
  // The whole point of a library sourced from other people's work is that the
  // founder inherits code, not liability they cannot see.
  const provenance = manifest.provenance;
  if (!provenance) fail(id, 'has no provenance — where did this code come from?');
  if (!provenance.license?.trim()) fail(id, 'has no licence');
  if (provenance.origin !== 'authored') {
    if (!provenance.source?.trim()) fail(id, `is ${provenance.origin} but does not say from what`);
    if (!provenance.sourceUrl?.trim()) fail(id, `is ${provenance.origin} but gives no source URL`);
  }

  // --- files --------------------------------------------------------------
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    fail(id, 'installs no files');
  }
  const targets = new Set<string>();
  for (const file of manifest.files) {
    safeTarget(id, file.to);
    if (targets.has(file.to)) fail(id, `writes "${file.to}" twice`);
    targets.add(file.to);
    if (!file.from?.trim()) fail(id, `"${file.to}" has no source file`);
  }

  // --- what it claims to prove --------------------------------------------
  if (options.knownGates) {
    const known = new Set(options.knownGates);
    for (const gate of manifest.satisfies ?? []) {
      if (!known.has(gate)) fail(id, `claims to satisfy "${gate}", which nothing runs`);
    }
  }
  if (options.knownCapabilities) {
    const known = new Set(options.knownCapabilities);
    for (const capability of manifest.provides ?? []) {
      if (!known.has(capability)) fail(id, `provides "${capability}", which is not in the catalog`);
    }
  }

  // A component is `verified` because something ran, not because it looks
  // finished. Without a contract test there is nothing that could have run.
  if (manifest.trust === 'verified' && !manifest.contractTest?.command) {
    fail(id, 'is marked verified but has no contract test to have verified it');
  }
  if (manifest.contractTest && !manifest.files.some((file) => file.role === 'test')) {
    fail(id, 'has a contract test command but ships no test files');
  }

  // --- environment --------------------------------------------------------
  for (const env of manifest.env ?? []) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(env.name)) fail(id, `"${env.name}" is not an environment variable name`);
    if (!env.description?.trim()) fail(id, `${env.name} has no explanation`);
    if (env.secret && env.devDefault) {
      fail(id, `${env.name} is a secret and must not ship a default value`);
    }
  }

  // --- schema -------------------------------------------------------------
  if (manifest.schema) {
    if (!manifest.schema.file?.trim()) fail(id, 'declares a schema with no file');
    if (!manifest.schema.models?.length && !manifest.schema.enums?.length) {
      fail(id, 'declares a schema that adds nothing');
    }
  }
}

/** Load one component directory. */
export async function loadComponent(
  directory: string,
  options: LoadOptions = {},
): Promise<LibraryComponent> {
  const manifestPath = path.join(directory, 'component.json');
  const raw = await readFile(manifestPath, 'utf8');
  let manifest: ComponentManifest;
  try {
    manifest = JSON.parse(raw) as ComponentManifest;
  } catch (error) {
    throw new Error(`${manifestPath}: not valid JSON — ${(error as Error).message}`);
  }

  const folder = path.basename(directory);
  if (manifest.id !== folder) {
    fail(manifest.id ?? folder, `lives in a folder called "${folder}"`);
  }

  validate(manifest, options);

  // Every file the manifest promises has to actually be there. This is the
  // check that catches a rename, and it is worth the disk reads.
  for (const file of manifest.files) {
    const source = path.join(directory, file.from);
    const found = await stat(source).catch(() => null);
    if (!found?.isFile()) fail(manifest.id, `${file.from} is missing`);
  }
  if (manifest.schema) {
    const source = path.join(directory, manifest.schema.file);
    const found = await stat(source).catch(() => null);
    if (!found?.isFile()) fail(manifest.id, `${manifest.schema.file} is missing`);
  }

  return { manifest, directory };
}

/** Load the whole library, checking that it hangs together. */
export async function loadLibrary(
  root: string,
  options: LoadOptions = {},
): Promise<LibraryComponent[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();

  const components: LibraryComponent[] = [];
  for (const name of directories) {
    const manifestPath = path.join(root, name, 'component.json');
    const exists = await stat(manifestPath).catch(() => null);
    if (!exists) continue;
    components.push(await loadComponent(path.join(root, name), options));
  }

  const byId = new Map<string, LibraryComponent>();
  for (const component of components) {
    if (byId.has(component.manifest.id)) fail(component.manifest.id, 'is defined twice');
    byId.set(component.manifest.id, component);
  }

  // Cross-references, checked once the whole set is known.
  for (const { manifest } of components) {
    for (const required of manifest.requires ?? []) {
      if (!byId.has(required)) fail(manifest.id, `needs "${required}", which is not in the library`);
      if (required === manifest.id) fail(manifest.id, 'requires itself');
    }
    for (const conflict of manifest.conflictsWith ?? []) {
      if (!byId.has(conflict)) fail(manifest.id, `conflicts with "${conflict}", which does not exist`);
    }
  }

  // A cycle in `requires` is an install that never terminates. Find it here
  // rather than at somebody's project.
  const state = new Map<string, 'visiting' | 'done'>();
  const walk = (id: string, trail: string[]): void => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      throw new Error(`components depend on each other in a loop: ${[...trail, id].join(' → ')}`);
    }
    state.set(id, 'visiting');
    for (const required of byId.get(id)?.manifest.requires ?? []) walk(required, [...trail, id]);
    state.set(id, 'done');
  };
  for (const component of components) walk(component.manifest.id, []);

  return components;
}
