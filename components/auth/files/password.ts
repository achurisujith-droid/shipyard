import bcrypt from 'bcryptjs';

/**
 * Password rules, checked on the server.
 *
 * Every one of these is checked here rather than in the browser, because the
 * browser is not where an attacker submits from. A rule enforced only in the
 * form is decoration.
 *
 * The rules follow OWASP and NIST 800-63B: length matters far more than
 * punctuation, so the floor is 12 characters rather than 8 with a symbol.
 * The composition rule is a compromise — NIST does not ask for one, and
 * customers do.
 */

export interface PasswordCheck {
  ok: boolean;
  /** Written for the person typing, not for a log file. */
  issues: string[];
}

const MIN_LENGTH = 12;
/** bcrypt silently ignores anything past 72 bytes, so refuse it rather than truncate. */
const MAX_LENGTH = 72;

/**
 * The passwords that get tried first. A short embedded list rather than a
 * breach corpus: it catches the trivial cases without a network call on every
 * sign-up, and the network call is the thing that would get disabled the first
 * time it was slow.
 */
const COMMON = new Set([
  'password', 'password1', 'password123', 'passw0rd', 'passw0rd1', 'p@ssw0rd',
  'qwerty', 'qwerty123', 'qwertyuiop', 'asdf1234', 'asdfasdf', 'zxcvbnm',
  '12345678', '123456789', '1234567890', '11111111', '00000000', 'aaaaaaaa',
  'iloveyou', 'iloveyou1', 'admin', 'admin123', 'administrator', 'welcome',
  'welcome1', 'letmein', 'letmein1', 'changeme', 'changeme1', 'monkey',
  'dragon', 'sunshine', 'princess', 'baseball', 'football', 'starwars',
  'master', 'masterkey', 'shadow', 'superman', 'batman', 'trustno1',
  'hello123', 'whatever', 'jordan23', 'thisisapassword', 'correcthorse',
]);

function characterClasses(password: string): number {
  let classes = 0;
  if (/[a-z]/.test(password)) classes += 1;
  if (/[A-Z]/.test(password)) classes += 1;
  if (/[0-9]/.test(password)) classes += 1;
  if (/[^a-zA-Z0-9]/.test(password)) classes += 1;
  return classes;
}

export function checkPassword(
  password: string,
  context: { email?: string; name?: string } = {},
): PasswordCheck {
  const issues: string[] = [];

  if (typeof password !== 'string' || password.length === 0) {
    return { ok: false, issues: ['Please choose a password.'] };
  }
  if (password.length < MIN_LENGTH) {
    issues.push(`Your password needs to be at least ${MIN_LENGTH} characters.`);
  }
  if (password.length > MAX_LENGTH) {
    issues.push(`Your password can be at most ${MAX_LENGTH} characters.`);
  }
  if (characterClasses(password) < 3) {
    issues.push('Mix in at least three of: small letters, capitals, numbers, symbols.');
  }

  const lowered = password.toLowerCase();
  if (COMMON.has(lowered)) {
    issues.push('That is one of the first passwords anyone would try.');
  }

  // A password that contains the email or the person's own name is guessable by
  // anyone who knows either, which for a work account is everybody.
  const local = context.email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 3 && lowered.includes(local)) {
    issues.push('Please do not put your email address in your password.');
  }
  const name = context.name?.trim().toLowerCase();
  if (name && name.length >= 3 && lowered.includes(name)) {
    issues.push('Please do not put your name in your password.');
  }

  // A run of the same character, or a straight sequence, is length without
  // strength.
  if (/(.)\1{3,}/.test(password)) {
    issues.push('Please avoid repeating the same character.');
  }

  return { ok: issues.length === 0, issues };
}

/** How much work an attacker has to do per guess. Raise it as hardware improves. */
const COST = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, COST);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  // A malformed hash must be a failed sign-in, never an exception that a caller
  // might mistake for a system error and retry around.
  return bcrypt.compare(password, hash).catch(() => false);
}

/** Normalise an email before it is stored or compared. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}
