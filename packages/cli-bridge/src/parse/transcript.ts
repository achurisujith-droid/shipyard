/**
 * Parses the finished transcript region into semantic blocks.
 *
 * Grammar observed on 2.1.221 (see REPORT.md §6):
 *
 *   ❯ what the user sent            <- user turn, wrapped lines indented 2
 *   ● Write(probe.txt)              <- tool call: ● Name(args)
 *     ⎿  Wrote 1 line to probe.txt  <- tool result
 *   ● Created probe.txt.            <- assistant prose, wrapped lines indented 2
 *   ✻ Sautéed for 2s                <- end-of-turn summary (verb varies)
 *
 * Note both tool calls and assistant prose start with `●`; they are told apart
 * by whether the remainder looks like `Name(args)`.
 */

export type TranscriptBlock =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; name: string; summary: string; result: string }
  | { kind: 'status'; text: string };

const USER_RE = /^\s{0,3}❯\s?(.*)$/;
const BULLET_RE = /^\s{0,3}[●⏺]\s?(.*)$/;
/** `Write(probe.txt)` or `Bash(npm test)` - a tool call rather than prose. */
const TOOL_CALL_RE = /^([A-Z][A-Za-z0-9_]*)\((.*)\)\s*$/;
const RESULT_RE = /^\s*⎿\s?(.*)$/;
const STATUS_RE = /^\s{0,3}[✻✽*]\s?(.*)$/;
const RULE_RE = /^[─━]{20,}\s*$/;

/**
 * Convert transcript lines into blocks.
 *
 * `lines` must contain only finished transcript - never the live input box,
 * whose content is repainted and would produce duplicates.
 */
export function parseTranscript(lines: string[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  let current: { kind: 'user' | 'assistant' | 'tool'; parts: string[]; name?: string } | null = null;
  let toolResult: string[] = [];

  const flush = (): void => {
    if (!current) return;
    const text = dedent(current.parts).trim();
    if (current.kind === 'tool') {
      blocks.push({
        kind: 'tool',
        name: current.name ?? 'Tool',
        summary: text,
        result: dedent(toolResult).trim(),
      });
    } else if (text.length > 0) {
      blocks.push({ kind: current.kind, text });
    }
    current = null;
    toolResult = [];
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');

    if (RULE_RE.test(line)) {
      flush();
      continue;
    }

    const status = STATUS_RE.exec(line);
    if (status) {
      flush();
      const text = (status[1] ?? '').trim();
      if (text) blocks.push({ kind: 'status', text });
      continue;
    }

    const user = USER_RE.exec(line);
    if (user) {
      flush();
      current = { kind: 'user', parts: [user[1] ?? ''] };
      continue;
    }

    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      flush();
      const body = bullet[1] ?? '';
      const call = TOOL_CALL_RE.exec(body.trim());
      current = call
        ? { kind: 'tool', parts: [body.trim()], name: call[1] ?? 'Tool' }
        : { kind: 'assistant', parts: [body] };
      continue;
    }

    const result = RESULT_RE.exec(line);
    if (result && current?.kind === 'tool') {
      toolResult.push(result[1] ?? '');
      continue;
    }

    // Continuation: blank lines and indented lines belong to the open block.
    // A code block or table inside an assistant answer arrives this way.
    if (current && (line.trim() === '' || /^\s{2,}/.test(line))) {
      if (current.kind === 'tool' && toolResult.length > 0) {
        toolResult.push(line);
      } else {
        current.parts.push(line);
      }
      continue;
    }

    // Anything else ends the current block. Unindented prose with no marker is
    // CLI chrome (banners, notices), not conversation, so it is dropped.
    flush();
  }

  flush();
  return blocks;
}

/** Remove the common leading indentation the TUI adds to wrapped lines. */
function dedent(lines: string[]): string {
  const meaningful = lines.filter((l) => l.trim().length > 0);
  if (meaningful.length === 0) return '';
  const indent = Math.min(
    ...meaningful.map((l) => {
      const m = /^\s*/.exec(l);
      return m ? m[0].length : 0;
    }),
  );
  return lines
    .map((l) => (l.length >= indent ? l.slice(indent) : l.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}
