import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ToolchainStatus } from '@shipyard/shared';

export type { ToolchainStatus };

/**
 * The Node and PostgreSQL runtimes Shipyard ships with.
 *
 * A Shipyard user has not installed Node and has not installed Postgres, and
 * asking them to is asking them to stop. So the app carries both, fetched at
 * build time by `scripts/fetch-toolchain.mjs`, and puts them on the front of
 * PATH for anything it runs on the user's behalf.
 *
 * Deliberately a real Node build rather than Electron running as Node. Under
 * ELECTRON_RUN_AS_NODE the module ABI is Electron's (148, versus Node 24's
 * 137), so a project that installs any native dependency would get binaries
 * that work here and fail the moment that same project is deployed. Local and
 * deployed must not diverge silently.
 */
export interface ToolchainManifest {
  nodeVersion: string;
  postgresVersion: string;
  postgresPackageVersion: string;
  platform: string;
  arch: string;
}

export interface ToolchainOptions {
  /**
   * `resources/toolchain/<platform>-<arch>`: inside the packaged app's
   * resources, or in the repo during development.
   */
  root: string;
  /** Where npm keeps its download cache, so it stays out of the user's home. */
  cacheDir: string;
  /** Only changes the wording when the toolchain is missing. */
  packaged?: boolean;
}

/** The directory the build script writes to, for this machine's platform. */
export function toolchainRoot(base: string): string {
  return path.join(base, 'resources', 'toolchain', `${process.platform}-${process.arch}`);
}

export class Toolchain {
  private manifest: ToolchainManifest | null = null;
  private loaded = false;

  readonly root: string;

  // Electron is deliberately not imported here: the runtimes have to be
  // testable from a plain Node script, outside the app.
  constructor(private readonly options: ToolchainOptions) {
    this.root = options.root;
  }

  /**
   * Directory to put first on PATH. Node's Windows archive is flat; on macOS
   * and Linux the executables are under `bin/`.
   */
  get nodeBinDir(): string {
    const nodeRoot = path.join(this.root, 'node');
    return process.platform === 'win32' ? nodeRoot : path.join(nodeRoot, 'bin');
  }

  get nodeExe(): string {
    return path.join(this.nodeBinDir, process.platform === 'win32' ? 'node.exe' : 'node');
  }

  get postgresBinDir(): string {
    return path.join(this.root, 'postgres', 'bin');
  }

  async status(): Promise<ToolchainStatus> {
    const manifest = await this.read();
    if (!manifest) {
      return {
        ready: false,
        reason: this.options.packaged
          ? 'This copy of Shipyard is missing its built-in tools. Reinstalling should fix it.'
          : 'Toolchain not fetched. Run: npm run toolchain -w @shipyard/desktop',
      };
    }
    return {
      ready: true,
      nodeVersion: manifest.nodeVersion,
      postgresVersion: manifest.postgresVersion,
    };
  }

  async read(): Promise<ToolchainManifest | null> {
    if (this.loaded) return this.manifest;
    this.loaded = true;
    try {
      const raw = await readFile(path.join(this.root, 'toolchain.json'), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && 'nodeVersion' in parsed) {
        this.manifest = parsed as ToolchainManifest;
      }
    } catch {
      this.manifest = null;
    }
    return this.manifest;
  }

  /**
   * The environment to run a user's project in.
   *
   * Our runtimes go on the FRONT of PATH so they win over anything the user
   * happens to have installed. That is the point: every Shipyard user gets the
   * same Node, so a project that works on one machine works on the next.
   */
  decorateEnv(base: NodeJS.ProcessEnv, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...base, ...extra };

    // Windows environment keys are case-insensitive but a plain object's are
    // not, so an inherited `Path` would sit alongside our `PATH` and win.
    const pathKey =
      Object.keys(env).find((key) => key.toLowerCase() === 'path' && key !== 'PATH') ?? 'PATH';
    const existing = env[pathKey] ?? '';
    if (pathKey !== 'PATH') delete env[pathKey];

    env['PATH'] = [this.nodeBinDir, this.postgresBinDir, existing]
      .filter((segment) => segment.length > 0)
      .join(path.delimiter);

    // npm otherwise writes its cache and logs under the user's home, mixing
    // Shipyard's installs with any real development they may do later.
    env['npm_config_cache'] = this.options.cacheDir;
    // Native addons that do build from source should target the runtime we
    // ship, not whatever built this Electron app.
    env['npm_config_runtime'] = 'node';
    delete env['ELECTRON_RUN_AS_NODE'];

    return env;
  }
}
