/**
 * Does the agent get told the things that stop it wasting the owner's money?
 *
 * Three instructions carry almost all the value here, and each has a case with
 * its name on it: do not edit the failing check, do not rewrite an installed
 * component, and do not build something the library already has.
 *
 *   npx tsx harness/test-tasks.ts
 */
import {
  composeCapabilityTask,
  composeGateTask,
  composePhaseTask,
  nextTask,
} from '../src/index';
import type { GateResult, ResolvedCapability } from '@shipyard/shared';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS  ${name}`);
  else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

const installed = [
  { id: 'auth', name: 'Signing in', paths: ['src/components/auth/'] },
  { id: 'rbac', name: 'Who is allowed to do what', paths: ['src/components/rbac/'] },
];

const phase = {
  phase: { title: 'The booking screen', outcome: 'A page where somebody picks a slot and confirms it.', effort: 'about a day' },
  index: 2,
  total: 4,
} as const;

const redBuild: GateResult = {
  gateId: 'unit_tests_pass',
  status: 'failed',
  durationMs: 4_200,
  failureSummary: 'bookings.test.ts: expected 200, got 500',
  output: ['at handler (src/app/api/bookings/route.ts:31)', 'TypeError: cannot read property id of undefined'].join('\n'),
};

const capability: ResolvedCapability = {
  capability: { id: 'authentication', label: 'Signing in', category: 'identity' },
  status: 'included',
  reason: 'Real people are going to use this, so they need a way to sign in.',
  gates: ['auth_login_works', 'protected_routes_enforced'],
  components: ['auth'],
  recipes: [],
};

function main(): void {
  // ------------------------------------------------------------------ phases
  const prototype = composePhaseTask({ ...phase, targetMode: 'functional_prototype' });
  check('a phase task names the phase and where it sits', /Phase 2 of 4: The booking screen/.test(prototype.message));
  check(
    'and says the phase ends with something the owner can see',
    /see something that was not there before/.test(prototype.message),
  );
  check(
    'a prototype is allowed to fake things',
    /made-up data and stubbed/.test(prototype.message),
  );
  check(
    'as long as it says so on screen',
    /Say clearly on\s*screen where something is faked/.test(prototype.message),
  );

  const production = composePhaseTask({ ...phase, targetMode: 'production_product' });
  check('a production build is not', /Nothing here should be faked or stubbed/.test(production.message));
  check(
    'and is told to say so rather than leave a placeholder',
    /say so rather than putting in a\s*placeholder/.test(production.message),
  );
  check(
    'every phase has to leave the app running',
    /Leave the app running/.test(prototype.message) && /Leave the app running/.test(production.message),
  );
  check('with acceptance criteria a person could check', prototype.acceptanceCriteria.length >= 3);
  check('and checks to run afterwards', prototype.gates.includes('build_passes'));

  // The waste this prevents: an agent writing its own sign-in beside a tested one.
  const withComponents = composePhaseTask({ ...phase, targetMode: 'customer_pilot', installed });
  check('installed parts are named in the prompt', /Signing in/.test(withComponents.message));
  check('with the folder it must not edit', /src\/components\/auth\//.test(withComponents.message));
  check(
    'and told to use them rather than write its own',
    /Use them rather\s*than writing your own/.test(withComponents.message),
  );
  check(
    'while still allowed to object',
    /say so rather than\s*working around it/.test(withComponents.message),
  );
  check(
    'a project with nothing installed gets no such paragraph',
    !/ready-made parts installed/.test(prototype.message),
  );

  const outstanding = composePhaseTask({
    ...phase,
    targetMode: 'customer_pilot',
    outstanding: [
      {
        ruleId: 'privacy.retention',
        ruleVersion: 1,
        category: 'privacy',
        severity: 'blocker',
        message: 'You have not said how long you keep people’s information.',
        applies: true,
        satisfied: false,
        requiredGates: [],
        missingGates: [],
        requiredComponents: [],
        humanReviewRequired: false,
        serviceTriggers: [],
      },
    ],
  });
  check(
    'outstanding obligations are mentioned without becoming this phase’s job',
    /do not make any of them harder to do later/.test(outstanding.message),
  );
  check('and quoted in the founder’s words', /how long you keep/.test(outstanding.message));

  // ------------------------------------------------------------ failing checks
  const gate = composeGateTask({
    failed: [redBuild],
    labels: { unit_tests_pass: 'The unit tests pass' },
  });
  check('a failing check is named the way the user sees it', /The unit tests pass/.test(gate.message));
  check('with what it said', /expected 200, got 500/.test(gate.message));
  check('and the tail of the output', /route\.ts:31/.test(gate.message));

  // The instruction that earns this whole function.
  check(
    'the agent is told not to edit the check',
    /Do not change the checks so that they pass/.test(gate.message),
  );
  check(
    'and why',
    /editing it turns a real problem into a hidden one/.test(gate.message),
  );
  check(
    'and to leave it failing rather than weaken it',
    /say so and leave it failing/.test(gate.message),
  );
  check(
    'that promise is in the acceptance criteria too',
    gate.acceptanceCriteria.some((criterion) => /none of them were edited/.test(criterion)),
  );
  check(
    'and it is told to say so rather than guess',
    /say so rather than guessing/.test(gate.message),
  );
  check('the failing checks are the ones re-run afterwards', gate.gates.includes('unit_tests_pass'));

  const twoFailed = composeGateTask({
    failed: [redBuild, { gateId: 'lint_passes', status: 'failed', durationMs: 900 }],
  });
  check('two failures are counted', /^2 of the checks/.test(twoFailed.message));
  check(
    'a check with no output at all does not break the prompt',
    twoFailed.message.includes('lint_passes'),
  );
  check(
    'passing checks are not asked about',
    composeGateTask({ failed: [{ gateId: 'build_passes', status: 'passed', durationMs: 10 }] }).gates.length === 0,
  );

  const contract = composeGateTask({ failed: [redBuild], installed, componentContract: true });
  check(
    'a broken component contract warns the user',
    Boolean(contract.warning) && /a developer should look at it/.test(contract.warning ?? ''),
  );
  check(
    'and the fix must not be inside the component',
    contract.acceptanceCriteria.some((criterion) => /was not rewritten/.test(criterion)),
  );

  // --------------------------------------------------------- missing capability
  const buildIt = composeCapabilityTask({ capability, intent: { targetMode: 'customer_pilot' } });
  check('a gap with no component is a build instruction', /Please build it/.test(buildIt.message));
  check('carrying the reason the founder was given', /Real people are going to use this/.test(buildIt.message));
  check('and the checks it will be judged by', /auth_login_works/.test(buildIt.message));
  check(
    'with acceptance criteria that include those checks',
    buildIt.acceptanceCriteria.some((criterion) => /auth_login_works/.test(criterion)),
  );
  check(
    'and a warning that the happy case is not enough',
    buildIt.acceptanceCriteria.some((criterion) => /not only in the happy case/.test(criterion)),
  );

  // The single most expensive mistake the library exists to prevent.
  const useIt = composeCapabilityTask({
    capability,
    intent: { targetMode: 'customer_pilot' },
    componentAvailable: true,
  });
  check(
    'a gap the library can fill is never a build instruction',
    !/Please build it/.test(useIt.message),
  );
  check('it says so plainly', /do not write this from scratch/i.test(useIt.message));
  check('and tells the owner what to install', /install it from/.test(useIt.message));
  check('with a warning on the button', Boolean(useIt.warning));
  check('and nothing to verify afterwards, because nothing was built', useIt.gates.length === 0);

  const reviewed = composeCapabilityTask({
    capability: { ...capability, status: 'requires_human_review' },
    intent: { targetMode: 'production_product' },
  });
  check(
    'something needing sign-off says so before the work starts',
    /a person should read/.test(reviewed.warning ?? ''),
  );

  // ------------------------------------------------------------------ ordering
  check(
    'a red build is dealt with before anything else',
    nextTask({
      failedGates: [redBuild],
      gapsWithComponents: [capability],
      phase: { ...phase, targetMode: 'customer_pilot' },
    })?.kind === 'gate_failure',
  );
  check(
    'then something the library can supply in minutes',
    nextTask({
      gapsWithComponents: [capability],
      phase: { ...phase, targetMode: 'customer_pilot' },
    })?.kind === 'capability_gap',
  );
  check(
    'then the phase in hand',
    nextTask({ phase: { ...phase, targetMode: 'customer_pilot' } })?.kind === 'phase',
  );
  check('and nothing at all when there is nothing to do', nextTask({}) === null);
  check(
    'a run where every check passed is not treated as a failure',
    nextTask({ failedGates: [{ gateId: 'build_passes', status: 'passed', durationMs: 5 }] }) === null,
  );

  // -------------------------------------------------------------- the voice
  for (const [label, task] of [
    ['phase', prototype],
    ['gate', gate],
    ['capability', buildIt],
  ] as const) {
    check(
      `the ${label} prompt does not talk to the founder in jargon`,
      !/\b(CRUD|idempotent|refactor|ORM|DTO)\b/.test(task.message),
    );
  }

  console.log(`\n${failed === 0 ? 'All task cases pass.' : `${failed} case(s) failed.`}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
