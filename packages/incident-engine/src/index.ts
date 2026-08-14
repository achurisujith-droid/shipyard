import { randomUUID } from 'node:crypto';

import { redacted, redactEnv } from '@shipyard/security';
import type {
  EscalationPacket,
  FixAttempt,
  FixRisk,
  GateResult,
  Incident,
  ProjectIntent,
  RuleOutcome,
  TargetMode,
} from '@shipyard/shared';

/**
 * What happens when the thing breaks out in the world.
 *
 * The loop is deliberately controlled rather than autonomous: detect, correlate,
 * reproduce, compose a task, ask the user, let the agent try, verify
 * independently, and hand to a person when it has failed twice or when the area
 * is one where a wrong guess is expensive.
 *
 * Nothing here sends anything. It prepares work and returns it; the user presses
 * send, which is the same rule the rest of Shipyard follows.
 */

/** A raw error from Sentry, an app, or a deployment, before we understand it. */
export interface RawEvent {
  source: Incident['source'];
  environment: Incident['environment'];
  title: string;
  message?: string;
  stack?: string;
  route?: string;
  release?: string;
  commitSha?: string;
  occurredAt?: string;
  /** A link back to where it came from. Never the raw payload. */
  ref?: string;
}

/**
 * How bad is it?
 *
 * The scale is about consequence, not about how alarming the stack trace looks.
 * Anything touching money, personal data or the whole site is S0 whatever it
 * says, because those are the ones where waiting costs more than being wrong.
 */
const S0_RE =
  /\b(payment|billing|charge|refund|stripe|subscription|invoice|payout|webhook signature|data (?:leak|exposure|breach)|unauthori[sz]ed|500|outage)\b|\b(?:cannot connect|connection (?:failed|refused)|ECONNREFUSED)\b/i;
const S1_RE = /\b(sign[- ]?in|log[- ]?in|auth|register|sign[- ]?up|checkout|cannot find module|failed to compile)\b/i;
const S3_RE = /\b(warning|deprecat|hydration|favicon|console\.log)\b/i;

export function severityOf(event: RawEvent): Incident['severity'] {
  const text = `${event.title} ${event.message ?? ''} ${event.route ?? ''}`;
  if (event.environment === 'production' && S0_RE.test(text)) return 'S0';
  if (S0_RE.test(text)) return 'S1';
  if (S1_RE.test(text)) return event.environment === 'production' ? 'S1' : 'S2';
  if (S3_RE.test(text)) return 'S3';
  return 'S2';
}

/**
 * Turn a raw event into an incident.
 *
 * Everything free-text goes through redaction on the way in. An error message
 * frequently contains the connection string that failed, and this record is
 * headed for a developer's screen.
 */
export function normalise(
  event: RawEvent,
  projectId: string,
  options: { componentPaths?: Record<string, string[]> } = {},
): Incident {
  return {
    id: randomUUID(),
    projectId,
    source: event.source,
    environment: event.environment,
    severity: severityOf(event),
    title: redacted(event.title).slice(0, 200),
    firstSeenAt: event.occurredAt ?? new Date().toISOString(),
    ...(event.release ? { release: event.release } : {}),
    ...(event.commitSha ? { commitSha: event.commitSha } : {}),
    ...(event.route ? { affectedRoute: event.route } : {}),
    ...(correlateComponent(event, options.componentPaths) ?? {}),
    ...(event.ref ? { rawEventRef: event.ref } : {}),
    reproductionStatus: 'pending',
    fixStatus: 'not_started',
    fixAttempts: 0,
  };
}

/**
 * Which verified component is this in?
 *
 * Matters because a failure inside a component we shipped is our bug, not the
 * founder's, and because a fix there needs the contract tests run afterwards.
 */
function correlateComponent(
  event: RawEvent,
  componentPaths?: Record<string, string[]>,
): { componentId: string } | null {
  if (!componentPaths) return null;
  const haystack = `${event.route ?? ''} ${event.stack ?? ''}`;
  for (const [componentId, paths] of Object.entries(componentPaths)) {
    if (paths.some((p) => haystack.includes(p.replace(/\/\*\*$/, '')))) return { componentId };
  }
  return null;
}

/**
 * How much freedom does the agent get on this one?
 *
 * The bottom two never reach the agent without a person, whatever the founder
 * would prefer. A wrong guess about a webhook signature is not a bug, it is a
 * chargeback.
 */
export function riskOf(incident: Incident): FixRisk {
  if (/\b(payment|billing|charge|refund|webhook signature)\b/i.test(incident.title)) {
    return 'mandatory_human';
  }
  if (/\b(auth|permission|unauthori[sz]ed|data (?:leak|exposure))\b/i.test(incident.title)) {
    return 'mandatory_human';
  }
  if (incident.severity === 'S0') return 'critical_outage';
  if (incident.componentId) return 'high';
  if (incident.severity === 'S1') return 'moderate';
  if (incident.severity === 'S3') return 'informational';
  return 'low';
}

