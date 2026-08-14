import { Terminal } from '@xterm/headless';

/**
 * A point-in-time read of the terminal screen. Everything the state machine
 * decides is derived from one of these — never from raw ANSI bytes.
 */
export interface ScreenSnapshot {
  /**
   * `alternate` means the app took over the whole screen and there is no
   * scrollback, which would invalidate the committed-line strategy below.
   * The probe harness checks this first.
   */
  bufferType: 'normal' | 'alternate';
  /** Total lines held: scrollback + viewport. */
  totalLines: number;
  /** Absolute index of the first viewport line. Lines below this are frozen. */
  baseY: number;
  /** Cursor position in absolute line coordinates. */
  cursorAbsY: number;
  cursorX: number;
  /** The visible viewport, trailing blank lines removed. */
  viewport: string[];
}

export interface ScreenBufferOptions {
  cols: number;
  rows: number;
  /**
   * Lines of history to retain. Once exceeded, xterm drops the oldest lines and
   * absolute indices shift, which would desync committed-line tracking. Sized
   * generously; `isHistorySaturated()` reports when we are near the edge.
   */
  scrollback?: number;
}

/**
 * Wraps @xterm/headless so the rest of the bridge reads a rendered screen
 * instead of a byte stream.
 *
 * The core idea for clean, de-duplicated text extraction: a TUI repaints its
 * viewport constantly, so viewport text is unreliable to harvest. But once a
 * line scrolls above the viewport (absolute index < baseY) it can never be
 * repainted again. Those lines are append-only truth. We harvest only from
 * there, tracking how far we have consumed.
 */
export class ScreenBuffer {
  private readonly term: Terminal;
  private readonly scrollback: number;
  private readonly rows: number;

  constructor(opts: ScreenBufferOptions) {
    this.scrollback = opts.scrollback ?? 20_000;
    this.rows = opts.rows;
    this.term = new Terminal({
      cols: opts.cols,
      rows: opts.rows,
      scrollback: this.scrollback,
      allowProposedApi: true,
      convertEol: false,
    });
  }

  /** Feed PTY output in. Resolves once xterm has parsed it and the buffer is current. */
  write(data: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.term.write(data, () => resolve());
    });
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  snapshot(): ScreenSnapshot {
    const buf = this.term.buffer.active;
    const baseY = buf.baseY;

    const viewport: string[] = [];
    for (let y = 0; y < this.rows; y += 1) {
      viewport.push(this.lineAt(baseY + y));
    }
    while (viewport.length > 0 && (viewport[viewport.length - 1] ?? '').trim() === '') {
      viewport.pop();
    }

    return {
      bufferType: buf.type,
      totalLines: buf.length,
      baseY,
      cursorAbsY: baseY + buf.cursorY,
      cursorX: buf.cursorX,
      viewport,
    };
  }

  /** Absolute-indexed line read. Out of range yields '' rather than throwing. */
  lineAt(absIndex: number): string {
    const line = this.term.buffer.active.getLine(absIndex);
    if (!line) return '';
    return line.translateToString(true);
  }

  /**
   * Lines that have scrolled out of the viewport since `fromAbsIndex` and are
   * therefore final. Returns the next index to pass in on the following call.
   */
  takeCommitted(fromAbsIndex: number): { lines: string[]; nextIndex: number } {
    const baseY = this.term.buffer.active.baseY;
    if (fromAbsIndex >= baseY) return { lines: [], nextIndex: fromAbsIndex };

    const lines: string[] = [];
    for (let y = fromAbsIndex; y < baseY; y += 1) {
      lines.push(this.lineAt(y));
    }
    return { lines, nextIndex: baseY };
  }

  /** Everything currently held, scrollback first. For diagnostics and REPORT.md. */
  allLines(): string[] {
    const buf = this.term.buffer.active;
    const out: string[] = [];
    for (let y = 0; y < buf.length; y += 1) out.push(this.lineAt(y));
    return out;
  }

  /**
   * True once history is at capacity, meaning old lines are being dropped and
   * absolute indices are no longer stable. Callers should treat this as a
   * signal to stop trusting previously stored indices.
   */
  isHistorySaturated(): boolean {
    return this.term.buffer.active.length >= this.scrollback + this.rows;
  }

  dispose(): void {
    this.term.dispose();
  }
}
