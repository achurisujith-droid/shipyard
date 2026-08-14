/**
 * Types shared between the cli-bridge library and anything that consumes it
 * (the Electron main process today, the renderer via IPC later).
 *
 * Scope 1 rule that shapes this file: Shipyard never reads Claude credential
 * files and never calls a model API. Everything here is derived from running
 * the Claude Code CLI's own commands and reading its own output.
 */

/**
 * Plan as reported by the CLI. `unknown` means "we could not parse it", never a
 * guess.
 *
 * `subscription` is the honest answer for a provider that tells us a paid plan
 * is in use but not which one. Codex's `doctor --json` reports the auth *mode*
 * — `chatgpt` versus an API key — and never the ChatGPT plan tier, so claiming
 * `pro` there would be an invention.
 */
export type ClaudeTier = 'free' | 'pro' | 'max' | 'team' | 'subscription' | 'unknown';

/**
 * How the CLI is authenticated. Screen 3 (plan check) needs this because an
 * Anthropic Console (API-billing) user has no subscription tier at all, and
 * warning them about "Claude Pro" would be wrong.
 */
export type ClaudeAuthMethod = 'subscription' | 'api-key' | 'unknown';

export interface DetectResult {
  installed: boolean;
  /** Absolute, resolved path to the executable we actually spawn. */
  path?: string;
  /**
   * Absolute path to the PATH entry that led us to the binary — on Windows the
   * npm shim (`claude.cmd`). This is the value worth caching: it survives CLI
   * upgrades, whereas the real binary path moves between versions. `path` is
   * always re-derived from this on startup, never restored from cache alone.
   */
  shimPath?: string;
  /** e.g. "2.1.215" */
  version?: string;
  /** version >= MIN_SUPPORTED_CLI_VERSION */
  supported: boolean;
  /** Where the binary was found, for diagnostics and REPORT.md. */
  source?: DetectSource;
  /** Set when installed is false, or when a candidate was rejected. */
  problem?: string;
  /**
   * We found evidence the CLI is mid-upgrade (a renamed `claude.exe.old.*` with
   * no replacement yet) rather than absent. Callers should retry with backoff
   * instead of sending a signed-in user to the install screen.
   */
  updateInProgress?: boolean;
}

export type DetectSource = 'cache' | 'which' | 'path-scan' | 'known-location';

export interface AuthStatus {
  authed: boolean;
  tier?: ClaudeTier;
  /** Display only. Never transmitted anywhere, never persisted to telemetry. */
  accountLabel?: string;
  /**
   * Not in the original Scope 1 signature; added because the plan-check screen
   * cannot give correct advice without it. See docs in REPORT.md.
   */
  authMethod?: ClaudeAuthMethod;
  /** Why we could not determine status, for the "Show details" toggle. */
  problem?: string;
}

export type LoginEvent =
  | { type: 'url-opened'; url: string }
  | { type: 'waiting' }
  | { type: 'success'; status: AuthStatus }
  | { type: 'failed'; reason: string };

export type SessionState =
  | 'starting'
  | 'idle'
  | 'thinking'
  | 'streaming'
  | 'tool-permission-prompt'
  | 'tool-running'
  | 'error'
  | 'rate-limited'
  | 'exited';

/**
 * What an interactive selection is actually asking.
 *
 * `permission` is Claude asking to change something. `question` is Claude
 * asking the user what they want (its question tool renders a tabbed form).
 * `review` is the final confirm step of that form — the one that must be
 * answered or the session stays blocked forever.
 */
export type PromptKind = 'permission' | 'question' | 'review' | 'other';

export interface PermissionRequest {
  /** Stable id so a UI can match a request to its answer. */
  id: string;
  /** What kind of thing is being asked. Drives the copy, not the mechanics. */
  kind: PromptKind;
  /** The question as the CLI phrased it, e.g. "Bash command" + the command. */
  question: string;
  /**
   * Progress through Claude's multi-question form, when this is one step of
   * one. Lets the UI say "question 2 of 3" instead of showing three
   * indistinguishable dialogs.
   */
  steps?: PromptStep[];
  /**
   * Tool the prompt is about, when we can identify it ("Bash", "Edit", ...).
   * The UI uses this to decide which option to pre-select; the bridge does not
   * make that policy call itself.
   */
  toolName?: string;
  /**
   * The selectable options the CLI is showing, in display order. Claude Code
   * 2.x renders a numbered menu, not a yes/no prompt, so this is never assumed
   * to be two items.
   */
  options: PermissionOption[];
  /** Raw screen text of the prompt box, for "Show details". */
  raw: string;
}

export interface PromptStep {
  label: string;
  /** Already answered. */
  done: boolean;
  isSubmit: boolean;
}

export interface PermissionOption {
  /** 1-based index as the CLI numbers it. */
  index: number;
  /** Verbatim label, e.g. "Yes, and don't ask again for npm commands in this project". */
  label: string;
  /** The explanatory line the CLI indents beneath an option, when it has one. */
  description?: string;
  /**
   * What picking this means. Only meaningful for `permission` prompts; a
   * question's options are just choices and are all `neutral`.
   */
  kind: 'allow-once' | 'allow-always' | 'deny' | 'neutral';
}

export interface ToolSummary {
  /** e.g. "Bash", "Read", "Edit" */
  name: string;
  /** One-line description as the TUI renders it, e.g. "Bash(npm test)". */
  summary: string;
}

export interface RateLimitInfo {
  /** Text the CLI showed, verbatim. */
  message: string;
  /** Parsed reset time if the CLI stated one; absent otherwise. */
  resetsAt?: string;
}

export interface SessionErrorInfo {
  message: string;
  /** True when the CLI process died and the session needs restart(). */
  fatal: boolean;
}

export interface SessionEvents {
  state: (state: SessionState, previous: SessionState) => void;
  /**
   * A completed, immutable block of assistant text. Guaranteed never to repeat
   * or overlap with another `assistant-text` event.
   */
  'assistant-text': (text: string) => void;
  /**
   * The block currently being written, as it grows. Each emission REPLACES the
   * previous partial rather than appending to it, so a UI can show a live
   * response without any risk of duplicated fragments.
   *
   * Always followed by an `assistant-text` carrying the same block once it is
   * final; the UI should drop the partial at that point.
   */
  'assistant-partial': (text: string) => void;
  'tool-summary': (tool: ToolSummary) => void;
  'permission-request': (request: PermissionRequest) => void;
  'rate-limited': (info: RateLimitInfo) => void;
  error: (error: SessionErrorInfo) => void;
}

export interface Session {
  readonly state: SessionState;
  readonly cwd: string;
  /**
   * OS process id of the running CLI, or undefined once it has exited.
   * Needed to guarantee no orphaned `claude` processes survive app quit.
   */
  readonly pid: number | undefined;
  /** Queue a user message. Safe to call before the session reaches `idle`. */
  send(text: string): void;
  /**
   * Answer the outstanding permission menu by 1-based option index, matching
   * `PermissionRequest.options[].index`. Deliberately not a boolean: the CLI
   * shows three or more choices and collapsing them loses "don't ask again".
   */
  respondToPermission(optionIndex: number): void;
  on<K extends keyof SessionEvents>(event: K, cb: SessionEvents[K]): void;
  off<K extends keyof SessionEvents>(event: K, cb: SessionEvents[K]): void;
  /** Terminate the CLI process. Idempotent. */
  kill(): void;
  /** Kill if alive, then start a fresh CLI process in the same cwd. */
  restart(): Promise<void>;
}
