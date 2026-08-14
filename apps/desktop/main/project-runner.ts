import { randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import * as pty from 'node-pty';

import { buildSessionEnv } from '@shipyard/cli-bridge';
import type {
  DetectedProblem,
  RunnerInfo,
  RunnerStatus,
  ShipyardEventName,
  ShipyardEvents,
} from '@shipyard/shared';

import type { PostgresManager } from './postgres';
import { detectNeeds } from './stack';
import { startStaticServer, type StaticServer } from './static-server';
import type { Toolchain } from './toolchain';

type Emit = <K extends ShipyardEventName>(event: K, payload: ShipyardEvents[K]) => void;

/** The dev server announcing itself, e.g. "Local: http://localhost:5173/". */
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?[^\s"'<>]*/i;
/**
 * Frameworks print a URL. Hand-written Node servers usually do not — they print
 * "Server listening on port 3000". Without this, such an app starts fine and the
 * preview never appears, which looks exactly like a failure to the user.
 */
const PORT_RE = /(?:listening|running|started|available|ready)\b[^\n]{0,24}?\bport\s*[:=]?\s*(\d{2,5})\b/i;

/**
 * Lines that mean the app is broken rather than merely noisy. Kept deliberately
 * tight: a false positive puts a scary card in front of a beginner and offers to
 * "fix" something that was never wrong.
 */
const PROBLEM_RE =
  /(^|\s)(error|failed to compile|module not found|cannot find module|syntaxerror|typeerror|referenceerror|econnrefused|eaddrinuse)\b/i;
/**
 * Noise that matches the above but is not a real failure.
 *
 * `error while requesting resource` is Next.js failing to reach Google Fonts.
 * It was caught putting a card in front of an app that went on to serve a
 * perfectly good page, which is the exact false positive this list exists for.
 */
const NOT_A_PROBLEM_RE =
  /(0 errors|no errors|error-free|errors: 0|--error|error handling|onerror|error boundary|error while requesting resource|deprecationwarning|experimentalwarning)/i;
/** `src/App.tsx:24:9` or `at src/App.tsx:24` */
const LOCATION_RE = /((?:[\w.-]+[\\/])*[\w.-]+\.[a-z]{1,4}):(\d+)(?::(\d+))?/i;

/**
 * Runs the user's project and watches it break.
 *
 * This is the local half of the vibe-coding loop: start the dev server, learn
 * the URL so the preview can point at it, and turn failures into something the
 * user can hand back to Claude with one click.
 */
/** Marker command for "no build step, just serve the folder". */
const STATIC_COMMAND = 'Preview index.html';

export class ProjectRunner {
  private child: pty.IPty | null = null;
  private staticServer: StaticServer | null = null;
  private confirming = false;
  private status: RunnerStatus = { state: 'idle' };
  private buffer = '';
  private seen = new Set<string>();
  private cwd: string | null = null;
  /** DATABASE_URL for the project currently running, when it needed one. */
  private databaseUrl: string | null = null;

  constructor(
    private readonly emit: Emit,
    private readonly toolchain: Toolchain,
    private readonly postgres: PostgresManager,
  ) {}

  /**
   * Can we run this project, and how?
   *
   * Three shapes, all of which the user can end up with depending on what they
   * told Claude to build:
   *  - a Node project with a dev script (may still need dependencies installed)
   *  - a plain static site: index.html and no package.json at all
   *  - nothing yet
   */
  async inspect(projectPath: string): Promise<RunnerInfo> {
    let raw: string | null = null;
    try {
      raw = await readFile(path.join(projectPath, 'package.json'), 'utf8');
    } catch {
      raw = null;
    }

    if (raw === null) {
      // "Plain HTML/CSS/JS" is one of the options Claude offers, and it produces
      // no package.json. There is still a site here worth previewing.
      if (await exists(path.join(projectPath, 'index.html'))) {
        return { canRun: true, command: 'Preview index.html' };
      }
      return {
        canRun: false,
        reason: "There's nothing to run yet. Ask Claude to build something first.",
      };
    }

    let scripts: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const s = (parsed as { scripts?: unknown }).scripts;
        if (s && typeof s === 'object') scripts = s as Record<string, unknown>;
      }
    } catch {
      return { canRun: false, reason: "This project's package.json could not be read." };
    }

    const script = ['dev', 'start', 'serve'].find((name) => typeof scripts[name] === 'string');
    if (!script) {
      if (await exists(path.join(projectPath, 'index.html'))) {
        return { canRun: true, command: 'Preview index.html' };
      }
      return {
        canRun: false,
        reason: 'This project has no dev or start script, so we don\u2019t know how to run it.',
      };
    }

    // A freshly scaffolded project has no node_modules, and `npm run dev` would
    // fail immediately with a message a beginner cannot act on.
    const needsInstall = !(await exists(path.join(projectPath, 'node_modules')));
    const needs = await detectNeeds(projectPath);
    return {
      canRun: true,
      command: `npm run ${script}`,
      needsInstall,
      needsDatabase: needs.database,
    };
  }

  current(): RunnerStatus {
    return this.status;
  }

  /**
   * The user pressed Stop while a slow step was running.
   *
   * A method rather than an inline check on purpose: `this.status` is a
   * property, and TypeScript keeps a narrowing on it across the calls that
   * change it, so a second inline comparison reads as impossible and stops
   * compiling. Going through a function reads the field afresh each time.
   */
  private cancelled(): boolean {
    return this.status.state === 'stopped';
  }

  async start(projectPath: string): Promise<void> {
    this.stop();

    const info = await this.inspect(projectPath);
    if (!info.canRun || !info.command) {
      this.setStatus({ state: 'failed', message: info.reason ?? 'Cannot run this project.' });
      return;
    }

    this.cwd = projectPath;
    this.buffer = '';
    this.seen.clear();

    // A static site has no dev server; we serve the folder ourselves.
    if (info.command === STATIC_COMMAND) {
      try {
        const server = await startStaticServer(projectPath);
        this.staticServer = server;
        this.emit('runner:log', { chunk: `Serving ${projectPath} at ${server.url}\r\n` });
        this.setStatus({ state: 'running', command: info.command, url: server.url });
      } catch (err) {
        this.setStatus({
          state: 'failed',
          message: `Could not start the preview: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      return;
    }

    // Freshly scaffolded projects have no node_modules. Running the dev script
    // first would fail with an error the user cannot act on.
    if (info.needsInstall) {
      this.setStatus({ state: 'installing', command: 'npm install' });
      const install = await this.runToCompletion(projectPath, 'npm install');
      if (!install.ok) {
        this.setStatus({
          state: 'failed',
          message: 'Installing the project’s dependencies failed.',
        });
        this.publish({
          id: randomUUID(),
          source: 'server',
          message: 'npm install failed',
          detail: install.tail,
        });
        return;
      }
      // A cancelled run must not silently continue into the dev server.
      if (this.cancelled()) return;
    }

    if (!(await this.prepareDatabase(projectPath))) return;

    this.setStatus({ state: 'starting', command: info.command });
    this.spawnDev(projectPath, info.command);
  }

  /**
   * Start Postgres and apply the schema, if this project talks to a database.
   *
   * Returns false when it failed, having already reported why. A project that
   * needs a database and cannot get one must not go on to start its dev
   * server: it would come up, fail every request, and bury the real cause
   * under a hundred connection errors.
   */
  private async prepareDatabase(projectPath: string): Promise<boolean> {
    this.databaseUrl = null;

    const needs = await detectNeeds(projectPath);
    if (!needs.database) return true;

    this.setStatus({ state: 'preparing', message: 'Starting the database' });
    this.emit('runner:log', { chunk: `Shipyard: this project ${needs.reason}.\r\n` });

    try {
      const handle = await this.postgres.ensure(projectPath, (message) => {
        this.setStatus({ state: 'preparing', message });
        this.emit('runner:log', { chunk: `Shipyard: ${message}\r\n` });
      });
      this.databaseUrl = handle.url;
      // The password is in the URL, so the log gets the address only.
      this.emit('runner:log', {
        chunk: `Shipyard: database ready on port ${handle.port}.\r\n`,
      });
    } catch (err) {
      this.setStatus({
        state: 'failed',
        message: 'Your app needs a database and it would not start.',
      });
      this.publish({
        id: randomUUID(),
        source: 'server',
        message: 'The database would not start',
        detail: err instanceof Error ? err.message : String(err),
      });
      return false;
    }

    if (this.cancelled()) return false;

    for (const command of needs.prepare ?? []) {
      this.setStatus({ state: 'preparing', message: 'Updating the database to match your app' });
      const result = await this.runToCompletion(projectPath, command);
      if (!result.ok) {
        this.setStatus({ state: 'failed', message: 'Setting up the database tables failed.' });
        this.publish({
          id: randomUUID(),
          source: 'server',
          message: 'Could not create the database tables',
          detail: `${command}\n\n${result.tail}`,
        });
        return false;
      }
      if (this.cancelled()) return false;
    }

    return true;
  }

  private spawnDev(projectPath: string, command: string): void {
    const child = this.spawnShell(projectPath, command);
    this.child = child;

    child.onData((chunk) => {
      if (this.child !== child) return;
      this.emit('runner:log', { chunk });
      this.consume(chunk);
    });

    child.onExit(({ exitCode }) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.cancelled()) return;
      // Spread first: we keep the url/command we learned, but the state and
      // message must win.
      this.setStatus({
        ...this.status,
        state: 'failed',
        message:
          exitCode === 0
            ? 'The dev server stopped.'
            : `The dev server stopped unexpectedly (code ${exitCode}).`,
      });
    });
  }

  /** Run a command to completion, keeping the tail of its output for diagnosis. */
  private runToCompletion(
    projectPath: string,
    command: string,
  ): Promise<{ ok: boolean; tail: string }> {
    return new Promise((resolve) => {
      const child = this.spawnShell(projectPath, command);
      this.child = child;
      const lines: string[] = [];

      child.onData((chunk) => {
        if (this.child !== child) return;
        this.emit('runner:log', { chunk });
        // Deliberately not run through problem detection: npm install prints
        // warnings containing the word "error" that are not failures.
        for (const line of stripAnsi(chunk).split(/\r?\n/)) {
          if (line.trim()) lines.push(line.trimEnd());
        }
        if (lines.length > 200) lines.splice(0, lines.length - 200);
      });

      child.onExit(({ exitCode }) => {
        if (this.child === child) this.child = null;
        resolve({ ok: exitCode === 0, tail: lines.slice(-40).join('\n') });
      });
    });
  }

  /**
   * npm is a `.cmd` shim on Windows and cannot be spawned without a shell, so
   * we go through one explicitly. The command is built from package.json and
   * from constants in this file, never from user input.
   *
   * The environment carries Shipyard's own Node and Postgres at the front of
   * PATH, so `node` and `npm` here are the versions we ship rather than
   * whatever the user's machine happens to have, which is usually nothing.
   */
  private spawnShell(projectPath: string, command: string): pty.IPty {
    const isWindows = process.platform === 'win32';
    const shell = isWindows
      ? path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'cmd.exe')
      : '/bin/sh';
    const args = isWindows ? ['/d', '/s', '/c', command] : ['-lc', command];

    const extra: NodeJS.ProcessEnv = { FORCE_COLOR: '0', NO_COLOR: '1' };
    if (this.databaseUrl) {
      // Injected rather than written into .env: it carries a password, and the
      // port changes every run. dotenv does not overwrite a real environment
      // variable, so an app that loads .env still ends up with this one.
      extra['DATABASE_URL'] = this.databaseUrl;
    }

    return pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: projectPath,
      env: this.toolchain.decorateEnv(buildSessionEnv(), extra) as Record<string, string>,
    });
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
    this.staticServer?.close();
    this.staticServer = null;
    if (this.status.state !== 'idle') this.setStatus({ state: 'stopped' });
  }

  clearProblems(): void {
    this.seen.clear();
  }

  /** Problems observed in the preview webview, handed over by the renderer. */
  reportBrowserProblem(message: string, detail: string, location?: string): void {
    this.publish({
      id: randomUUID(),
      source: 'browser',
      message: trim(message),
      detail: detail.slice(0, 4_000),
      ...(location ? { location } : {}),
    });
  }

  /** Parse dev-server output line by line, looking for a URL and for failures. */
  private consume(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';

    for (const raw of lines) {
      const line = stripAnsi(raw).trimEnd();
      if (line.trim().length === 0) continue;

      if (!this.status.url) {
        const candidate = candidateUrl(line);
        if (candidate) {
          // Confirm it actually answers before pointing the preview at it. A
          // guessed port that serves nothing is worse than no preview at all.
          void this.confirmUrl(candidate);
          continue;
        }
      }

      if (PROBLEM_RE.test(line) && !NOT_A_PROBLEM_RE.test(line)) {
        const location = LOCATION_RE.exec(line);
        this.publish({
          id: randomUUID(),
          source: 'server',
          message: trim(line),
          // Trailing context is usually the stack or the code frame.
          detail: [line, ...lines.slice(lines.indexOf(raw) + 1, lines.indexOf(raw) + 12)]
            .join('\n')
            .slice(0, 4_000),
          ...(location?.[0] ? { location: location[0] } : {}),
        });
      }
    }
  }

  /**
   * Poll a candidate URL until it answers, then show the preview.
   *
   * Dev servers print their address slightly before they accept connections,
   * and a port parsed out of prose is a guess. Waiting for a real response
   * means the preview never loads a blank error page.
   */
  private async confirmUrl(url: string): Promise<void> {
    if (this.status.url || this.confirming) return;
    this.confirming = true;
    try {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (!this.child && !this.staticServer) return;
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 2_000);
          await fetch(url, { signal: controller.signal });
          clearTimeout(timer);
          if (!this.status.url) {
            this.setStatus({ ...this.status, state: 'running', url });
            // It serves pages, so whatever it printed on the way up was not
            // fatal. Dev servers are noisy while starting; leaving a red card
            // beside a working app teaches people to ignore every card.
            this.resolveProblems('server');
          }
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      this.emit('runner:log', {
        chunk: `\r\nShipyard: could not reach ${url}. The app may still be starting.\r\n`,
      });
    } finally {
      this.confirming = false;
    }
  }

  /**
   * Withdraw the problems we reported from one source.
   *
   * The de-duplication set is cleared alongside, so a failure that recurs after
   * this point is reported again rather than being swallowed as "already seen".
   */
  private resolveProblems(source: DetectedProblem['source']): void {
    let had = false;
    for (const key of [...this.seen]) {
      if (key.startsWith(`${source}:`)) {
        this.seen.delete(key);
        had = true;
      }
    }
    if (had) this.emit('runner:problems-resolved', { source });
  }

  /** De-duplicated so one broken import does not produce twenty identical cards. */
  private publish(problem: DetectedProblem): void {
    const key = `${problem.source}:${problem.message}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.emit('runner:problem', problem);
  }

  private setStatus(next: RunnerStatus): void {
    this.status = next;
    this.emit('runner:status', next);
  }

  shutdown(): void {
    this.stop();
    this.cwd = null;
  }
}

/** The dev server may still emit colour codes despite NO_COLOR. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, '');
}

/**
 * Pull a previewable address out of a line of dev-server output, whether it
 * printed a URL or only a port number.
 */
export function candidateUrl(line: string): string | null {
  const url = URL_RE.exec(line);
  if (url?.[0]) return url[0].replace(/\/$/, '');

  const port = PORT_RE.exec(line);
  const value = port?.[1] ? Number.parseInt(port[1], 10) : NaN;
  if (Number.isFinite(value) && value >= 1_024 && value <= 65_535) {
    return `http://localhost:${value}`;
  }
  return null;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function trim(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 197)}...` : flat;
}
