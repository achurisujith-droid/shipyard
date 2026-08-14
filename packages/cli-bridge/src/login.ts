import { EventEmitter } from 'node:events';
import os from 'node:os';

import * as pty from 'node-pty';

import type { AuthStatus, LoginEvent } from '@shipyard/shared';

import { authStatus } from './auth';
import { AUTH_POLL_INTERVAL_MS, LOGIN_TIMEOUT_MS, PTY_COLS, PTY_ROWS } from './constants';
import { buildSessionEnv } from './env';
import { ScreenBuffer } from './screen';

/** The CLI prints a URL for the browser to open; we surface it, never store it. */
const URL_RE = /https?:\/\/[^\s"'<>]+/;

export interface LoginSession {
  on(event: 'event', cb: (e: LoginEvent) => void): void;
  /** Raw terminal output, for the "Show details" toggle on the sign-in screen. */
  on(event: 'output', cb: (chunk: string) => void): void;
  /** Forward keystrokes from an embedded terminal, if the flow asks for input. */
  write(data: string): void;
  cancel(): void;
}

/**
 * Run `claude auth login` in a terminal and wait for it to take effect.
 *
 * Shipyard never touches the credential itself. The CLI opens the browser, the
 * user authenticates with Anthropic directly, and the CLI stores whatever it
 * stores. Our only way of knowing the outcome is to keep asking the CLI whether
 * it considers itself signed in.
 */
export function startLogin(cliPath: string): LoginSession {
  const emitter = new EventEmitter();
  const screen = new ScreenBuffer({ cols: PTY_COLS, rows: PTY_ROWS, scrollback: 2_000 });

  let finished = false;
  let sawUrl = false;
  let writeChain: Promise<void> = Promise.resolve();

  const child = pty.spawn(cliPath, ['auth', 'login', '--claudeai'], {
    name: 'xterm-256color',
    cols: PTY_COLS,
    rows: PTY_ROWS,
    // Login is not project-scoped; run it somewhere neutral so we never trip
    // the workspace trust dialog here.
    cwd: os.tmpdir(),
    env: buildSessionEnv(),
  });

  const emit = (e: LoginEvent): void => {
    if (finished && e.type !== 'success') return;
    emitter.emit('event', e);
  };

  const finish = (e: LoginEvent): void => {
    if (finished) return;
    finished = true;
    emitter.emit('event', e);
    cleanup();
  };

  const cleanup = (): void => {
    if (poll) clearInterval(poll);
    if (timeout) clearTimeout(timeout);
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    screen.dispose();
  };

  child.onData((data) => {
    emitter.emit('output', data);
    writeChain = writeChain.then(async () => {
      await screen.write(data);
      if (sawUrl) return;
      const text = screen.snapshot().viewport.join('\n');
      const match = URL_RE.exec(text);
      if (match?.[0]) {
        sawUrl = true;
        emit({ type: 'url-opened', url: match[0] });
        emit({ type: 'waiting' });
      }
    });
  });

  child.onExit(() => {
    if (finished) return;
    // The process ending is not itself success or failure - ask the CLI.
    void checkNow().then((status) => {
      if (status.authed) finish({ type: 'success', status });
      else finish({ type: 'failed', reason: 'The sign-in process closed before completing.' });
    });
  });

  const checkNow = (): Promise<AuthStatus> => authStatus(cliPath);

  const poll: NodeJS.Timeout | null = setInterval(() => {
    void (async () => {
      if (finished) return;
      const status = await checkNow();
      if (status.authed) finish({ type: 'success', status });
    })();
  }, AUTH_POLL_INTERVAL_MS);
  poll.unref?.();

  const timeout: NodeJS.Timeout | null = setTimeout(() => {
    finish({ type: 'failed', reason: 'Sign-in timed out after 5 minutes.' });
  }, LOGIN_TIMEOUT_MS);
  timeout.unref?.();

  return {
    on(event: 'event' | 'output', cb: (arg: never) => void): void {
      emitter.on(event, cb as (...args: unknown[]) => void);
    },
    write(data: string): void {
      if (!finished) child.write(data);
    },
    cancel(): void {
      finish({ type: 'failed', reason: 'Sign-in cancelled.' });
    },
  } as LoginSession;
}
