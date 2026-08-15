import { describe, expect, it } from 'vitest';

import { capLength, clean, looksEmpty } from '@/components/document_text_extract/clean';
import { describeKind, isLegacyDoc, sniff } from '@/components/document_text_extract/sniff';
import { extractText, MAX_BYTES } from '@/components/document_text_extract/extract';

/**
 * The contract for reading documents.
 *
 * The case that matters most is the scanned PDF. It does not error — it
 * succeeds at extracting nothing, and an app that does not check saves an empty
 * record and nobody notices until a person looks.
 */

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('working out what a file is', () => {
  it('recognises a PDF from its bytes', () => {
    expect(sniff(bytes(0x25, 0x50, 0x44, 0x46, 0x2d))).toBe('pdf');
  });

  it('recognises a Word document', () => {
    expect(sniff(bytes(0x50, 0x4b, 0x03, 0x04, 0x14))).toBe('docx');
  });

  it('recognises plain text', () => {
    expect(sniff(text('Dear Sir or Madam,\nI am writing to apply.'))).toBe('plain');
  });

  it('is not fooled by the file name', () => {
    // `cv.pdf` containing a Word document is a thing that happens, and handing
    // it to a PDF parser produces a confusing error rather than a useful one.
    expect(sniff(bytes(0x50, 0x4b, 0x03, 0x04))).toBe('docx');
  });

  it('rejects something that is not a document', () => {
    expect(sniff(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('unknown');
  });

  it('spots an old Word file and says what to do about it', () => {
    const legacy = bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
    expect(isLegacyDoc(legacy)).toBe(true);
    expect(describeKind('unknown', true)).toMatch(/save it as \.docx/);
  });

  it('describes every kind in words a person would understand', () => {
    for (const kind of ['pdf', 'docx', 'plain', 'unknown'] as const) {
      expect(describeKind(kind)).not.toMatch(/MIME|octet-stream|0x/);
    }
  });
});

describe('cleaning up extracted text', () => {
  it('rejoins a word broken across a line', () => {
    expect(clean('experi-\nence in accounting')).toBe('experience in accounting');
  });

  it('turns ligatures back into letters', () => {
    // PDFs emit these constantly and every search for "office" then fails.
    expect(clean('o\u{FB03}ce')).toBe('office');
  });

  it('removes invisible characters that break searching', () => {
    expect(clean('acc­ount')).toBe('account');
  });

  it('straightens curly quotes', () => {
    expect(clean('‘hello’')).toBe("'hello'");
  });

  it('collapses the blank lines left by page breaks', () => {
    expect(clean('one\n\n\n\n\ntwo')).toBe('one\n\ntwo');
  });
});

describe('a document with no text in it', () => {
  it('is spotted rather than returned as success', () => {
    expect(looksEmpty('')).toBe(true);
    expect(looksEmpty('  \n  ')).toBe(true);
  });

  it('counts stray page furniture as empty', () => {
    // A scanned page often yields a page number and nothing else.
    expect(looksEmpty('1\n\n2\n\n3')).toBe(true);
  });

  it('scales with the number of pages', () => {
    const shortText = 'One sentence of about twelve words which is fine for a single page.';
    expect(looksEmpty(shortText, 1)).toBe(false);
    expect(looksEmpty(shortText, 20)).toBe(true);
  });

  it('accepts a real document', () => {
    expect(looksEmpty('I have eight years of experience in accounts payable and reconciliation work.')).toBe(false);
  });
});

describe('very long documents', () => {
  it('are cut down', () => {
    const result = capLength('x'.repeat(500), 100);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(100);
  });

  it('are cut at a word boundary', () => {
    const result = capLength(`${'word '.repeat(50)}end`, 100);
    expect(result.text.endsWith(' ')).toBe(false);
    expect(result.text).not.toMatch(/wo$/);
  });

  it('are left alone when short enough', () => {
    expect(capLength('short', 100)).toEqual({ text: 'short', truncated: false });
  });
});

describe('the one way in', () => {
  it('refuses an empty file in words the uploader can act on', async () => {
    const result = await extractText(new Uint8Array(0));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toBe('That file is empty.');
  });

  it('refuses one that is too big, and says how big is allowed', async () => {
    const result = await extractText(new Uint8Array(MAX_BYTES + 1));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/20 MB/);
  });

  it('refuses a file that is not a document', async () => {
    const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);
    const result = await extractText(png);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/PDFs, Word documents and text files work/);
  });

  it('reads a plain text file', async () => {
    const result = await extractText(
      text('I have eight years of experience in accounts payable, reconciliation and month-end close.'),
    );
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.words).toBeGreaterThan(10);
  });

  it('never throws, whatever it is given', async () => {
    for (const input of [new Uint8Array(0), bytes(0), bytes(255, 255, 255), text('x')]) {
      await expect(extractText(input)).resolves.toBeDefined();
    }
  });

  it('never returns a bare string, so a caller has to check', async () => {
    const result = await extractText(text('hello'));
    expect(typeof result).toBe('object');
    expect('ok' in result).toBe(true);
  });

  it('explains a scanned PDF rather than saying nothing went wrong', async () => {
    // A PDF header with no page content: the shape of a scan as far as text
    // extraction is concerned.
    const result = await extractText(text('%PDF-1.4\n%%EOF\n'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(['no_text', 'unreadable']).toContain(result.reason);
      expect(result.message.length).toBeGreaterThan(20);
      expect(result.message).not.toMatch(/undefined|null|Error:/);
    }
  });
});
