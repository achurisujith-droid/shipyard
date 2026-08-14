import type { AuthStatus } from '@shipyard/shared';

import type { InputBox } from '../parse/chrome';

/**
 * An agent CLI that Shipyard can drive.
 *
 * Two exist: Anthropic's Claude Code and OpenAI's Codex. They are different
 * programs with different terminal interfaces, but the transport rules are
 * identical and provider-independent, because they follow from what a personal
 * subscription is for rather than from whose subscription it is:
 *
 *   1. Never read, write, or reference a credential. Auth state comes only from
 *      running the CLI's own command and reading what it prints. Codex keeps
 *      its token in ~/.codex/auth.json; we know that file exists and we never
 *      open it, exactly as with Claude's.
 *   2. Interactive terminal only, every turn started by a human. `claude -p`
 *      and `codex exec` are the same refusal for the same reason — and both
 *      remove the approval step that Shipyard's consent model is built on.
 *
 * What differs between them is grammar, not architecture: where the input box
 * is, what "ready" looks like, how a reply is marked. That is what this
 * interface isolates.
 */
export type ProviderId = 'claude' | 'codex';

export interface ProviderChrome {
  /**
   * The CLI is accepting keystrokes.
   *
   * Must be a positive signal. Both CLIs sit silent with a blank screen during
   * startup and discard anything typed then, so "quiet" is not "ready".
   */
  isReady(viewport: string[]): boolean;
  /** A turn is in progress. */
  isBusy(viewport: string[]): boolean;
  /** The composer, and whether it currently holds anything. */
  findInputBox(viewport: string[]): InputBox | null;
  /** Our text left the box and appeared in the transcript. */
  wasSubmitted(viewport: string[], text: string): boolean;
}

export interface ProviderDescriptor {
  id: ProviderId;
  /** Product name, as shown to the user. */
  name: string;
  /**
   * The account this drives, in the words the user would use. They think in
   * terms of the subscription they pay for, not the CLI that consumes it.
   */
  accountName: string;
  /** Executable base names to look for on PATH, most preferred first. */
  binaryNames: readonly string[];
  /** Oldest version we will drive. Below this the surface differs too much to guess. */
  minVersion: string;

  /**
   * Places to look when PATH has nothing. Both CLIs can be installed by a
   * desktop app that never touches PATH — on this machine Codex was installed
   * that way and `where codex` finds nothing at all.
   */
  knownLocations(): string[];

  /**
   * Turn a PATH entry into something spawnable without a shell.
   *
   * Neither CLI is necessarily a real executable where PATH points: Claude is
   * an npm `.cmd` shim on Windows, Codex is a launcher beside a version-hashed
   * binary directory. Node refuses to spawn `.cmd` without a shell
   * (CVE-2024-27980) and we will not enable one.
   */
  resolveExecutable(shimPath: string): Promise<string | undefined>;

  /** Extract a version from `--version` output, or undefined if unrecognised. */
  parseVersion(output: string): string | undefined;

  /** Ask the CLI whether it is signed in. Never touches a credential store. */
  authStatus(executable: string): Promise<AuthStatus>;

  /** Arguments for an interactive session. Never a headless or print flag. */
  sessionArgs(): string[];

  /** Environment for a spawned session. */
  buildSessionEnv(source?: NodeJS.ProcessEnv): Record<string, string>;

  /** How to read this CLI's screen. */
  chrome: ProviderChrome;
}
