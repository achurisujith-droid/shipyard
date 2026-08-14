import type {
  BuildPhase,
  CapabilityPlan,
  ComponentInstallation,
  ProjectIntent,
  RuleOutcome,
  TargetMode,
} from '@shipyard/shared';

/**
 * What a project is, written down where both a person and a machine can read it.
 *
 * `PROJECT.md` already tells the agent what is being built. These are the other
 * half: **`ARCHITECTURE.md`** for a person, and four JSON files for everything
 * else that needs to agree about the same project.
 *
 * The reason for both is that they fail differently. Prose is what a developer
 * picking this up in six months will actually read, and it cannot be checked.
 * JSON can be diffed, validated and compared against what is really installed,
 * and nobody reads it. Writing one and calling it the other is how a project
 * ends up with documentation that is confidently out of date.
 *
 * Everything here is derived. Nothing is written by hand and nothing is
 * remembered — regenerate after any change and the files are correct again,
 * which is the only way documentation stays true.
 */

const CONTRACT_VERSION = 1;

/** The files, and what each one settles. */
export const CONTRACT_FILES = {
  project: 'shipyard.project.json',
  plan: 'shipyard.plan.json',
  rules: 'shipyard.rules.json',
  readiness: 'shipyard.readiness.json',
} as const;

export interface ProjectContract {
  contractVersion: number;
  generatedAt: string;
  projectId: string;
  name: string;
  /** The founder's own words. The most valuable line in the file. */
  idea: string;
  targetMode: TargetMode;
  intent: ProjectIntent;
  stack: {
    framework: string;
    language: string;
    database: string;
    orm: string;
    tests: string;
  };
}

export interface PlanContract {
  contractVersion: number;
  generatedAt: string;
  phases: (BuildPhase & { index: number })[];
  capabilities: {
    id: string;
    label: string;
    status: string;
    reason: string;
    components: string[];
    gates: string[];
  }[];
  /** Named now so they are not a surprise at pilot. */
  deferred: string[];
  /** Things Shipyard cannot do for this project, said before work starts. */
  unsupported: { id: string; label: string; reason: string }[];
  installedComponents: { id: string; version: string; installedAt: string }[];
}

export interface RulesContract {
  contractVersion: number;
  generatedAt: string;
  /** Every rule that applies, whether or not it is satisfied. */
  applicable: {
    ruleId: string;
    version: number;
    severity: string;
    message: string;
    satisfied: boolean;
    missingGates: string[];
  }[];
  blockers: string[];
  warnings: string[];
  humanReviewRequired: string[];
}

export interface ReadinessContract {
  contractVersion: number;
  generatedAt: string;
  score: number;
  threshold: number;
  targetMode: TargetMode;
  ready: boolean;
  /**
   * Stated in the file, because a score with no yardstick invites the reading
   * that 60 is "mostly done" rather than "below the bar for what you said you
   * are building".
   */
  scoredAgainst: string;
  blockers: string[];
  nextActions: string[];
  evidenceCount: number;
}

export interface ContractInput {
  projectId: string;
  name: string;
  intent: ProjectIntent;
  idea: string;
  phases: BuildPhase[];
  capabilityPlan: CapabilityPlan;
  ruleOutcomes: RuleOutcome[];
  readiness: { score: number; threshold: number; ready: boolean; nextActions: string[] };
  installed: ComponentInstallation[];
  evidenceCount: number;
  /** Passed in rather than read from a clock, so output is reproducible. */
  generatedAt: string;
}

const STACK = {
  framework: 'Next.js',
  language: 'TypeScript',
  database: 'PostgreSQL',
  orm: 'Prisma',
  tests: 'Vitest',
} as const;

export function projectContract(input: ContractInput): ProjectContract {
  return {
    contractVersion: CONTRACT_VERSION,
    generatedAt: input.generatedAt,
    projectId: input.projectId,
    name: input.name,
    idea: input.idea,
    targetMode: input.intent.targetMode,
    intent: input.intent,
    stack: { ...STACK },
  };
}

export function planContract(input: ContractInput): PlanContract {
  return {
    contractVersion: CONTRACT_VERSION,
    generatedAt: input.generatedAt,
    phases: input.phases.map((phase, index) => ({ ...phase, index: index + 1 })),
    capabilities: input.capabilityPlan.resolved.map((resolved) => ({
      id: resolved.capability.id,
      label: resolved.capability.label,
      status: resolved.status,
      reason: resolved.reason,
      components: resolved.components,
      gates: resolved.gates,
    })),
    deferred: input.capabilityPlan.deferred.map((resolved) => resolved.capability.id),
    unsupported: input.capabilityPlan.unsupported.map((resolved) => ({
      id: resolved.capability.id,
      label: resolved.capability.label,
      reason: resolved.reason,
    })),
    installedComponents: input.installed
      .filter((installation) => installation.status !== 'removed')
      .map((installation) => ({
        id: installation.componentId,
        version: installation.version,
        installedAt: installation.installedAt,
      })),
  };
}

