import type {
  BuildPhase,
  Capability,
  GateResult,
  ProjectIntent,
  ResolvedCapability,
  RuleOutcome,
  TargetMode,
} from '@shipyard/shared';

/**
 * Turning what Shipyard knows into something the agent can act on.
 *
 * By the time a task is composed, four systems have already had their say: the
 * intake wizard knows what is being built, the capability resolver knows what
 * it needs, the rulebook knows what it owes its users, and the verification
 * runner knows what is currently failing. None of that reaches the agent unless
 * something writes it down.
 *
 * `composeFixTask` in the incident engine does this for a failure out in the
 * world. These do it for the other two moments that matter: starting a phase of
 * work, and answering a check that has gone red.
 *
 * Every task here is a **draft**. Nothing is ever sent automatically — the user
 * presses send, and the thing that spends their Claude usage is their decision.
 */

export interface AgentTask {
  /** Why this task exists, for the UI to label it. */
  kind: 'phase' | 'gate_failure' | 'capability_gap';
  /** The prompt. Never sent automatically. */
  message: string;
  /** Files worth opening first. */
  context: string[];
  /** What has to be true for this to count as done. */
  acceptanceCriteria: string[];
  /** Checks to run afterwards, before the work is kept. */
  gates: string[];
  /** Shown next to the send button when the user should think first. */
  warning?: string;
}

/** Bullet a list, or say plainly that there is nothing in it. */
function bullets(items: readonly string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : '- (nothing yet)';
}

/**
 * What the agent must be told about the components that are already installed.
 *
 * This paragraph is the difference between a library that saves work and one
 * that gets quietly rewritten. Without it, an agent asked to add sign-in to a
 * project that already has it will write its own — and the tests that made the
 * installed one trustworthy will be testing dead code.
 */
function installedComponentsNote(installed: readonly { id: string; name: string; paths: string[] }[]): string {
  if (installed.length === 0) return '';
  return [
    '',
    'This project already has these ready-made parts installed. Use them rather',
    'than writing your own, and do not edit inside their folders:',
    '',
    ...installed.map((component) => `- **${component.name}** — \`${component.paths[0] ?? component.id}\``),
    '',
    'If one of them is genuinely wrong for what is being asked, say so rather than',
    'working around it.',
  ].join('\n');
}

export interface PhaseTaskInput {
  phase: BuildPhase;
  /** Which phase this is, and how many there are, for the opening line. */
  index: number;
  total: number;
  targetMode: TargetMode;
  /** Components already in the project. */
  installed?: { id: string; name: string; paths: string[] }[];
  /** Gates this phase's work will be judged by. */
  gates?: string[];
  /** Rules that apply and are not yet satisfied. */
  outstanding?: RuleOutcome[];
}

/**
 * The task for building one phase.
 *
 * A phase ends with something on screen that was not there before. That is
 * stated in the prompt rather than assumed, because "the data model is
 * complete" is a phase the owner cannot check, and a phase the owner cannot
 * check is one where progress and the appearance of progress are the same
 * thing.
 */
export function composePhaseTask(input: PhaseTaskInput): AgentTask {
  const { phase, index, total, targetMode } = input;
  const outstanding = input.outstanding ?? [];

  const lines = [
    `Phase ${index} of ${total}: ${phase.title}`,
    '',
    phase.outcome,
    '',
    'When this phase is finished, the person who owns this project should be able',
    'to open the app and see something that was not there before. Please work',
    'towards that rather than towards a complete data model.',
  ];

  if (targetMode === 'ui_concept' || targetMode === 'functional_prototype') {
    lines.push(
      '',
      'This is not going in front of real users yet, so made-up data and stubbed',
      'behaviour are fine where they let the screen exist sooner. Say clearly on',
      'screen where something is faked, so nobody mistakes it for working.',
    );
  } else {
    lines.push(
      '',
      'Real people will use this. Nothing here should be faked or stubbed — if',
      'something cannot be done properly yet, say so rather than putting in a',
      'placeholder that looks finished.',
    );
  }

  const note = installedComponentsNote(input.installed ?? []);
  if (note) lines.push(note);

  if (outstanding.length > 0) {
    lines.push(
      '',
      'These are outstanding for the project as a whole. You do not have to finish',
      'them in this phase, but do not make any of them harder to do later:',
      '',
      bullets(outstanding.slice(0, 6).map((rule) => rule.message)),
    );
  }

  lines.push(
    '',
    'Leave the app running at the end. If you cannot, say what is broken rather',
    'than leaving it for the owner to discover.',
  );

  return {
    kind: 'phase',
    message: lines.join('\n'),
    context: ['PROJECT.md', 'ARCHITECTURE.md'],
    acceptanceCriteria: [
      'There is something visible in the app that was not there before this phase.',
      'The app still starts and the main journey through it still works.',
      'Anything deliberately left unfinished is written down, not left to be found.',
    ],
    gates: input.gates ?? ['build_passes', 'typecheck_passes'],
  };
}

export interface GateTaskInput {
  failed: GateResult[];
  /** Labels keyed by gate id, so the prompt names checks the way the user sees them. */
  labels?: Record<string, string>;
  installed?: { id: string; name: string; paths: string[] }[];
  /** True when one of the failing checks belongs to an installed component. */
  componentContract?: boolean;
}

/**
 * The task for a check that has gone red.
 *
 * The instruction that matters is **do not change the check**. A failing test
 * is the only thing standing between a broken build and a confident release,
 * and "make the tests pass" is an instruction an agent can satisfy by editing
 * the test. Saying so up front costs one sentence.
 */
