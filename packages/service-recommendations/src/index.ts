import { randomUUID } from 'node:crypto';

import type {
  Incident,
  ProjectIntent,
  RuleOutcome,
  SecurityFinding,
  ServiceOffer,
  ServiceRecommendation,
} from '@shipyard/shared';

/**
 * When to offer paid help, and when to shut up.
 *
 * The rule this whole module exists to obey: a recommendation must be caused by
 * something that is actually true about the project right now. An offer that
 * fires on a timer, or on a mode the user picked, or on nothing at all, is an
 * advert — and one advert teaches the user to ignore every future one,
 * including the one that would have saved their launch.
 *
 * So every recommendation carries the evidence that produced it, and there is a
 * test asserting a healthy project is offered nothing.
 */

export interface RecommendationInput {
  projectId: string;
  intent: ProjectIntent;
  /** Rule outcomes from the rulebook. Only unsatisfied ones can trigger. */
  outcomes: RuleOutcome[];
  /** Service triggers the capability resolver produced. */
  capabilityTriggers?: string[];
  incidents?: Incident[];
  securityFindings?: SecurityFinding[];
  /** Consecutive failed deployments. Two is a pattern, not bad luck. */
  failedDeployments?: number;
  /** How far off the launch date is, in days. Negative is overdue. */
  daysToLaunch?: number;
  readinessScore?: number;
  readinessThreshold?: number;
  /** Ids the user has already declined, so we do not ask twice. */
  declined?: string[];
  /** Ids the user snoozed, with when they may be asked again. */
  snoozedUntil?: Record<string, string>;
}

interface Trigger {
  serviceId: string;
  reason: string;
  evidence: string[];
}

/**
 * Work out what is worth offering.
 *
 * Each branch reads as "this specific thing is true, therefore this specific
 * help is useful". If you cannot write that sentence for a trigger, it does not
 * belong here.
 */
function triggersFor(input: RecommendationInput): Trigger[] {
  const triggers: Trigger[] = [];
  const open = input.outcomes.filter((o) => o.applies && !o.satisfied);

  // A rule that names a service and is not satisfied. The rulebook already did
  // the thinking; this turns it into an offer with the rule as its evidence.
  for (const outcome of open) {
    for (const serviceId of outcome.serviceTriggers) {
      triggers.push({
        serviceId,
        reason: outcome.message,
        evidence: [outcome.ruleId, ...outcome.missingGates],
      });
    }
  }

  // Capability triggers only count when the capability is genuinely incomplete,
  // which the rulebook is the judge of. Offering a payment review to a project
  // whose payment checks all pass is the advert case.
  const unmetGates = new Set(open.flatMap((o) => o.missingGates));
  for (const serviceId of input.capabilityTriggers ?? []) {
    if (!triggers.some((t) => t.serviceId === serviceId) && unmetGates.size > 0) {
      triggers.push({
        serviceId,
        reason: 'Part of what this project needs is not finished yet.',
        evidence: [...unmetGates].slice(0, 4),
      });
    }
  }

  // A problem that has survived two attempts. The third attempt usually costs
  // more than the hour a person would spend.
  for (const incident of input.incidents ?? []) {
    if (incident.fixAttempts >= 2 && incident.fixStatus !== 'fixed') {
      triggers.push({
        serviceId: 'fix_sprint',
        reason: `"${incident.title}" has come back after two attempts to fix it. That usually means the cause is somewhere other than where it appears.`,
        evidence: [incident.id],
      });
    }
    if (incident.severity === 'S0' && incident.fixStatus !== 'fixed') {
      triggers.push({
        serviceId: 'fix_sprint',
        reason: 'Something is broken for real users right now.',
        evidence: [incident.id],
      });
    }
  }

  const highRisk = (input.securityFindings ?? []).filter(
    (f) => f.status === 'open' && (f.severity === 'critical' || f.severity === 'high'),
  );
  if (highRisk.length > 0) {
    triggers.push({
      serviceId: 'security_privacy_review',
      reason: `The security checks found ${highRisk.length} thing${highRisk.length === 1 ? '' : 's'} worth a person's attention before launch.`,
      evidence: highRisk.map((f) => f.id).slice(0, 4),
    });
  }

  if ((input.failedDeployments ?? 0) >= 2) {
    triggers.push({
      serviceId: 'fix_sprint',
      reason: 'Deploying has failed more than once. That is usually configuration rather than code, and it is quick for someone who has seen it before.',
      evidence: [`failed_deployments=${input.failedDeployments ?? 0}`],
    });
  }

  // A launch date inside two weeks with the score below the bar. Said now, while
  // there is still time to do something about it.
  const short = input.daysToLaunch !== undefined && input.daysToLaunch <= 14;
  const below =
    input.readinessScore !== undefined &&
    input.readinessThreshold !== undefined &&
    input.readinessScore < input.readinessThreshold;
  if (short && below) {
    triggers.push({
      serviceId: 'launch_readiness_audit',
      reason: `You are aiming to launch in ${input.daysToLaunch} days and the project is at ${input.readinessScore} against a bar of ${input.readinessThreshold}. Worth knowing now which of the gaps actually matter.`,
      evidence: [`days_to_launch=${input.daysToLaunch ?? 0}`, `score=${input.readinessScore ?? 0}`],
    });
  }

  return triggers;
}

