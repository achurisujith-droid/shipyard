import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as pty from 'node-pty';

import {
  authStatus,
  buildSessionEnv,
  createSession,
  detectClaude,
  startLogin,
  type LoginSession,
} from '@shipyard/cli-bridge';
import type {
  AuthStatus,
  DetectResult,
  InstallPlan,
  Session,
  SessionHandle,
  ShipyardEventName,
  ShipyardEvents,
} from '@shipyard/shared';

import type { Store } from './store';

type Emit = <K extends ShipyardEventName>(event: K, payload: ShipyardEvents[K]) => void;

/**
 * Owns every Claude Code process the app starts.
 *
 * All PTY traffic stays in the main process; the renderer only ever sees the
 * semantic events the bridge emits. Nothing here touches a credential store —
 * auth state comes from asking the CLI (see docs/ADR-001).
 */
export class CLIManager {
  private readonly sessions = new Map<string, Session>();
  private login: LoginSession | null = null;
  private installPty: pty.IPty | null = null;
  private lastDetect: DetectResult | null = null;

  constructor(
    private readonly store: Store,
    private readonly emit: Emit,
  ) {}

  // --- detection & auth ---------------------------------------------------

  /**
   * Where Claude Code is, right now.
   *
   * "Right now" is load-bearing. The CLI updates itself underneath us, and it
   * does so by renaming the running binary before writing the replacement —
   * sometimes writing it to a different install altogether. A machine with both
   * an npm-global and an fnm install can have the working one swap sides
   * between two launches of this app, which is exactly what happened in
   * testing: a cached path that resolved yesterday spawned `File not found`
   * today.
   *
   * So the in-memory result is re-validated against the filesystem before it is
   * handed out. It is a fast path, not a source of truth.
   */
  async detect(force = false): Promise<DetectResult> {
    if (!force && this.lastDetect?.installed && (await stillThere(this.lastDetect.path))) {
      return this.lastDetect;
    }

    const cached = this.store.cliShimPath;
    let result = await detectClaude(cached && !force ? { cachedShimPath: cached } : {});

    // The CLI's updater renames the running binary before writing its
    // replacement, so an install can briefly have no executable at all. Treat
    // that as transient rather than telling a signed-in user to reinstall.
    if (!result.installed && result.updateInProgress) {
      await delay(2_000);
      result = await detectClaude({});
    }

    // A cached shim that no longer leads anywhere must not be tried again on
    // the next launch: it would send detection to a dead install first every
    // time, and on a machine with a second working copy that is pure delay.
    if (result.installed && result.shimPath) {
      this.store.cliShimPath = result.shimPath;
    } else if (cached) {
      this.store.clearSetting('cli.shimPath');
    }

    this.lastDetect = result;
    return result;
  }

  /**
   * The executable to spawn, re-checked at the moment of spawning.
   *
   * Callers used to take `detect().path` and hand it straight to node-pty. If
   * the updater had moved it in between, the user got node-pty's raw
   * `File not found: C:\...\claude.exe`, which is both frightening and
   * unactionable. One forced re-detect turns that into either a working session
   * or a sentence they can act on.
   */
  private async resolveBinary(): Promise<DetectResult> {
    const detected = await this.detect();
    if (detected.installed && (await stillThere(detected.path))) return detected;
    return this.detect(true);
  }

  async authStatus(): Promise<AuthStatus> {
    const detected = await this.resolveBinary();
    if (!detected.installed || !detected.path) {
      return { authed: false, tier: 'unknown', problem: 'Claude Code is not installed.' };
    }
    return authStatus(detected.path);
  }

  // --- sign in ------------------------------------------------------------

  async startLogin(): Promise<void> {
    const detected = await this.resolveBinary();
    if (!detected.installed || !detected.path) {
      this.emit('login:event', { type: 'failed', reason: 'Claude Code is not installed.' });
      return;
    }
    this.cancelLogin();

    const session = startLogin(detected.path);
    this.login = session;
    session.on('event', (e) => {
      this.emit('login:event', e);
      if (e.type === 'success' || e.type === 'failed') this.login = null;
    });
    session.on('output', (chunk) => {
      this.emit('login:output', { chunk });
    });
  }

  cancelLogin(): void {
    this.login?.cancel();
    this.login = null;
  }

  writeLogin(data: string): void {
    this.login?.write(data);
  }

  // --- guided install -----------------------------------------------------

