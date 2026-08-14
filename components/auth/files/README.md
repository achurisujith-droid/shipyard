# Signing in

Email-and-password accounts, with sessions you can end.

## What you get

| | |
| --- | --- |
| `POST /api/auth/register` | Create an account. |
| `POST /api/auth/login` | Sign in. |
| `POST /api/auth/logout` | Sign out. |
| `GET /api/auth/me` | Who is signed in. |
| `requireUser()` | Use at the top of any route that should be private. |
| `currentUser()` | The signed-in user on a page, or null. |

## Using it in a private route

```ts
import { requireUser } from '@/components/auth/current-user';

export async function GET() {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;   // 401, already written for you
  return Response.json({ hello: auth.user.email });
}
```

The shape is deliberate. A helper that returned `null` would let you carry on
past a failed check by forgetting an `if`, and that is the single most common
way a private page ends up public.

## Three decisions worth knowing about

**Sign-in failures all say the same thing.** Wrong password, unknown address and
disabled account produce one identical sentence. Telling them apart turns your
sign-in form into a way of finding out who has an account with you.

**Sessions live in the database.** The cookie holds a random value that means
nothing on its own. That is what makes signing someone out work immediately —
including everyone, when a password changes.

**Only the hash of the session token is stored.** A leaked backup is bad. A
leaked backup containing working sessions is worse.

## What it does not do

- No Google or Microsoft sign-in, and no two-factor.
- No verification email and no password reset. Both need the email component.
- Locking is per account. Someone trying one password against thousands of
  accounts needs a limit per address, which belongs at your hosting edge.
