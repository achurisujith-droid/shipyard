/**
 * Dev runner: compile the main process, start Vite for the renderer, wait until
 * it actually serves, then launch Electron pointed at it.
 *
 * Hand-rolled rather than pulling in an Electron/Vite meta-framework — it is
 * ~60 lines and we keep full control of process lifetimes, which matters here
 * because a stray Electron holds the single-instance lock.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const repoRoot = path.resolve(appDir, '..', '..');
const binDir = path.join(repoRoot, 'node_modules', '.bin');
const isWindows = process.platform === 'win32';
const bin = (name) => path.join(binDir, isWindows ? `${name}.cmd` : name);

const DEV_URL = 'http://localhost:5273';
const children = [];

function run(command, args, options = {}) {
  // shell: true is required on Windows to execute the .cmd shims npm creates.
  // Every argument here is a constant from this file; nothing is interpolated.
  const child = spawn(command, args, {
    stdio: 'inherit',
    shell: isWindows,
    ...options,
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// 1. Build main + preload. Electron loads these from disk, so they must exist
//    before it starts.
console.log('[dev] building main process…');
const build = run(bin('tsc'), ['-b', path.join(appDir, 'tsconfig.main.json')], { cwd: repoRoot });
const [buildCode] = await once(build, 'exit');
if (buildCode !== 0) {
  console.error('[dev] main process build failed');
  shutdown(buildCode ?? 1);
}

// 2. Renderer dev server.
console.log('[dev] starting Vite…');
run(bin('vite'), [], { cwd: appDir });

if (!(await waitForServer(DEV_URL))) {
  console.error(`[dev] Vite did not come up at ${DEV_URL}`);
  shutdown(1);
}

// 3. Electron. ELECTRON_RUN_AS_NODE makes Electron behave as plain Node — some
//    editor terminals set it, and it would silently break the app.
console.log('[dev] launching Electron…');
const env = { ...process.env, VITE_DEV_SERVER_URL: DEV_URL };
delete env.ELECTRON_RUN_AS_NODE;

const electron = run(bin('electron'), [appDir], { cwd: repoRoot, env });
const [electronCode] = await once(electron, 'exit');
shutdown(electronCode ?? 0);
