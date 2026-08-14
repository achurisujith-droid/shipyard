import type { Evidence, TargetMode } from '@shipyard/shared';

/**
 * Where a project is, and what it took to get there.
 *
 * The states exist so that "prototype" and "customers are using this" cannot be
 * the same thing by accident. Every step forward has to be paid for with
 * evidence; a step the user wants and cannot pay for is refused with the reason
 * attached, not silently allowed.
 */

export type ProjectState =
  | 'created'
  | 'onboarding_complete'
  | 'blueprint_ready'
  | 'local_scaffold_ready'
  | 'components_selected'
  | 'components_installed'
  | 'agent_building'
  | 'local_preview_running'
  | 'verification_running'
  | 'prototype_ready'
  | 'pilot_preparation'
  | 'pilot_live'
  | 'production_preparation'
  | 'production_live'
  | 'maintenance';

export interface Transition {
  from: ProjectState;
  to: ProjectState;
  /** Gates that must have passed. */
  requires: string[];
  /**
   * Crossing this line puts the project in front of people, so a failed check
   * cannot be waved through by the person who wants to launch.
   */
  protected?: boolean;
  /** Only reachable when the project is aiming at least this high. */
  minMode?: TargetMode;
  /** Why this step exists, in the user's terms. */
  meaning: string;
}

/**
 * The graph.
 *
 * Forward edges only. Going backwards happens by re-entering an earlier state
 * through `regress`, which records why — a project that quietly slid back from
 * live to broken should be visible as exactly that.
 */
export const TRANSITIONS: readonly Transition[] = [
  {
    from: 'created',
    to: 'onboarding_complete',
    requires: ['intent_captured'],
    meaning: 'We know what you are making and how far you are taking it.',
  },
  {
    from: 'onboarding_complete',
    to: 'blueprint_ready',
    requires: ['plan_approved'],
    meaning: 'You have read the plan and agreed with it.',
  },
  {
    from: 'blueprint_ready',
    to: 'local_scaffold_ready',
    requires: ['supported_stack_selected', 'build_passes'],
    meaning: 'There is a real project on your machine and it builds.',
  },
  {
    from: 'local_scaffold_ready',
    to: 'components_selected',
    requires: ['capabilities_resolved'],
    meaning: 'We know which ready-made parts this needs instead of writing them again.',
  },
  {
    from: 'components_selected',
    to: 'components_installed',
    requires: ['component_contract_tests_pass'],
    meaning: 'Those parts are in and still behave the way they are supposed to.',
  },
  {
    from: 'components_installed',
    to: 'agent_building',
    requires: [],
    meaning: 'Claude is building your product.',
  },
  {
    from: 'agent_building',
    to: 'local_preview_running',
    requires: ['build_passes'],
    meaning: 'You can see it running.',
  },
  {
    from: 'local_preview_running',
    to: 'verification_running',
    requires: [],
    meaning: 'The checks are running.',
  },
  {
    from: 'verification_running',
    to: 'prototype_ready',
    requires: ['build_passes', 'core_flow_smoke_test'],
    meaning: 'The main journey works, on your machine.',
  },
  {
    from: 'prototype_ready',
    to: 'pilot_preparation',
    requires: [],
    minMode: 'customer_pilot',
    meaning: 'Getting it fit for real people to use.',
  },
  {
    from: 'pilot_preparation',
    to: 'pilot_live',
    requires: [
      'auth_login_works',
      'database_persists_across_restart',
      'transactional_email_sends',
      'error_monitoring_receives_test_event',
      'critical_flow_tests_pass',
      'deployed_health_check_passes',
      'backup_plan_recorded',
    ],
    protected: true,
    minMode: 'customer_pilot',
    meaning: 'Real people are using it, and you will know before they do when something breaks.',
  },
  {
    from: 'pilot_live',
    to: 'production_preparation',
    requires: [],
    minMode: 'production_product',
    meaning: 'Getting it fit to be depended on.',
  },
  {
    from: 'production_preparation',
    to: 'production_live',
    requires: [
      'security_scan_clean',
      'dependency_scan_clean',
      'backup_restore_tested',
      'uptime_check_configured',
      'incident_process_recorded',
      'domain_ssl_verified',
      'handoff_documentation_written',
    ],
    protected: true,
    minMode: 'production_product',
    meaning: 'It is a product now. Someone is accountable for it staying up.',
  },
  {
    from: 'production_live',
    to: 'maintenance',
    requires: [],
    meaning: 'Live and being looked after.',
  },
];

