/** Oldest CLI we will drive. Below this, the TUI/flag surface differs enough that we refuse rather than guess. */
export const MIN_SUPPORTED_CLI_VERSION = '2.0.0';

/**
 * Measured on Windows 11: `claude --version` takes ~1.2s and `auth status`
 * ~1.6s even warm (native binary + AV scanning). Detection must therefore be
 * async and cached; app startup must never block on it.
 */
export const CLI_EXEC_TIMEOUT_MS = 20_000;

export const AUTH_POLL_INTERVAL_MS = 2_000;
export const LOGIN_TIMEOUT_MS = 5 * 60_000;

/** Terminal geometry for spawned sessions, per spec. */
export const PTY_COLS = 120;
export const PTY_ROWS = 40;
