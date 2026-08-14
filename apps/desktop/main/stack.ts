import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * What a project needs before it can run.
 *
 * Starting a database costs a few seconds and 40 MB of disk, so we only do it
 * for projects that actually talk to one. A todo list backed by a JSON file
 * should start instantly.
 */
export interface StackNeeds {
  database: boolean;
  /** Why we think so, for the log. Never shown as an error. */
  reason?: string;
  /**
   * Commands to run, in order, once the database is up and before the dev
   * server starts. Prisma only: it is by far the most common ORM in generated
   * projects and its commands are stable. Other tools are left to the
   * project's own start script.
   */
  prepare?: string[];
}

/** Packages that only exist in a project because it connects to Postgres. */
const POSTGRES_PACKAGES = [
  'pg',
  'postgres',
  'pg-promise',
  'prisma',
  '@prisma/client',
  'drizzle-orm',
  'typeorm',
  'sequelize',
  'knex',
  'kysely',
  '@vercel/postgres',
  '@neondatabase/serverless',
];

export async function detectNeeds(projectPath: string): Promise<StackNeeds> {
  const deps = await readDependencies(projectPath);
  const matched = POSTGRES_PACKAGES.filter((name) => deps.has(name));

  const prismaSchema = path.join(projectPath, 'prisma', 'schema.prisma');
  const schema = await readIfPresent(prismaSchema);
  const prismaPostgres = schema !== null && /provider\s*=\s*"postgres(ql)?"/.test(schema);

  // A project can reference DATABASE_URL before any driver is installed, which
  // is exactly the state a half-built app is in.
  const env = (await readIfPresent(path.join(projectPath, '.env'))) ?? '';
  const envExample = (await readIfPresent(path.join(projectPath, '.env.example'))) ?? '';
  const envMentions = /DATABASE_URL\s*=\s*["']?postgres/i.test(`${env}\n${envExample}`);

  if (matched.length === 0 && !prismaPostgres && !envMentions) {
    return { database: false };
  }

  const needs: StackNeeds = {
    database: true,
    reason: matched.length > 0 ? `uses ${matched.join(', ')}` : 'is configured for Postgres',
  };

  if (deps.has('prisma') || deps.has('@prisma/client')) {
    // `generate` first, always. Prisma 7 projects write the client to a path
    // inside the project rather than into node_modules, so without it the app
    // starts and immediately fails on an import that does not resolve. It is
    // idempotent and cheap, so running it for older projects too costs nothing.
    //
    // Then: `migrate deploy` applies committed migrations, `db push` is for a
    // schema that has never been migrated — the usual state of a project two
    // minutes after it was generated.
    const hasMigrations = await exists(path.join(projectPath, 'prisma', 'migrations'));
    needs.prepare = [
      'npx prisma generate',
      hasMigrations ? 'npx prisma migrate deploy' : 'npx prisma db push --accept-data-loss',
    ];
  }

  return needs;
}

async function readDependencies(projectPath: string): Promise<Set<string>> {
  const raw = await readIfPresent(path.join(projectPath, 'package.json'));
  if (raw === null) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return new Set();
    const pkg = parsed as Record<string, unknown>;
    const names = new Set<string>();
    for (const field of ['dependencies', 'devDependencies']) {
      const block = pkg[field];
      if (block && typeof block === 'object') {
        for (const name of Object.keys(block)) names.add(name);
      }
    }
    return names;
  } catch {
    return new Set();
  }
}

async function readIfPresent(target: string): Promise<string | null> {
  try {
    return await readFile(target, 'utf8');
  } catch {
    return null;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
