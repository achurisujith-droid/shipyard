import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = path.dirname(fileURLToPath(import.meta.url));

// Root defaults to the working directory, which dev.mjs and the build script
// both set to this app's folder.
export default defineConfig({
  // Relative base so the built renderer works when loaded over file://
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      // The shared package compiles to CommonJS for the main process, and Vite
      // cannot see named exports through TypeScript's `__exportStar` shim. That
      // went unnoticed while the renderer imported only types, which vanish at
      // compile time; the first real constant it imported failed at runtime.
      // Pointing at the source fixes it and gives hot reload on shared edits.
      '@shipyard/shared': path.resolve(here, '..', '..', 'packages', 'shared', 'src', 'index.ts'),
    },
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
  },
  server: {
    port: 5273,
    strictPort: true,
  },
});
