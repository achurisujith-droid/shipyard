import {
  modeAtLeast,
  type Evidence,
  type IntentFlag,
  type ProjectIntent,
  type Rule,
  type RuleOutcome,
} from '@shipyard/shared';

/**
 * Everything the evaluator is allowed to look at.
 *
 * Deliberately closed. If a rule could consult the model, or the agent's own
 * account of what it did, the answer would stop being reproducible — and
 * "reproducible" is the whole reason this layer exists rather than asking
 * Claude whether the project is ready.
 */
export interface ProjectFacts {
  intent: ProjectIntent;
  /** Capability IDs the resolver decided this project has. */
  capabilities: string[];
  /** Everything observed so far, newest wins when a gate repeats. */
  evidence: Evidence[];
}

/** Latest observation per gate. Evidence is append-only; this collapses it. */
export function latestEvidence(evidence: Evidence[]): Map<string, Evidence> {
  const latest = new Map<string, Evidence>();
  for (const item of evidence) {
    const current = latest.get(item.gateId);
    if (!current || item.observedAt >= current.observedAt) latest.set(item.gateId, item);
  }
  return latest;
}

function flagValue(intent: ProjectIntent, flag: IntentFlag): boolean {
  return intent[flag];
}

/** Does this rule apply to this project at all? */
export function ruleApplies(rule: Rule, facts: ProjectFacts): boolean {
  const { when } = rule;
  const { intent } = facts;

  if (when.minMode && !modeAtLeast(intent.targetMode, when.minMode)) return false;
  if (when.modeIn && !when.modeIn.includes(intent.targetMode)) return false;
  if (when.factsTrue?.some((flag) => !flagValue(intent, flag))) return false;
  if (when.factsFalse?.some((flag) => flagValue(intent, flag))) return false;
  if (when.capabilities?.some((cap) => !facts.capabilities.includes(cap))) return false;

  return true;
}

/**
 * Evaluate one rule.
 *
 * A gate with no evidence and a gate whose evidence says `failed` are both
 * "missing". They are different problems for the user — one is unrun, one is
 * broken — but neither is a reason to let a launch through, and conflating them
 * here keeps `satisfied` meaning exactly one thing.
 */
export function evaluateRule(rule: Rule, facts: ProjectFacts): RuleOutcome {
  const applies = ruleApplies(rule, facts);
  const requiredGates = rule.require.gates ?? [];
  const latest = latestEvidence(facts.evidence);

  const missingGates = applies
    ? requiredGates.filter((gateId) => latest.get(gateId)?.status !== 'passed')
    : [];

  return {
    ruleId: rule.id,
    ruleVersion: rule.version,
    category: rule.category,
    severity: rule.severity,
    message: rule.message,
    applies,
    satisfied: applies ? missingGates.length === 0 : true,
    requiredGates,
    missingGates,
    requiredComponents: rule.require.components ?? [],
    humanReviewRequired: applies ? (rule.require.humanReview ?? false) : false,
    // Only offer to sell help for something that is actually wrong. A service
    // recommendation attached to a satisfied rule is an advert.
    serviceTriggers:
      applies && missingGates.length > 0 ? (rule.require.serviceTriggers ?? []) : [],
  };
}

/** Evaluate the whole rulebook, in catalog order so output is stable. */
export function evaluate(rules: Rule[], facts: ProjectFacts): RuleOutcome[] {
  return rules.map((rule) => evaluateRule(rule, facts));
}

/** Every gate this project is obliged to pass, deduplicated. */
export function requiredGates(rules: Rule[], facts: ProjectFacts): string[] {
  const gates = new Set<string>();
  for (const rule of rules) {
    if (!ruleApplies(rule, facts)) continue;
    for (const gate of rule.require.gates ?? []) gates.add(gate);
  }
  return [...gates].sort();
}

/** Components the rules oblige this project to install. */
export function requiredComponents(rules: Rule[], facts: ProjectFacts): string[] {
  const components = new Set<string>();
  for (const rule of rules) {
    if (!ruleApplies(rule, facts)) continue;
    for (const component of rule.require.components ?? []) components.add(component);
  }
  return [...components].sort();
}

/**
 * The unsatisfied outcomes, worst first.
 *
 * What the user is shown. Blockers before warnings before recommendations, and
 * within a severity, the rule with the most missing evidence first — that is
 * usually the one whose absence explains the others.
 */
export function openFindings(outcomes: RuleOutcome[]): RuleOutcome[] {
  const rank = { blocker: 0, warning: 1, recommendation: 2 } as const;
  return outcomes
    .filter((outcome) => outcome.applies && !outcome.satisfied)
    .sort(
      (a, b) =>
        rank[a.severity] - rank[b.severity] ||
        b.missingGates.length - a.missingGates.length ||
        a.ruleId.localeCompare(b.ruleId),
    );
}

/** Does anything stand between this project and its chosen mode? */
export function hasBlockers(outcomes: RuleOutcome[]): boolean {
  return outcomes.some((o) => o.applies && !o.satisfied && o.severity === 'blocker');
}

/**
 * Explain one finding in the user's terms.
 *
 * The rule's own message says what is at stake for their product. This adds
 * what is actually missing, without turning it into a list of test names: a
 * founder who reads "rbac_permission_tests" learns nothing.
 */
export function explain(outcome: RuleOutcome, gateLabels: Record<string, string> = {}): string {
  if (outcome.satisfied) return outcome.message;
  const missing = outcome.missingGates.map((gate) => gateLabels[gate] ?? gate);
  if (missing.length === 0) return outcome.message;
  const list =
    missing.length === 1
      ? missing[0]
      : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`;
  return `${outcome.message} Still missing: ${list}.`;
}