export function rulesContract(input: ContractInput): RulesContract {
  // Rules that do not apply are left out entirely. Recording them as
  // "satisfied" would make a concept build look like it had cleared
  // obligations it was never under.
  const applicable = input.ruleOutcomes.filter((outcome) => outcome.applies);
  return {
    contractVersion: CONTRACT_VERSION,
    generatedAt: input.generatedAt,
    applicable: applicable.map((outcome) => ({
      ruleId: outcome.ruleId,
      version: outcome.ruleVersion,
      severity: outcome.severity,
      message: outcome.message,
      satisfied: outcome.satisfied,
      missingGates: outcome.missingGates,
    })),
    blockers: applicable
      .filter((outcome) => !outcome.satisfied && outcome.severity === 'blocker')
      .map((outcome) => outcome.ruleId),
    warnings: applicable
      .filter((outcome) => !outcome.satisfied && outcome.severity === 'warning')
      .map((outcome) => outcome.ruleId),
    humanReviewRequired: applicable
      .filter((outcome) => outcome.humanReviewRequired)
      .map((outcome) => outcome.ruleId),
  };
}

export function readinessContract(input: ContractInput): ReadinessContract {
  return {
    contractVersion: CONTRACT_VERSION,
    generatedAt: input.generatedAt,
    score: input.readiness.score,
    threshold: input.readiness.threshold,
    targetMode: input.intent.targetMode,
    ready: input.readiness.ready,
    scoredAgainst:
      'The whole production checklist, not this project’s own obligations. What changes with the target mode is the bar, not the yardstick.',
    blockers: input.ruleOutcomes
      .filter((outcome) => outcome.applies && !outcome.satisfied && outcome.severity === 'blocker')
      .map((outcome) => outcome.message),
    nextActions: input.readiness.nextActions,
    evidenceCount: input.evidenceCount,
  };
}

/** All four, keyed by filename. */
export function contracts(input: ContractInput): Record<string, unknown> {
  return {
    [CONTRACT_FILES.project]: projectContract(input),
    [CONTRACT_FILES.plan]: planContract(input),
    [CONTRACT_FILES.rules]: rulesContract(input),
    [CONTRACT_FILES.readiness]: readinessContract(input),
  };
}

/* ------------------------------------------------------------ architecture -- */

function heading(text: string): string {
  return `## ${text}`;
}

/**
 * `ARCHITECTURE.md`, for a person.
 *
 * Written for two readers who want different things: the founder, who needs to
 * know what their app is made of and what it cannot do; and whoever picks this
 * up later, who needs to know where things live and which decisions were
 * deliberate.
 *
 * The section that matters most is the last one. A document that lists what a
 * system does and not what it deliberately does not do is the reason people
 * spend a week discovering a limitation that was decided on purpose in week
 * one.
 */
