import { describe, expect, it } from 'vitest';

import { checkPassword, hashPassword, normaliseEmail, verifyPassword } from '@/components/auth/password';
import { LOCKOUT_SETTINGS, isLockedOut, lockoutMinutesRemaining } from '@/components/auth/lockout';
import { sameToken, sessionTokenHash } from '@/components/auth/session';

/**
 * The contract for sign-in.
 *
 * These are the cases that decide whether the component is safe rather than
 * merely working. They run without a database on purpose: the logic that stops
 * an attacker is pure, and pure logic can be checked on every build instead of
 * only when someone has a database running.
 */

describe('password rules', () => {
  it('refuses a short password', () => {
    expect(checkPassword('Sh0rt!').ok).toBe(false);
  });

  it('refuses one of the first passwords anyone would try', () => {
    expect(checkPassword('password123').ok).toBe(false);
  });

  it('refuses a password containing the email address', () => {
    const result = checkPassword('jasmine-2026-summer', { email: 'jasmine@example.com' });
    expect(result.ok).toBe(false);
    expect(result.issues.join(' ')).toMatch(/email/i);
  });

  it('refuses a password containing the person’s name', () => {
    expect(checkPassword('Priya!Priya!2026', { name: 'Priya' }).ok).toBe(false);
  });

  it('refuses a long run of the same character', () => {
    expect(checkPassword('Aaaaaaaaaaaa1!').ok).toBe(false);
  });

  it('refuses one that is long but has no variety', () => {
    expect(checkPassword('aaabbbcccdddeee').ok).toBe(false);
  });

  it('accepts a reasonable one', () => {
    expect(checkPassword('Harbour-Kettle-91', { email: 'sam@example.com' }).ok).toBe(true);
  });

  it('refuses one longer than bcrypt actually reads', () => {
    // bcrypt ignores everything past 72 bytes. Accepting a 200-character
    // password would mean silently only checking the first 72.
    expect(checkPassword(`${'Harbour-Kettle-91'.repeat(10)}`).ok).toBe(false);
  });

  it('says what is wrong in words a person can act on', () => {
    const issues = checkPassword('abc').issues.join(' ');
    expect(issues).not.toMatch(/regex|policy violation|ERR_/);
    expect(issues).toMatch(/at least 12 characters/);
  });
});

describe('password storage', () => {
  it('never stores the password itself', async () => {
    const hash = await hashPassword('Harbour-Kettle-91');
    expect(hash).not.toContain('Harbour-Kettle-91');
    expect(hash.startsWith('$2')).toBe(true);
  });

  it('accepts the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('Harbour-Kettle-91');
    expect(await verifyPassword('Harbour-Kettle-91', hash)).toBe(true);
    expect(await verifyPassword('Harbour-Kettle-92', hash)).toBe(false);
  });

  it('treats a corrupted hash as a failed sign-in rather than an error', async () => {
    await expect(verifyPassword('anything', 'not-a-hash')).resolves.toBe(false);
  });

  it('is not case sensitive about email addresses', () => {
    expect(normaliseEmail('  Sam@Example.COM ')).toBe('sam@example.com');
  });
});

describe('sessions', () => {
  it('stores a hash rather than the token', () => {
    const token = 'a-session-token';
    const stored = sessionTokenHash(token);
    expect(stored).not.toContain(token);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives the same token the same hash', () => {
    expect(sessionTokenHash('abc')).toBe(sessionTokenHash('abc'));
  });

  it('compares tokens without giving away where they differ', () => {
    expect(sameToken('abc', 'abc')).toBe(true);
    expect(sameToken('abc', 'abd')).toBe(false);
    expect(sameToken('abc', 'abcd')).toBe(false);
  });
});

describe('locking an account', () => {
  it('is not locked when nothing has gone wrong', () => {
    expect(isLockedOut({ lockedUntil: null })).toBe(false);
  });

  it('is locked while the lock is in the future', () => {
    expect(isLockedOut({ lockedUntil: new Date(Date.now() + 60_000) })).toBe(true);
  });

  it('unlocks itself once the time has passed', () => {
    expect(isLockedOut({ lockedUntil: new Date(Date.now() - 1) })).toBe(false);
  });

  it('can say how long is left, rounded up', () => {
    expect(lockoutMinutesRemaining({ lockedUntil: new Date(Date.now() + 61_000) })).toBe(2);
    expect(lockoutMinutesRemaining({ lockedUntil: null })).toBe(0);
  });

  it('never allows an unlimited number of attempts', () => {
    expect(LOCKOUT_SETTINGS.maxAttempts).toBeGreaterThanOrEqual(1);
    expect(LOCKOUT_SETTINGS.lockoutMs).toBeGreaterThanOrEqual(60_000);
  });
});
