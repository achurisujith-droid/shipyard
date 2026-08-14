import {
  latestEvidence,
  openFindings,
  type ProjectFacts,
} from '@shipyard/rulebook';
import type { RuleOutcome, TargetMode } from '@shipyard/shared';

/**
 * How ready is this, and how do we know?
 *
 * The score is measured against the **whole** production checklist, not against
 * what the project currently owes. A concept build genuinely scores around 20:
 * it has no sign-in, no tests and no deployment, and pretending otherwise is
 * how a demo ends up in front of customers. What changes with the target mode
 * is the threshold, not the yardstick.
 *
 * Every point is attached to an observation. Nothing here asks the agent
 * whether it finished.
 */

export interface ReadinessCategory {
  id: string;
  /** What the user reads. */
  label: string;
  /** Out of 100, summing to 100 across all categories. */
  weight: number;
  /** The full production checklist for this category. */
  gates: string[];
}

/**
 * The checklist.
 *
 * Weights are the plan's: testing carries the most because it is the only
 * category that keeps being true after the day it was checked.
 */
export const CATEGORIES: readonly ReadinessCategory[] = [
  {
    id: 'scope',
    label: 'Knowing what you are building',
    weight: 10,
    gates: ['intent_captured', 'plan_approved', 'not_production_label_present'],
  },
  {
    id: 'architecture',
    label: 'Foundations',
    weight: 10,
    gates: ['build_passes', 'supported_stack_selected', 'database_persists_across_restart'],
  },
  {
    id: 'auth',
    label: 'Sign-in and permissions',
    weight: 12,
    gates: ['auth_login_works', 'rbac_permission_tests_pass', 'protected_routes_enforced'],
  },
  {
    id: 'privacy',
    label: 'Looking after people’s information',
    weight: 10,
    gates: [
      'audit_log_records_access',
      'privacy_export_delete_works',
      'data_retention_statement_written',
    ],
  },
  {
    id: 'integrations',
    label: 'The services it depends on',
    weight: 10,
    gates: [
      'transactional_email_sends',
      'stripe_webhook_signature_verified',
      'file_storage_round_trip',
    ],
  },
  {
    id: 'testing',
    label: 'Checks that run every time',
    weight: 15,
    gates: [
      'core_flow_smoke_test',
      'critical_flow_tests_pass',
      'stripe_idempotency_test_passed',
      'failed_payment_flow_tested',
      'component_contract_tests_pass',
    ],
  },
  {
    id: 'observability',
    label: 'Finding out when it breaks',
    weight: 10,
    gates: [
      'error_monitoring_receives_test_event',
      'release_tagged_in_monitoring',
      'payment_events_logged',
    ],
  },
  {
    id: 'deployment',
    label: 'Being online',
    weight: 10,
    gates: ['deployed_health_check_passes', 'domain_ssl_verified', 'uptime_check_configured'],
  },
  {
    id: 'security',
    label: 'Known holes and licences',
    weight: 8,
    gates: [
      'secrets_scan_clean',
      'dependency_scan_clean',
      'license_scan_reviewed',
      'security_scan_clean',
    ],
  },
  {
    id: 'operations',
    label: 'What happens after launch',
    weight: 5,
    gates: ['backup_plan_recorded', 'backup_restore_tested', 'incident_process_recorded'],
  },
];

/**
 * What each mode has to reach before it can be called ready.
 *
 * `ui_concept` is 15 rather than the 20 originally suggested, because 20 turned
 * out to be unreachable by a concept build that is exactly what it claims to
 * be. The most a legitimate one can earn is about 17: the scope category in
 * full, two thirds of foundations (it builds and has a chosen stack, but stores
 * nothing), and one testing gate for a click-through that works. Setting the
 * bar above the ceiling would fail every honest concept and teach people to
 * ignore the number — the opposite of the point.
 *
 * The other three are the plan's, and all three are comfortably reachable.
 */
export const THRESHOLDS: Record<TargetMode, number> = {
  ui_concept: 15,
  functional_prototype: 40,
  customer_pilot: 70,
  production_product: 85,
};