/** What Shipyard does about it, given the risk. */
export function actionFor(risk: FixRisk): {
  agentMayAttempt: boolean;
  requiresApprovalBeforeMerge: boolean;
  requiresDeveloper: boolean;
  explanation: string;
} {
  switch (risk) {
    case 'informational':
      return {
        agentMayAttempt: false,
        requiresApprovalBeforeMerge: false,
        requiresDeveloper: false,
        explanation: 'Worth knowing about. Nothing is broken for your users.',
      };
    case 'low':
      return {
        agentMayAttempt: true,
        requiresApprovalBeforeMerge: false,
        requiresDeveloper: false,
        explanation: 'Claude can try this one. You will see the change before it is kept.',
      };
    case 'moderate':
      return {
        agentMayAttempt: true,
        requiresApprovalBeforeMerge: true,
        requiresDeveloper: false,
        explanation: 'Claude can try this, and every check has to pass before the change is kept.',
      };
    case 'high':
      return {
        agentMayAttempt: true,
        requiresApprovalBeforeMerge: true,
        requiresDeveloper: true,
        explanation:
          'This is in a part we built and verified. Claude can propose a fix, and a developer should read it.',
      };
    case 'critical_outage':
      return {
        agentMayAttempt: false,
        requiresApprovalBeforeMerge: true,
        requiresDeveloper: true,
        explanation:
          'Your app is down for real people. The fastest safe move is to go back to the last working version, not to try a fix on the live site.',
      };
    case 'mandatory_human':
      return {
        agentMayAttempt: false,
        requiresApprovalBeforeMerge: true,
        requiresDeveloper: true,
        explanation:
          'This touches money, sign-in or personal data. A person has to look at it — a wrong guess here costs more than the wait.',
      };
  }
}

/** The task the agent is asked to do, ready for the user to send. */
export interface FixTask {
  incidentId: string;
  risk: FixRisk;
  /** The prompt. Never sent automatically. */
  message: string;
  /** Files worth opening first. */
  context: string[];
  /** What has to be true for the fix to count. */
  acceptanceCriteria: string[];
  /** Gates to run afterwards, before the change is kept. */
  gates: string[];
  /** Shown next to the send button, when the risk warrants it. */
  warning?: string;
}

/**
 * Compose the fix task.
 *
 * Written as an instruction to reproduce first and fix second. An agent that
 * starts editing before it can make the failure happen is guessing, and a guess
 * that makes the symptom disappear is how a bug comes back a week later.
 */
export function composeFixTask(
  incident: Incident,
  options: {
    failedGates?: GateResult[];
    componentPaths?: string[];
    contractGates?: string[];
  } = {},
): FixTask {
  const risk = riskOf(incident);
  const action = actionFor(risk);
  const failed = options.failedGates ?? [];

  const lines = [
    `Something is failing in the running app and I need it fixed.`,
    ``,
    `What happened: ${incident.title}`,
    incident.affectedRoute ? `Where: ${incident.affectedRoute}` : '',
    incident.release ? `Version: ${incident.release}` : '',
    incident.environment !== 'local' ? `This is happening in ${incident.environment}.` : '',
    ``,
    `Please reproduce it before changing anything. Write a test that fails for this`,
    `reason, then make that test pass. If you cannot reproduce it, say so rather`,
    `than guessing — a change that makes the symptom disappear without explaining`,
    `it will bring the problem back later.`,
  ];

  if (failed.length > 0) {
    lines.push('', 'These checks are currently failing:');
    for (const gate of failed) {
      lines.push(`  - ${gate.gateId}: ${gate.failureSummary ?? 'failed'}`);
      if (gate.output) lines.push(`    ${gate.output.split('\n').slice(-6).join('\n    ')}`);
    }
  }

  if (incident.componentId) {
    lines.push(
      '',
      `This appears to be inside ${incident.componentId}, which is a verified component.`,
      `Do not rewrite its internals. Use its documented interface, and if the fault is`,
      `genuinely inside it, say so instead of working around it.`,
    );
  }

  if (incident.fixAttempts > 0) {
    lines.push(
      '',
      `This is attempt ${incident.fixAttempts + 1}. The previous attempt did not hold, so the`,
      `cause is probably not where it appears to be. Widen the search before editing.`,
    );
  }

  return {
    incidentId: incident.id,
    risk,
    message: redacted(lines.filter((l) => l !== '').join('\n')),
    context: options.componentPaths ?? [],
    acceptanceCriteria: [
      'A test exists that fails for this reason before the fix and passes after it.',
      ...(incident.componentId ? ['The component contract tests still pass.'] : []),
      'No other check that was passing has started failing.',
    ],
    gates: [
      'build_passes',
      'unit_tests_pass',
      ...failed.map((g) => g.gateId),
      ...(options.contractGates ?? []),
    ].filter((g, i, all) => all.indexOf(g) === i),
    ...(action.requiresDeveloper ? { warning: action.explanation } : {}),
  };
}

