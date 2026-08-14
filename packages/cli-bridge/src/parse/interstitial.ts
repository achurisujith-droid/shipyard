import type { ParsedMenu } from './menu';

/**
 * First-run dialogs that stand between spawning the CLI and a usable prompt.
 *
 * These are answered automatically because a user cannot meaningfully consent
 * to them inside Shipyard's chat pane — but each choice is deliberate, and none
 * of them is "whatever is highlighted". Accepting the default on the fullscreen
 * renderer prompt moves the CLI to the alternate screen buffer and destroys all
 * text extraction, and the answer is persisted to the user's global settings.
 *
 * Anything NOT matched here is surfaced to the user rather than guessed at.
 */
export interface InterstitialDecision {
  /** Matches the label of the option to choose. */
  match: RegExp;
  why: string;
}

export function classifyInterstitial(menu: ParsedMenu): InterstitialDecision | null {
  const text = `${menu.header}\n${menu.options.map((o) => o.label).join('\n')}`;

  // Shipyard creates the project directory itself, so trusting it is correct.
  if (/trust this folder|Accessing workspace/i.test(text)) {
    return { match: /trust this folder/i, why: 'workspace trust' };
  }
  // MUST decline: fullscreen = alternate screen buffer = no scrollback.
  if (/fullscreen renderer/i.test(text)) {
    return { match: /not now|^no\b/i, why: 'fullscreen renderer (would break extraction)' };
  }
  if (/Claude in Chrome/i.test(text)) {
    return { match: /keep browser tools off|^no\b/i, why: 'chrome integration' };
  }
  // Never "Fix with Claude" - that would start an unrelated turn we did not ask for.
  if (/Settings Error/i.test(text)) {
    return { match: /continue without/i, why: 'settings error' };
  }
  return null;
}

/**
 * Does this menu look like a tool permission request rather than a first-run
 * dialog? Used only for labelling; unmatched menus are surfaced to the user
 * either way, so a wrong answer here is cosmetic rather than dangerous.
 */
export function looksLikePermission(menu: ParsedMenu): boolean {
  if (/Do you want to/i.test(menu.header)) return true;
  const labels = menu.options.map((o) => o.label);
  return labels.some((l) => /^yes/i.test(l)) && labels.some((l) => /^no/i.test(l));
}