export interface CategoryScore {
  id: string;
  label: string;
  weight: number;
  /** Points earned, out of `weight`. */
  earned: number;
  passed: string[];
  outstanding: string[];
}

export interface Readiness {
  /** 0-100, against the whole production checklist. */
  score: number;
  threshold: number;
  targetMode: TargetMode;
  byCategory: CategoryScore[];
  /** Unsatisfied rules that stop a launch at this mode. */
  blockers: RuleOutcome[];
  warnings: RuleOutcome[];
  recommendations: RuleOutcome[];
  /** A person must sign off, whatever the score says. */
  humanReviewRequired: boolean;
  /** Score is high enough AND nothing is blocking AND sign-off is not owed. */
  ready: boolean;
  /**
   * What to do next, worst first. The point of the whole exercise: a number
   * with no next action is a number that makes someone feel bad and changes
   * nothing.
   */
  nextActions: string[];
  /** Paid help this project's open findings justify offering. */
  serviceTriggers: string[];
}

/**
 * Score the project.
 *
 * `outcomes` comes from the rulebook. Passing it in rather than evaluating here
 * keeps this function pure arithmetic over observations, which is what makes it
 * cheap to test and impossible to argue with.
 */
export function assess(facts: ProjectFacts, outcomes: RuleOutcome[]): Readiness {
  const latest = latestEvidence(facts.evidence);
  const passedGate = (gateId: string): boolean => latest.get(gateId)?.status === 'passed';

  const byCategory: CategoryScore[] = CATEGORIES.map((category) => {
    const passed = category.gates.filter(passedGate);
    const outstanding = category.gates.filter((gate) => !passedGate(gate));
    return {
      id: category.id,
      label: category.label,
      weight: category.weight,
      earned: (passed.length / category.gates.length) * category.weight,
      passed,
      outstanding,
    };
  });

  const score = Math.round(byCategory.reduce((total, c) => total + c.earned, 0));
  const open = openFindings(outcomes);
  const blockers = open.filter((o) => o.severity === 'blocker');
  const warnings = open.filter((o) => o.severity === 'warning');
  const recommendations = open.filter((o) => o.severity === 'recommendation');

  const threshold = THRESHOLDS[facts.intent.targetMode];
  // Human review owed by an unsatisfied rule. A satisfied rule's sign-off has
  // already happened, so it must not keep the project blocked forever.
  const humanReviewRequired = outcomes.some(
    (o) => o.applies && !o.satisfied && o.humanReviewRequired,
  );

  const serviceTriggers = [...new Set(open.flatMap((o) => o.serviceTriggers))].sort();

  return {
    score,
    threshold,
    targetMode: facts.intent.targetMode,
    byCategory,
    blockers,
    warnings,
    recommendations,
    humanReviewRequired,
    ready: score >= threshold && blockers.length === 0 && !humanReviewRequired,
    nextActions: [...blockers, ...warnings].map((o) => o.message),
    serviceTriggers,
  };
}

/**
 * One line for the top of the screen.
 *
 * Says where they stand and what stands in the way, in that order, without a
 * celebration and without a scolding.
 */
export function summarise(readiness: Readiness): string {
  if (readiness.ready) {
    return `Ready for ${label(readiness.targetMode)}. Score ${readiness.score} out of a threshold of ${readiness.threshold}.`;
  }
  if (readiness.blockers.length > 0) {
    const count = readiness.blockers.length;
    return `Not ready for ${label(readiness.targetMode)}: ${count} thing${count === 1 ? '' : 's'} still to sort out. Score ${readiness.score} of ${readiness.threshold}.`;
  }
  if (readiness.humanReviewRequired) {
    return `Everything checks out, but this needs a person to sign it off before ${label(readiness.targetMode)}.`;
  }
  return `Score ${readiness.score}, and ${label(readiness.targetMode)} needs ${readiness.threshold}.`;
}

function label(mode: TargetMode): string {
  switch (mode) {
    case 'ui_concept':
      return 'showing as a concept';
    case 'functional_prototype':
      return 'demonstrating';
    case 'customer_pilot':
      return 'a pilot with real users';
    case 'production_product':
      return 'launch';
  }
}
