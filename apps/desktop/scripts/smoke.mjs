/**
 * Runs the app's self-check. `node scripts/smoke.mjs [--session]`
 *
 *   (default)   wiring only: preload bridge, renderer mount, IPC round trip
 *   --session   also drives a real Claude Code session end to end, including a
 *               permission prompt and crash recovery. Needs a logged-in CLI.
 *
 * Exists as a script rather than an npm `env VAR=x` line because setting
 * environment variables inline is not portable across shells.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const repoRoot = path.resolve(appDir, '..', '..');
const isWindows = process.platform === 'win32';
const electron = path.join(repoRoot, 'node_modules', '.bin', isWindows ? 'electron.cmd' : 'electron');

const env = { ...process.env, SHIPYARD_SMOKE: process.argv.includes('--session') ? 'session' : '1' };
// Some editor terminals set this, which makes Electron run as plain Node and
// the app silently fail to start.
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [appDir], {
  stdio: 'inherit',
  shell: isWindows,
  cwd: repoRoot,
  env,
});
child.on('exit', (code) => process.exit(code ?? 1));
