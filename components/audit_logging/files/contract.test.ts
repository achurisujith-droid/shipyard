import { describe, expect, it } from 'vitest';

import { describeEvent } from '@/components/audit_logging/audit';
import { redactDetails, redactValue } from '@/components/audit_logging/redact';

/**
 * The contract for the audit log.
 *
 * The log is the table most likely to be exported, kept forever, and read by
 * someone who was not there. So the cases that matter most are not about
 * writing rows — they are about what must never end up in one.
 */

describe('what never reaches the log', () => {
  it('drops anything under a key that names a secret', () => {
    const stored = redactDetails({ email: 'a@b.com', password: 'hunter2', apiKey: 'abc123' });
    expect(JSON.stringify(stored)).not.toContain('hunter2');
    expect(JSON.stringify(stored)).not.toContain('abc123');
  });

  it('catches a key written in a different style', () => {
    for (const key of ['api_key', 'API-KEY', 'accessToken', 'Authorization', 'sessionSecret']) {
      const stored = redactDetails({ [key]: 'should-not-survive' });
      expect(JSON.stringify(stored)).not.toContain('should-not-survive');
    }
  });

  it('catches a live payment key even under an innocent name', () => {
    const key = `sk_live_${'A'.repeat(24)}`;
    const stored = redactDetails({ note: `the key is ${key}` });
    expect(JSON.stringify(stored)).not.toContain(key);
  });

  it('catches a bearer token and a signed token', () => {
    const bearer = redactDetails({ header: `Bearer ${'a'.repeat(40)}` });
    expect(JSON.stringify(bearer)).not.toContain('a'.repeat(40));

    const jwt = `eyJhbGciOiJIUzI1NiJ9.${'b'.repeat(20)}.${'c'.repeat(20)}`;
    expect(JSON.stringify(redactDetails({ token: jwt }))).not.toContain('b'.repeat(20));
  });

  it('keeps the database host but not the password', () => {
    const stored = JSON.stringify(redactDetails({ dsn: 'postgresql://app:hunter2@db.internal/shop' }));
    expect(stored).not.toContain('hunter2');
    expect(stored).toContain('db.internal');
  });

  it('does not keep email addresses in the details', () => {
    // The actor is recorded as an id. Repeating addresses in free-form details
    // turns the log into a second copy of the customer list.
    expect(JSON.stringify(redactDetails({ note: 'chased sam@example.com' }))).not.toContain('sam@example.com');
  });

  it('reaches inside nested objects and arrays', () => {
    const stored = JSON.stringify(
      redactDetails({ changes: [{ field: 'password', value: 'hunter2' }], meta: { deep: { token: 'xyz789' } } }),
    );
    expect(stored).not.toContain('hunter2');
    expect(stored).not.toContain('xyz789');
  });

  it('stops descending rather than following a deeply nested structure', () => {
    const deep = { a: { b: { c: { d: { e: 'buried' } } } } };
    expect(JSON.stringify(redactValue(deep))).not.toContain('buried');
  });

  it('truncates something enormous rather than storing it whole', () => {
    const long = redactValue('x'.repeat(5_000));
    expect(String(long).length).toBeLessThan(600);
    expect(String(long)).toContain('truncated');
  });

  it('survives values that are not JSON at all', () => {
    expect(() => redactDetails({ fn: () => undefined, sym: Symbol('x') })).not.toThrow();
  });

  it('leaves ordinary values alone', () => {
    const stored = redactDetails({ status: 'cancelled', count: 3, ok: true });
    expect(stored).toEqual({ status: 'cancelled', count: 3, ok: true });
  });
});

describe('describing an event for a person', () => {
  it('reads as a sentence', () => {
    expect(describeEvent({ action: 'booking.cancelled', entityType: 'booking', entityId: '42', actorUserId: 'u1' }))
      .toBe('Someone cancelled booking 42');
  });

  it('distinguishes the system from a person', () => {
    expect(describeEvent({ action: 'retention.swept', entityType: 'candidate', actorUserId: null }))
      .toMatch(/^The system/);
  });

  it('copes with an action that has no dot in it', () => {
    expect(describeEvent({ action: 'exported', entityType: 'report' })).toContain('exported');
  });
});
