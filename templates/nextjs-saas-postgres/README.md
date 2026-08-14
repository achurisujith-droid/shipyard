# Your app

A Next.js app with a PostgreSQL database, ready for Shipyard components to be
installed into it.

## What is here

| | |
| --- | --- |
| `src/app/` | Your pages and API routes. |
| `src/lib/prisma.ts` | The database connection, shared across the app. |
| `prisma/schema.prisma` | What the database looks like. Components add to it. |
| `tests/contracts/` | Tests that came with installed components. |

## Running it

```bash
npm install
cp .env.example .env     # then fill in DATABASE_URL
npm run db:push          # create the tables
npm run dev
```

## The two markers in `prisma/schema.prisma`

```prisma
// >>> shipyard:components
// <<< shipyard:components
```

Everything between those lines was written by the installer. Editing it by hand
is how you end up with a schema that no longer matches any component version.
Your own models go below the closing marker.

## Installed components

Components install their implementation into `src/components/<id>/`. Those files
are **protected**: the agent will not rewrite them, because a verified component
that gets casually regenerated is an unverified component with a version number.

Each one names its extension points — the files you and the agent are meant to
edit. They are listed in the library when you install.

To check an installed component still works:

```bash
npm run test:contracts
```
