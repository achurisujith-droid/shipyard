/**
 * Parsers for the CLI's persistent screen furniture: the input box, the status
 * line, and the boundary between finished transcript and live UI.
 *
 * The input box is drawn between two full-width horizontal rules, with the
 * status line below it:
 *
 *   ────────────────────────────────────────   <- top rule
 *   ❯ what the user is typing
 *     ...wrapped continuation
 *   ────────────────────────────────────────   <- bottom rule
 *     ⏸ manual mode on · ? for shortcuts        <- status line
 *
 * Everything ABOVE the top rule is finished transcript and will never be
 * repainted, which is what makes de-duplicated extraction possible.
 */

/** A full-width rule. The welcome box uses ╭ ╰ corners, so it will not match. */
const RULE_RE = /^[─━]{20,}\s*$/;
const STATUS_RE = /\? for shortcuts|⏸ |◉ /;
/** Shown in an empty input box, e.g. `Try "fix lint errors"`. */
const PLACEHOLDER_RE = /^Try ["“]/;

export interface InputBox {
  /** Viewport-relative index of the rule above the input area. */
  topRuleIndex: number;
  /** Viewport-relative index of the rule below the input area. */
  bottomRuleIndex: number;
  /** What the user has typed, with the `❯ ` marker and wrap indent removed. */
  text: string;
  /** True when the box is empty or showing its placeholder suggestion. */
  empty: boolean;
}

/**
 * Locate the input box in a viewport snapshot, or null when the CLI is not
 * currently showing one (during startup, or while a modal is open).
 */
export function findInputBox(viewport: string[]): InputBox | null {
  const ruleIndices: number[] = [];
  for (let i = 0; i < viewport.length; i += 1) {
    if (RULE_RE.test(viewport[i] ?? '')) ruleIndices.push(i);
  }
  if (ruleIndices.length < 2) return null;

  const bottomRuleIndex = ruleIndices[ruleIndices.length - 1];
  const topRuleIndex = ruleIndices[ruleIndices.length - 2];
  if (bottomRuleIndex === undefined || topRuleIndex === undefined) return null;

  const raw = viewport.slice(topRuleIndex + 1, bottomRuleIndex);
  const text = raw
    .map((line, idx) => (idx === 0 ? line.replace(/^\s*❯\s?/, '') : line.replace(/^\s{0,2}/, '')))
    .join('\n')
    .trim();

  return {
    topRuleIndex,
    bottomRuleIndex,
    text,
    empty: text.length === 0 || PLACEHOLDER_RE.test(text),
  };
}

/**
 * The CLI is accepting keystrokes.
 *
 * Silence is NOT a readiness signal: during startup the CLI can sit quiet with
 * a blank screen, and anything typed then is discarded. The status line only
 * renders once input is genuinely accepted.
 */
export function isReady(viewport: string[]): boolean {
  return viewport.some((l) => STATUS_RE.test(l)) && findInputBox(viewport) !== null;
}

/** The CLI's status line, e.g. `⏸ manual mode on · esc to interrupt`. */
export function statusLine(viewport: string[]): string | null {
  for (let i = viewport.length - 1; i >= 0; i -= 1) {
    const line = viewport[i] ?? '';
    if (STATUS_RE.test(line)) return line.trim();
  }
  return null;
}

/**
 * A turn is currently running.
 *
 * The status line swaps `? for shortcuts` for `esc to interrupt` for exactly as
 * long as the CLI is working. Measured across a streaming turn, this is the one
 * unambiguous busy/idle signal — the `✻ Sautéed for 2s` marker is an end-of-turn
 * summary that stays in the transcript afterwards, so it cannot be used.
 */
export function isBusy(viewport: string[]): boolean {
  return /esc to interrupt/i.test(statusLine(viewport) ?? '');
}

/**
 * Viewport-relative index where finished transcript ends. Lines below this
 * belong to the live input box and will be repainted; lines above are final.
 */
export function transcriptEndIndex(viewport: string[]): number {
  const box = findInputBox(viewport);
  return box ? box.topRuleIndex : viewport.length;
}

/**
 * Did `text` make it out of the input box and into the transcript?
 *
 * Checks only the region ABOVE the input box, because before submission the
 * same text is sitting in the box and would produce a false positive.
 */
export function wasSubmitted(viewport: string[], text: string): boolean {
  const end = transcriptEndIndex(viewport);
  const needle = normalise(text).slice(0, 30);
  if (needle.length === 0) return false;

  for (let i = 0; i < end; i += 1) {
    const line = viewport[i] ?? '';
    if (!/^\s*❯/.test(line)) continue;
    if (normalise(line.replace(/^\s*❯\s?/, '')).startsWith(needle.slice(0, 20))) return true;
  }
  return false;
}

function normalise(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
