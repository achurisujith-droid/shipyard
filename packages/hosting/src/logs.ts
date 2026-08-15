/**
 * The hosted app's logs and errors, coming back to the founder's Shipyard.
 *
 * This is the half of hosting that pays for the rest. The incident engine has
 * existed for a while and has had nothing to feed it: turning a production
 * failure into a fix task needed somebody's Sentry account, which needed the
 * founder to have set one up, which most had not. Hosting removes that — we are
 * running the process, so we already see it crash.
 *
 * The founder does not go looking at a dashboard. The error appears in the app
 * they are already in, next to the conversation where it can be fixed.
 *
 * ## The part that needs care
 *
 * A hosted app's logs are full of its users' information. Not by anybody's
 * intention — an error message quotes the row it choked on, a request log
 * carries the query string, a stack trace prints the arguments. That is
 * somebody's customer's email address, and the moment Shipyard *stores* it, we
 * have made a copy of personal data that nobody decided to make.
 *
 * So there are two different things and they are treated differently:
 *
 * **What the founder sees.** Their app, their data, their responsibility.
 * Streamed as it is.
 *
 * **What Shipyard keeps.** Redacted first, bounded in time, and only what an
 * incident needs. Support bundles and fix tasks are built from this one, never
 * from the stream.
 *
 * Getting that backwards is how a hosting provider ends up holding a shadow
 * copy of every customer database in its log store.
 */

export type LogStream = 'stdout' | 'stderr' | 'build' | 'request';

export interface LogLine {
  deploymentId: string;
  stream: LogStream;
  at: string;
  text: string;
  /** For request logs. */
  status?: number;
  route?: string;
  durationMs?: number;
}

/* ------------------------------------------------------------- redaction -- */