export function composeGateTask(input: GateTaskInput): AgentTask {
  const labels = input.labels ?? {};
  const failed = input.failed.filter((result) => result.status === 'failed');
  const name = (id: string): string => labels[id] ?? id;

  const lines = [
    failed.length === 1
      ? 'One of the checks on this project is failing.'
      : `${failed.length} of the checks on this project are failing.`,
    '',
    'Please work out why, and fix the cause.',
    '',
  ];

  for (const result of failed) {
    lines.push(`**${name(result.gateId)}**`);
    if (result.failureSummary) lines.push(`  ${result.failureSummary}`);
    if (result.output) {
      const tail = result.output.split('\n').slice(-12).join('\n');
      lines.push('', '```', tail, '```');
    }
    lines.push('');
  }

  lines.push(
    'Two things to be clear about.',
    '',
    '**Do not change the checks so that they pass.** A check exists to catch',
    'exactly this, and editing it turns a real problem into a hidden one. If a',
    'check is genuinely wrong, say so and leave it failing.',
    '',
    '**Fix the cause, not the symptom.** If you cannot reproduce the failure,',
    'say so rather than guessing — a guess that makes the symptom disappear is',
    'how the same problem comes back next week.',
  );

  const note = installedComponentsNote(input.installed ?? []);
  if (note) lines.push(note);

  const acceptance = [
    'Every check listed above passes, and none of them were edited to achieve it.',
    'The reason each one was failing is written down.',
  ];
  if (input.componentContract) {
    acceptance.push('The installed component was not rewritten — the fix is in the code that uses it.');
  }

  return {
    kind: 'gate_failure',
    message: lines.join('\n'),
    context: failed.map((result) => result.gateId),
    acceptanceCriteria: acceptance,
    gates: failed.map((result) => result.gateId),
    ...(input.componentContract
      ? {
          warning:
            'One of these checks belongs to a ready-made part. If the fix means changing that part, a developer should look at it.',
        }
      : {}),
  };
}

export interface CapabilityTaskInput {
  capability: ResolvedCapability;
  intent: Pick<ProjectIntent, 'targetMode'>;
  /** True when the library has a component for this and it is not installed. */
  componentAvailable?: boolean;
  installed?: { id: string; name: string; paths: string[] }[];
}

/**
 * The task for something the project needs and does not have.
 *
 * When the library already has a component for it, this says so and stops.
 * Asking an agent to write sign-in from scratch next to a tested sign-in
 * component is the exact waste the library exists to prevent, and the founder
 * has no way to know it happened.
 */
export function composeCapabilityTask(input: CapabilityTaskInput): AgentTask {
  const { capability } = input;
  const label = capability.capability.label;

  if (input.componentAvailable) {
    return {
      kind: 'capability_gap',
      message: [
        `This project needs "${label}", and there is already a tested part in the`,
        'library that provides it.',
        '',
        `Reason it is needed: ${capability.reason}`,
        '',
        'Please do not write this from scratch. Tell the owner to install it from',
        'the ready-made parts list, and carry on with something else in the',
        'meantime.',
      ].join('\n'),
      context: [],
      acceptanceCriteria: ['The owner has been told which ready-made part to install.'],
      gates: [],
      warning: 'There is a tested part for this. Installing it is quicker and safer than building it.',
    };
  }

  const lines = [
    `This project needs "${label}", and there is no ready-made part for it.`,
    '',
    `Reason it is needed: ${capability.reason}`,
    '',
    'Please build it, and keep it separate enough that it can be tested on its own.',
  ];

  if (capability.gates.length > 0) {
    lines.push(
      '',
      'It will be judged by these checks, so build towards them rather than',
      'towards something that merely runs:',
      '',
      bullets(capability.gates),
    );
  }

  const note = installedComponentsNote(input.installed ?? []);
  if (note) lines.push(note);

  return {
    kind: 'capability_gap',
    message: lines.join('\n'),
    context: ['ARCHITECTURE.md'],
    acceptanceCriteria: [
      `${label} works end to end, not only in the happy case.`,
      'There are tests for it that would fail if it stopped working.',
      ...capability.gates.map((gate) => `The check "${gate}" passes.`),
    ],
    gates: capability.gates,
    ...(capability.status === 'requires_human_review'
      ? { warning: 'This is one a person should read before it goes anywhere near real users.' }
      : {}),
  };
}

/**
 * The next thing worth doing, out of everything outstanding.
 *
 * Ordering matters more than it looks. A founder shown eight tasks does the one
 * they understand, which is rarely the one that is blocking the others. Failing
 * checks come first because nothing built on top of a red build is trustworthy;
 * then capabilities the library can supply, because those are minutes rather
 * than days; then the phase in hand.
 */
export function nextTask(options: {
  failedGates?: GateResult[];
  gapsWithComponents?: ResolvedCapability[];
  phase?: PhaseTaskInput;
  labels?: Record<string, string>;
  installed?: { id: string; name: string; paths: string[] }[];
}): AgentTask | null {
  const failed = (options.failedGates ?? []).filter((result) => result.status === 'failed');
  if (failed.length > 0) {
    return composeGateTask({
      failed,
      ...(options.labels ? { labels: options.labels } : {}),
      ...(options.installed ? { installed: options.installed } : {}),
    });
  }

  const supplied = options.gapsWithComponents ?? [];
  if (supplied.length > 0 && supplied[0]) {
    return composeCapabilityTask({
      capability: supplied[0],
      intent: { targetMode: 'functional_prototype' },
      componentAvailable: true,
      ...(options.installed ? { installed: options.installed } : {}),
    });
  }

  if (options.phase) return composePhaseTask(options.phase);
  return null;
}

export type { Capability };
