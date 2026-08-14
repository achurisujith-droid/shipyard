import { findInputBox, wasSubmitted } from './parse/chrome';

/**
 * Typing into the CLI's input box.
 *
 * Writing a whole message in one PTY write does NOT work: the CLI applies a
 * paste heuristic to bulk input, and the Enter that follows is inserted as a
 * literal newline inside the box instead of submitting. Measured on 2.1.221 —
 * a 209-character message failed to submit with both CR and LF after a bulk
 * write, and submitted first time when typed in chunks.
 *
 * So we type at roughly human speed, wait for the echo to settle, submit, and
 * then verify the text actually reached the transcript rather than assuming it.
 */

/** Characters per write. Small enough to read as typing, large enough to stay quick. */
const CHUNK_SIZE = 16;
const CHUNK_GAP_MS = 25;
/** Quiet period required once the box holds what we typed. */
const ECHO_MATCH_STABLE_MS = 250;
/** Longer quiet period used when the echoed length never matches. */
const ECHO_SETTLE_MS = 600;
const ECHO_TIMEOUT_MS = 15_000;
/**
 * Per-attempt windows for confirming the message reached the transcript.
 *
 * Deliberately short first: a dropped Enter is cheap to retry and expensive to
 * wait out. A single 8s window meant one missed keystroke cost 8 seconds of
 * apparent hang before anything happened.
 */
const SUBMIT_TIMEOUTS_MS = [2_000, 4_000, 8_000] as const;

export interface InputIO {
  write(data: string): void;
  viewport(): Promise<string[]>;
}

export interface SubmitResult {
  submitted: boolean;
  /** How many Enter presses it took. Useful for the harness to flag flakiness. */
  attempts: number;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Ctrl+U: kill the line. Handled by the CLI's input the way readline does. */
const KILL_LINE = '';
/** Ctrl+E: move to the end, so the backspace fallback deletes everything. */
const END_OF_LINE = '';
/** DEL, which is what a terminal actually sends for the Backspace key. */
const BACKSPACE = '';
const CLEAR_ATTEMPTS = 3;
/** Safety valve for the backspace fallback: no message is this long. */
const MAX_BACKSPACES = 400;

/**
 * Empty the input box before typing into it.
 *
 * The CLI puts text there on its own. When Claude ends a turn with a suggested
 * reply — 'Say "go with placeholders" and I will start' — the composer comes
 * back pre-filled with that phrase. Typing on top of it produced a merged
 * message, and the echo check then compared against the wrong length and
 * reported the send as failed, so the user's answer never arrived and the
 * session looked hung. This is the reason a wizard-driven session could ask
 * questions and then refuse to move on.
 *
 * Ctrl+U first because it is one keystroke, then a verified backspace fallback,
 * because a clear that silently does not clear is exactly the failure being
 * fixed.
 */
export async function clearComposer(io: InputIO): Promise<boolean> {
  for (let attempt = 0; attempt < CLEAR_ATTEMPTS; attempt += 1) {
    const box = findInputBox(await io.viewport());
    // No box means a modal is open or the CLI is starting; nothing to clear.
    if (!box || box.empty) return true;

    if (attempt === 0) {
      io.write(KILL_LINE);
    } else {
      // Cursor position is unknown, so go to the end and delete backwards.
      io.write(END_OF_LINE);
      await delay(30);
      const count = Math.min(box.text.length + 8, MAX_BACKSPACES);
      for (let i = 0; i < count; i += 1) io.write(BACKSPACE);
    }
    await delay(120);
  }

  const box = findInputBox(await io.viewport());
  return !box || box.empty;
}

/** Type `text` into the input box without submitting it. */
export async function typeText(io: InputIO, text: string): Promise<void> {
  await clearComposer(io);
  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    io.write(text.slice(i, i + CHUNK_SIZE));
    await delay(CHUNK_GAP_MS);
  }
  await waitForEcho(io, text);
}

/**
 * Type `text` and submit it, confirming it reached the transcript.
 *
 * Returns `submitted: false` rather than throwing so callers can decide whether
 * a stuck input box is fatal.
 */
export async function typeAndSubmit(io: InputIO, text: string): Promise<SubmitResult> {
  await typeText(io, text);

  for (let attempt = 0; attempt < SUBMIT_TIMEOUTS_MS.length; attempt += 1) {
    io.write('\r');
    const deadline = Date.now() + (SUBMIT_TIMEOUTS_MS[attempt] ?? 8_000);
    while (Date.now() < deadline) {
      await delay(80);
      if (wasSubmitted(await io.viewport(), text)) {
        return { submitted: true, attempts: attempt + 1 };
      }
    }
  }
  return { submitted: false, attempts: SUBMIT_TIMEOUTS_MS.length };
}

/**
 * Wait until the input box has finished echoing what we typed.
 *
 * Stops early once the box holds roughly the expected number of characters;
 * otherwise settles on the echo going quiet, because wrapping and placeholder
 * handling make an exact length match unreliable.
 */
async function waitForEcho(io: InputIO, text: string): Promise<void> {
  const expected = text.trim().length;
  const started = Date.now();
  let lastLength = -1;
  let stableSince = Date.now();

  while (Date.now() - started < ECHO_TIMEOUT_MS) {
    const box = findInputBox(await io.viewport());
    const length = box?.empty ? 0 : (box?.text.length ?? 0);

    if (length !== lastLength) {
      lastLength = length;
      stableSince = Date.now();
    }
    // Wrapping can add or drop a character or two versus what we wrote.
    //
    // The box holding the right number of characters is NOT enough: an Enter
    // sent the instant the count matches is dropped, and the retry then costs
    // seconds. Measured — trimming this wait to 120ms pushed time-to-first-
    // token from ~0.5s to 8.8s because the first Enter always missed. Wait for
    // the echo to actually stop moving.
    if (length >= expected - 2 && Date.now() - stableSince >= ECHO_MATCH_STABLE_MS) return;
    // Fallback: the length never matched (unexpected wrapping, a placeholder we
    // failed to recognise). Settle on the echo going quiet instead.
    if (Date.now() - stableSince >= ECHO_SETTLE_MS) return;

    await delay(60);
  }
}
