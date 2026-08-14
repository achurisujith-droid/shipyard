/**
 * Does Shipyard find out for itself?
 *
 * The whole product rests on this: not asking the agent whether it finished,
 * but running something and reading what came back. So these cases use a real
 * project with real scripts — one that passes, one that fails, one that was
 * never written — and assert on what the runner concludes.
 *
 * The third is the interesting one. A project with no permission tests has not
 * failed its permission tests; it has not got any. Calling that a failure puts
 * a red card in front of someone whose project is fine.
 *
 *   npx tsx harness/test-verify.ts
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { attest, GATES, gateLabel, runnableGates, toEvidence, verify } from '../src/index';

/**
 * A key-shaped string, assembled rather than written out, so this file does not
 * itself trip the secret scanners pointed at this repository. The value is
 * nonsense; only its shape matters.
 */
const FAKE_KEY = 'sk' + '_live_' + 'A'.repeat(24);

const root = path.join(os.tmpdir(), `shipyard-verify-${process.pid}`);
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS  ${name}`);
  else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  // --- the registry itself -------------------------------------------------
  check('every gate is labelled for a person', GATES.every((g) => g.label.length > 5 && !g.label.includes('_')));
  check('every command gate has a command', GATES.filter((g) => g.kind === 'command').every((g) => Boolean(g.command)));
  check('no gate id appears twice', new Set(GATES.map((g) => g.id)).size === GATES.length);
  check('an unknown gate label falls back to its id rather than vanishing', gateLabel('nope') === 'nope');

  // A payments gate must not run in a project that takes no payments: two
  // minutes proving a flow that does not exist.
  check(
    'gates are skipped when the project has no such capability',
    runnableGates(['stripe_webhook_signature_verified', 'build_passes'], []).map((g) => g.id).join() ===
      'build_passes',
  );
  check(
    'and run when it does',
    runnableGates(['stripe_webhook_signature_verified'], ['subscription_payments']).length === 1,
  );
  check(
    'external and manual gates are never shelled out',
    runnableGates(['auth_login_works', 'plan_approved'], []).length === 0,
  );

  // --- a real project ------------------------------------------------------
  const project = path.join(root, 'app');
  await mkdir(project, { recursive: true });
  await writeFile(
    path.join(project, 'package.json'),
    JSON.stringify(
      {
        name: 'fixture',
        private: true,
        scripts: {
          build: 'node -e "console.log(\'built\')"',
          typecheck: 'node -e "console.error(\'src/App.tsx:24:9 - error TS2304: Cannot find name X\'); process.exit(1)"',
          test: 'node -e "console.log(\'ok\')"',
          // Prints a live-looking key, to prove output is redacted before storage.
          lint: `node -e "console.error('failed using ${FAKE_KEY}'); process.exit(1)"`,
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  const run = await verify(
    ['build_passes', 'typecheck_passes', 'unit_tests_pass', 'lint_passes', 'rbac_permission_tests_pass'],
    {
      projectPath: project,
      projectId: 'proj_1',
      capabilities: ['role_permissions'],
      trigger: 'manual',
      timeoutMs: 60_000,
    },
  );

  const byId = new Map(run.gates.map((g) => [g.gateId, g]));
  check('a passing build passes', byId.get('build_passes')?.status === 'passed');
  check('a passing test suite passes', byId.get('unit_tests_pass')?.status === 'passed');
  check('a failing typecheck fails', byId.get('typecheck_passes')?.status === 'failed');
  check(
    'and the summary is the actual error, not the runner’s tally',
    /Cannot find name X/.test(byId.get('typecheck_passes')?.failureSummary ?? ''),
    byId.get('typecheck_passes')?.failureSummary,
  );

  // The one that separates "broken" from "not built yet".
  check(
    'a check the project never set up is pending, not failed',
    byId.get('rbac_permission_tests_pass')?.status === 'pending',
    JSON.stringify(byId.get('rbac_permission_tests_pass')),
  );
  check(
    'and says so in a way that does not read as an alarm',
    /has not been set up/.test(byId.get('rbac_permission_tests_pass')?.failureSummary ?? ''),
  );

  // Gate output is stored and sent to the agent. It must not carry a live key.
  check(
    'output is redacted before it is stored',
    !JSON.stringify(run).includes(FAKE_KEY),
    byId.get('lint_passes')?.output,
  );
  check(
    'but the failure is still legible',
    /failed using sk/.test(byId.get('lint_passes')?.output ?? ''),
    byId.get('lint_passes')?.output,
  );

  check('the run fails when any gate failed', run.status === 'failed');
  check('and it records how long things took', run.gates.every((g) => g.durationMs >= 0));

  // --- evidence ------------------------------------------------------------
  const evidence = toEvidence(run);
  check('every gate produces evidence', evidence.length === run.gates.length);
  check('evidence carries the run it came from', evidence.every((e) => e.ref === run.id));
  check(
    'a pending gate is recorded as pending, not silently dropped',
    evidence.some((e) => e.gateId === 'rbac_permission_tests_pass' && e.status === 'pending'),
  );

  // --- claims are not evidence --------------------------------------------
  check('a person can attest to something only they can know', attest('backup_restore_tested', 'passed').status === 'passed');
  check(
    'and an external system can attest to what it observed',
    attest('deployed_health_check_passes', 'passed', 'HTTP 200').summary === 'HTTP 200',
  );
  check(
    'but nobody can declare a runnable check passed',
    (() => {
      try {
        attest('build_passes', 'passed');
        return false;
      } catch (err) {
        return /proved by running it/.test(err instanceof Error ? err.message : '');
      }
    })(),
  );
  check(
    'and an unknown gate is refused',
    (() => {
      try {
        attest('made_up_gate', 'passed');
        return false;
      } catch {
        return true;
      }
    })(),
  );

  // --- a project that passes everything asked of it ------------------------
  const clean = await verify(['build_passes', 'unit_tests_pass'], {
    projectPath: project,
    projectId: 'proj_1',
    capabilities: [],
    trigger: 'readiness_check',
    timeoutMs: 60_000,
  });
  check('a run with no failures passes', clean.status === 'passed');
  check('and it knows why it was run', clean.trigger === 'readiness_check');

  await rm(root, { recursive: true, force: true }).catch(() => undefined);
  console.log(`\n${failed === 0 ? 'All verification cases pass.' : `${failed} case(s) failed.`}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
