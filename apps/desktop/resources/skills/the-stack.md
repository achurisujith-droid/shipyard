---
name: The stack
description: React, Node and PostgreSQL — what to use, and what will not run here
---

# The stack

This project runs inside Shipyard, on the owner's own computer. Shipyard ships
its own **Node 24** and **PostgreSQL 18**, so neither needs installing. What is
here is here; what is not, is not.

## Use

- **React** for the interface, with **Vite**
- **Express** for the server
- **PostgreSQL** for anything that has to be remembered
- **Prisma** for talking to the database

Connect using `process.env.DATABASE_URL`. Shipyard sets it before your app
starts, on a port that changes every run. Never hard-code a connection string
and never assume port 5432.

## Do not use

| Not this | Because | Use instead |
| --- | --- | --- |
| Docker, docker-compose | Not installed, needs admin rights the owner may not have | Nothing — Postgres runs directly |
| MySQL, MongoDB, SQLite | Only Postgres is provided | PostgreSQL |
| Redis | No official Windows build | Postgres tables, or `LISTEN`/`NOTIFY` for queues |
| Anything needing a system package manager | The owner has no compiler and cannot install one | A dependency with prebuilt binaries |

## Native dependencies

Anything that compiles C++ on install (`node-gyp` in the output) will fail on a
machine with no build tools, which is most of them. Before adding a dependency,
prefer a pure-JavaScript one. `bcrypt` → `bcryptjs`. `sharp` is usually fine
because it ships prebuilt binaries; check that it does before relying on it.

## Ports

Read the port from `process.env.PORT` and fall back to 3000. Shipyard watches
your server's output to find the address for the preview pane, so print it
clearly on startup:

```js
app.listen(port, () => console.log(`Server listening on port ${port}`));
```

## Secrets

There is no secrets manager. Read configuration from `process.env`, keep an
`.env.example` listing what is needed, and never commit real keys. If the app
needs a key the owner has not got yet, make that a visible message on screen,
not a crash at startup.
