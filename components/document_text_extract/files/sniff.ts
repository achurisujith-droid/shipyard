/**
 * Working out what a file actually is.
 *
 * From its first few bytes, never from its name. A filename is user input, and
 * `invoice.pdf` is a thing anybody can call anything — including a .docx, a
 * spreadsheet, or something that is not a document at all.
 *
 * Trusting the extension here would mean handing a Word parser a PDF, getting a
 * confusing library error, and showing the user "something went wrong".
 */

export type DocumentKind = 'pdf' | 'docx' | 'plain' | 'unknown';

/** The first bytes that identify each format. */
const SIGNATURES: { kind: DocumentKind; bytes: number[] }[] = [
  // "%PDF"
  { kind: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
  // "PK\x03\x04" — a zip. Every .docx is one; so is every .xlsx, which is why
  // the caller checks the inner content type before trusting this.
  { kind: 'docx', bytes: [0x50, 0x4b, 0x03, 0x04] },
];

export function sniff(bytes: Uint8Array): DocumentKind {
  for (const signature of SIGNATURES) {
    if (signature.bytes.every((byte, index) => bytes[index] === byte)) return signature.kind;
  }

  // Plain text has no signature, so it is identified by absence: no null bytes
  // and mostly printable characters in the first kilobyte.
  const sample = bytes.subarray(0, 1024);
  if (sample.length === 0) return 'unknown';
  let printable = 0;
  for (const byte of sample) {
    if (byte === 0) return 'unknown';
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127) || byte >= 128) {
      printable += 1;
    }
  }
  return printable / sample.length > 0.9 ? 'plain' : 'unknown';
}

/** An old Word file, which looks like nothing else and is not supported. */
export function isLegacyDoc(bytes: Uint8Array): boolean {
  // The OLE compound-document header, used by Word 97–2003.
  const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  return ole.every((byte, index) => bytes[index] === byte);
}

/** What to tell somebody whose file cannot be read, in their words. */
export function describeKind(kind: DocumentKind, legacy = false): string {
  if (legacy) {
    return 'That is an older Word file (.doc). Open it in Word and save it as .docx, then try again.';
  }
  switch (kind) {
    case 'pdf':
      return 'a PDF';
    case 'docx':
      return 'a Word document';
    case 'plain':
      return 'a plain text file';
    case 'unknown':
      return 'not a document this can read. PDFs, Word documents and text files work.';
  }
}
