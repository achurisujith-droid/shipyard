/**
 * Your emails.
 *
 * This file is an extension point — it is meant to be edited, and the agent is
 * allowed to change it. The sending machinery around it is not.
 *
 * One thing worth keeping: `escape()` on anything a user supplied. A name is
 * user input, and an email is HTML.
 */

export function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function layout(body: string): string {
  return `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;color:#14181f;max-width:32rem">${body}</div>`;
}

export function welcomeEmail(input: { name?: string | null; appUrl: string }) {
  const greeting = input.name ? `Hello ${escape(input.name)},` : 'Hello,';
  return {
    subject: 'Welcome',
    html: layout(
      `<p>${greeting}</p><p>Your account is ready.</p><p><a href="${escape(input.appUrl)}">Open the app</a></p>`,
    ),
  };
}

export function passwordChangedEmail(input: { appUrl: string }) {
  return {
    subject: 'Your password was changed',
    html: layout(
      `<p>Your password has just been changed, and you have been signed out everywhere else.</p>
       <p>If that was not you, <a href="${escape(input.appUrl)}">reset it now</a>.</p>`,
    ),
  };
}
