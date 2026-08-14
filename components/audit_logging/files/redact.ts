/**
 * Keeping secrets out of the audit log.
 *
 * An audit log is the one table that is deliberately kept forever, exported for
 * investigations, and read by people who were not there at the time. It is
 * therefore the worst possible place for a password reset payload or an API key
 * to end up — and the most likely, because the code that writes it is usually
 * handed the whole request body.
 */

/** Keys whose values never get written down, whatever they contain. */
const SECRET_KEY = /(password|passwd|secret|token|api[-_]?key|authorization|cookie|session|credential|otp|pin|cvv|ssn|card[-_]?number)/i;

/** Values that look like credentials even when the key is innocent. */
const SECRET_VALUE: [RegExp, string][] = [
  [/\bsk_(?:live|test)_[A-Za-z0-9]{8,}/g, '[redacted:stripe-key]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, 'Bearer [redacted]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[redacted:token]'],
  [/(postgres(?:ql)?:\/\/)[^\s@"']*@/gi, '$1[redacted]@'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
];

const MAX_STRING = 500;
const MAX_DEPTH = 4;

/**
 * The change-record shape, which key-based redaction alone does not catch.
 *
 * Audit details routinely arrive as `{ field: 'password', value: '…' }` or
 * `{ name: 'apiKey', oldValue: …, newValue: … }`. The keys carrying the secret
 * are called `value` and `newValue`, which are innocent names — so the secret
 * has to be found by reading what the *neighbouring* key says the field is.
 */
const FIELD_NAME_KEYS = ['field', 'name', 'key', 'attribute', 'property'];
const FIELD_VALUE_KEYS = ['value', 'newvalue', 'oldvalue', 'from', 'to', 'previous', 'current', 'was', 'now'];

function namesASecretField(record: Record<string, unknown>): boolean {
  return FIELD_NAME_KEYS.some((key) => {
    const named = record[key];
    return typeof named === 'string' && SECRET_KEY.test(named);
  });
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    let out = value;
    for (const [pattern, replacement] of SECRET_VALUE) out = out.replace(pattern, replacement);
    return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}… [truncated]` : out;
  }

  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();

  // A log entry is not a backup. Past a few levels the value stops being
  // readable by a person and starts being a place for things to hide.
  if (depth >= MAX_DEPTH) return '[nested]';

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactValue(item, depth + 1));
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const secretField = namesASecretField(record);
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(record)) {
      if (SECRET_KEY.test(key)) {
        out[key] = '[redacted]';
      } else if (secretField && FIELD_VALUE_KEYS.includes(key.toLowerCase())) {
        out[key] = '[redacted]';
      } else {
        out[key] = redactValue(inner, depth + 1);
      }
    }
    return out;
  }

  return '[unloggable]';
}

/** Redact a whole details object, returning something safe to store. */
export function redactDetails(details: unknown): Record<string, unknown> | null {
  if (details === null || details === undefined) return null;
  const redacted = redactValue(details);
  if (redacted && typeof redacted === 'object' && !Array.isArray(redacted)) {
    return redacted as Record<string, unknown>;
  }
  return { value: redacted };
}
