/**
 * Does the resolver decide the right things, for the right reasons?
 *
 * Three fixture projects, as the plan asks for: a concept, a SaaS pilot that
 * takes money and holds personal data, and one that asks for something Shipyard
 * cannot build. The third matters most — the failure it prevents is a founder
 * discovering at launch that the thing they came here for was never possible.
 *
 *   npx tsx harness/test-resolver.ts
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluate, loadRules } from '@shipyard/rulebook';
import type { ProjectIntent, TargetMode } from '@shipyard/shared';

import {
  capabilityIds,
  displayableFreeTier,
  loadCatalog,
  offersFor,
  resolve,
  scopeWarnings,
} from '../src/index';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = path.resolve(HERE, '..', '..', '..', 'shipyard-catalog');

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS  ${name}`);
  else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

function intent(targetMode: TargetMode, overrides: Partial<ProjectIntent> = {}): ProjectIntent {
  return {
    targetMode,
    regions: ['GB'],
    sensitiveData: false,
    payments: false,
    aiAffectsConsequentialDecision: false,
    humanReviewRequired: false,
    publicFacing: false,
    existingCodeSource: 'new_project',
    ...overrides,
  };
}

async function main(): Promise<void> {
  const catalog = await loadCatalog(CATALOG);
  check('the catalog loads', catalog.capabilities.length > 0 && catalog.vendors.length > 0);
  check(
    'every capability is labelled in plain language, not by id',
    catalog.capabilities.every((c) => c.label.length > 3 && !c.label.includes('_')),
    catalog.capabilities.find((c) => c.label.includes('_'))?.id,
  );
  check(
    'every vendor a capability names actually exists',
    (() => {
      const ids = new Set(catalog.vendors.map((v) => v.id));
      const missing = catalog.capabilities
        .flatMap((c) => c.vendors ?? [])
        .filter((v) => !ids.has(v));
      if (missing.length) console.log(`        missing: ${[...new Set(missing)].join(', ')}`);
      return missing.length === 0;
    })(),
  );
  check(
    'every service a capability triggers actually exists',
    (() => {
      const ids = new Set(catalog.services.map((s) => s.id));
      const missing = catalog.capabilities
        .flatMap((c) => c.serviceTriggers ?? [])
        .filter((s) => !ids.has(s));
      if (missing.length) console.log(`        missing: ${[...new Set(missing)].join(', ')}`);
      return missing.length === 0;
    })(),
  );

  // --- fixture 1: a concept build ------------------------------------------
  const concept = resolve(intent('ui_concept'), catalog.capabilities, catalog.vendors);
  check(
    'a concept build is not asked to set up sign-in',
    !capabilityIds(concept).includes('authentication'),
    capabilityIds(concept).join(', '),
  );
  check(
    'but sign-in is named as coming later, rather than sprung on them',
    concept.deferred.some((r) => r.capability.id === 'authentication'),
  );
  check(
    'and the reason says when it starts to matter',
    /becomes necessary at a pilot with real people/.test(
      concept.deferred.find((r) => r.capability.id === 'authentication')?.reason ?? '',
    ),
    concept.deferred.find((r) => r.capability.id === 'authentication')?.reason,
  );

  // --- fixture 2: a real SaaS pilot ----------------------------------------
  const saas = resolve(
    intent('customer_pilot', { publicFacing: true, payments: true, sensitiveData: true }),
    catalog.capabilities,
    catalog.vendors,
  );
  const saasIds = capabilityIds(saas);
  check(
    'a typical SaaS pilot resolves at least ten capabilities',
    saasIds.length >= 10,
    `${saasIds.length}: ${saasIds.join(', ')}`,
  );
  for (const expected of [
    'authentication',
    'role_permissions',
    'audit_logging',
    'privacy_export_delete',
    'subscription_payments',
    'transactional_email',
    'error_monitoring',
    'deployment',
  ]) {
    check(`the pilot includes ${expected}`, saasIds.includes(expected));
  }
  check(
    'payments need a person to sign them off, not just a passing test',
    saas.included.find((r) => r.capability.id === 'subscription_payments')?.status ===
      'requires_human_review',
  );
  check(
    'and the reason quotes what the founder actually said',
    /money changes hands/.test(
      saas.included.find((r) => r.capability.id === 'subscription_payments')?.reason ?? '',
    ),
    saas.included.find((r) => r.capability.id === 'subscription_payments')?.reason,
  );
  check(
    'holding personal data is why permissions are required',
    /information people would mind losing/.test(
      saas.included.find((r) => r.capability.id === 'role_permissions')?.reason ?? '',
    ),
  );
  check('the plan names the components to install', saas.components.includes('auth'));
  check('and the recipes that set up the vendors', saas.recipes.includes('sentry_nextjs_basic'));
  check('and picks a vendor per capability', saas.resolved.some((r) => r.vendor === 'stripe'));

  // The resolver's gates and the rulebook's gates have to be the same language,
  // or the score is measured against obligations nothing produces.
  const rules = await loadRules(path.join(CATALOG, 'rules'));
  const outcomes = evaluate(rules, {
    intent: intent('customer_pilot', { publicFacing: true, payments: true, sensitiveData: true }),
    capabilities: saasIds,
    evidence: [],
  });
  const ruleGates = new Set(
    outcomes.filter((o) => o.applies).flatMap((o) => o.requiredGates),
  );
  const shared = saas.gates.filter((g) => ruleGates.has(g));
  check(
    'the resolver and the rulebook speak about the same gates',
    shared.length >= 8,
    `${shared.length} shared: ${shared.join(', ')}`,
  );

  // --- fixture 3: something Shipyard cannot build --------------------------
  const mobile = resolve(
    intent('customer_pilot', { publicFacing: true }),
    catalog.capabilities.map((c) =>
      c.id === 'native_mobile' ? { ...c, triggeredBy: ['publicFacing' as const] } : c,
    ),
    catalog.vendors,
  );
  check('unsupported work is refused rather than attempted', mobile.unsupported.length > 0);
  check(
    'and the warning says what to do instead',
    scopeWarnings(mobile).some((w) => /phone browser/.test(w)),
    scopeWarnings(mobile).join(' | '),
  );
  check(
    'an unsupported capability contributes no gates to pretend it is covered',
    mobile.unsupported.every((r) => r.gates.length === 0),
  );

  // --- free-tier claims ----------------------------------------------------
  // Free tiers change without notice. A limit quoted from memory is a confident
  // wrong answer a founder will plan a launch around.
  const sentry = catalog.vendors.find((v) => v.id === 'sentry');
  check(
    'an unverified free tier is not repeated to the user',
    sentry !== undefined && displayableFreeTier(sentry) === null,
    JSON.stringify(sentry?.freeTier),
  );
  check(
    'a verified one is',
    displayableFreeTier({
      ...(sentry as NonNullable<typeof sentry>),
      freeTier: {
        available: true,
        limits: 'x',
        upgradeTrigger: 'y',
        lastVerifiedAt: '2026-08-14',
        sourceUrl: 'https://example.com',
      },
    }) !== null,
  );

  // --- what to offer, and what it costs ------------------------------------
  const offers = offersFor(saas.serviceTriggers, catalog.services);
  check(
    'a payments project is offered the payment review',
    offers.some((o) => o.id === 'payment_integration_review'),
    offers.map((o) => o.id).join(', '),
  );
  check(
    'every offer states the free alternative next to the price',
    offers.every((o) => o.selfServiceAlternative.length > 20),
  );
  check(
    'a concept build is offered nothing',
    offersFor(concept.serviceTriggers, catalog.services).length === 0,
    concept.serviceTriggers.join(', '),
  );

  console.log(`\n${failed === 0 ? 'All resolver cases pass.' : `${failed} case(s) failed.`}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
