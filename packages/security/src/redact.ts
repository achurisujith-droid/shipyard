/**
 * Take the secrets out before anything is shown, stored or sent.
 *
 * This runs on every path where project text leaves its original file: gate
 * output, incident detail, escalation packets, support bundles, telemetry. It
 * is the last line rather than the only one — the real defence is that Shipyard
 * never asks for a provider password and never stores an agent token — but it
 * is the line that catches the user's own `.env` ending up in a bug report.
 *
 * Deliberately over-eager. A redacted string that did not need redacting costs
 * a developer one question. A leaked live key costs the founder their account.
 */

interface Pattern {
  name: string;
  re: RegExp;
  /** Keep this many leading characters so a human can tell keys apart. */
  keep?: number;
}

/**
 * Ordered most specific first: a Stripe live key should be reported as a Stripe
 * live key, not as "a long random string".
 */
const PATTERNS: Pattern[] = [
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, keep: 10 },
  { name: 'OpenAI API key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, keep: 6 },
  { name: 'Stripe secret key', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, keep: 11 },
  { name: 'Stripe webhook secret', re: /\bwhsec_[A-Za-z0-9]{16,}/g, keep: 6 },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, keep: 4 },
  { name: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, keep: 4 },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{20,}/g, keep: 4 },
  { name: 'Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, keep: 5 },
  { name: 'Sentry DSN', re: /\bhttps:\/\/[0-9a-f]{16,}@[\w.-]+\/\d+/g, keep: 8 },
  { name: 'private key', re: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g },
  { name: 'JSON web token', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, keep: 6 },
  {
    name: 'connection string password',
    re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]+)(@)/gi,
  },
  // Last resort: anything assigned to a name that says it is a secret. Catches
  // the keys we have never seen, which is most of them.
  {
    name: 'secret-looking assignment',
    re: /\b([A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|APIKEY|API_KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL)[A-Z0-9_]*)\s*[:=]\s*["']?([^\s"'\r\n]{8,})["']?/g,
  },
];

export interface Redaction {
  /** Which pattern matched, for the finding — never the value. */
  name: string;
  count: number;
}

export interface RedactResult {
  text: string;
  redactions: Redaction[];
}

/** Replace every secret in `text`, and say what was replaced. */
export function redact(text: string): RedactResult {
  let out = text;
  const found = new Map<string, number>();

  for (const pattern of PATTERNS) {
    out = out.replace(pattern.re, (match, ...groups: unknown[]) => {
      found.set(pattern.name, (found.get(pattern.name) ?? 0) + 1);

      // Connection strings: keep the scheme, host and user, lose the password.
      if (pattern.name === 'connection string password') {
        return `${String(groups[0])}[redacted]${String(groups[2])}`;
      }
      // Named assignments: keep the name so the reader knows which one it was.
      if (pattern.name === 'secret-looking assignment') {
        return `${String(groups[0])}=[redacted]`;
      }
      if (pattern.keep && match.length > pattern.keep) {
        return `${match.slice(0, pattern.keep)}[redacted]`;
      }
      return '[redacted]';
    });
  }

  return {
    text: out,
    redactions: [...found].map(([name, count]) => ({ name, count })),
  };
}

/** Convenience for the common case: give me the safe string. */
export function redacted(text: string): string {
  return redact(text).text;
}

/**
 * Redact an object's string values, for environment summaries.
 *
 * Values under a key that names a secret are dropped entirely rather than
 * pattern-matched — `DATABASE_URL` is a secret whatever it happens to look
 * like, and a short password would slip through the length checks above.
 */
const SECRET_KEY_RE =
  /(SECRET|PASSWORD|PASSWD|TOKEN|KEY|CREDENTIAL|DSN|DATABASE_URL|CONNECTION)/i;

export function redactEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    out[key] = SECRET_KEY_RE.test(key) ? '[redacted]' : redacted(value);
  }
  return out;
}
