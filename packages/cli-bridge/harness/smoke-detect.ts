/**
 * Smoke check for Milestone 1.1 + 1.2 against the real CLI on this machine.
 * Prints the account label only as a masked form so a screen-shared run does
 * not leak the tester's email.
 */
import { authStatus, detectClaude } from '../src';

function mask(label: string | undefined): string {
  if (!label) return '(none)';
  const at = label.indexOf('@');
  if (at <= 1) return `${label.slice(0, 1)}***`;
  return `${label.slice(0, 2)}***${label.slice(at)}`;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const detected = await detectClaude();
  const t1 = Date.now();

  console.log('--- detectClaude() ---');
  console.log(JSON.stringify(detected, null, 2));
  console.log(`elapsed: ${t1 - t0}ms`);

  if (!detected.installed || !detected.path) {
    console.log('\nCLI not installed - stopping.');
    return;
  }

  // Cache path re-resolution: the second call should hit the cached shim and
  // still re-derive the executable.
  const t2 = Date.now();
  const cached = await detectClaude({ cachedShimPath: detected.shimPath });
  const t3 = Date.now();
  console.log(`\n--- detectClaude({cachedShimPath}) --- source=${cached.source} elapsed=${t3 - t2}ms`);

  const t4 = Date.now();
  const auth = await authStatus(detected.path);
  const t5 = Date.now();

  console.log('\n--- authStatus() ---');
  console.log(
    JSON.stringify({ ...auth, accountLabel: mask(auth.accountLabel) }, null, 2),
  );
  console.log(`elapsed: ${t5 - t4}ms`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
