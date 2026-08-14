import { EventEmitter } from 'node:events';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

import * as pty from 'node-pty';

import type {
  PermissionOption,
  PermissionRequest,
  RateLimitInfo,
  Session,
  SessionErrorInfo,
  SessionEvents,
  SessionState,
} from '@shipyard/shared';

import { PTY_COLS, PTY_ROWS } from './constants';
import { buildSessionEnv, sessionArgs } from './env';
import { typeAndSubmit } from './input';
import { findInputBox, isBusy, isReady, transcriptEndIndex } from './parse/chrome';
import { classifyInterstitial } from './parse/interstitial';
import {
  classifyMenu,
  keysToSelect,
  parseMenu,
  type MenuKind,
  type ParsedMenu,
  type ParsedMenuOption,
} from './parse/menu';
import { parseTranscript, type TranscriptBlock } from './parse/transcript';
import { ScreenBuffer } from './screen';

/**
 * How often the screen is re-read. This is also the cadence at which streaming
 * text reaches the UI, so it trades CPU against how live the response feels.
 */
const POLL_INTERVAL_MS = 100;
/** Interstitials arrive late; give startup a generous budget before erroring. */
const STARTUP_TIMEOUT_MS = 120_000;
const RATE_LIMIT_RE =
  /(rate limit|usage limit|limit reached|out of (?:usage|credits)|try again (?:at|in|after))/i;
const RESET_RE = /reset[s]?\s+(?:at|in)\s+([^\n·|]{3,40})/i;

export interface CreateSessionOptions {
  /** Absolute path to the CLI executable, from detectClaude(). */
  cliPath: string;
  /** Project directory. Created if missing. */
  cwd: string;
  cols?: number;
  rows?: number;
}

/**
 * A live interactive Claude Code session driven through a pseudo-terminal.
 *
 * All state is read from a rendered screen buffer, never from raw ANSI bytes.
 * See REPORT.md for the behaviours this works around; the short version is that
 * the TUI repaints constantly, so the only text safe to harvest is text that has
 * scrolled above the viewport and can never be repainted again.
 */
class ClaudeSession implements Session {
  readonly cwd: string;

  private readonly emitter = new EventEmitter();
  /** Replaced wholesale on restart(); a new process means a new screen. */
  private screen: ScreenBuffer;
  private readonly cliPath: string;
  private readonly cols: number;
  private readonly rows: number;

  private child: pty.IPty | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;

  private currentState: SessionState = 'starting';
  private startedAt = Date.now();
  private everReady = false;

  /** Absolute line index up to which transcript has been consumed. */
  private harvestedUpTo = 0;
  private pendingLines: string[] = [];
  private emittedBlocks = 0;
  private sawHistorySaturation = false;
  /** Last partial text sent, so we only emit on change. */
  private lastPartial: string | null = null;
  /** Last block seen in the live (still-repainting) region, for state inference. */
  private liveLast: TranscriptBlock | null = null;

  private activeMenu: ParsedMenu | null = null;
  private emittedPermissionKey: string | null = null;
  private lastRateLimitKey: string | null = null;

  private killed = false;

  constructor(opts: CreateSessionOptions) {
    this.cliPath = opts.cliPath;
    this.cwd = opts.cwd;
    this.cols = opts.cols ?? PTY_COLS;
    this.rows = opts.rows ?? PTY_ROWS;
    this.screen = new ScreenBuffer({ cols: this.cols, rows: this.rows });
  }

