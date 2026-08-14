import { describe, expect, it, vi } from 'vitest';

import { htmlToText, looksLikeAnAddress, mayEmail, sendEmail } from '@/components/transactional_email/email';
import { consoleProvider, providerFromEnv, type EmailProvider } from '@/components/transactional_email/providers';
import { escape, welcomeEmail } from '@/components/transactional_email/templates';

/** A provider that records rather than sends, so the tests never leave the machine. */
function recorder(): EmailProvider & { sent: { to: string; subject: string; from: string }[] } {
  const sent: { to: string; subject: string; from: string }[] = [];
  return {
    name: 'recorder',
    sent,
    async send(message, from) {
      sent.push({ to: message.to, subject: message.subject, from });
      return { sent: true, id: 'rec_1' };
    },
  };
}

const production = { NODE_ENV: 'production', EMAIL_FROM: 'hello@example.com' } as unknown as NodeJS.ProcessEnv;

describe('who may be emailed', () => {
  it('nobody, by default, outside production', () => {
    // The accident this prevents: a seed script emailing real customers.
    expect(mayEmail('someone@real-customer.com', { NODE_ENV: 'development' } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });

  it('only the addresses on the allowlist', () => {
    const env = { NODE_ENV: 'development', EMAIL_ALLOWLIST: 'me@example.com' } as unknown as NodeJS.ProcessEnv;
    expect(mayEmail('me@example.com', env)).toBe(true);
    expect(mayEmail('someone@real-customer.com', env)).toBe(false);
  });

  it('supports a whole domain', () => {
    const env = { NODE_ENV: 'development', EMAIL_ALLOWLIST: '@example.com' } as unknown as NodeJS.ProcessEnv;
    expect(mayEmail('anyone@example.com', env)).toBe(true);
    expect(mayEmail('anyone@elsewhere.com', env)).toBe(false);
  });

  it('everybody, in production', () => {
    expect(mayEmail('someone@real-customer.com', production)).toBe(true);
  });
});

describe('addresses', () => {
  it('accepts an ordinary one', () => {
    expect(looksLikeAnAddress('sam@example.com')).toBe(true);
  });

  it('rejects nonsense', () => {
    for (const bad of ['', 'sam', 'sam@', '@example.com', 'sam @example.com', 'sam@example']) {
      expect(looksLikeAnAddress(bad)).toBe(false);
    }
  });

  it('rejects one with a newline in it', () => {
    // A line break in an address field is how extra headers get injected.
    expect(looksLikeAnAddress('sam@example.com\nBcc: everyone@example.com')).toBe(false);
  });
});

describe('sending', () => {
  it('refuses a subject containing a line break', async () => {
    const outcome = await sendEmail(
      { to: 'sam@example.com', subject: 'Hi\nBcc: everyone@example.com', html: '<p>x</p>' },
      { provider: recorder(), env: production },
    );
    expect(outcome.sent).toBe(false);
    expect(outcome.error).toMatch(/line break/);
  });

  it('refuses when there is nobody to send from', async () => {
    const outcome = await sendEmail(
      { to: 'sam@example.com', subject: 'Hi', html: '<p>x</p>' },
      { provider: recorder(), env: { NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv },
    );
    expect(outcome.sent).toBe(false);
    expect(outcome.error).toMatch(/EMAIL_FROM/);
  });

  it('always attaches a plain-text version', async () => {
    const provider = recorder();
    const captured: string[] = [];
    const wrapped: EmailProvider = {
      name: 'x',
      async send(message, from) {
        captured.push(message.text);
        return provider.send(message, from);
      },
    };
    await sendEmail(
      { to: 'sam@example.com', subject: 'Hi', html: '<h1>Hello</h1><p>There</p>' },
      { provider: wrapped, env: production },
    );
    expect(captured[0]).toContain('Hello');
    expect(captured[0]).not.toContain('<h1>');
  });

  it('sends when everything is in order', async () => {
    const provider = recorder();
    const outcome = await sendEmail(
      { to: 'sam@example.com', subject: 'Hi', html: '<p>x</p>' },
      { provider, env: production },
    );
    expect(outcome.sent).toBe(true);
    expect(provider.sent[0]).toEqual({ to: 'sam@example.com', subject: 'Hi', from: 'hello@example.com' });
  });
});

describe('choosing a provider', () => {
  it('prints to the console when no key is set', () => {
    expect(providerFromEnv({} as unknown as NodeJS.ProcessEnv).name).toBe('console');
  });

  it('prints to the console even when a provider is named, if there is no key', () => {
    // Failing towards "nobody receives it" rather than "the wrong person does".
    expect(providerFromEnv({ EMAIL_PROVIDER: 'resend' } as unknown as NodeJS.ProcessEnv).name).toBe('console');
  });

  it('uses the provider once a key exists', () => {
    expect(providerFromEnv({ EMAIL_API_KEY: 'k', EMAIL_PROVIDER: 'resend' } as unknown as NodeJS.ProcessEnv).name).toBe('resend');
  });

  it('falls back rather than throwing on an unknown provider', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(providerFromEnv({ EMAIL_API_KEY: 'k', EMAIL_PROVIDER: 'pigeon' } as unknown as NodeJS.ProcessEnv).name).toBe('console');
    warn.mockRestore();
  });

  it('the console provider never claims a message left the building', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const outcome = await consoleProvider.send(
      { to: 'a@b.com', subject: 's', html: '<p>h</p>', text: 't' },
      'from@example.com',
    );
    expect(outcome.id).toBe('console');
    info.mockRestore();
  });
});

describe('templates', () => {
  it('escapes anything a user typed', () => {
    const email = welcomeEmail({ name: '<script>alert(1)</script>', appUrl: 'https://example.com' });
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
  });

  it('copes with no name at all', () => {
    expect(welcomeEmail({ name: null, appUrl: 'https://example.com' }).html).toContain('Hello');
  });

  it('escapes the characters that matter', () => {
    expect(escape('a & b < c > "d"')).toBe('a &amp; b &lt; c &gt; &quot;d&quot;');
  });
});

describe('plain text', () => {
  it('turns list items into bullets', () => {
    expect(htmlToText('<ul><li>one</li><li>two</li></ul>')).toContain('• one');
  });

  it('collapses runs of blank lines', () => {
    expect(htmlToText('<p>a</p><p></p><p></p><p>b</p>')).toBe('a\n\nb');
  });
});
