/**
 * Does Shipyard only ask for money when it has earned the right to?
 *
 * The case that matters most is the last one: a healthy project is offered
 * nothing. Every advert shown to someone who did not need it is a reason to
 * ignore the next one, including the one that would have saved their launch.
 *
 *   npx tsx harness/test-services.ts
 */
import type { Incident, RuleOutcome, SecurityFinding, ServiceOffer } from '@shipyard/shared';

import { present, recommend, respond, snoozeUntil } from '../src/index';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS  ${name}`);
  else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

const CATALOG: ServiceOffer[] = [
  {
    id: 'sentry_setup',
    name: 'Sentry Setup',
    deliverable: 'Monitoring wired up.',
    priceMin: 149,
    priceMax: 299,
    priceUnit: 'project',
    selfServiceAlternative: 'Shipyard can install this itself in about twenty minutes.',
    enabled: true,
  },
  {
    id: 'fix_sprint',
    name: 'Fix Sprint',
    deliverable: 'A developer fixes one scoped problem.',
    priceMin: 500,
    priceMax: 2000,
    priceUnit: 'project',
    selfServiceAlternative: 'Keep going with Claude; this is for when it has stalled.',
    enabled: true,
  },
  {
    id: 'security_privacy_review',
    name: 'Security and Privacy Review',
    deliverable: 'Findings and fixes.',
    priceMin: 750,
    priceMax: 2500,
    priceUnit: 'project',
    selfServiceAlternative: 'The automated scans catch known holes.',
    enabled: true,
  },
  {
    id: 'launch_readiness_audit',
    name: 'Launch Readiness Audit',
    deliverable: 'A written report.',
    priceMin: 500,
    priceMax: 1000,
    priceUnit: 'project',
    selfServiceAlternative: 'Your readiness score already lists every blocker.',
    enabled: true,
  },
  {
    id: 'operate_plan',
    name: 'Operate Plan',
    deliverable: 'Monitoring watched.',
    priceMin: 99,
    priceMax: 499,
    priceUnit: 'month',
    selfServiceAlternative: 'Shipyard keeps showing you incidents for free.',
    enabled: true,
  },
  {
    id: 'disabled_thing',
    name: 'Disabled',
    deliverable: '-',
    priceMin: 1,
    priceMax: 2,
    priceUnit: 'project',
    selfServiceAlternative: '-',
    enabled: false,
  },
];

const intent = {
  targetMode: 'customer_pilot' as const,
  regions: ['GB'],
  sensitiveData: false,
  payments: false,
  aiAffectsConsequentialDecision: false,
  humanReviewRequired: false,
  publicFacing: true,
  existingCodeSource: 'new_project' as const,
};

function outcome(overrides: Partial<RuleOutcome> = {}): RuleOutcome {
  return {
    ruleId: 'observability.error_monitoring.before_pilot',
    ruleVersion: 1,
    category: 'observability',
    severity: 'blocker',
    message: 'Anyone on the internet can reach this and nothing is watching it.',
    applies: true,
    satisfied: false,
    requiredGates: ['error_monitoring_receives_test_event'],
    missingGates: ['error_monitoring_receives_test_event'],
    requiredComponents: [],
    humanReviewRequired: false,
    serviceTriggers: ['sentry_setup'],
    ...overrides,
  };
}

function main(): void {
  // --- an unsatisfied rule that names a service ---------------------------
  const monitoring = recommend({ projectId: 'p', intent, outcomes: [outcome()] }, CATALOG);
  check('a missing monitoring gate offers the setup', monitoring[0]?.serviceId === 'sentry_setup');
  check(
    'and the reason is the rule’s own words, not sales copy',
    /Anyone on the internet can reach this/.test(monitoring[0]?.reason ?? ''),
  );
  check(
    'with the evidence that produced it',
    monitoring[0]?.evidence.includes('observability.error_monitoring.before_pilot') === true,
    JSON.stringify(monitoring[0]?.evidence),
  );

  // --- the case this whole module exists to get right ---------------------
  const healthy = recommend(
    { projectId: 'p', intent, outcomes: [outcome({ satisfied: true, missingGates: [] })] },
    CATALOG,
  );
  check('a project with nothing wrong is offered nothing', healthy.length === 0, JSON.stringify(healthy));

  const notApplicable = recommend(
    { projectId: 'p', intent, outcomes: [outcome({ applies: false })] },
    CATALOG,
  );
  check('a rule that does not apply cannot sell anything', notApplicable.length === 0);

  // Capability triggers are not enough on their own: a project whose payment
  // checks all pass must not be sold a payment review.
  const capabilityOnly = recommend(
    {
      projectId: 'p',
      intent,
      outcomes: [outcome({ satisfied: true, missingGates: [] })],
      capabilityTriggers: ['security_privacy_review'],
    },
    CATALOG,
  );
  check(
    'a capability trigger with nothing outstanding sells nothing',
    capabilityOnly.length === 0,
    JSON.stringify(capabilityOnly),
  );

  // --- a problem that has resisted two attempts ---------------------------
  const stuck: Incident = {
    id: 'inc_1',
    projectId: 'p',
    source: 'sentry',
    environment: 'production',
    severity: 'S1',
    title: 'Checkout fails intermittently',
    firstSeenAt: '2026-08-14T10:00:00.000Z',
    reproductionStatus: 'pending',
    fixStatus: 'in_progress',
    fixAttempts: 2,
  };
  const stuckOffers = recommend({ projectId: 'p', intent, outcomes: [], incidents: [stuck] }, CATALOG);
  check('two failed attempts offers a developer', stuckOffers.some((r) => r.serviceId === 'fix_sprint'));
  check(
    'and explains why more attempts will not help',
    /cause is somewhere other than where it appears/.test(
      stuckOffers.find((r) => r.serviceId === 'fix_sprint')?.reason ?? '',
    ),
  );
  check(
    'one failed attempt does not',
    recommend({ projectId: 'p', intent, outcomes: [], incidents: [{ ...stuck, fixAttempts: 1 }] }, CATALOG)
      .length === 0,
  );

  // --- security findings ---------------------------------------------------
  const finding: SecurityFinding = {
    id: 'sf_1',
    projectId: 'p',
    type: 'secret',
    severity: 'critical',
    summary: 'A key is in a source file.',
    status: 'open',
    foundAt: '2026-08-14T10:00:00.000Z',
  };
  check(
    'a critical security finding offers a review',
    recommend({ projectId: 'p', intent, outcomes: [], securityFindings: [finding] }, CATALOG).some(
      (r) => r.serviceId === 'security_privacy_review',
    ),
  );
  check(
    'one already dealt with does not',
    recommend(
      { projectId: 'p', intent, outcomes: [], securityFindings: [{ ...finding, status: 'fixed' }] },
      CATALOG,
    ).length === 0,
  );

  // --- a deadline the project will not make -------------------------------
  const deadline = recommend(
    {
      projectId: 'p',
      intent,
      outcomes: [],
      daysToLaunch: 9,
      readinessScore: 44,
      readinessThreshold: 70,
    },
    CATALOG,
  );
  check('a launch in nine days at 44 offers an audit', deadline.some((r) => r.serviceId === 'launch_readiness_audit'));
  check(
    'and says the numbers rather than being vague about it',
    /9 days.*44.*70/s.test(deadline[0]?.reason ?? ''),
    deadline[0]?.reason,
  );
  check(
    'a project already over the bar is left alone',
    recommend(
      { projectId: 'p', intent, outcomes: [], daysToLaunch: 9, readinessScore: 88, readinessThreshold: 70 },
      CATALOG,
    ).length === 0,
  );

  // --- the user's answer ---------------------------------------------------
  check(
    'a declined offer is not made again',
    recommend({ projectId: 'p', intent, outcomes: [outcome()], declined: ['sentry_setup'] }, CATALOG)
      .length === 0,
  );
  const later = snoozeUntil(7, new Date('2026-08-14T00:00:00.000Z'));
  check(
    'a snoozed offer waits',
    recommend(
      { projectId: 'p', intent, outcomes: [outcome()], snoozedUntil: { sentry_setup: later } },
      CATALOG,
      '2026-08-15T00:00:00.000Z',
    ).length === 0,
  );
  check(
    'and comes back when the snooze is over',
    recommend(
      { projectId: 'p', intent, outcomes: [outcome()], snoozedUntil: { sentry_setup: later } },
      CATALOG,
      '2026-08-30T00:00:00.000Z',
    ).length === 1,
  );
  check('declining is recorded rather than forgotten', respond(monitoring[0]!, 'declined').status === 'declined');

  // --- what the user actually sees ----------------------------------------
  const shown = present(monitoring, CATALOG);
  check('the price is a range a person can read', shown[0]?.price === '$149–$299');
  check('the free path is shown next to it, always', shown[0]?.insteadYouCould.includes('twenty minutes'));
  check(
    'a monthly plan says so',
    present([{ ...monitoring[0]!, serviceId: 'operate_plan' }], CATALOG)[0]?.price === '$99–$499 a month',
  );
  check(
    'a disabled service is never offered',
    recommend(
      { projectId: 'p', intent, outcomes: [outcome({ serviceTriggers: ['disabled_thing'] })] },
      CATALOG,
    ).length === 0,
  );

  // Two rules wanting the same service is one offer, not two.
  const duplicated = recommend(
    { projectId: 'p', intent, outcomes: [outcome(), outcome({ ruleId: 'other.rule' })] },
    CATALOG,
  );
  check('the same offer is not made twice', duplicated.length === 1);

  console.log(`\n${failed === 0 ? 'All service cases pass.' : `${failed} case(s) failed.`}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
