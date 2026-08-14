import type { InputBox } from '../../parse/chrome';

/**
 * Reading Codex's screen.
 *
 * Captured from a real session (harness/probe-codex.ts). Codex draws nothing
 * like Claude Code, which is the whole reason this file exists:
 *
 *   • I'll check whether hello.txt already exists, then create it.
 *   • Ran Test-Path -LiteralPath hello.txt
 *     └ False
 *   • Working (2s • esc to interrupt)
 *
 *   › Use /skills to list available skills
 *
 *     gpt-5.5 xhigh · C:\tmp\my-project
 *
 * Claude puts its composer between two horizontal rules and ends with
 * `? for shortcuts`; Codex prefixes the composer with `›` and ends with a
 * `model · directory` line. Everything below reads that grammar.
 *
 * It uses the NORMAL screen buffer, not the alternate one — verified in the
 * probe. That matters more than any of the above: it means committed lines
 * scroll into history and the shared extraction strategy works unchanged.
 */

/** `  gpt-5.5 xhigh · C:\path\to\project` — the footer, present only when idle-capable. */
const STATUS_RE = /^\s*\S+.*\s·\s.+$/;
/** `› ` at the start of a line marks the composer. */
const COMPOSER_RE = /^\s*›\s?(.*)$/;
/** `• Working (2s • esc to interrupt)` / `◦ Working (0s • …)` */
const BUSY_RE = /^\s*[•◦]\s*(Working|Thinking|Running)\b.*esc to interrupt/i;
/** What Codex shows in an empty composer. */
const PLACEHOLDER_RE = /^(Use \/skills|Ask Codex|Type a message|\/\w+ to)/i;

/**
 * The composer is the last `›`-prefixed line above the status footer.
 *
 * Menus also use `›` as their caret, so a line that looks like `› 1. Yes` is a
 * menu option and not the composer. Excluding numbered options keeps the two
 * apart without needing to parse the menu first.
 */
export function findInputBox(viewport: string[]): InputBox | null {
  for (let i = viewport.length - 1; i >= 0; i -= 1) {
    const line = viewport[i] ?? '';
    const match = COMPOSER_RE.exec(line);
    if (!match) continue;

    const text = (match[1] ?? '').trim();
    // `› 1. Yes, continue` is a menu caret, not an empty composer.
    if (/^\d+\.\s/.test(text)) continue;

    return {
      topRuleIndex: i,
      bottomRuleIndex: i,
      text,
      empty: text.length === 0 || PLACEHOLDER_RE.test(text),
    };
  }
  return null;
}

/**
 * Codex is accepting keystrokes.
 *
 * Requires both the composer and the status footer. The footer alone appears
 * mid-turn, and the composer alone appears while the screen is still being
 * painted during startup; together they only occur once the session is live.
 */
export function isReady(viewport: string[]): boolean {
  if (!findInputBox(viewport)) return false;
  // The footer is the last non-blank line.
  for (let i = viewport.length - 1; i >= 0; i -= 1) {
    const line = viewport[i] ?? '';
    if (line.trim().length === 0) continue;
    return STATUS_RE.test(line);
  }
  return false;
}

export function isBusy(viewport: string[]): boolean {
  return viewport.some((line) => BUSY_RE.test(line));
}

/**
 * Our message left the composer and appeared in the transcript above it.
 *
 * Compared on a normalised prefix rather than the whole string: Codex wraps
 * long messages across lines, so an exact match would never succeed.
 */
export function wasSubmitted(viewport: string[], text: string): boolean {
  const needle = normalise(text).slice(0, 60);
  if (needle.length === 0) return false;

  const box = findInputBox(viewport);
  // Still sitting in the composer means it has not been sent.
  if (box && !box.empty && normalise(box.text).startsWith(needle.slice(0, 30))) return false;

  const flat = normalise(viewport.join(' '));
  return flat.includes(needle);
}

function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}
