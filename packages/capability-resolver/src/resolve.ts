import {
  modeAtLeast,
  type Capability,
  type CapabilityPlan,
  type ProjectIntent,
  type ResolvedCapability,
  type TargetMode,
  type Vendor,
} from '@shipyard/shared';

/**
 * Turn what the founder said into what has to exist.
 *
 * Deterministic and explainable. Given the same intent and the same catalog it
 * returns the same plan every time, and every line of that plan can say why it
 * is there — which is the difference between a plan a founder can argue with
 * and a list they have to take on faith.
 */

const MODE_LABEL: Record<TargetMode, string> = {
  ui_concept: 'something to look at',
  functional_prototype: 'a working prototype',
  customer_pilot: 'a pilot with real people',
  production_product: 'a product people pay for',
};

const FLAG_REASON: Record<string, string> = {
  sensitiveData: 'you said this holds information people would mind losing',
  payments: 'you said money changes hands inside it',
  aiAffectsConsequentialDecision:
    'you said this decides something that changes a person’s life',
  humanReviewRequired: 'you said a person reviews the important decisions',
  publicFacing: 'you said anyone on the internet can reach it',
};

/** Pick the vendor: the first enabled one the capability names, best first. */
function chooseVendor(capability: Capability, vendors: Vendor[]): Vendor | undefined {
  for (const id of capability.vendors ?? []) {
    const vendor = vendors.find((v) => v.id === id && v.enabled);
    if (vendor) return vendor;
  }
  return undefined;
}

/** Which facts about this project pulled a capability in? */
function triggeringFlags(capability: Capability, intent: ProjectIntent): string[] {
  return (capability.triggeredBy ?? []).filter((flag) => intent[flag]);
}

function resolveOne(
  capability: Capability,
  intent: ProjectIntent,
  vendors: Vendor[],
): ResolvedCapability {
  const vendor = chooseVendor(capability, vendors);
  const base = {
    capability,
    gates: capability.gates ?? [],
    components: capability.components ?? [],
    recipes: capability.recipes ?? [],
    ...(vendor ? { vendor: vendor.id } : {}),
  };

  // Said before development starts. Finding out at launch is the expensive way.
  if (capability.supported === false) {
    return {
      ...base,
      status: 'unsupported',
      gates: [],
      components: [],
      recipes: [],
      reason: capability.insteadUse
        ? `Shipyard cannot build this yet. ${capability.insteadUse}`
        : 'Shipyard cannot build this yet, so it is not in the plan.',
    };
  }

  const flags = triggeringFlags(capability, intent);
  const byMode = capability.requiredFrom && modeAtLeast(intent.targetMode, capability.requiredFrom);
  const needsReview = (capability.humanReviewWhen ?? []).some((flag) => intent[flag]);

  if (flags.length > 0 || byMode) {
    const why = flags.length
      ? (FLAG_REASON[flags[0] as string] ?? 'of what you told us about the project')
      : `you are building ${MODE_LABEL[intent.targetMode]}`;

    if (needsReview) {
      return {
        ...base,
        status: 'requires_human_review',
        reason: `Needed because ${why}. A person has to check how this one is done — a passing test is not enough here.`,
      };
    }
    return { ...base, status: 'included', reason: `Needed because ${why}.` };
  }

  // Not needed yet, but named now rather than sprung on them at pilot.
  if (capability.requiredFrom) {
    return {
      ...base,
      status: 'deferred',
      gates: [],
      components: [],
      recipes: [],
      reason: `Not needed for ${MODE_LABEL[intent.targetMode]}. It becomes necessary at ${MODE_LABEL[capability.requiredFrom]}.`,
    };
  }

  return {
    ...base,
    status: 'optional',
    gates: [],
    components: [],
    recipes: [],
    reason: 'Worth having. Your project works without it.',
  };
}

/** Resolve the whole catalog against one project. */
export function resolve(
  intent: ProjectIntent,
  capabilities: Capability[],
  vendors: Vendor[] = [],
): CapabilityPlan {
  const resolved = capabilities
    .map((capability) => resolveOne(capability, intent, vendors))
    .sort((a, b) => a.capability.id.localeCompare(b.capability.id));

  const active = resolved.filter(
    (r) => r.status === 'included' || r.status === 'requires_human_review',
  );

  const unique = (values: string[]): string[] => [...new Set(values)].sort();

  return {
    resolved,
    included: active,
    deferred: resolved.filter((r) => r.status === 'deferred'),
    unsupported: resolved.filter((r) => r.status === 'unsupported'),
    gates: unique(active.flatMap((r) => r.gates)),
    components: unique(active.flatMap((r) => r.components)),
    recipes: unique(active.flatMap((r) => r.recipes)),
    serviceTriggers: unique(active.flatMap((r) => r.capability.serviceTriggers ?? [])),
  };
}

/**
 * The capability ids a project has, for the rulebook to test against.
 *
 * The rulebook's `when.capabilities` condition needs a flat list; this is the
 * bridge between the two, so a rule can say "if this project takes
 * subscriptions" without knowing how that was decided.
 */
export function capabilityIds(plan: CapabilityPlan): string[] {
  return plan.included.map((r) => r.capability.id);
}

/**
 * Warn before anyone starts building.
 *
 * Returns one plain sentence per thing this project needs that Shipyard cannot
 * do. An empty array means the library covers the project's foundation.
 */
export function scopeWarnings(plan: CapabilityPlan): string[] {
  return plan.unsupported.map((r) => `${r.capability.label}: ${r.reason}`);
}
