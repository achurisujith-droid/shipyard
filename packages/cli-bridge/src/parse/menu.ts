/**
 * Parser for Claude Code's interactive selections.
 *
 * One grammar serves several things: the workspace trust dialog, integration
 * prompts, settings errors, tool permission requests, and the multi-question
 * form Claude uses to ask the user what they want. All render as a header
 * block, a list of "N. label" options with the current one marked by a caret,
 * and sometimes a key-hint line.
 *
 * The question form is a tabbed sequence that ends in a review step:
 *
 *   ←  ☒ Site type  ☒ Tech stack  ✔ Submit  →
 *   Review your answers
 *   ...
 *   ❯ 1. Submit answers
 *     2. Cancel
 *
 * That review step has NO hint line. Requiring one made the parser go blind at
 * precisely the step that unblocks the session, so the CLI sat waiting forever.
 * A caret-marked option is now sufficient on its own.
 *
 * Everything here reads rendered screen lines. No ANSI byte matching.
 */

export interface ParsedMenuOption {
  /** 1-based, as the CLI numbers it. */
  index: number;
  label: string;
  /** The explanatory line(s) the CLI indents beneath an option, if any. */
  description?: string;
  /** True for the option the caret currently sits on. */
  selected: boolean;
}

/** One step of the multi-question form, from the tab bar. */
export interface MenuTab {
  label: string;
  /** ☒ rather than ☐: this question has been answered. */
  done: boolean;
  isSubmit: boolean;
}

export interface ParsedMenu {
  /** Text above the options: the question and any explanation. */
  header: string;
  options: ParsedMenuOption[];
  /** e.g. "Enter to select · Tab/Arrow keys to navigate · Esc to cancel". May be empty. */
  hint: string;
  /** Present only when this menu is a step of Claude's question form. */
  tabs?: MenuTab[];
}

/** `❯ 1. Yes, I trust this folder` / `  2. No, exit` */
const OPTION_RE = /^(\s*)([❯>›])?\s*(\d+)\.\s+(.*\S)\s*$/;
const HINT_RE = /Enter to (confirm|select)|Esc to |↑\/↓|Tab\/Arrow|Press Enter/i;
/** The full-width rule the CLI draws around a modal. */
const RULE_RE = /^[─━—]{10,}\s*$/;
/** `←  ☒ Site type  ☐ Tech stack  ✔ Submit  →` */
const TABBAR_RE = /[☐☒☑]/;

export function parseMenu(viewport: string[]): ParsedMenu | null {
  const options: ParsedMenuOption[] = [];
  const descriptions: string[][] = [];
  let firstOptionLine = -1;
  let lastOptionLine = -1;
  let optionIndent = 0;

  for (let i = 0; i < viewport.length; i += 1) {
    const line = viewport[i] ?? '';
    const m = OPTION_RE.exec(line);

    if (m) {
      const index = Number.parseInt(m[3] ?? '', 10);
      // Options are numbered consecutively from 1. Anything else is prose that
      // happens to start with a number.
      if (Number.isFinite(index) && index === options.length + 1) {
        options.push({
          index,
          label: (m[4] ?? '').trim(),
          selected: (m[2] ?? '').length > 0,
        });
        descriptions.push([]);
        if (firstOptionLine === -1) firstOptionLine = i;
        lastOptionLine = i;
        optionIndent = (m[1] ?? '').length + (m[2] ? m[2].length + 1 : 0);
        continue;
      }
    }

    // A line indented past the option marker continues the previous option's
    // description. This is where the CLI puts "A one-page site about you...".
    if (options.length > 0 && i === lastOptionLine + 1 && !RULE_RE.test(line)) {
      const indent = /^\s*/.exec(line)?.[0].length ?? 0;
      if (line.trim().length > 0 && indent > optionIndent) {
        descriptions[descriptions.length - 1]?.push(line.trim());
        lastOptionLine = i;
      }
    }
  }

  if (options.length < 2) return null;

  for (let i = 0; i < options.length; i += 1) {
    const text = (descriptions[i] ?? []).join(' ').trim();
    const option = options[i];
    if (option && text.length > 0) option.description = text;
  }

  const hintLine = viewport.slice(lastOptionLine + 1).find((l) => HINT_RE.test(l)) ?? '';

  // Accept on EITHER a hint line or a caret-marked option. The review step of
  // the question form has a caret and no hint; requiring both hung the session.
  const hasCaret = options.some((o) => o.selected);
  if (!hintLine && !hasCaret) return null;

  // Header runs from the rule above the options down to the first option.
  let headerStart = 0;
  for (let i = firstOptionLine - 1; i >= 0; i -= 1) {
    if (RULE_RE.test(viewport[i] ?? '')) {
      headerStart = i + 1;
      break;
    }
  }

  const headerLines = viewport.slice(headerStart, firstOptionLine);
  const tabs = parseTabs(headerLines);
  const header = headerLines
    .filter((l) => !TABBAR_RE.test(l))
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join('\n');

  return { header, options, hint: hintLine.trim(), ...(tabs ? { tabs } : {}) };
}

function parseTabs(headerLines: string[]): MenuTab[] | null {
  const bar = headerLines.find((l) => TABBAR_RE.test(l));
  if (!bar) return null;

  const tabs: MenuTab[] = [];
  for (const token of bar.split(/\s{2,}/)) {
    // The bar is bracketed by ← and → scroll arrows, which strip to nothing.
    // Skip them; do NOT stop, or the first arrow ends the scan before any tab
    // is seen.
    const text = token.replace(/[←→]/g, '').trim();
    if (text.length === 0) continue;
    const done = /[☒☑]/.test(text);
    const label = text.replace(/^[☐☒☑✔✓]\s*/, '').trim();
    if (label.length === 0) continue;
    tabs.push({ label, done, isSubmit: /^submit$/i.test(label) });
  }
  return tabs.length > 0 ? tabs : null;
}

/**
 * What is this selection actually asking?
 *
 * Copy differs enormously: "Claude wants to change a file" is right for a
 * permission prompt and badly wrong for "What kind of site do you want?".
 */
export type MenuKind = 'permission' | 'question' | 'review' | 'other';

export function classifyMenu(menu: ParsedMenu): MenuKind {
  if (/ready to submit your answers|review your answers/i.test(menu.header)) return 'review';
  if (menu.tabs && menu.tabs.length > 0) return 'question';
  if (/^do you want to/im.test(menu.header)) return 'permission';

  const labels = menu.options.map((o) => o.label);
  if (labels.some((l) => /^yes/i.test(l)) && labels.some((l) => /^no\b/i.test(l))) {
    return 'permission';
  }
  return 'other';
}

/**
 * Keystrokes that move the caret from the currently selected option to
 * `targetIndex` and confirm.
 *
 * Arrow-key navigation rather than typing the digit: number shortcuts are not
 * consistently supported across these menus, and a digit that is ignored
 * followed by Enter would confirm the WRONG option.
 */
export function keysToSelect(menu: ParsedMenu, targetIndex: number): string {
  const current = menu.options.find((o) => o.selected)?.index ?? 1;
  const delta = targetIndex - current;
  const arrow = delta >= 0 ? '[B' : '[A';
  return arrow.repeat(Math.abs(delta)) + '\r';
}
