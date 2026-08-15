import path from 'node:path';

import {
  browse,
  CATALOGUE_FILE,
  catalogueMarkdown,
  checkProtectedPaths,
  coverage,
  find,
  install,
  installedIn,
  loadLibrary,
  planInstall,
  planRemoval,
  planUpgrade,
  protectedPathsInstruction,
  readInstallRecord,
  uninstall,
  upgrade,
  type BrowseOptions,
  type LibraryEntry,
} from '@shipyard/component-library';
import type {
  ComponentInstallPlan,
  ComponentInstallResult,
  ComponentManifest,
  LibraryComponent,
  RemovalPlan,
  RemovalResult,
  UpgradePlan,
  UpgradeResult,
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
  /**
   * Called after anything that changes what the project is made of, so the
   * documents describing it can be rewritten. A failure here is logged and
   * swallowed by the caller — stale documentation must not fail an install.
   */
  onChanged?: (projectPath: string, projectId?: string) => Promise<void>;
  /** Where a person can browse the same list. Shown in the catalogue, never fetched. */
  libraryUrl?: string;
  /** How many components are planned but do not exist, so the agent is not told to install one. */
  planned?: number;
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
    await this.writeCatalogue(projectPath).catch(() => undefined);
    await this.options.onChanged?.(projectPath, projectId).catch(() => undefined);

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

  async planRemoval(id: string, projectPath: string): Promise<RemovalPlan> {
    return planRemoval(await this.load(), id, projectPath);
  }

  /** Take it out, then correct what the agent has been told it may not touch. */
  async uninstall(id: string, projectPath: string, projectId?: string): Promise<RemovalResult> {
    const result = await uninstall(await this.load(), id, projectPath);
    if (!result.removed) return result;

    await this.refreshAgentInstructions(projectPath);
    await this.writeCatalogue(projectPath).catch(() => undefined);
    await this.options.onChanged?.(projectPath, projectId).catch(() => undefined);
    if (projectId && this.options.metadata) {
      this.options.metadata.markComponentRemoved(projectId, id);
    }
    return result;
  }

  async planUpgrade(id: string, projectPath: string): Promise<UpgradePlan> {
    return planUpgrade(await this.load(), id, projectPath);
  }

  async upgrade(id: string, projectPath: string, projectId?: string): Promise<UpgradeResult> {
    const result = await upgrade(await this.load(), id, projectPath);
    if (!result.upgraded) return result;

    await this.refreshAgentInstructions(projectPath);
    await this.writeCatalogue(projectPath).catch(() => undefined);
    await this.options.onChanged?.(projectPath, projectId).catch(() => undefined);
    if (projectId && this.options.metadata) {
      const record = await readInstallRecord(projectPath);
      const installation = record.components.find((entry) => entry.componentId === id);
      if (installation) this.options.metadata.recordComponentInstall(projectId, installation);
    }
    return result;
  }

  async installed(projectPath: string): Promise<Record<string, string>> {
    return installedIn(projectPath).catch(() => ({}));
  }

  /**
   * Write the catalogue into the project.
   *
   * Called after anything that changes what is installed, and at project
   * creation, so the list the agent reads is never describing a library from
   * three releases ago.
   */
  async writeCatalogue(projectPath: string): Promise<void> {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const components = await this.load();
    const installed = Object.keys(await installedIn(projectPath).catch(() => ({})));
    const file = path.join(projectPath, CATALOGUE_FILE);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      catalogueMarkdown(components, {
        installed,
        ...(this.options.libraryUrl ? { url: this.options.libraryUrl } : {}),
        ...(this.options.planned ? { planned: this.options.planned } : {}),
      }),
      'utf8',
    );
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
