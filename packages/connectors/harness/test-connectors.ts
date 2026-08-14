/**
 * Does the founder get asked at the right moment?
 *
 * Everything else here is bookkeeping. The case that earns this package is
 * that a multi-day wait is raised weeks before it is due, and a two-minute
 * signup is not — because being wrong in either direction costs the founder
 * real time, and neither mistake is visible until it is expensive.
 *
 *   npx tsx harness/test-connectors.ts
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GATES } from '@shipyard/verification-runner';
import { loadCatalog } from '@shipyard/capability-resolver';
import type { Evidence } from '@shipyard/shared';

import {
  connectionStatus,
  effortFor,
  founderSteps,
  loadRecipes,
  setupQueue,
  whenToAsk,
} from '../src/index';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const catalogRoot = path.join(repoRoot, 'shipyard-catalog');

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS  ${name}`);
  else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

const evidence = (gateId: string, status: Evidence['status']): Evidence[] => [
  { gateId, status, observedAt: '2026-08-14T10:00:00.000Z' },
];

async function main(): Promise<void> {
  const catalog = await loadCatalog(catalogRoot);
  const recipes = await loadRecipes(path.join(catalogRoot, 'recipes'), {
    knownGates: GATES.map((gate) => gate.id),
    knownVendors: catalog.vendors.map((vendor) => vendor.id),
    knownCapabilities: catalog.capabilities.map((capability) => capability.id),
  });

  // ----------------------------------------------------------------- loading
  check('the recipes load', recipes.length === 7, `${recipes.length} found`);
  check(
    'every recipe is proved by a check something actually runs',
    recipes.every((recipe) => GATES.some((gate) => gate.id === recipe.verifiedBy)),
  );
  check(
    'every recipe names a vendor in the catalog',
    recipes.every((recipe) => catalog.vendors.some((vendor) => vendor.id === recipe.vendorId)),
  );
  check(
    'every capability the catalog promises a recipe for has one',
    (() => {
      const promised = new Set(catalog.capabilities.flatMap((capability) => capability.recipes ?? []));
      const have = new Set(recipes.map((recipe) => recipe.id));
      return [...promised].every((id) => have.has(id));
    })(),
    `missing: ${[...new Set(catalog.capabilities.flatMap((c) => c.recipes ?? []))]
      .filter((id) => !recipes.some((r) => r.id === id))
      .join(', ')}`,
  );
  check(
    'no recipe ever asks the founder for a password',
    recipes.every((recipe) =>
      recipe.steps.every((step) => !/\bpassword\b/i.test(step.instruction)),
    ),
  );
  check(
    'the steps are written in plain language',
    recipes.every((recipe) =>
      recipe.steps.every((step) => !/\b(OAuth|IAM|CORS|CNAME record|SPF)\b/.test(step.instruction)),
    ),
  );
  check(
    'every recipe says what it does not do',
    recipes.filter((recipe) => (recipe.limitations?.length ?? 0) > 0).length >= 5,
  );

  const stripe = recipes.find((recipe) => recipe.id === 'stripe_checkout');
  const sentry = recipes.find((recipe) => recipe.id === 'sentry_nextjs_basic');
  const email = recipes.find((recipe) => recipe.id === 'transactional_email_basic');
  check('the recipes we reason about below exist', Boolean(stripe && sentry && email));
  if (!stripe || !sentry || !email) {
    process.exitCode = 1;
    return;
  }

  // ------------------------------------------------------------------ timing
  const buildingAPrototype = {
    intent: { targetMode: 'functional_prototype' as const },
    neededCapabilities: ['subscription_payments', 'error_monitoring', 'transactional_email'],
  };

  // The whole reason this package exists.
  const stripeEarly = whenToAsk(stripe, buildingAPrototype);
  check('a multi-day wait is raised while they are still prototyping', stripeEarly.when === 'now');
  check(
    'and the reason says why now rather than later',
    /waiting happens while you carry on building/.test(stripeEarly.reason),
    stripeEarly.reason,
  );
  check(
    'and names the wait, so it does not read as busywork',
    /days rather than minutes/.test(stripeEarly.reason),
  );
  check('it is not counted as blocking a launch that is not happening yet', stripeEarly.blocksLaunch === false);

  const emailEarly = whenToAsk(email, buildingAPrototype);
  check('a sending domain is raised early too', emailEarly.when === 'now');
  check('because DNS takes a day to spread', /take a day to spread/.test(emailEarly.reason));

  // And the other direction.
  const sentryEarly = whenToAsk(sentry, buildingAPrototype);
  check('a two-minute signup is not raised during a prototype', sentryEarly.when === 'later');
  check(
    'and says when it will come up',
    /pilot with real customers/.test(sentryEarly.reason),
    sentryEarly.reason,
  );
  check('with the honest reassurance that it is quick', /only takes a few minutes/.test(sentryEarly.reason));

  const atPilot = {
    intent: { targetMode: 'customer_pilot' as const },
    neededCapabilities: ['error_monitoring'],
    installedComponents: ['sentry_error_monitoring'],
  };
  const sentryDue = whenToAsk(sentry, atPilot);
  check('once it is due and the code is there, it is asked for', sentryDue.when === 'at_build');
  check('and it blocks the launch', sentryDue.blocksLaunch === true);
  check(
    'the reason says the code is waiting on it',
    /the step that makes it actually work/.test(sentryDue.reason),
  );

  const sentryNoComponent = whenToAsk(sentry, { ...atPilot, installedComponents: [] });
  check(
    'but not before the code that uses it exists',
    sentryNoComponent.when === 'before_pilot',
    sentryNoComponent.when,
  );

  const stripeDue = whenToAsk(stripe, {
    intent: { targetMode: 'customer_pilot' },
    neededCapabilities: ['subscription_payments'],
  });
  check('a long wait that is now due is urgent', stripeDue.when === 'now');
  check(
    'and says so plainly',
    /most likely thing to hold up your launch/.test(stripeDue.reason),
  );

  check(
    'nothing is asked for if the project does not need it',
    whenToAsk(stripe, { intent: { targetMode: 'customer_pilot' }, neededCapabilities: [] }).when === 'not_needed',
  );
  check(
    'and nothing is asked for twice',
    whenToAsk(stripe, { ...buildingAPrototype, alreadyWorking: true }).when === 'not_needed',
  );

  // ------------------------------------------------------------------- effort
  check('a long wait is described as waiting, not as work', /waiting for them to check/.test(effortFor(stripe)));
  check('an instant one says it works straight away', /works straight away/.test(effortFor(sentry)));
  check(
    'effort separates their time from the waiting',
    /of your time, then/.test(effortFor(stripe)),
    effortFor(stripe),
  );

  // -------------------------------------------------------------------- queue
  const queue = setupQueue(recipes, {
    intent: { targetMode: 'functional_prototype' },
    neededCapabilities: ['subscription_payments', 'error_monitoring', 'transactional_email', 'file_storage'],
  });
  check('the queue leaves out what is not needed', queue.every((prompt) => prompt.when !== 'not_needed'));
  check('the long waits are at the top', queue[0]?.when === 'now' && queue[1]?.when === 'now');
  check(
    'and the quick ones are not',
    queue.findIndex((prompt) => prompt.recipeId === 'sentry_nextjs_basic') > 1,
    queue.map((prompt) => prompt.recipeId).join(' → '),
  );
  check(
    'anything already working drops out',
    !setupQueue(recipes, {
      intent: { targetMode: 'customer_pilot' },
      neededCapabilities: ['error_monitoring'],
      working: ['sentry_nextjs_basic'],
    }).some((prompt) => prompt.recipeId === 'sentry_nextjs_basic'),
  );

  // ------------------------------------------------------------------ status
  const notStarted = connectionStatus(sentry, { evidence: [] });
  check('an untouched connection says so', notStarted.state === 'not_started');
  check('and names what will be needed', notStarted.missingSettings.includes('SENTRY_DSN'));

  const claimed = connectionStatus(sentry, { evidence: [], claimed: ['SENTRY_DSN'] });
  check('filling the settings in is not the same as it working', claimed.state === 'claimed');
  // The distinction the readiness score depends on.
  check(
    'and the wording says so rather than implying success',
    /nothing has confirmed it works yet/.test(claimed.summary),
    claimed.summary,
  );

  const working = connectionStatus(sentry, {
    evidence: evidence('error_monitoring_receives_test_event', 'passed'),
    claimed: ['SENTRY_DSN'],
  });
  check('only a passing check makes it working', working.state === 'working');
  check(
    'and it says how that was established',
    /proved by running it, not by asking/.test(working.summary),
  );
  check('with when it was last checked', working.lastCheckedAt === '2026-08-14T10:00:00.000Z');

  const broken = connectionStatus(sentry, {
    evidence: evidence('error_monitoring_receives_test_event', 'failed'),
    claimed: ['SENTRY_DSN'],
  });
  check('a failing check means broken, not missing', broken.state === 'broken');
  check(
    'and points at the connection rather than the app',
    /wrong with the connection rather than with your app/.test(broken.summary),
  );

  // ------------------------------------------------------------------- steps
  const steps = founderSteps(stripe);
  check('the founder gets only their own steps', steps.length > 0);
  check('numbered from one', steps[0]?.number === 1);
  check(
    'and the agent’s steps are not among them',
    steps.every((step) => !/Wire the checkout button/.test(step.instruction)),
  );
  check(
    'the steps that matter most are marked',
    steps.some((step) => step.critical),
  );
  check(
    'and a critical step explains itself',
    steps.filter((step) => step.critical).every((step) => Boolean(step.because)),
  );
  check(
    'the step handling the key says where it goes and that it stays there',
    steps.some((step) => step.produces === 'STRIPE_SECRET_KEY' && /never sent anywhere/.test(step.because ?? '')),
  );
  check(
    'and there is a step that makes them actually test it',
    steps.some((step) => /test card/.test(step.instruction)),
  );

  console.log(`\n${failed === 0 ? 'All connector cases pass.' : `${failed} case(s) failed.`}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
