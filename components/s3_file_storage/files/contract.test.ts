import { describe, expect, it } from 'vitest';

import {
  ALLOWED_TYPES,
  MAX_BYTES,
  isAllowedSize,
  isAllowedType,
  keyBelongsTo,
  safeDisplayName,
  storageKey,
} from '@/components/s3_file_storage/keys';

/**
 * The contract for uploads.
 *
 * A filename is user input arriving from a form. Everything here is a rehearsal
 * of somebody putting something unexpected in it.
 */

describe('the key a file is stored under', () => {
  it('is scoped to the organisation', () => {
    expect(storageKey({ organizationId: 'org1', contentType: 'image/png' })).toMatch(/^org\/org1\//);
  });

  it('is random rather than taken from the filename', () => {
    const a = storageKey({ organizationId: 'org1', contentType: 'image/png' });
    const b = storageKey({ organizationId: 'org1', contentType: 'image/png' });
    expect(a).not.toBe(b);
  });

  it('refuses an organisation id that is not one', () => {
    // A path fragment in the organisation id would put files outside the prefix
    // they were meant to be in.
    expect(() => storageKey({ organizationId: '../../etc', contentType: 'image/png' })).toThrow();
    expect(() => storageKey({ organizationId: '', contentType: 'image/png' })).toThrow();
  });

  it('recognises which organisation a key belongs to', () => {
    const key = storageKey({ organizationId: 'org1', contentType: 'image/png' });
    expect(keyBelongsTo(key, 'org1')).toBe(true);
    expect(keyBelongsTo(key, 'org2')).toBe(false);
  });

  it('rejects a key that tries to climb out of its folder', () => {
    expect(keyBelongsTo('org/org1/../org2/secret.pdf', 'org1')).toBe(false);
  });

  it('is not fooled by a prefix that merely starts the same', () => {
    expect(keyBelongsTo('org/org12/file.png', 'org1')).toBe(false);
  });
});

describe('the name shown to a person', () => {
  it('keeps an ordinary filename', () => {
    expect(safeDisplayName('quarterly report.pdf')).toBe('quarterly report.pdf');
  });

  it('strips a path off the front', () => {
    expect(safeDisplayName('../../../etc/passwd')).toBe('passwd');
    expect(safeDisplayName('C:\\Users\\sam\\secret.txt')).toBe('secret.txt');
  });

  it('removes characters that break things downstream', () => {
    expect(safeDisplayName('re:port<>|?.pdf')).not.toMatch(/[<>:|?]/);
  });

  it('never returns an empty name', () => {
    expect(safeDisplayName('...')).toBe('file');
    expect(safeDisplayName('/')).toBe('file');
  });

  it('caps the length', () => {
    expect(safeDisplayName(`${'a'.repeat(500)}.pdf`).length).toBeLessThanOrEqual(120);
  });

  it('strips control characters', () => {
    expect(safeDisplayName('report\u0000.pdf')).toBe('report.pdf');
  });
});

describe('what may be uploaded', () => {
  it('accepts the types on the list', () => {
    for (const type of Object.keys(ALLOWED_TYPES)) expect(isAllowedType(type)).toBe(true);
  });

  it('ignores a charset suffix', () => {
    expect(isAllowedType('text/csv; charset=utf-8')).toBe(true);
  });

  it('refuses anything else', () => {
    expect(isAllowedType('application/x-msdownload')).toBe(false);
    expect(isAllowedType('text/html')).toBe(false);
    expect(isAllowedType('')).toBe(false);
  });

  it('refuses an empty file and one that is too big', () => {
    expect(isAllowedSize(0)).toBe(false);
    expect(isAllowedSize(MAX_BYTES)).toBe(true);
    expect(isAllowedSize(MAX_BYTES + 1)).toBe(false);
    expect(isAllowedSize(-1)).toBe(false);
    expect(isAllowedSize(1.5)).toBe(false);
  });
});
