import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import type { Toolchain } from './toolchain';

/**
 * Runs a real PostgreSQL server for a user's project.
 *
 * Not Docker. Docker Desktop needs a gigabyte of disk, administrator rights,
 * hardware virtualisation switched on in firmware, and a paid licence above a
 * company-size threshold — four things a Shipyard user cannot be asked to
 * arrange. Postgres is just a program; it does not need a virtual machine
 * around it to run one database on one laptop.
 *
 * One cluster per project, so deleting a project takes its data with it and
 * two projects can never collide on a table name.
 */
export interface DatabaseHandle {
  /** What the user's app should connect to. */
  url: string;
  port: number;
  dataDir: string;
}

interface Cluster {
  handle: DatabaseHandle;
  dataDir: string;
}

/**
 * The database a project's app connects to.
 *
 * `initdb` creates this one, and each project gets a cluster to itself, so a
 * separate `app` database would add a step and buy no isolation. It would also
 * need a client tool to create it, and the binaries we ship are the server
 * only: `initdb`, `pg_ctl`, `postgres`. No `psql`.
 */
const DATABASE_NAME = 'postgres';
/** Cluster superuser. Not the user's OS account; scoped to this cluster only. */
const ROLE = 'shipyard';

export type ProgressListener = (message: string) => void;

export class PostgresManager {
  private readonly running = new Map<string, Cluster>();

  constructor(
    private readonly toolchain: Toolchain,
    /** Parent directory for every project's cluster, e.g. userData/databases. */
    private readonly dataRoot: string,
  ) {}

  /**
   * Bring up the database for a project, creating the cluster the first time.
   *
   * `initdb` takes about five seconds and happens exactly once per project;
   * starting an existing cluster is closer to 150ms.
   */
  async ensure(projectPath: string, onProgress: ProgressListener = () => {}): Promise<DatabaseHandle> {
    const existing = this.running.get(projectPath);
    if (existing) return existing.handle;

    // Hashed rather than derived from the project name: data directories nest
    // deeply and Windows still has a path length limit that a long project
    // name plus Postgres's own tree can cross.
    const key = createHash('sha256').update(path.resolve(projectPath)).digest('hex').slice(0, 16);
    const clusterDir = path.join(this.dataRoot, key);
    const dataDir = path.join(clusterDir, 'data');
    const secretFile = path.join(clusterDir, 'password');

    await mkdir(clusterDir, { recursive: true });

    let password: string;
    if (await isCluster(dataDir)) {
      password = (await readFile(secretFile, 'utf8')).trim();
    } else {
      onProgress('Setting up this project’s database. This happens once and takes a few seconds.');
      password = randomBytes(24).toString('base64url');
      await writeFile(secretFile, password, { encoding: 'utf8', mode: 0o600 });
      await this.initCluster(dataDir, clusterDir, password);
    }

    const port = await freePort();
    await this.startServer(dataDir, clusterDir, port);

    const handle: DatabaseHandle = {
      url: `postgresql://${ROLE}:${encodeURIComponent(password)}@127.0.0.1:${port}/${DATABASE_NAME}`,
      port,
      dataDir,
    };

    this.running.set(projectPath, { handle, dataDir });
    return handle;
  }

  /** `initdb`. Runs once per project, then never again. */
  private async initCluster(dataDir: string, clusterDir: string, password: string): Promise<void> {
    const pwfile = path.join(clusterDir, 'initdb-password');
    await writeFile(pwfile, password, { encoding: 'utf8', mode: 0o600 });
    try {
      await this.pg('initdb', [
        '-D',
        dataDir,
        '-U',
        ROLE,
        '--pwfile',
        pwfile,
        '-E',
        'UTF8',
        // The builtin provider gives byte-order collation that is identical on
        // every machine and does not depend on the OS's locale data. A user's
        // ORDER BY must not produce different rows on Windows and on a server.
        // The locale goes in --builtin-locale, not --locale, which still means
        // the libc one.
        '--locale-provider=builtin',
        '--builtin-locale=C.UTF-8',
        // Passwords over a loopback socket, never trust.
        '-A',
        'scram-sha-256',
      ]);
    } finally {
      // The password lives in the cluster now; this copy is no longer needed.
      await rm(pwfile, { force: true }).catch(() => {});
    }
  }