/**
 * Recommendations for this project, right now.
 *
 * Deduplicated by service, keeping the first reason — which is the most specific
 * one, because rule-driven triggers come first. Declined and snoozed offers are
 * dropped: a user who said no has said no.
 */
export function recommend(
  input: RecommendationInput,
  catalog: ServiceOffer[],
  now = new Date().toISOString(),
): ServiceRecommendation[] {
  const declined = new Set(input.declined ?? []);
  const byService = new Map<string, Trigger>();

  for (const trigger of triggersFor(input)) {
    if (declined.has(trigger.serviceId)) continue;
    const until = input.snoozedUntil?.[trigger.serviceId];
    if (until && until > now) continue;
    if (!byService.has(trigger.serviceId)) byService.set(trigger.serviceId, trigger);
  }

  return [...byService.values()]
    .filter((t) => catalog.some((s) => s.id === t.serviceId && s.enabled))
    .sort((a, b) => a.serviceId.localeCompare(b.serviceId))
    .map((trigger) => ({
      id: randomUUID(),
      projectId: input.projectId,
      serviceId: trigger.serviceId,
      reason: trigger.reason,
      evidence: trigger.evidence,
      status: 'offered' as const,
      offeredAt: now,
    }));
}

/** What the user is shown: the offer, why, what it costs, and the free path. */
export interface PresentedOffer {
  recommendation: ServiceRecommendation;
  offer: ServiceOffer;
  price: string;
  /** Always shown. An offer that hides the free path is an advert. */
  insteadYouCould: string;
}

export function present(
  recommendations: ServiceRecommendation[],
  catalog: ServiceOffer[],
): PresentedOffer[] {
  return recommendations.flatMap((recommendation) => {
    const offer = catalog.find((s) => s.id === recommendation.serviceId);
    if (!offer) return [];
    return [
      {
        recommendation,
        offer,
        price: priceLabel(offer),
        insteadYouCould: offer.selfServiceAlternative,
      },
    ];
  });
}

function priceLabel(offer: ServiceOffer): string {
  const unit = offer.priceUnit === 'month' ? ' a month' : '';
  if (offer.priceMin === 0 && offer.priceMax === 0) return 'Free';
  if (offer.priceMin === offer.priceMax) return `$${offer.priceMin}${unit}`;
  return `$${offer.priceMin}–$${offer.priceMax}${unit}`;
}

/**
 * Record what the user decided.
 *
 * Snoozing is not declining and declining is not hiding: the underlying problem
 * stays in the readiness score either way. The plan is explicit that a high-risk
 * item cannot be dismissed out of the score, and this is where that is honoured
 * — this function changes the offer, never the finding.
 */
export function respond(
  recommendation: ServiceRecommendation,
  decision: 'accepted' | 'snoozed' | 'declined',
): ServiceRecommendation {
  return { ...recommendation, status: decision };
}

/** When a snoozed offer may be raised again. */
export function snoozeUntil(days = 7, from = new Date()): string {
  return new Date(from.getTime() + days * 86_400_000).toISOString();
}