/** Record that an attempt was made, and decide what happens next. */
export function recordAttempt(
  incident: Incident,
  outcome: 'verified' | 'failed',
  verificationRunId?: string,
): { incident: Incident; attempt: FixAttempt; escalate: boolean } {
  const attempts = incident.fixAttempts + 1;
  // Two is the line the plan draws, and it is the right one: a third attempt on
  // the same fault usually costs more than the hour a person would spend.
  const escalate = outcome === 'failed' && attempts >= 2;

  return {
    incident: {
      ...incident,
      fixAttempts: attempts,
      fixStatus: outcome === 'verified' ? 'fixed' : escalate ? 'escalated' : 'in_progress',
    },
    attempt: {
      id: randomUUID(),
      incidentId: incident.id,
      projectId: incident.projectId,
      startedAt: new Date().toISOString(),
      risk: riskOf(incident),
      status: outcome,
      ...(verificationRunId ? { verificationRunId } : {}),
    },
    escalate,
  };
}

/**
 * Everything a developer needs, so they start from context rather than a blank
 * ticket.
 *
 * The test for this packet is whether someone who has never seen the project can
 * begin work without asking a question. Every field exists because its absence
 * would produce one.
 */
export function buildEscalationPacket(input: {
  projectId: string;
  projectSummary: string;
  intent: ProjectIntent;
  currentState: string;
  readinessScore: number;
  blockers: RuleOutcome[];
  capabilities: string[];
  incident?: Incident;
  failedGates?: GateResult[];
  fixAttempts?: FixAttempt[];
  reproduction?: string[];
  env?: Record<string, string | undefined>;
  serviceRecommendationId?: string;
}): EscalationPacket {
  const severity: EscalationPacket['severity'] = input.incident?.severity ?? 'S2';

  return {
    id: randomUUID(),
    projectId: input.projectId,
    ...(input.incident ? { incidentId: input.incident.id } : {}),
    ...(input.serviceRecommendationId
      ? { serviceRecommendationId: input.serviceRecommendationId }
      : {}),
    severity,
    createdAt: new Date().toISOString(),
    status: 'open',
    packet: {
      projectSummary: redacted(input.projectSummary),
      targetMode: input.intent.targetMode,
      currentState: input.currentState,
      readinessScore: input.readinessScore,
      blockers: input.blockers.map((b) => `${b.ruleId}: ${b.message}`),
      rules: input.blockers.map((b) => b.ruleId),
      capabilities: input.capabilities,
      reproduction: (input.reproduction ?? []).map(redacted),
      failedGates: (input.failedGates ?? []).map((g) => ({
        ...g,
        ...(g.output ? { output: redacted(g.output) } : {}),
        ...(g.failureSummary ? { failureSummary: redacted(g.failureSummary) } : {}),
      })),
      fixAttempts: (input.fixAttempts ?? []).map(
        (a) => `${a.startedAt} ${a.status}${a.taskSummary ? `: ${redacted(a.taskSummary)}` : ''}`,
      ),
      // Redacted, always. This is the field most likely to carry a live key and
      // the one most likely to be pasted into a chat window.
      environment: redactEnv(input.env ?? {}),
      acceptanceCriteria: acceptanceFor(severity, input.intent.targetMode),
      turnaroundTarget: turnaroundFor(severity),
    },
  };
}

function acceptanceFor(severity: EscalationPacket['severity'], mode: TargetMode): string[] {
  const base = [
    'The failing check passes, and nothing that was passing has started failing.',
    'A test exists that would catch this happening again.',
  ];
  if (severity === 'S0') {
    return [
      'The immediate harm has stopped — rolled back or the feature disabled.',
      ...base,
      'A short note on what happened, for the founder to read.',
    ];
  }
  if (mode === 'production_product') {
    return [...base, 'The change is reviewed by a second person before it goes live.'];
  }
  return base;
}

function turnaroundFor(severity: EscalationPacket['severity']): string {
  switch (severity) {
    case 'S0':
      return 'Immediately. Contain first, diagnose second.';
    case 'S1':
      return 'Same working day.';
    case 'S2':
      return 'Within two working days.';
    case 'S3':
      return 'Whenever it next makes sense.';
  }
}
