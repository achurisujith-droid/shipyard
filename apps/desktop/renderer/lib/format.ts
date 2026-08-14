/**
 * Turning machine output into something a non-developer can read.
 *
 * PRODUCT.md principle 4: say what happened, not what ran. The CLI reports
 * `Write(src/app.tsx)`; the user wants "Created src/app.tsx". The raw form is
 * kept and shown on demand, never as the headline.
 */

export interface Activity {
  /** Plain-language headline. */
  label: string;
  /** The raw form, shown only when the user expands the row. */
  detail: string;
  /** Single glyph. Deliberately not an icon font: nothing to load, nothing to break. */
  icon: string;
}

/** `Write(src/app.tsx)` -> name "Write", args "src/app.tsx" */
function splitCall(summary: string): { name: string; args: string } {
  const match = /^([A-Za-z_][\w]*)\((.*)\)\s*$/s.exec(summary.trim());
  if (!match) return { name: summary.trim(), args: '' };
  return { name: match[1] ?? '', args: match[2] ?? '' };
}

export function describeActivity(toolName: string, summary: string): Activity {
  const { name, args } = splitCall(summary);
  const tool = (toolName || name || 'Tool').trim();
  const target = args.trim();

  switch (tool) {
    case 'Write':
      return { label: target ? `Created ${target}` : 'Created a file', detail: summary, icon: '+' };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { label: target ? `Edited ${target}` : 'Edited a file', detail: summary, icon: '±' };
    case 'Read':
      return { label: target ? `Read ${target}` : 'Read a file', detail: summary, icon: '◦' };
    case 'Bash':
      // The command itself is jargon; keep it in the detail, not the headline.
      return { label: 'Ran a command', detail: summary, icon: '›' };
    case 'Glob':
    case 'Grep':
      return { label: 'Searched your project', detail: summary, icon: '⌕' };
    case 'TodoWrite':
      return { label: 'Updated its plan', detail: summary, icon: '☰' };
    case 'WebFetch':
    case 'WebSearch':
      return { label: 'Looked something up online', detail: summary, icon: '◇' };
    case 'Task':
      return { label: 'Started a helper', detail: summary, icon: '◈' };
    case 'Shipyard':
      return { label: summary, detail: '', icon: '•' };
    default:
      return { label: target ? `${tool}: ${target}` : tool, detail: summary, icon: '•' };
  }
}

/** Box-drawing characters the CLI uses to render tables. */
const BOX_DRAWING = /[─-╿]/;
/** A fenced-code shape survives as indented lines even though the fences are stripped. */
const CODE_ISH = /[{};]\s*$|^\s*(?:const|let|var|function|class|import|export|def|public|private)\b/m;

/**
 * Should this reply be rendered as preformatted text?
 *
 * The CLI renders markdown itself before we ever see it: fences are stripped
 * and tables are drawn with box characters. Showing every reply in monospace
 * would make the whole app look like a terminal, which PRODUCT.md rules out.
 * So monospace is reserved for content that genuinely depends on alignment.
 */
export function isPreformatted(text: string): boolean {
  if (BOX_DRAWING.test(text)) return true;
  if (CODE_ISH.test(text)) return true;

  // Several consecutive indented lines: almost certainly a code block whose
  // fence the CLI removed.
  const lines = text.split('\n');
  let run = 0;
  for (const line of lines) {
    if (line.trim().length > 0 && /^\s{2,}/.test(line)) {
      run += 1;
      if (run >= 3) return true;
    } else if (line.trim().length > 0) {
      run = 0;
    }
  }
  return false;
}

/** "1m 04s" / "9s" - for a wait the user is watching. */
export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/**
 * "just now" / "yesterday" / "3 March" — for a timestamp the user is scanning.
 *
 * A list of apps is read to find one, not to audit it, so relative wording wins
 * until it stops being meaningful, at which point a date is clearer than
 * "47 days ago".
 */
export function formatWhen(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'at some point';

  const minutes = Math.floor((Date.now() - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;

  const date = new Date(then);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** Last path segment, for window titles and headers. */
export function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
