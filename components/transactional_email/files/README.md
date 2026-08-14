# Emailing your users

```ts
import { sendEmail } from '@/components/transactional_email/email';
import { welcomeEmail } from '@/components/transactional_email/templates';

const email = welcomeEmail({ name: user.name, appUrl: process.env.APP_URL! });
await sendEmail({ to: user.email, subject: email.subject, html: email.html });
```

## Nothing is sent until you say so

With no `EMAIL_API_KEY`, emails are printed to the server console. That is the
default rather than an option, because the accident it prevents — a test run or
a seed script emailing real customers — is the kind you cannot take back.

Outside production there is a second catch: only addresses in `EMAIL_ALLOWLIST`
can be emailed at all, even with a working key. Set it to your own address, or
`@yourcompany.com` for the whole team.

## Changing provider

`EMAIL_PROVIDER=resend` with a key. Adding another means writing one small
object in `providers.ts` — the rest of the app does not know or care which one
is in use.

## What it does not do

- One email at a time. This is not a newsletter tool.
- No opens, clicks or bounce handling. Those live in your provider's dashboard.
- The Resend provider is written against their documented API. It has not been
  run against a live account here, so treat the first send as the real test.
