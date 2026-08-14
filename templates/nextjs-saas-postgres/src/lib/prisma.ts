import { PrismaClient } from '@prisma/client';

/**
 * One database connection, reused.
 *
 * Next.js reloads modules in development, and a fresh PrismaClient per reload
 * exhausts the connection pool within a few minutes of editing. Holding it on
 * `globalThis` is the standard way round that; in production the module is
 * loaded once and the global is never read.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
