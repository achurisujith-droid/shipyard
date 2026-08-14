import { describe, expect, it } from 'vitest';

import { scrubEvent, scrubHeaders, scrubObject, scrubText } from '@/components/sentry_error_monitoring/scrub';

/**
 * The contract for error monitoring.
 *
 * Every case here is about what does *not* get sent. Whether the event arrives
 * is something only a real Sentry account can answer — that is what the test
 * event route is for, and why this component is not marked verified.
 */

describe('what never leaves with an error report', () => {
  it('drops the authorization header', () => {
    expect(scrubHeaders({ authorization: 'Bearer secret-token' })['authorization']).toBe('[redacted]');
  });

  it('drops cookies whatever case they are written in', () => {
    expect(scrubHeaders({ Cookie: 'sid=abc' })['Cookie']).toBe('[redacted]');
    expect(scrubHeaders({ 'Set-Cookie': 'sid=abc' })['Set-Cookie']).toBe('[redacted]');
  });

  it('keeps the headers that help', () => {
    expect(scrubHeaders({ 'content-type': 'application/json' })['content-type']).toBe('application/json');
  });

  it('drops the request body entirely rather than trying to clean it', () => {
    const event = scrubEvent({ request: { data: { password: 'hunter2', note: 'anything' } } });
    expect(event.request?.data).toBe('[dropped]');
  });

  it('reduces the user to an id', () => {
    const event = scrubEvent({
      user: { id: 'u_1', email: 'sam@example.com', ip_address: '203.0.113.4', username: 'sam' },
    });
    expect(event.user).toEqual({ id: 'u_1' });
  });

  it('sends no user at all when there is no id', () => {
    expect(scrubEvent({ user: { email: 'sam@example.com' } }).user).toEqual({});
  });

  it('cleans the error message itself', () => {
    // Assembled rather than written out: a fixture that looks like a real key
    // gets a commit rejected by secret scanning, which is the feature working
    // correctly on its own test data.
    const fakeKey = `sk${'_live_'}${'A'.repeat(24)}`;
    const event = scrubEvent({
      exception: { values: [{ value: `failed for sam@example.com with ${fakeKey}` }] },
    });
    const text = JSON.stringify(event);
    expect(text).not.toContain('sam@example.com');
    expect(text).not.toContain(fakeKey);
  });

  it('cleans a credential out of the URL', () => {
    // Password-reset links and signed download links are the commonest way a
    // working credential reaches a third party's database.
    const event = scrubEvent({ request: { url: 'https://app.example.com/reset?token=abc123def456&page=2' } });
    expect(event.request?.url).not.toContain('abc123def456');
    expect(event.request?.url).toContain('page=2');
  });

  it('catches a reset code, which does not look like anything', () => {
    const event = scrubEvent({ request: { url: 'https://app.example.com/verify?code=884213' } });
    expect(event.request?.url).not.toContain('884213');
  });

  it('cleans a database password out of a connection error', () => {
    expect(scrubText('connect failed postgresql://app:hunter2@db.internal/shop')).not.toContain('hunter2');
  });

  it('removes anything shaped like a card number', () => {
    expect(scrubText('card 4242 4242 4242 4242 declined')).not.toContain('4242 4242 4242 4242');
  });

  it('reaches into extra context', () => {
    const event = scrubEvent({ extra: { apiKey: 'abc123', nested: { sessionToken: 'xyz' } } });
    const text = JSON.stringify(event.extra);
    expect(text).not.toContain('abc123');
    expect(text).not.toContain('xyz');
  });

  it('stops descending rather than following a deep structure', () => {
    expect(JSON.stringify(scrubObject({ a: { b: { c: { d: { e: 'buried' } } } } }))).not.toContain('buried');
  });

  it('leaves an ordinary event alone', () => {
    const event = scrubEvent({ message: 'Could not load the bookings page' });
    expect(event.message).toBe('Could not load the bookings page');
  });

  it('does not fall over on an empty event', () => {
    expect(() => scrubEvent({})).not.toThrow();
  });
});