export function architectureMarkdown(input: ContractInput): string {
  const { intent, capabilityPlan } = input;
  const included = capabilityPlan.included;
  const installed = input.installed.filter((installation) => installation.status !== 'removed');
  const installedIds = new Set(installed.map((installation) => installation.componentId));

  const lines: string[] = [
    `# ${input.name} — how it is put together`,
    '',
    `*Generated by Shipyard on ${input.generatedAt.slice(0, 10)}. Regenerated when the project changes — edit the project, not this file.*`,
    '',
    `**What it is:** ${input.idea}`,
    '',
    `**How far it is going right now:** ${describeMode(intent.targetMode)}`,
    '',
    heading('The stack'),
    '',
    '| | |',
    '| --- | --- |',
    `| Framework | ${STACK.framework} |`,
    `| Language | ${STACK.language} |`,
    `| Database | ${STACK.database}, through ${STACK.orm} |`,
    `| Tests | ${STACK.tests} |`,
    '',
    'Shipyard carries its own Node and PostgreSQL, so neither needs installing.',
    'That is also the reason the choice is not open: anything requiring a service',
    'Shipyard does not ship cannot run on the owner’s machine.',
    '',
    heading('What this project needs, and why'),
    '',
    'Each of these was decided from what the owner said about their situation,',
    'not from a checklist. The reason is kept so it can be argued with.',
    '',
  ];

  if (included.length === 0) {
    lines.push('_Nothing yet — the plan has not been resolved._', '');
  } else {
    lines.push('| Needs | Because | Provided by |', '| --- | --- | --- |');
    for (const resolved of included) {
      const provider = resolved.components.length
        ? resolved.components
            .map((id) => (installedIds.has(id) ? `\`${id}\` (installed)` : `\`${id}\` (not installed yet)`))
            .join(', ')
        : 'written for this project';
      lines.push(`| ${resolved.capability.label} | ${resolved.reason} | ${provider} |`);
    }
    lines.push('');
  }

  if (installed.length > 0) {
    lines.push(
      heading('Ready-made parts in use'),
      '',
      'These came from the Shipyard library. They are already tested, and their',
      'tests are part of what proves this project is safe to launch — so the',
      'agent is told not to rewrite them. Their folders are listed in',
      '`.shipyard/protected.json`.',
      '',
      '| Part | Version | Installed |',
      '| --- | --- | --- |',
      ...installed.map(
        (installation) =>
          `| \`${installation.componentId}\` | ${installation.version} | ${installation.installedAt.slice(0, 10)} |`,
      ),
      '',
    );
  }

  lines.push(
    heading('Where things live'),
    '',
    '```',
    'src/app/           pages and API routes',
    'src/components/    installed parts — do not edit inside these',
    'src/lib/           shared code, including the database connection',
    'prisma/schema.prisma   the database, as the code understands it',
    'tests/contracts/   the tests that came with installed parts',
    '```',
    '',
    'In `prisma/schema.prisma`, everything between the two `shipyard:components`',
    'markers was written by the installer. Your own tables go below them.',
    '',
    heading('How it gets built'),
    '',
  );

  if (input.phases.length === 0) {
    lines.push('_No phases planned yet._', '');
  } else {
    for (const [index, phase] of input.phases.entries()) {
      lines.push(`${index + 1}. **${phase.title}** — ${phase.outcome} _(${phase.effort})_`);
    }
    lines.push(
      '',
      'Each phase ends with something visible in the app. A phase that ends with',
      '"the data model is complete" is one the owner cannot check, and a phase',
      'the owner cannot check is one where progress and the appearance of',
      'progress are the same thing.',
      '',
    );
  }

  const blockers = input.ruleOutcomes.filter(
    (outcome) => outcome.applies && !outcome.satisfied && outcome.severity === 'blocker',
  );

  lines.push(
    heading('What has to be true before real people use it'),
    '',
    `Readiness is **${input.readiness.score} out of 100**, against a bar of ${input.readiness.threshold} for ${describeMode(intent.targetMode)}.`,
    '',
    'That number is scored against the whole production checklist rather than',
    'against this project’s own obligations. A concept build genuinely scores',
    'around 17, and that is correct — what changes with ambition is the bar, not',
    'the yardstick. Scoring "percentage of what you owe" would let a concept',
    'build score 100 and make the number meaningless.',
    '',
  );

  if (blockers.length === 0) {
    lines.push('Nothing is currently blocking.', '');
  } else {
    lines.push('Currently blocking:', '');
    for (const blocker of blockers) lines.push(`- ${blocker.message}`);
    lines.push('');
  }

  // The section people wish they had read first.
  lines.push(heading('What this deliberately does not do'), '');

  const limits: string[] = [];
  for (const resolved of capabilityPlan.unsupported) {
    limits.push(`**${resolved.capability.label}.** ${resolved.reason}`);
  }
  for (const resolved of capabilityPlan.deferred) {
    limits.push(`**${resolved.capability.label}.** ${resolved.reason}`);
  }
  if (!intent.payments) limits.push('**Taking payment.** Nothing here charges anybody.');
  if (!intent.sensitiveData) {
    limits.push(
      '**Holding sensitive personal information.** The project was set up on the basis that it does not. If that changes, the obligations change with it.',
    );
  }
  if (intent.targetMode === 'ui_concept' || intent.targetMode === 'functional_prototype') {
    limits.push(
      '**Being used by strangers.** This is not built to withstand that yet, and the checks that would prove it is have not been run.',
    );
  }

  lines.push(
    limits.length > 0
      ? limits.map((limit) => `- ${limit}`).join('\n')
      : '- Nothing has been ruled out yet.',
    '',
    'This list is here on purpose. A document that says what a system does and',
    'not what it will not do is why people spend a week discovering a limit that',
    'was decided deliberately in week one.',
    '',
  );

  return lines.join('\n');
}

function describeMode(mode: TargetMode): string {
  switch (mode) {
    case 'ui_concept':
      return 'a look at the idea — screens only, nothing real behind them';
    case 'functional_prototype':
      return 'a working prototype for people the owner knows';
    case 'customer_pilot':
      return 'a pilot with real customers using it';
    case 'production_product':
      return 'a live product strangers depend on';
  }
}
