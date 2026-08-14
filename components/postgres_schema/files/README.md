# Database foundation

Gives the app a database connection it can rely on, a way to tell whether that
connection is working, and a place to keep small settings.

## What you get

| | |
| --- | --- |
| `GET /api/health` | Returns 200 when the database answers, 503 when it does not. |
| `checkDatabase()` | The same check, callable from your own code. |
| `transaction()` | Do several writes, or none of them. |
| `getSetting` / `setSetting` | Remember small things between restarts. |

## Why the health check does so little

Deployment platforms poll it to decide whether a release is good. A health check
that runs real application logic is one that fails when the app is merely busy —
and takes a working deployment down with it.

## What it does not do

- It does not back anything up. That is a separate decision, and Shipyard asks
  you about it separately before you go live.
- A passing health check means the database answered. It does not mean the data
  in it is right.