  get state(): SessionState {
    return this.currentState;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  on<K extends keyof SessionEvents>(event: K, cb: SessionEvents[K]): void {
    this.emitter.on(event, cb as (...args: unknown[]) => void);
  }

  off<K extends keyof SessionEvents>(event: K, cb: SessionEvents[K]): void {
    this.emitter.off(event, cb as (...args: unknown[]) => void);
  }

  /** Start the CLI process. Resolves once it is accepting input. */
  async start(): Promise<void> {
    this.killed = false;
    this.startedAt = Date.now();

    const child = pty.spawn(this.cliPath, sessionArgs(), {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: buildSessionEnv(),
    });
    this.child = child;

    // Both handlers capture `child` and bail if it is no longer the current
    // process. Without this, a dying process's exit handler fires AFTER
    // restart() has spawned its replacement and nulls out the new child,
    // leaving the session wedged with a live process it no longer tracks.
    child.onData((data) => {
      if (this.child !== child) return;
      this.writeChain = this.writeChain.then(() => this.screen.write(data));
    });
    child.onExit(({ exitCode, signal }) => {
      if (this.child !== child) return;
      this.child = null;
      this.stopPolling();
      this.setState('exited');
      if (!this.killed) {
        this.emitError({
          message: `Claude Code exited unexpectedly (code ${exitCode}, signal ${String(signal)}).`,
          fatal: true,
        });
      }
    });

    this.startPolling();
    await this.waitUntilReady();
  }

  send(text: string): void {
    const message = text.trim();
    if (message.length === 0) return;
    void this.sendInternal(message);
  }

  private async sendInternal(message: string): Promise<void> {
    try {
      await this.waitUntilReady();
      const result = await typeAndSubmit(this.io(), message);
      if (!result.submitted) {
        this.emitError({
          message:
            'Message could not be submitted - the input box did not accept Enter after 3 attempts.',
          fatal: false,
        });
      }
    } catch (err: unknown) {
      this.emitError({ message: describe(err), fatal: false });
    }
  }

  respondToPermission(optionIndex: number): void {
    const menu = this.activeMenu;
    if (!menu || !this.child) return;
    const option = menu.options.find((o) => o.index === optionIndex);
    if (!option) {
      this.emitError({
        message: `No option ${optionIndex} on the current prompt.`,
        fatal: false,
      });
      return;
    }
    this.child.write(keysToSelect(menu, optionIndex));
    this.activeMenu = null;
    this.emittedPermissionKey = null;
  }

  kill(): void {
    this.killed = true;
    this.stopPolling();
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.kill();
      } catch {
        // Already dead; nothing to do.
      }
    }
    this.setState('exited');
  }

  async restart(): Promise<void> {
    this.kill();
    // Reset every piece of derived state; a new process starts a new screen.
    this.screen.dispose();
    this.screen = new ScreenBuffer({ cols: this.cols, rows: this.rows });
    this.writeChain = Promise.resolve();
    this.harvestedUpTo = 0;
    this.pendingLines = [];
    this.emittedBlocks = 0;
    this.lastPartial = null;
    this.liveLast = null;
    this.activeMenu = null;
    this.emittedPermissionKey = null;
    this.lastRateLimitKey = null;
    this.sawHistorySaturation = false;
    this.everReady = false;
    this.currentState = 'starting';
    await this.start();
  }

  // --- internals ---------------------------------------------------------

  private io() {
    return {
      write: (d: string): void => {
        this.child?.write(d);
      },
      viewport: async (): Promise<string[]> => {
        await this.writeChain;
        return this.screen.snapshot().viewport;
      },
    };
  }

  private startPolling(): void {
    this.stopPolling();
    this.timer = setInterval(() => {
      void this.tick();
    }, POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private ticking = false;

  private async tick(): Promise<void> {
    if (this.ticking || !this.child) return;
    this.ticking = true;
    try {
      await this.writeChain;
      const snap = this.screen.snapshot();

      if (!this.sawHistorySaturation && this.screen.isHistorySaturated()) {
        this.sawHistorySaturation = true;
        this.emitError({
          message:
            'Session history reached the scrollback limit; the oldest transcript is being discarded.',
          fatal: false,
        });
      }

      const menu = parseMenu(snap.viewport);
      const busy = isBusy(snap.viewport);
      const ready = isReady(snap.viewport);
      if (ready) this.everReady = true;

      if (menu) {
        this.handleMenu(menu, snap.viewport);
      } else {
        this.activeMenu = null;
        this.emittedPermissionKey = null;
        this.harvest(snap.baseY, snap.viewport, busy);
        this.updateState(ready, busy, snap.viewport);
      }
    } catch (err: unknown) {
      this.emitError({ message: describe(err), fatal: false });
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Known first-run dialogs are answered automatically; everything else is
   * handed to the user. We never auto-accept a highlighted default.
   */
  private handleMenu(menu: ParsedMenu, viewport: string[]): void {
    const decision = classifyInterstitial(menu);
    if (decision) {
      const target = menu.options.find((o) => decision.match.test(o.label));
      if (target) {
        this.setState('starting');
        this.child?.write(keysToSelect(menu, target.index));
        // Skip whatever scrolled past while the dialog was up: it is CLI
        // chrome, not conversation.
        this.harvestedUpTo = Number.MAX_SAFE_INTEGER;
        return;
      }
    }

    this.activeMenu = menu;
    this.setState('tool-permission-prompt');

    const key = `${menu.header}::${menu.options.map((o) => o.label).join('|')}`;
    if (this.emittedPermissionKey === key) return;
    this.emittedPermissionKey = key;

    const kind = classifyMenu(menu);
    this.emitter.emit('permission-request', {
      id: key,
      kind,
      question: menu.header,
      ...(menu.tabs ? { steps: menu.tabs } : {}),
      ...(kind === 'permission' ? { toolName: guessToolName(viewport) } : {}),
      options: menu.options.map((o) => classifyOption(kind, o)),
      raw: viewport.join('\n'),
    } satisfies PermissionRequest);
  }

  /**
   * Harvest finished transcript.
   *
   * While a turn is running we consume only lines that have scrolled ABOVE the
   * viewport, because anything still on screen is being repainted and would be
   * emitted twice. Once the turn ends, the region above the input box is final
   * too, so we take the remainder.
   */
  private harvest(baseY: number, viewport: string[], busy: boolean): void {
    if (this.harvestedUpTo === Number.MAX_SAFE_INTEGER) {
      // Re-sync after an interstitial: start from the current live region.
      this.harvestedUpTo = baseY;
      this.pendingLines = [];
      this.emittedBlocks = 0;
    }

    const liveEnd = baseY + transcriptEndIndex(viewport);
    const end = busy ? baseY : liveEnd;
    for (let i = this.harvestedUpTo; i < end; i += 1) {
      this.pendingLines.push(this.screen.lineAt(i));
    }
    if (end > this.harvestedUpTo) this.harvestedUpTo = end;

    const blocks = parseTranscript(this.pendingLines);
    // The final block may still be growing, so hold it back until the turn ends.
    const stable = busy ? Math.max(0, blocks.length - 1) : blocks.length;
    for (let i = this.emittedBlocks; i < stable; i += 1) {
      const block = blocks[i];
      if (block) this.emitBlock(block);
    }
    this.emittedBlocks = Math.max(this.emittedBlocks, stable);

    // Stream the block still being written. This reads the LIVE region, which
    // is repainted constantly - safe only because each emission replaces the
    // last rather than appending, so a re-render cannot duplicate anything.
    if (busy) {
      this.streamPartial(end, liveEnd);
    } else if (this.lastPartial !== null) {
      this.lastPartial = null;
    }

    if (!busy && this.emittedBlocks >= blocks.length) {
      // Turn complete and fully drained: reset so the buffer does not grow
      // without bound across a long session.
      this.pendingLines = [];
      this.emittedBlocks = 0;
    }
  }

  /**
   * Emit the in-flight assistant block so the UI can show a response as it
   * arrives instead of waiting for the whole turn.
   *
   * `from`..`liveEnd` is the part of the transcript still on screen, which the
   * TUI repaints as text grows. We re-parse it every tick and send the current
   * text; consumers replace rather than append, so repaints are harmless.
   */
  private streamPartial(from: number, liveEnd: number): void {
    if (liveEnd <= from) {
      this.liveLast = null;
      return;
    }

    const live = [...this.pendingLines];
    for (let i = from; i < liveEnd; i += 1) live.push(this.screen.lineAt(i));

    const blocks = parseTranscript(live);
    const last = blocks[blocks.length - 1] ?? null;
    this.liveLast = last;
    if (!last || last.kind !== 'assistant') return;

    const text = last.text.trim();
    if (text.length === 0 || text === this.lastPartial) return;
    this.lastPartial = text;
    this.emitter.emit('assistant-partial', text);
  }

  private emitBlock(block: TranscriptBlock): void {
    // A completed block supersedes whatever partial was showing.
    if (block.kind === 'assistant') this.lastPartial = null;
    if (block.kind === 'assistant') {
      this.emitter.emit('assistant-text', block.text);
    } else if (block.kind === 'tool') {
      this.emitter.emit('tool-summary', { name: block.name, summary: block.summary });
    }
    // 'user' blocks are our own echo; 'status' blocks are timing chrome.
  }

  private updateState(ready: boolean, busy: boolean, viewport: string[]): void {
    const rate = this.detectRateLimit(viewport);
    if (rate) {
      this.setState('rate-limited');
      return;
    }
    if (!ready) {
      if (Date.now() - this.startedAt > STARTUP_TIMEOUT_MS && !this.everReady) {
        this.setState('error');
        this.emitError({
          message: 'Claude Code did not become ready within 2 minutes.',
          fatal: true,
        });
      } else {
        this.setState('starting');
      }
      return;
    }
    if (busy) {
      this.setState(this.inferBusyState());
      return;
    }
    this.setState('idle');
  }

  /** Distinguish tool execution from text generation within a running turn. */
  private inferBusyState(): SessionState {
    // Prefer the live region: during a turn the committed transcript is often
    // still empty, which would report "thinking" for the whole response.
    const last = this.liveLast ?? parseTranscript(this.pendingLines).at(-1) ?? null;
    if (last?.kind === 'tool' && last.result.trim().length === 0) return 'tool-running';
    if (last?.kind === 'assistant') return 'streaming';
    return 'thinking';
  }

  /**
   * NOTE: unverified against a real limit. Inducing one on a Max account is
   * impractical, so this is pattern matching against the CLI's documented
   * wording and should be treated as best-effort. See REPORT.md §5.
   */
  private detectRateLimit(viewport: string[]): RateLimitInfo | null {
    const region = viewport.slice(0, transcriptEndIndex(viewport)).join('\n');
    if (!RATE_LIMIT_RE.test(region)) return null;

    const line = viewport.find((l) => RATE_LIMIT_RE.test(l))?.trim() ?? region.slice(0, 200);
    const info: RateLimitInfo = { message: line };
    const reset = RESET_RE.exec(region);
    if (reset?.[1]) info.resetsAt = reset[1].trim();

    if (this.lastRateLimitKey !== line) {
      this.lastRateLimitKey = line;
      this.emitter.emit('rate-limited', info);
    }
    return info;
  }

  private async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.child) throw new Error('Session exited before becoming ready.');
      await this.writeChain;
      const snap = this.screen.snapshot();
      if (!parseMenu(snap.viewport) && isReady(snap.viewport)) return;
      await sleep(150);
    }
    throw new Error('Claude Code did not become ready within 2 minutes.');
  }

  private setState(next: SessionState): void {
    if (next === this.currentState) return;
    const previous = this.currentState;
    this.currentState = next;
    this.emitter.emit('state', next, previous);
  }

  private emitError(info: SessionErrorInfo): void {
    this.emitter.emit('error', info);
  }
}

