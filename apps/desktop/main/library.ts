import path from 'node:path';

import {
  browse,
  checkProtectedPaths,
  coverage,
  find,
  install,
  installedIn,
  loadLibrary,
  planInstall,
  protectedPathsInstruction,
  readInstallRecord,
  type BrowseOptions,
  type LibraryEntry,
} from '@shipyard/component-library';
import type {
  ComponentInstallPlan,
  ComponentInstallResult,
  ComponentManifest,
  LibraryComponent,
} from '@shipyard/shared';

import type { Metadata } from './metadata';

/**
 * The component library, from the app's point of view.
 *
 * Two responsibilities beyond wrapping the engine. It finds the components on
 * disk, which differs between the repository and the packaged app. And it keeps
 * the project's `CLAUDE.md` current after every install, because that file is
 * how the agent finds out which parts of the project it must not rewrite — a
 * protected path nobody told the agent about is a wish.
 */

/**
 * Where the components live.
 *
 * Unlike the skills, which are copied into `apps/desktop/resources`, the
 * library sits at the top of the repository next to `shipyard-catalog` — both
 * are data the product is built around rather than assets belonging to the
 * desktop app, and both are meant to be reviewable as a diff. electron-builder
 * copies it into the packaged app's resources at build time.
 */
export function componentsRoot(packaged: boolean, dirname: string): string {
  return packaged
    ? path.join(process.resourcesPath, 'components')
    : // dist/main → dist → desktop → apps → the repository root
      path.join(dirname, '..', '..', '..', '..', 'components');
}

export interface LibraryOptions {
  /** Where the component directories live. */
  root: string;
  /** Gate ids the verification runner knows, so a manifest cannot invent one. */
  knownGates?: readonly string[];
  knownCapabilities?: readonly string[];
  metadata?: Metadata;
}

export class Library {
  private components: LibraryComponent[] | null = null;
  private failure: string | null = null;

  constructor(private readonly options: LibraryOptions) {}

  /**
   * Load once, and remember a failure rather than retrying it on every call.
   *
   * A library that fails to load is a packaging problem, not a transient one.
   * Retrying it per keystroke in the search box would turn one clear error into
   * a stuttering UI.
   */
  private async load(): Promise<LibraryComponent[]> {
    if (this.components) return this.components;
    if (this.failure) throw new Error(this.failure);
    try {
      this.components = await loadLibrary(this.options.root, {
        ...(this.options.knownGates ? { knownGates: this.options.knownGates } : {}),
        ...(this.options.knownCapabilities ? { knownCapabilities: this.options.knownCapabilities } : {}),
      });
      return this.components;
    } catch (error) {
      this.failure = `The component library could not be read: ${(error as Error).message}`;
      throw new Error(this.failure);
    }
  }

  /** The list to show, ordered by what this project actually needs. */
  async list(projectPath?: string, options: Omit<BrowseOptions, 'installed'> = {}): Promise<LibraryEntry[]> {
    const components = await this.load();
    const installed = projectPath ? await installedIn(projectPath).catch(() => ({})) : {};
    return browse(components, { ...options, installed });
  }

  async detail(id: string): Promise<ComponentManifest | null> {
    return find(await this.load(), id)?.manifest ?? null;
  }

  async plan(id: string, projectPath: string): Promise<ComponentInstallPlan> {
    return planInstall(await this.load(), id, projectPath);
  }

  /** Install, then tell the agent what it may no longer touch. */
  async install(id: string, projectPath: string, projectId?: string): Promise<ComponentInstallResult> {
    const components = await this.load();
    const result = await install(components, id, projectPath);
    if (!result.installed) return result;

    await this.refreshAgentInstructions(projectPath);

    if (projectId && this.options.metadata) {
      const record = await readInstallRecord(projectPath);
      for (const installation of record.components) {
        this.options.metadata.recordComponentInstall(projectId, installation);
      }
      this.options.metadata.record({
        id: `${projectId}:${id}:${stamp()}`,
        projectId,
        type: 'component_installed',
        at: new Date().toISOString(),
        payload: { component: id, files: result.filesWritten.length },
      });
    }

    return result;
  }

  async installed(projectPath: string): Promise<Record<string, string>> {
    return installedIn(projectPath).catch(() => ({}));
  }

  /** Has anything rewritten a component since it was installed? */
  async tampering(projectPath: string) {
    return checkProtectedPaths(projectPath).catch(() => []);
  }

  /** How much of what this project needs the library can supply. */
  async coverageFor(plan: Parameters<typeof coverage>[1]) {
    return coverage(await this.load(), plan);
  }

  /**
   * Keep the "do not rewrite these" section of CLAUDE.md accurate.
   *
   * Rewritten in place between markers rather than appended, so ten installs
   * leave one section rather than ten. Everything outside the markers is the
   * user's and is never touched.
   */
  private async refreshAgentInstructions(projectPath: string): Promise<void> {
    const { readFile, writeFile } = await import('node:fs/promises');
    const file = path.join(projectPath, 'CLAUDE.md');
    const record = await readInstallRecord(projectPath);
    const section = protectedPathsInstruction(record.components);
    if (!section) return;

    const OPEN = '<!-- shipyard:components -->';
    const CLOSE = '<!-- /shipyard:components -->';
    const block = `${OPEN}\n${section}${CLOSE}\n`;

    const existing = await readFile(file, 'utf8').catch(() => '');
    const start = existing.indexOf(OPEN);
    const end = existing.indexOf(CLOSE);

    const next =
      start !== -1 && end !== -1 && end > start
        ? existing.slice(0, start) + block + existing.slice(end + CLOSE.length)
        : `${existing.trimEnd()}${existing.trim() ? '\n\n' : ''}${block}`;

    await writeFile(file, next, 'utf8').catch(() => undefined);
  }
}

/** A stable-enough id for the telemetry row. */
function stamp(): string {
  return new Date().toISOString().replace(/[^0-9]/g, '');
}
