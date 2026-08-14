import type { Evidence, GateStatus, ProjectIntent, TargetMode } from './production';

/**
 * The things Shipyard remembers about a project.
 *
 * All of it is local. None of it leaves the machine, and none of it is a
 * credential — the one rule that matters most here is that a record written for
 * a developer to read must never be the thing that leaks a secret, which is why
 * every free-text field that could carry one goes through redaction first.
 */

/** A check Shipyard can run, and what it proves. */
export interface GateDefinition {
  id: string;
  /** What the user reads when it fails. Never the id. */
  label: string;
  /**
   * How it runs. `command` shells out in the project; `manual` is something a
   * person confirms; `external` is proved by something outside the project,
   * like an error arriving in Sentry.
   */
  kind: 'command' | 'manual' | 'external';
  /** For `command` gates: what to run, in the project directory. */
  command?: string;
  /** Only run this gate when the project actually has one of these. */
  requiresCapability?: string[];
  /** Roughly how long, so a slow gate can warn before it starts. */
  expect?: 'fast' | 'slow';
}

export interface GateResult {
  gateId: string;
  status: GateStatus;
  durationMs: number;
  /** One line, already trimmed and redacted. Shown on the card. */
  failureSummary?: string;
  /** The tail of the output, redacted. Shown on expand and sent to Claude. */
  output?: string;
}

export interface VerificationRun {
  id: string;
  projectId: string;
  /** What caused this run. */
  trigger: 'manual' | 'readiness_check' | 'after_fix' | 'after_install';
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'passed' | 'failed' | 'cancelled';
  gates: GateResult[];
}

/** Something went wrong in the running app, out in the world. */
export interface Incident {
  id: string;
  projectId: string;
  source: 'sentry' | 'app' | 'deployment' | 'synthetic';
  environment: 'local' | 'preview' | 'production';
  severity: 'S0' | 'S1' | 'S2' | 'S3';
  title: string;
  firstSeenAt: string;
  release?: string;
  commitSha?: string;
  affectedRoute?: string;
  /** The component we believe it is in, when a protected path matches. */
  componentId?: string;
  /** Link back to where it came from. Never the raw payload. */
  rawEventRef?: string;
  reproductionStatus: 'pending' | 'reproduced' | 'not_reproducible';
  fixStatus: 'not_started' | 'in_progress' | 'fixed' | 'escalated';
  /** Two failed attempts is the point where more attempts cost more than a person. */
  fixAttempts: number;
}

/**
 * How much freedom the agent gets on a fix.
 *
 * The plan is explicit that this is a controlled loop, not unrestricted
 * autofixing. The bottom two rows never reach the agent without a person.
 */
export type FixRisk =
  | 'informational'
  | 'low'
  | 'moderate'
  | 'high'
  | 'critical_outage'
  | 'mandatory_human';

export interface FixAttempt {
  id: string;
  incidentId: string;
  projectId: string;
  startedAt: string;
  risk: FixRisk;
  status: 'proposed' | 'sent' | 'verified' | 'failed';
  /** The verification run that judged it. */
  verificationRunId?: string;
  /** What was asked of the agent, kept so a developer can see what was tried. */
  taskSummary?: string;
}

export interface ServiceRecommendation {
  id: string;
  projectId: string;
  serviceId: string;
  /** Why now, in the user's terms. */
  reason: string;
  /** Rule ids, gate ids or incident ids that justify it. */
  evidence: string[];
  status: 'offered' | 'accepted' | 'snoozed' | 'declined';
  offeredAt: string;
}

export interface EscalationPacket {
  id: string;
  projectId: string;
  incidentId?: string;
  serviceRecommendationId?: string;
  severity: Incident['severity'];
  createdAt: string;
  status: 'open' | 'in_progress' | 'resolved' | 'cancelled';
  /** The whole context a developer needs, already redacted. */
  packet: {
    projectSummary: string;
    targetMode: TargetMode;
    currentState: string;
    readinessScore: number;
    blockers: string[];
    rules: string[];
    capabilities: string[];
    reproduction: string[];
    failedGates: GateResult[];
    fixAttempts: string[];
    environment: Record<string, string>;
    acceptanceCriteria: string[];
    turnaroundTarget: string;
  };
}

export interface SecurityFinding {
  id: string;
  projectId: string;
  type: 'secret' | 'dependency' | 'license' | 'lifecycle_script' | 'agent_config';
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** What and where, with the secret itself never included. */
  summary: string;
  location?: string;
  status: 'open' | 'accepted' | 'fixed';
  foundAt: string;
}

/**
 * What Shipyard measures about itself.
 *
 * Not feature usage. The question this exists to answer is whether the library
 * is reducing human delivery hours, because if it is not, Shipyard is an agency
 * with extra steps.
 */
export interface TelemetryEvent {
  id: string;
  projectId?: string;
  type: string;
  at: string;
  /** Numbers and ids only. Never project content, never user text. */
  payload: Record<string, string | number | boolean>;
}

/** Everything persisted about one project's intent and progress. */
export interface ProjectMetadata {
  projectId: string;
  intent?: ProjectIntent;
  state: string;
  capabilities: string[];
  evidence: Evidence[];
  readinessScore?: number;
  updatedAt: string;
}