  /**
   * `pg_ctl start -w`, which returns only once the server accepts connections.
   *
   * Bound to loopback explicitly. A database on a laptop in a coffee shop must
   * not be reachable from the rest of the network.
   */
  private async startServer(dataDir: string, clusterDir: string, port: number): Promise<void> {
    const logFile = path.join(clusterDir, 'postgres.log');

    // A hard shutdown leaves a lock file naming a process that no longer
    // exists. Postgres refuses to start rather than risk two servers on one
    // data directory, so we clear it only after confirming nothing is there.
    await clearStaleLock(dataDir);

    try {
      await this.pg(
        'pg_ctl',
        ['-D', dataDir, '-l', logFile, '-o', `-p ${port} -h 127.0.0.1`, '-w', '-t', '30', 'start'],
        {},
        true, // the server it starts would hold our pipes open for its lifetime
      );
    } catch (err) {
      const log = await readFile(logFile, 'utf8').catch(() => '');
      const tail = log.trim().split(/\r?\n/).slice(-12).join('\n');
      throw new Error(
        `The database would not start.${tail ? `\n\n${tail}` : ''}\n\n${describe(err)}`,
      );
    }
  }

  async stop(projectPath: string): Promise<void> {
    const cluster = this.running.get(projectPath);
    if (!cluster) return;
    this.running.delete(projectPath);
    await this.stopServer(cluster.dataDir).catch(() => {});
  }

  /**
   * Stop everything, for app quit.
   *
   * An orphaned Postgres is worse than an orphaned dev server: it holds a port
   * and a lock file, and the user has no way to find or stop it.
   */
  async stopAll(): Promise<void> {
    const clusters = [...this.running.values()];
    this.running.clear();
    await Promise.all(clusters.map((c) => this.stopServer(c.dataDir).catch(() => {})));
  }

  private async stopServer(dataDir: string): Promise<void> {
    // `fast` rolls back open transactions and shuts down cleanly, rather than
    // waiting for clients that the user has already walked away from.
    await this.pg('pg_ctl', ['-D', dataDir, '-m', 'fast', '-w', '-t', '20', 'stop']);
  }

  /**
   * Spawn a PostgreSQL executable by absolute path, never through a shell.
   *
   * `detached` matters more than it looks. `pg_ctl start` launches the
   * postmaster as its own child, and that child inherits stdout and stderr. If
   * we wait for those pipes to close we wait for the database to shut down —
   * which is to say, forever. So the start call gets no pipes at all; its
   * output already goes to the log file via `-l`.
   */
  private pg(
    tool: string,
    args: string[],
    env: NodeJS.ProcessEnv = {},
    detached = false,
  ): Promise<{ stdout: string; stderr: string }> {
    const exe = path.join(
      this.toolchain.postgresBinDir,
      process.platform === 'win32' ? `${tool}.exe` : tool,
    );

    return new Promise((resolve, reject) => {
      const child = spawn(exe, args, {
        env: this.toolchain.decorateEnv(process.env, env),
        windowsHide: true,
        stdio: detached ? 'ignore' : ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => (stdout += d));
      child.stderr?.on('data', (d: Buffer) => (stderr += d));

      child.on('error', reject);
      // `exit` rather than `close`: the process is done, whatever its
      // grandchildren are still holding open.
      child.on('exit', (code) => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`${tool} exited ${code ?? -1}\n${(stderr || stdout).trim()}`));
      });
    });
  }
}

/** A data directory Postgres has already been initialised into. */
async function isCluster(dataDir: string): Promise<boolean> {
  try {
    await access(path.join(dataDir, 'PG_VERSION'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove `postmaster.pid` when the process it names is gone.
 *
 * Only ever after checking. The lock file is the one thing standing between a
 * user and two servers writing the same data directory, so we do not clear it
 * on a guess.
 */
async function clearStaleLock(dataDir: string): Promise<void> {
  const lockFile = path.join(dataDir, 'postmaster.pid');
  let contents: string;
  try {
    contents = await readFile(lockFile, 'utf8');
  } catch {
    return;
  }

  const pid = Number.parseInt(contents.split('\n')[0] ?? '', 10);
  if (!Number.isInteger(pid) || pid <= 0) return;

  try {
    // Signal 0 tests for existence without touching the process.
    process.kill(pid, 0);
    return; // Still alive: leave the lock alone.
  } catch (err) {
    // EPERM means it exists but belongs to someone else — also leave it.
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
  }
  await rm(lockFile, { force: true }).catch(() => {});
}

/**
 * Ask the OS for a port, then release it.
 *
 * Racy in principle. In practice the window is milliseconds and the
 * alternative — a fixed port — collides with whatever else the user is
 * running, which is a certainty rather than a race.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('Could not find a free port'))));
    });
  });
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const withOutput = err as Error & { stderr?: string };
    return (withOutput.stderr || err.message).trim();
  }
  return String(err);
}

/** Exported for tests: how much disk a project's database is using. */
export async function clusterSize(dataDir: string): Promise<number> {
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const { stat } = await import('node:fs/promises');
        total += (await stat(full).catch(() => ({ size: 0 }))).size;
      }
    }
  };
  await walk(dataDir);
  return total;
}
