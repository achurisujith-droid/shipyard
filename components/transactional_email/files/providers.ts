/**
 * The email provider, behind a door you can change.
 *
 * Every provider does the same three things — take an address, a subject and a
 * body, and either accept it or say why not. Putting that behind one interface
 * means switching from one to another is a line of configuration rather than a
 * search through the codebase, which matters because free tiers change and
 * deliverability problems are usually solved by moving.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

export interface SendOutcome {
  sent: boolean;
  /** The provider's id for the message, when it gives one. */
  id?: string;
  /** Safe to show a developer. Never contains the API key. */
  error?: string;
}

export interface EmailProvider {
  name: string;
  send(message: EmailMessage, from: string): Promise<SendOutcome>;
}

/**
 * The default until a key is set: print it, do not send it.
 *
 * This is what stops the classic accident of a test run emailing real
 * customers. It is the default rather than an option because the accident
 * happens when somebody has not thought about it yet.
 */
export const consoleProvider: EmailProvider = {
  name: 'console',
  async send(message, from) {
    console.info(
      ['', '── email (not sent) ──', `from:    ${from}`, `to:      ${message.to}`, `subject: ${message.subject}`, '', message.text, '──────────────────────', ''].join('\n'),
    );
    return { sent: true, id: 'console' };
  },
};

/** Resend, written against their documented HTTP API. */
export function resendProvider(apiKey: string): EmailProvider {
  return {
    name: 'resend',
    async send(message, from) {
      try {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from,
            to: [message.to],
            subject: message.subject,
            html: message.html,
            text: message.text,
            ...(message.replyTo ? { reply_to: message.replyTo } : {}),
          }),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          // The status and the provider's message, and nothing else. Echoing
          // the request back would put the API key in a log line.
          return { sent: false, error: `Resend refused it (${response.status}): ${body.slice(0, 200)}` };
        }

        const body = (await response.json().catch(() => ({}))) as { id?: string };
        return { sent: true, id: body.id };
      } catch (error) {
        return { sent: false, error: error instanceof Error ? error.message : 'Could not reach the email provider.' };
      }
    },
  };
}

/** Pick a provider from the environment. */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): EmailProvider {
  const key = env.EMAIL_API_KEY?.trim();
  const named = env.EMAIL_PROVIDER?.trim().toLowerCase();

  // No key means no sending, whatever the provider is set to. Failing over to
  // the console is the safe direction: the worst case is an email nobody
  // receives, rather than one that reaches the wrong person.
  if (!key) return consoleProvider;
  if (named === 'console') return consoleProvider;
  if (named === 'resend' || named === undefined || named === '') return resendProvider(key);

  console.warn(`[email] unknown provider "${named}" — printing to the console instead of sending.`);
  return consoleProvider;
}
