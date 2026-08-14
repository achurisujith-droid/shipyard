/**
 * Milestone 1.4 discovery probe.
 *
 * Spawns a real interactive Claude Code session in a PTY and records what the
 * screen actually looks like at each stage. The state machine and parsers are
 * written from this captured output, not from assumptions about the TUI.
 *
 * Hard-won lessons already encoded here:
 *   - Never blind-accept a menu default. The "Try the new fullscreen renderer?"
 *     prompt defaults to Yes, which switches the TUI to the ALTERNATE screen
 *     buffer - no scrollback, no committed-line extraction, architecture dead.
 *     Worse, the answer is persisted to the user's global settings.json.
 *   - Never send text while a menu is open; it gets swallowed and the following
 *     Enter answers the menu instead.
 *   - A fresh directory blocks on a trust dialog, and further interstitials can
 *     appear asynchronously well after startup.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import * as pty from 'node-pty';

import { detectClaude } from '../src/detect';
import { PTY_COLS, PTY_ROWS } from '../src/constants';
import { ScreenBuffer } from '../src/screen';
import { keysToSelect, parseMenu, type ParsedMenu } from '../src/parse/menu';

const OUT_DIR = path.resolve(__dirname, '..', '.probe-out');
/**
 * A fresh directory per run: the trust decision is remembered per project, so
 * reusing one would hide the first-run dialog we specifically need to see.
 * Pass a path as argv[2] to probe an already-trusted directory instead.
 */
const PROJECT_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(OUT_DIR, `project-${process.pid}`);

const SETTLE_MS = 2_000;
const PHASE_TIMEOUT_MS = 90_000;

const ESC = '';
const ENTER = '\r';

interface Phase {
  name: string;
  screen: string[];
  bufferType: string;
  totalLines: number;
  baseY: number;
  cursor: string;
}

/**
 * What to do about a modal we did not initiate.
 *
 * Always selects an option by its label rather than pressing Esc: the Settings
 * Error dialog ignores Esc entirely and will spin forever. Label matching also
 * survives the options being reordered between CLI versions, which index
 * matching would not.
 */
interface Decision {
  match: RegExp;
  why: string;
}

function interstitialPolicy(menu: ParsedMenu): Decision | null {
  const text = `${menu.header}\n${menu.options.map((o) => o.label).join('\n')}`;

  if (/trust this folder|Accessing workspace/i.test(text)) {
    // Shipyard creates the project directory itself, so trusting it is correct
    // - but it must be a deliberate decision, never an accepted default.
    return { match: /trust this folder/i, why: 'trust dialog -> accept' };
  }
  if (/fullscreen renderer/i.test(text)) {
    return {
      match: /not now|no\b/i,
      why: 'fullscreen renderer -> DECLINE (alt buffer would kill extraction)',
    };
  }
  if (/Claude in Chrome/i.test(text)) {
    return { match: /keep browser tools off|no\b/i, why: 'chrome -> decline' };
  }
  if (/Settings Error/i.test(text)) {
    return {
      match: /continue without/i,
      why: 'settings error -> continue without (never "Fix with Claude")',
    };
  }
  return null;
}

