import { capLength, clean, looksEmpty } from '@/components/document_text_extract/clean';
import { describeKind, isLegacyDoc, sniff, type DocumentKind } from '@/components/document_text_extract/sniff';

/**
 * One way in, whatever the file is.
 *
 * The shape of the result is the point. It never throws for a document it
 * cannot read and never returns a bare string, because both make it easy for a
 * caller to store nothing and believe they stored something. `ok` has to be
 * checked, and when it is false there is a sentence to show the person who
 * uploaded the file.
 */

export const MAX_BYTES = 20 * 1024 * 1024;

export type ExtractResult =
  | { ok: true; kind: DocumentKind; text: string; words: number; truncated: boolean; pages?: number }
  | { ok: false; kind: DocumentKind; reason: string; /** Safe to show the user. */ message: string };

export async function extractText(
  file: Uint8Array,
  options: { maxCharacters?: number } = {},
): Promise<ExtractResult> {
  if (file.length === 0) {
    return { ok: false, kind: 'unknown', reason: 'empty_file', message: 'That file is empty.' };
  }
  if (file.length > MAX_BYTES) {
    return {
      ok: false,
      kind: 'unknown',
      reason: 'too_large',
      message: `That file is bigger than ${Math.floor(MAX_BYTES / 1024 / 1024)} MB. Please upload a smaller one.`,
    };
  }
  if (isLegacyDoc(file)) {
    return { ok: false, kind: 'unknown', reason: 'legacy_doc', message: describeKind('unknown', true) };
  }

  const kind = sniff(file);
  let raw = '';
  let pages: number | undefined;

  try {
    if (kind === 'pdf') {
      const { extractText: pdfText, getDocumentProxy } = await import('unpdf');
      const document = await getDocumentProxy(file);
      // `mergePages` narrows the return type to a single string, so the union
      // is resolved for us here rather than needing a runtime check.
      const result = await pdfText(document, { mergePages: true });
      raw = result.text;
      pages = result.totalPages;
    } else if (kind === 'docx') {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer: Buffer.from(file) });
      raw = result.value;
    } else if (kind === 'plain') {
      raw = new TextDecoder('utf-8', { fatal: false }).decode(file);
    } else {
      return {
        ok: false,
        kind,
        reason: 'unsupported',
        message: `That file is ${describeKind(kind)}`,
      };
    }
  } catch (error) {
    // A corrupt or password-protected file. The library's own message is not
    // written for the person who uploaded it.
    return {
      ok: false,
      kind,
      reason: 'unreadable',
      message: `That ${describeKind(kind)} could not be opened. It may be damaged or password-protected.`,
    };
  }

  const cleaned = clean(raw);

  // The failure worth catching: a scanned document reads as a successful
  // extraction of nothing, and the app saves an empty record without complaint.
  if (looksEmpty(cleaned, pages ?? 1)) {
    return {
      ok: false,
      kind,
      reason: 'no_text',
      message:
        kind === 'pdf'
          ? 'That PDF has no text in it — it is most likely a scan, which is a picture of the words rather than the words themselves. Please upload a version saved from the original document.'
          : 'There is no readable text in that file.',
    };
  }

  const capped = capLength(cleaned, options.maxCharacters);
  return {
    ok: true,
    kind,
    text: capped.text,
    words: capped.text.split(/\s+/).filter(Boolean).length,
    truncated: capped.truncated,
    ...(pages !== undefined ? { pages } : {}),
  };
}
