/**
 * Does the rulebook say the right thing about real projects?
 *
 * Fixtures are whole projects, not isolated conditions, because the failure
 * this layer exists to prevent is a *combination*: a project that looks fine
 * because each rule was tested on its own. The cases below are the four modes
 * plus the three facts that change everything — payments, sensitive data, and
 * software that decides something about a person.
 *
 *   npx tsx harness/test-rules.ts
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Evidence, ProjectIntent, TargetMode } from '@shipyard/shared';
import { assess, CATEGORIES, THRESHOLDS } from '@shipyard/readiness';
import {
  requestTransition,
  availableTransitions,
  TRANSITIONS,
} from '@shipyard/project-state';

import { evaluate, explain, loadRules, openFindings, requiredGates } from '../src/index';
import type { ProjectFacts } from '../src/index';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = path.resolve(HERE, '..', '..', '..', 'shipyard-catalog', 'rules');

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

/** Evidence that every listed gate passed, an hour ago. */
function passed(...gateIds: string[]): Evidence[] {
  return gateIds.map((gateId) => ({
    gateId,
    status: 'passed' as const,
    observedAt: '2026-08-14T09:00:00.000Z',
  }));
}

async function main(): Promise<void> {
  const rules = await loadRules(CATALOG);
  check('the catalog loads', rules.length > 0, `${rules.length} rules`);
  check(
    'every rule has a message written for a person',
    rules.every((r) => r.message.length > 40 && !/\b(RBAC|SSL|webhook signature)\b/.test(r.message.split('.')[0] ?? '')),
    rules.find((r) => r.message.length <= 40)?.id,
  );

  // --- weights and thresholds are the ones the plan specifies --------------
  const totalWeight = CATEGORIES.reduce((sum, c) => sum + c.weight, 0);
  check('readiness weights sum to 100', totalWeight === 100, `got ${totalWeight}`);
  check(
    'every gate a rule requires is scored somewhere',
    (() => {
      const scored = new Set(CATEGORIES.flatMap((c) => c.gates));
      const unscored = [...new Set(rules.flatMap((r) => r.require.gates ?? []))].filter(
        (g) => !scored.has(g),
      );
      // Gates that gate a transition but carry no score are deliberate; these
      // are the ones the plan lists under readiness categories.
      const allowed = new Set([
        'capabilities_resolved',
        'human_review_step_present',
        'decision_consent_recorded',
        'decision_audit_trail_complete',
        'no_repeated_fix_failures',
        'handoff_documentation_written',
      ]);
      const leaked = unscored.filter((g) => !allowed.has(g));
      if (leaked.length) console.log(`        unscored: ${leaked.join(', ')}`);
      return leaked.length === 0;
    })(),
  );

  // --- a concept build is not held to a product's standard ----------------
  // What a concept build honestly has: it builds, it says what it is, and the
  // click-through works. No database, no sign-in, no deployment.
  const concept: ProjectFacts = {
    intent: intent('ui_concept'),
    capabilities: [],
    evidence: passed(
      'intent_captured',
      'plan_approved',
      'not_production_label_present',
      'supported_stack_selected',
      'build_passes',
      'core_flow_smoke_test',
    ),
  };
  const conceptOutcomes = evaluate(rules, concept);
  const conceptReadiness = assess(concept, conceptOutcomes);
  check(
    'a concept build has no blockers',
    conceptReadiness.blockers.length === 0,
    conceptReadiness.blockers.map((b) => b.ruleId).join(', '),
  );
  check(
    'a concept build is judged against the same yardstick',
    conceptReadiness.score < 40,
    `scored ${conceptReadiness.score}`,
  );
  check(
    'a concept build can still be called ready for what it is',
    conceptReadiness.ready,
    JSON.stringify({ score: conceptReadiness.score, threshold: conceptReadiness.threshold }),
  );
  check(
    'a concept build is not asked to set up payments or monitoring',
    requiredGates(rules, concept).every((g) => !g.startsWith('stripe_') && !g.startsWith('error_monitoring')),
  );

  // --- the same project, aimed at real users -------------------------------
  const pilotFacts: ProjectFacts = {
    intent: intent('customer_pilot', { publicFacing: true }),
    capabilities: [],
    evidence: concept.evidence,
  };
  const pilotOutcomes = evaluate(rules, pilotFacts);
  const pilotReadiness = assess(pilotFacts, pilotOutcomes);
  check(
    'aiming higher creates blockers without changing a line of code',
    pilotReadiness.blockers.length > 0,
    `${pilotReadiness.blockers.length} blockers`,
  );
  check('a pilot is not ready on a concept’s evidence', !pilotReadiness.ready);
  check(
    'monitoring is required once strangers can reach it',
    requiredGates(rules, pilotFacts).includes('error_monitoring_receives_test_event'),
  );
  check(
    'the user is offered help that matches what is wrong',
    pilotReadiness.serviceTriggers.includes('sentry_setup') &&
      pilotReadiness.serviceTriggers.includes('launch_readiness_audit'),
    pilotReadiness.serviceTriggers.join(', '),
  );

  // --- money and personal data pull in their own obligations ---------------
  const risky: ProjectFacts = {
    intent: intent('customer_pilot', {
      publicFacing: true,
      payments: true,
      sensitiveData: true,
    }),
    capabilities: [],
    evidence: [],
  };
  const riskyGates = requiredGates(rules, risky);
  check(
    'taking payments requires the webhook to be verified',
    riskyGates.includes('stripe_webhook_signature_verified') &&
      riskyGates.includes('stripe_idempotency_test_passed'),
  );
  check(
    'holding personal data requires permissions, audit and deletion',
    riskyGates.includes('rbac_permission_tests_pass') &&
      riskyGates.includes('audit_log_records_access') &&
      riskyGates.includes('privacy_export_delete_works'),
  );
  check(
    'the same project without those facts owes neither',
    (() => {
      const plain = requiredGates(rules, {
        intent: intent('customer_pilot', { publicFacing: true }),
        capabilities: [],
        evidence: [],
      });
      return !plain.includes('stripe_webhook_signature_verified') &&
        !plain.includes('privacy_export_delete_works');
    })(),
  );

  // --- software that decides something about a person ---------------------
  // The one rule with no mode floor: a demo that makes real decisions about
  // real people is not a demo.
  const decides: ProjectFacts = {
    intent: intent('ui_concept', { aiAffectsConsequentialDecision: true }),
    capabilities: [],
    evidence: passed('intent_captured', 'plan_approved', 'not_production_label_present'),
  };
  const decidesReadiness = assess(decides, evaluate(rules, decides));
  check(
    'consequential decisions are gated even in a concept build',
    decidesReadiness.blockers.some((b) => b.ruleId === 'privacy.consequential_decisions.human_review'),
    decidesReadiness.blockers.map((b) => b.ruleId).join(', '),
  );
  check('and that project cannot be called ready', !decidesReadiness.ready);
  check(
    'a person is required to sign it off, not just a passing test',
    decidesReadiness.humanReviewRequired,
  );

  // --- a fully evidenced pilot --------------------------------------------
  const complete: ProjectFacts = {
    intent: intent('customer_pilot', { publicFacing: true }),
    capabilities: [],
    evidence: passed(
      ...new Set([
        ...requiredGates(rules, { intent: intent('customer_pilot', { publicFacing: true }), capabilities: [], evidence: [] }),
        ...CATEGORIES.flatMap((c) => c.gates),
      ]),
    ),
  };
  const completeReadiness = assess(complete, evaluate(rules, complete));
  check(
    'a fully evidenced pilot clears its threshold',
    completeReadiness.score >= THRESHOLDS.customer_pilot,
    `scored ${completeReadiness.score}`,
  );
  check('and has nothing blocking it', completeReadiness.blockers.length === 0,
    completeReadiness.blockers.map((b) => `${b.ruleId} missing ${b.missingGates.join('/')}`).join('; '));
  check('and is ready', completeReadiness.ready);

  // --- evidence goes stale, and readiness can go down ----------------------
  const regressed: ProjectFacts = {
    ...complete,
    evidence: [
      ...complete.evidence,
      {
        gateId: 'critical_flow_tests_pass',
        status: 'failed',
        observedAt: '2026-08-14T12:00:00.000Z',
        summary: 'Sign-up stopped working after the last change.',
      },
    ],
  };
  const regressedReadiness = assess(regressed, evaluate(rules, regressed));
  check(
    'a newer failure overrides an older pass',
    !regressedReadiness.ready && regressedReadiness.score < completeReadiness.score,
    `${completeReadiness.score} -> ${regressedReadiness.score}`,
  );
  check(
    'and the user is told what to do about it, not just given a number',
    regressedReadiness.nextActions.length > 0,
  );

  // --- explanations name the missing thing --------------------------------
  const finding = openFindings(evaluate(rules, pilotFacts))[0];
  const sentence = finding ? explain(finding, { auth_login_works: 'people can sign in' }) : '';
  check('an explanation says what is still missing', /Still missing:/.test(sentence), sentence);

  // --- the state machine ---------------------------------------------------
  check(
    'every transition target is a state something can leave, or the end',
    TRANSITIONS.every(
      (t) => t.to === 'maintenance' || TRANSITIONS.some((next) => next.from === t.to),
    ),
  );

  const jump = requestTransition({
    from: 'created',
    to: 'production_live',
    targetMode: 'production_product',
    evidence: [],
  });
  check('you cannot skip from created to live', !jump.allowed);

  const unpaid = requestTransition({
    from: 'pilot_preparation',
    to: 'pilot_live',
    targetMode: 'customer_pilot',
    evidence: passed('auth_login_works'),
  });
  check('going live without the evidence is refused', !unpaid.allowed);
  check(
    'and the refusal lists exactly what is missing',
    !unpaid.allowed && unpaid.missing.includes('deployed_health_check_passes'),
    unpaid.allowed ? '' : unpaid.missing.join(', '),
  );

  const evidenced = {
    from: 'pilot_preparation' as const,
    to: 'pilot_live' as const,
    targetMode: 'customer_pilot' as const,
    evidence: passed(
      'auth_login_works',
      'database_persists_across_restart',
      'transactional_email_sends',
      'error_monitoring_receives_test_event',
      'critical_flow_tests_pass',
      'deployed_health_check_passes',
      'backup_plan_recorded',
    ),
  };
  const unapproved = requestTransition(evidenced);
  check(
    'the step that exposes real users still needs a person to say yes',
    !unapproved.allowed && unapproved.needsApproval,
    unapproved.allowed ? 'was allowed' : unapproved.reason,
  );

  const approved = requestTransition({
    ...evidenced,
    approval: { by: 'founder', note: 'Ten pilot customers, invited by hand.' },
  });
  check('with evidence and sign-off, it goes live', approved.allowed);

  const failedGate = requestTransition({
    ...evidenced,
    evidence: [
      ...evidenced.evidence,
      { gateId: 'auth_login_works', status: 'failed', observedAt: '2026-08-14T13:00:00.000Z' },
    ],
    approval: { by: 'founder', note: 'Ship it anyway.' },
  });
  check(
    'sign-off cannot wave through a check that is actually failing',
    !failedGate.allowed,
    failedGate.allowed ? 'was allowed' : '',
  );

  check(
    'a prototype-only project is not offered the pilot step',
    availableTransitions('prototype_ready', 'functional_prototype').length === 0,
  );
  check(
    'and a pilot project is',
    availableTransitions('prototype_ready', 'customer_pilot').some((t) => t.to === 'pilot_preparation'),
  );

  console.log(`\n${failed === 0 ? 'All rulebook cases pass.' : `${failed} case(s) failed.`}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