async function main(): Promise<void> {
  await mkdir(PROJECT_DIR, { recursive: true });

  const detected = await detectClaude();
  if (!detected.installed || !detected.path) {
    console.error('Claude Code not found; cannot probe.');
    process.exitCode = 1;
    return;
  }
  console.log(`Using ${detected.path} (v${detected.version})`);
  console.log(`Project dir: ${PROJECT_DIR}\n`);

  const screen = new ScreenBuffer({ cols: PTY_COLS, rows: PTY_ROWS });
  const rawChunks: string[] = [];
  let lastOutputAt = Date.now();
  let exited = false;
  let exitInfo = '';

  const child = pty.spawn(
    detected.path,
    [
      // Suppress the Chrome-extension interstitial on machines that have it.
      '--no-chrome',
      // Pin the non-fullscreen renderer for THIS session only. --settings
      // merges, so the user's own permissions and theme are untouched. Without
      // this we inherit whatever `tui` value sits in their global settings, and
      // "fullscreen" moves the CLI to the alternate buffer, which destroys
      // scrollback and with it all text extraction.
      // Valid values are "default" and "fullscreen" - confirmed by the CLI's
      // own validation error.
      '--settings',
      JSON.stringify({ tui: 'default' }),
    ],
    {
      name: 'xterm-256color',
      cols: PTY_COLS,
      rows: PTY_ROWS,
      cwd: PROJECT_DIR,
      env: cleanEnv(),
    },
  );

  // Writes are serialised: xterm parsing is async and out-of-order writes
  // would corrupt the buffer.
  let writeChain: Promise<void> = Promise.resolve();
  child.onData((data) => {
    rawChunks.push(data);
    lastOutputAt = Date.now();
    writeChain = writeChain.then(() => screen.write(data));
  });
  child.onExit(({ exitCode, signal }) => {
    exited = true;
    exitInfo = `exitCode=${exitCode} signal=${String(signal)}`;
  });

  const phases: Phase[] = [];

  const capture = async (name: string): Promise<Phase> => {
    await writeChain;
    const snap = screen.snapshot();
    const phase: Phase = {
      name,
      screen: snap.viewport,
      bufferType: snap.bufferType,
      totalLines: snap.totalLines,
      baseY: snap.baseY,
      cursor: `${snap.cursorAbsY},${snap.cursorX}`,
    };
    phases.push(phase);

    console.log(`\n${'='.repeat(78)}`);
    console.log(
      `PHASE: ${name}  [buffer=${phase.bufferType} total=${phase.totalLines} baseY=${phase.baseY} cursor=${phase.cursor}]`,
    );
    if (phase.bufferType === 'alternate') {
      console.log('!!! ALTERNATE BUFFER - scrollback extraction is not viable here');
    }
    console.log('='.repeat(78));
    for (const line of phase.screen) console.log(`| ${line}`);
    return phase;
  };

  const settle = async (label: string): Promise<void> => {
    const started = Date.now();
    for (;;) {
      if (exited) return;
      if (Date.now() - lastOutputAt >= SETTLE_MS) return;
      if (Date.now() - started >= PHASE_TIMEOUT_MS) {
        console.log(`[settle:${label}] timed out after ${PHASE_TIMEOUT_MS}ms`);
        return;
      }
      await delay(150);
    }
  };

  const currentMenu = async (): Promise<ParsedMenu | null> => {
    await writeChain;
    return parseMenu(screen.snapshot().viewport);
  };

  const viewportKey = async (): Promise<string> => {
    await writeChain;
    return screen.snapshot().viewport.join('\n');
  };

  /**
   * The input box is accepting keystrokes. The status line ("? for shortcuts")
   * only renders once the CLI is genuinely interactive, which makes it a far
   * better readiness signal than silence.
   */
  const isReady = async (): Promise<boolean> => {
    await writeChain;
    const snap = screen.snapshot();
    return snap.viewport.some((l) => /\? for shortcuts/.test(l));
  };

  /**
   * Clear every interstitial standing between us and a usable prompt. Runs to
   * a fixed point rather than a fixed count, because dialogs arrive late - and
   * bails on stall, because a modal that ignores our input will otherwise loop.
   *
   * "Settled" is NOT the same as "ready": during startup the CLI can go quiet
   * for seconds with a blank screen, and anything typed then is discarded.
   * Readiness is the status line, which only renders once input is accepted.
   */
  const waitForReady = async (label: string): Promise<void> => {
    let stalls = 0;
    for (let i = 0; i < 8; i += 1) {
      await settle(`${label}-${i}`);
      const menu = await currentMenu();
      if (!menu) {
        if (await isReady()) return;
        // Quiet but not ready: the CLI is still painting. Keep waiting.
        const waitStart = Date.now();
        while (Date.now() - waitStart < 30_000) {
          await delay(300);
          if (await currentMenu()) break;
          if (await isReady()) return;
        }
        continue;
      }

      const before = await viewportKey();
      await capture(`interstitial-${i}`);

      const decision = interstitialPolicy(menu);
      const target = decision
        ? menu.options.find((o) => decision.match.test(o.label))
        : undefined;

      if (decision && target) {
        console.log(`[interstitial] ${decision.why} -> option ${target.index} "${target.label}"`);
        child.write(keysToSelect(menu, target.index));
      } else {
        // Unknown modal: pick the last option, which is conventionally the
        // decline/exit-safely choice, rather than guessing with Esc.
        const last = menu.options[menu.options.length - 1];
        console.log(
          `[interstitial] UNRECOGNISED modal - selecting last option ${last?.index} "${last?.label}"`,
        );
        console.log(`   header was: ${menu.header.slice(0, 200)}`);
        if (last) child.write(keysToSelect(menu, last.index));
      }
      lastOutputAt = Date.now();
      await delay(700);

      if ((await viewportKey()) === before) {
        stalls += 1;
        console.log(`[interstitial] screen unchanged (stall ${stalls}/2)`);
        if (stalls >= 2) {
          console.log('[interstitial] modal is not responding to input - giving up');
          return;
        }
      } else {
        stalls = 0;
      }
    }
    console.log('[interstitial] gave up after 8 rounds');
  };

  /** Refuses to type into a menu - that was the bug that set tui=fullscreen. */
  const send = async (text: string): Promise<void> => {
    const menu = await currentMenu();
    if (menu) {
      console.log('\n!!! REFUSING to send while a menu is open - clearing first');
      await waitForReady('pre-send');
    }
    console.log(`\n>>> SEND: ${JSON.stringify(text)}`);
    child.write(text);
    lastOutputAt = Date.now();
    await delay(300);
  };

  // --- Phase 1: startup and first-run dialogs -----------------------------
  await settle('startup');
  await capture('01-startup');
  await waitForReady('startup');
  await capture('02-ready-idle');

  // --- Phase 2: a plain text turn ----------------------------------------
  await send('Say hello in exactly one short sentence.');
  await delay(500);
  await capture('03-prompt-typed');

  await send(ENTER);
  await delay(1_500);
  await capture('04-mid-turn');
  await settle('assistant-reply');
  await capture('05-after-reply');

  // --- Phase 3: a turn that must ask for tool permission ------------------
  // `echo` is auto-allowed as a safe read-only command and never prompts, so
  // this asks for something with a side effect on disk.
  await send('Create a file named probe.txt containing the single word hello');
  await delay(500);
  await send(ENTER);
  await settle('permission');
  await capture('06-permission-menu');

  // --- Phase 4: answer the permission menu and watch the tool run ---------
  const permMenu = await currentMenu();
  if (permMenu) {
    console.log('\n--- PERMISSION MENU PARSED ---');
    console.log(`header: ${permMenu.header}`);
    for (const o of permMenu.options) {
      console.log(`  ${o.selected ? '>' : ' '} ${o.index}. ${o.label}`);
    }
    console.log(`hint: ${permMenu.hint}`);

    const allow = permMenu.options.find((o) => /^yes/i.test(o.label)) ?? permMenu.options[0];
    if (allow) {
      console.log(`\n>>> selecting option ${allow.index} "${allow.label}"`);
      child.write(keysToSelect(permMenu, allow.index));
      lastOutputAt = Date.now();
      await settle('tool-run');
      await capture('07-after-permission');
    }
  } else {
    console.log('\n!!! no permission menu detected - check phase 06');
  }

  // --- Shut down ----------------------------------------------------------
  if (!exited) {
    child.kill();
    await delay(800);
  }

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, 'raw.log'), rawChunks.join(''), 'utf8');
  await writeFile(path.join(OUT_DIR, 'phases.json'), JSON.stringify(phases, null, 2), 'utf8');
  await writeFile(path.join(OUT_DIR, 'all-lines.txt'), screen.allLines().join('\n'), 'utf8');

  console.log(`\n\nExit: ${exited ? exitInfo : 'still running (killed)'}`);
  console.log(`Wrote ${OUT_DIR}`);
  process.exit(0);
}

/** node-pty needs a string-valued env; process.env has optional undefineds. */
function cleanEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') out[k] = v;
  }
  out['TERM'] = 'xterm-256color';
  return out;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