  /**
   * The official one-liner, per platform. Shown with a Copy button, and also
   * runnable in place so a non-technical user never has to leave the app.
   */
  installPlan(): InstallPlan {
    if (process.platform === 'win32') {
      return {
        command: 'irm https://claude.ai/install.ps1 | iex',
        description:
          "Downloads and runs Anthropic's official installer for Claude Code using Windows PowerShell.",
        runnable: true,
      };
    }
    return {
      command: 'curl -fsSL https://claude.ai/install.sh | bash',
      description: "Downloads and runs Anthropic's official installer for Claude Code.",
      runnable: true,
    };
  }

  /**
   * Runs the install command in a PTY so the user watches it happen.
   *
   * This is the one place we hand a string to a shell. The command is a
   * compile-time constant from `installPlan()` with no interpolation of user
   * input, and the shell binary is an absolute path.
   */
  runInstall(): void {
    if (this.installPty) return;
    const plan = this.installPlan();

    const shell =
      process.platform === 'win32'
        ? path.join(
            process.env['SystemRoot'] ?? 'C:\\Windows',
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe',
          )
        : '/bin/bash';
    const args =
      process.platform === 'win32'
        ? ['-NoProfile', '-NonInteractive', '-Command', plan.command]
        : ['-lc', plan.command];

    const child = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 100,
      rows: 24,
      cwd: os.homedir(),
      env: buildSessionEnv(),
    });
    this.installPty = child;

    child.onData((chunk) => {
      this.emit('install:output', { chunk });
    });
    child.onExit(({ exitCode }) => {
      this.installPty = null;
      this.lastDetect = null;
      this.emit('install:result', {
        ok: exitCode === 0,
        ...(exitCode === 0 ? {} : { message: `Installer exited with code ${exitCode}.` }),
      });
    });
  }

  // --- sessions -----------------------------------------------------------

  async createSession(projectPath: string): Promise<SessionHandle> {
    const detected = await this.resolveBinary();
    if (!detected.installed || !detected.path) {
      throw new Error(
        detected.problem ??
          'Claude Code could not be found. It may have moved during an update — reinstalling it will fix this.',
      );
    }

    const sessionId = randomUUID();
    const session = await createSession({ cliPath: detected.path, cwd: projectPath });
    this.wire(sessionId, session);
    this.sessions.set(sessionId, session);
    return { sessionId, cwd: session.cwd };
  }

  private wire(sessionId: string, session: Session): void {
    session.on('state', (state, previous) => {
      this.emit('session:state', { sessionId, state, previous });
    });
    session.on('assistant-text', (text) => {
      this.emit('session:assistant-text', { sessionId, text });
    });
    session.on('assistant-partial', (text) => {
      this.emit('session:assistant-partial', { sessionId, text });
    });
    session.on('tool-summary', (tool) => {
      this.emit('session:tool-summary', { sessionId, tool });
    });
    session.on('permission-request', (request) => {
      this.emit('session:permission-request', { sessionId, request });
    });
    session.on('rate-limited', (info) => {
      this.emit('session:rate-limited', { sessionId, info });
    });
    session.on('error', (error) => {
      this.emit('session:error', { sessionId, error });
    });
  }

  send(sessionId: string, text: string): void {
    this.get(sessionId).send(text);
  }

  respondToPermission(sessionId: string, optionIndex: number): void {
    this.get(sessionId).respondToPermission(optionIndex);
  }

  async restart(sessionId: string): Promise<void> {
    await this.get(sessionId).restart();
  }

  kill(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.kill();
    this.sessions.delete(sessionId);
  }

  state(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.state ?? null;
  }

  /**
   * OS process id of a session's CLI. Not exposed over IPC — the renderer has
   * no business with pids. Used by diagnostics and the acceptance smoke test,
   * which has to kill a CLI the way a crash would.
   */
  pidOf(sessionId: string): number | undefined {
    return this.sessions.get(sessionId)?.pid;
  }

  /**
   * Terminate everything we started. Called on quit; leaving a `claude` process
   * behind is an explicit Milestone 2 failure.
   */
  shutdown(): void {
    this.cancelLogin();
    if (this.installPty) {
      try {
        this.installPty.kill();
      } catch {
        /* already gone */
      }
      this.installPty = null;
    }
    for (const [id, session] of this.sessions) {
      try {
        session.kill();
      } catch {
        /* already gone */
      }
      this.sessions.delete(id);
    }
  }

  private get(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`No such session: ${sessionId}`);
    return session;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Is this executable still on disk?
 *
 * Cheap, and the alternative is node-pty's `File not found` reaching the user
 * as the entire explanation.
 */
async function stillThere(target: string | undefined): Promise<boolean> {
  if (!target) return false;
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