const PATTERNS: [RegExp, string][] = [
  // Credentials first — these must never survive into storage.
  [/\bsk_(?:live|test)_[A-Za-z0-9]{8,}/g, '[key]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, 'Bearer [redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[token]'],
  [/(postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:@/]+:[^\s@/]+@/gi, '$1://[redacted]@'],
  [/([?&](?:token|key|secret|password|code|auth|signature|sig|session)=)[^&\s"']+/gi, '$1[redacted]'],
  // Then the founder's customers.
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
  [/\b(?:\d[ -]*?){13,19}\b/g, '[card]'],
  // An IP address identifies a person, and a request log is full of them.
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]'],
  [/\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b/gi, '[ip]'],
];

const MAX_LINE = 2_000;

/**
 * Clean a line before Shipyard stores it.
 *
 * Not before showing it to the founder — that is their own data and hiding it
 * would make their logs useless for the one thing logs are for.
 */
export function redactForStorage(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out.length > MAX_LINE ? `${out.slice(0, MAX_LINE)}… [truncated]` : out;
}

/** How long Shipyard keeps its own copy. */
export const RETENTION_DAYS = 14;

export function expiresAt(at: string, days = RETENTION_DAYS): string {
  return new Date(new Date(at).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

export function isExpired(at: string, now = new Date(), days = RETENTION_DAYS): boolean {
  return new Date(expiresAt(at, days)).getTime() <= now.getTime();
}

/* ------------------------------------------------- errors worth reacting to */

/**
 * Lines that are worth waking somebody for, and lines that are not.
 *
 * A hosted Next.js app writes a great deal to stderr that is not a problem —
 * warnings, deprecations, the framework narrating itself. Treating all of it as
 * an incident would produce a product that cries wolf on day one, and a founder
 * who learns to ignore the thing that was supposed to tell them their app is
 * broken.
 */
const NOISE = [
  /^\s*(warn|warning|info|debug|trace|notice)\b/i,
  /\bdeprecat/i,
  /ExperimentalWarning/i,
  /punycode/i,
  /Browserslist/i,
  /^\s*(ready|compiled|event|wait|info)\s*-/i,
  /Fast Refresh/i,
  /webpack\.cache/i,
];

const ERROR_SIGNAL = [
  /^\s*(error|fatal|uncaught|unhandled)\b/i,
  /\bError:\s/,
  /\bException\b/,
  /\bat\s+\S+\s+\(.*:\d+:\d+\)/,
  /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EADDRINUSE/,
  /PrismaClient\w*Error/,
  /Cannot (?:find module|read propert)/i,
];

export function looksLikeAnError(line: LogLine): boolean {
  if (line.stream === 'request') return (line.status ?? 0) >= 500;
  if (NOISE.some((pattern) => pattern.test(line.text))) return false;
  if (line.stream === 'stderr') return ERROR_SIGNAL.some((pattern) => pattern.test(line.text));
  // stdout can still carry a crash, but the bar is higher.
  return /\bError:\s|\bUncaught\b|\bUnhandled\b/.test(line.text);
}

/**
 * The shape the incident engine already understands.
 *
 * Handed off rather than duplicated. Severity, risk and whether the agent may
 * attempt a fix are decided there, by rules that already have tests around
 * them; hosting's job is only to notice and to describe.
 */
export interface RawEventFromLogs {
  source: 'shipyard_hosting';
  environment: 'production';
  title: string;
  route?: string;
  stack?: string;
  release?: string;
}

/** Turn a log line into something the incident engine can reason about. */
export function toRawEvent(
  line: LogLine,
  context: { release?: string } = {},
): RawEventFromLogs | null {
  if (!looksLikeAnError(line)) return null;

  // Redacted here, not later. Everything downstream — the incident record, the
  // fix task, the escalation packet — is built from this, so a credential that
  // survives this line survives into all of them.
  const clean = redactForStorage(line.text);
  const firstLine = clean.split('\n')[0]?.trim() ?? clean;

  const title =
    line.stream === 'request' && line.status
      ? `${line.status} on ${line.route ?? 'a page'}`
      : firstLine.slice(0, 200);

  return {
    source: 'shipyard_hosting',
    environment: 'production',
    title,
    ...(line.route ? { route: line.route } : {}),
    ...(clean.includes('\n') ? { stack: clean } : {}),
    ...(context.release ? { release: context.release } : {}),
  };
}

/* ----------------------------------------------------------- rate limiting */

/**
 * One broken page, not four thousand incidents.
 *
 * A crashing route logs on every request. Without this, a founder's first
 * production error arrives as a wall of identical notifications, which is worse
 * than silence — silence at least does not train them to dismiss things.
 *
 * Grouped by what the error is rather than when it happened, so the count
 * becomes useful information: "this has happened 412 times since 09:14" is a
 * much better sentence than 412 rows.
 */
export function fingerprint(event: RawEventFromLogs): string {
  return event.title
    .toLowerCase()
    // Numbers in an error are usually ids, and grouping should not be defeated
    // by them.
    .replace(/\b\d+\b/g, 'N')
    .replace(/[0-9a-f]{8,}/gi, 'ID')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export interface Grouped {
  fingerprint: string;
  event: RawEventFromLogs;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Collapse a stream of events into the distinct problems behind them. */
export function group(events: readonly { event: RawEventFromLogs; at: string }[]): Grouped[] {
  const groups = new Map<string, Grouped>();

  for (const entry of events) {
    const key = fingerprint(entry.event);
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (entry.at > existing.lastSeenAt) existing.lastSeenAt = entry.at;
      if (entry.at < existing.firstSeenAt) existing.firstSeenAt = entry.at;
    } else {
      groups.set(key, {
        fingerprint: key,
        event: entry.event,
        count: 1,
        firstSeenAt: entry.at,
        lastSeenAt: entry.at,
      });
    }
  }

  return [...groups.values()].sort((a, b) => b.count - a.count);
}

/**
 * What to say to the founder about a group of errors.
 *
 * The number matters more than the message. "Something went wrong" is anxiety;
 * "this has happened to 3 people in the last hour" is a decision they can make.
 */
export function describeGroup(grouped: Grouped): string {
  const { count } = grouped;
  if (count === 1) return `This happened once, at ${grouped.firstSeenAt.slice(11, 16)}.`;
  return `This has happened ${count.toLocaleString()} times, most recently at ${grouped.lastSeenAt.slice(11, 16)}.`;
}