export interface TransitionRequest {
  from: ProjectState;
  to: ProjectState;
  targetMode: TargetMode;
  evidence: Evidence[];
  /**
   * A person with authority accepted the risk. Only ever consulted for
   * protected transitions, and recorded on the result either way.
   */
  approval?: { by: string; note: string };
}

export type TransitionResult =
  | { allowed: true; transition: Transition; satisfied: string[] }
  | {
      allowed: false;
      /** Plain language, ready to show. */
      reason: string;
      missing: string[];
      /** True when only a sign-off is missing, not evidence. */
      needsApproval: boolean;
    };

const MODE_ORDER: TargetMode[] = [
  'ui_concept',
  'functional_prototype',
  'customer_pilot',
  'production_product',
];

/** Can the project move? If not, exactly what is in the way. */
export function requestTransition(request: TransitionRequest): TransitionResult {
  const transition = TRANSITIONS.find((t) => t.from === request.from && t.to === request.to);
  if (!transition) {
    return {
      allowed: false,
      reason: `There is no step from "${request.from}" to "${request.to}".`,
      missing: [],
      needsApproval: false,
    };
  }

  if (
    transition.minMode &&
    MODE_ORDER.indexOf(request.targetMode) < MODE_ORDER.indexOf(transition.minMode)
  ) {
    return {
      allowed: false,
      reason:
        'This step only applies to projects going further than this one is. Change what you are aiming for first, and the checks will be recalculated.',
      missing: [],
      needsApproval: false,
    };
  }

  const passed = new Set<string>();
  for (const item of request.evidence) {
    if (item.status === 'passed') passed.add(item.gateId);
    else passed.delete(item.gateId);
  }

  const missing = transition.requires.filter((gate) => !passed.has(gate));
  if (missing.length > 0) {
    return {
      allowed: false,
      reason: transition.protected
        ? 'This is the step that puts your product in front of people, so it cannot be taken on trust. Some checks have not passed yet.'
        : 'Some of the checks this step depends on have not passed yet.',
      missing,
      needsApproval: false,
    };
  }

  // Every check passed, but the step is one that exposes real users. Someone
  // has to say so out loud.
  if (transition.protected && !request.approval) {
    return {
      allowed: false,
      reason:
        'Every check has passed. This step needs someone to sign it off before it happens, because it is the point where real people are affected.',
      missing: [],
      needsApproval: true,
    };
  }

  return { allowed: true, transition, satisfied: transition.requires };
}

/** Where could this project go from here, given what it is aiming at? */
export function availableTransitions(
  from: ProjectState,
  targetMode: TargetMode,
): Transition[] {
  return TRANSITIONS.filter(
    (t) =>
      t.from === from &&
      (!t.minMode || MODE_ORDER.indexOf(targetMode) >= MODE_ORDER.indexOf(t.minMode)),
  );
}

/**
 * Fall back to an earlier state because something broke.
 *
 * Separate from `requestTransition` on purpose. Going forwards needs evidence;
 * going backwards needs only a reason, and refusing to record it would leave a
 * project that is down still claiming to be live.
 */
export function regress(
  from: ProjectState,
  to: ProjectState,
  reason: string,
): { from: ProjectState; to: ProjectState; reason: string; regression: true } {
  return { from, to, reason, regression: true };
}
