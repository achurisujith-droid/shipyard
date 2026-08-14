import {
  providerFromEnv,
  type EmailMessage,
  type EmailProvider,
  type SendOutcome,
} from '@/components/transactional_email/providers';

/**
 * Sending an email, with the guard rails on.
 *
 * The guard rail that earns its place is the allowlist. Outside production,
 * this refuses to email anyone who is not explicitly listed — because the
 * accident it prevents is a seed script or a test run reaching a real customer,
 * and that accident is unrecoverable in a way that a bug in a template is not.
 */

/** A shape check, not a validity check — only sending proves an address works. */
const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function looksLikeAnAddress(value: string): boolean {
  const trimmed = value.trim();
  // Header injection: a newline in an address field can add headers of its own.
  if (/[\r\n]/.test(trimmed)) return false;
  if (trimmed.length > 254) return false;
  return ADDRESS.test(trimmed);
}

/** Who we are allowed to email in this environment. */
export function mayEmail(address: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === 'production') return true;
  const allowed = (env.EMAIL_ALLOWLIST ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length === 0) return false;
  const target = address.trim().toLowerCase();
  return allowed.some((entry) =>
    entry.startsWith('@') ? target.endsWith(entry) : entry === target,
  );
}

/** Strip tags to make the plain-text alternative every email should carry. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface SendRequest {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

export async function sendEmail(
  request: SendRequest,
  options: { provider?: EmailProvider; env?: NodeJS.ProcessEnv } = {},
): Promise<SendOutcome> {
  const env = options.env ?? process.env;

  if (!looksLikeAnAddress(request.to)) {
    return { sent: false, error: 'That does not look like an email address.' };
  }
  if (/[\r\n]/.test(request.subject)) {
    return { sent: false, error: 'The subject line cannot contain a line break.' };
  }
  if (!mayEmail(request.to, env)) {
    console.info(`[email] not sending to ${request.to}: outside production, only allowlisted addresses are emailed.`);
    return { sent: false, error: 'Blocked: this address is not on the development allowlist.' };
  }

  const from = env.EMAIL_FROM?.trim();
  if (!from) return { sent: false, error: 'EMAIL_FROM is not set, so there is nobody to send from.' };

  const message: EmailMessage = {
    to: request.to.trim(),
    subject: request.subject,
    html: request.html,
    // Every email gets a plain-text alternative. Some clients only show that
    // one, and an empty one is a common reason mail is marked as spam.
    text: request.text?.trim() || htmlToText(request.html),
    ...(request.replyTo ? { replyTo: request.replyTo } : {}),
  };

  const provider = options.provider ?? providerFromEnv(env);
  return provider.send(message, from);
}
