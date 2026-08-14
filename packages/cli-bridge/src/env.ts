/**
 * Environment preparation for spawned CLI sessions.
 *
 * The Scope 1 spec says "unmodified env". Probing showed that is not safe as
 * written: if Shipyard is ever launched from a terminal that is itself inside a
 * Claude Code session, the child inherits session markers and behaves
 * differently - we observed `CLAUDE_CODE_CHILD_SESSION` silently disabling
 * transcript saving, and the inherited entrypoint changing which model the
 * session reported using.
 *
 * So: pass the user's environment through untouched, except for CLI-owned
 * markers that describe a *different* session. We add nothing that would change
 * behaviour or authentication.
 */

/**
 * Session-scoped markers set by a parent Claude Code process. Removing these
 * makes a spawned session behave as if launched from a clean terminal.
 *
 * Deliberately NOT removed: ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN and the
 * Bedrock/Vertex switches. Those describe how the user has chosen to
 * authenticate, and silently dropping them would change which account the CLI
 * uses. We read auth state from the CLI, we do not steer it.
 */
const INHERITED_SESSION_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_PID',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_ENABLE_TASKS',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
] as const;

export function buildSessionEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  const drop = new Set<string>(INHERITED_SESSION_MARKERS);

  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue;
    if (drop.has(key)) continue;
    out[key] = value;
  }

  // node-pty needs a terminal type; the CLI renders differently without one.
  out['TERM'] = 'xterm-256color';
  return out;
}

/**
 * Arguments every Shipyard-spawned session uses.
 *
 * `--settings` MERGES with the user's own settings rather than replacing them,
 * so their permissions, theme and MCP config are preserved. We pin only the one
 * value that would otherwise break us.
 */
export function sessionArgs(): string[] {
  return [
    // Suppress the "Claude in Chrome extension detected" interstitial on
    // machines that have the extension installed.
    '--no-chrome',
    // `tui: "fullscreen"` moves the CLI onto the terminal's ALTERNATE screen
    // buffer, which has no scrollback. All of our text extraction depends on
    // lines scrolling into history, so a user with fullscreen enabled globally
    // would otherwise break every session. Valid values: "default",
    // "fullscreen".
    '--settings',
    JSON.stringify({ tui: 'default' }),
    // Effort governs how long the model reasons before it writes anything. A
    // user with `effortLevel: "xhigh"` in their global settings waits ~11s of
    // total silence before the first character of every reply — measured, and
    // identical in the CLI itself. That is a reasonable trade for an expert at
    // a terminal and a broken-looking one for someone watching a chat window.
    //
    // Scoped to Shipyard's own sessions: the user's terminal and IDE sessions
    // keep whatever they configured.
    '--effort',
    SESSION_EFFORT,
  ];
}

/**
 * Reasoning effort for Shipyard sessions. `medium` is roughly 3-4x faster to
 * first token than `xhigh` and is the right default for interactive building.
 */
export const SESSION_EFFORT = 'medium';
