/**
 * What must never leave the building with an error report.
 *
 * Error monitoring is a service you send your production failures to, and
 * production failures arrive holding whatever was in scope when they happened —
 * request bodies, headers, session cookies, the customer's email address. The
 * default configuration of every monitoring SDK sends more than a small company
 * has thought about, and it becomes a data-protection problem in a third
 * party's database that nobody remembers agreeing to.
 *
 * So this runs before anything is sent, and it is the part of this component
 * that is actually tested — because it is the part that can be tested without
 * an account, and the part that matters if it is wrong.
 */

/** Header names that carry credentials or identity. */
const SENSITIVE_HEADER = /^(authorization|cookie|set-cookie|x-api-key|x-auth-token|proxy-authorization)$/i;

/** Query and body keys whose values are never useful in a bug report. */
const SENSITIVE_KEY = /(password|passwd|secret|token|api[-_]?key|authorization|cookie|session|credential|otp|pin|cvv|card)/i;

const PATTERNS: [RegExp, string][] = [
  // A URL is the most common place a credential hides in an error report:
  // password-reset links, signed download links, callback URLs. Matched on the
  // parameter name rather than the shape of the value, because a reset code is
  // just a string and nothing about it looks secret.
  [/([?&](?:token|key|secret|password|code|auth|signature|sig|access_token|api_key|session)=)[^&\s"']+/gi, '$1[redacted]'],
  [/\bsk_(?:live|test)_[A-Za-z0-9]{8,}/g, '[redacted:key]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[redacted:token]'],
  [/(postgres(?:ql)?:\/\/)[^\s@"']*@/gi, '$1[redacted]@'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
  [/\b(?:\d[ -]*?){13,19}\b/g, '[redacted:card]'],
];

export function scrubText(value: string): string {
  let out = value;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export function scrubHeaders(headers: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!headers) return {};
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SENSITIVE_HEADER.test(name) ? '[redacted]' : typeof value === 'string' ? scrubText(value) : value;
  }
  return out;
}

export function scrubObject(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 4) return '[nested]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => scrubObject(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : scrubObject(inner, depth + 1);
    }
    return out;
  }
  return '[unloggable]';
}

/** The shape of a monitoring event, kept minimal so this file has no SDK import. */
export interface MonitoringEvent {
  message?: string;
  request?: {
    url?: string;
    headers?: Record<string, unknown>;
    data?: unknown;
    query_string?: string;
    cookies?: unknown;
  };
  user?: { id?: string; email?: string; ip_address?: string; username?: string };
  extra?: Record<string, unknown>;
  exception?: { values?: { value?: string }[] };
}

/**
 * The filter that runs on every event before it is sent.
 *
 * The user object is reduced to an id. Knowing *which* user hit a bug is what
 * makes it fixable; knowing their email address and IP is what makes the
 * monitoring account a copy of the customer list.
 */
export function scrubEvent(event: MonitoringEvent): MonitoringEvent {
  const scrubbed: MonitoringEvent = { ...event };

  if (event.message) scrubbed.message = scrubText(event.message);

  if (event.exception?.values) {
    scrubbed.exception = {
      values: event.exception.values.map((value) => ({
        ...value,
        ...(value.value ? { value: scrubText(value.value) } : {}),
      })),
    };
  }

  if (event.request) {
    scrubbed.request = {
      ...(event.request.url ? { url: scrubText(event.request.url) } : {}),
      headers: scrubHeaders(event.request.headers),
      // The body is dropped rather than scrubbed. It is the single most likely
      // place for something we did not think of, and a bug report almost never
      // needs it.
      data: '[dropped]',
      cookies: '[dropped]',
      ...(event.request.query_string ? { query_string: scrubText(event.request.query_string) } : {}),
    };
  }

  if (event.user) {
    scrubbed.user = event.user.id ? { id: event.user.id } : {};
  }

  if (event.extra) scrubbed.extra = scrubObject(event.extra) as Record<string, unknown>;

  return scrubbed;
}
