import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // Contract tests talk to a real database and must not race each other.
    fileParallelism: false,
  },
  resolve: {
    alias: { '@': path.resolve(process.cwd(), 'src') },
  },
});