/**
 * Create and start a session.
 *
 * Deviates from the Scope 1 signature `createSession(cwd)` by also requiring the
 * resolved CLI path: detection is cached by the caller and re-running it per
 * session would add ~1.5s of Windows cold-start to every launch.
 */
export async function createSession(opts: CreateSessionOptions): Promise<Session> {
  const cwd = path.resolve(opts.cwd);
  // Treat the path as hostile input: resolve it, then make sure it is a real
  // directory. node-pty reports a missing cwd as an opaque "error code: 267".
  try {
    const info = await stat(cwd);
    if (!info.isDirectory()) throw new Error(`Not a directory: ${cwd}`);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await mkdir(cwd, { recursive: true });
    } else {
      throw err;
    }
  }

  const session = new ClaudeSession({ ...opts, cwd });
  await session.start();
  return session;
}

/**
 * Only permission prompts have allow/deny semantics. A question's options are
 * just choices, and colouring one of them red because it happens to start with
 * "No" would be actively misleading.
 */
function classifyOption(promptKind: MenuKind, option: ParsedMenuOption): PermissionOption {
  const base = {
    index: option.index,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
  };

  if (promptKind !== 'permission') {
    // The review step's "Cancel" is the one non-permission option that really
    // is a refusal, and the UI should not present it as an equal choice.
    const kind = /^cancel$/i.test(option.label) ? 'deny' : 'neutral';
    return { ...base, kind };
  }

  const l = option.label.toLowerCase();
  let kind: PermissionOption['kind'];
  if (/don'?t ask|allow all|this session|auto-?accept/.test(l)) kind = 'allow-always';
  else if (/^yes/.test(l)) kind = 'allow-once';
  else kind = 'deny';
  return { ...base, kind };
}

/** Best-effort: the tool name from the most recent `● Name(args)` line. */
function guessToolName(viewport: string[]): string | undefined {
  for (let i = viewport.length - 1; i >= 0; i -= 1) {
    const m = /^\s{0,3}[●⏺]\s*([A-Z][A-Za-z0-9_]*)\(/.exec(viewport[i] ?? '');
    if (m?.[1]) return m[1];
  }
  return undefined;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
