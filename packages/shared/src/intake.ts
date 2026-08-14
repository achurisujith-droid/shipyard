/**
 * The conversation that starts a project.
 *
 * A non-developer founder cannot answer "which database?" or "REST or GraphQL?",
 * and asking is how you lose them. They CAN answer questions about their own
 * situation: what they are making, who will touch it, and whether they want to
 * see it before it is finished. Those answers determine the technical decisions
 * without the user ever meeting one.
 *
 * Three questions, not seven. Each one changes the plan; a question whose answer
 * changes nothing is a question that should not be asked.
 */

import { modeAtLeast, type ProjectIntent, type TargetMode } from './production';

export type { TargetMode };

/**
 * How far this build is going, right now.
 *
 * The question the whole system hangs off. Everything downstream — which rules
 * apply, which checks are required, what counts as ready — is decided by this
 * one answer, which is why it is asked in the user's language and never
 * inferred from their idea.
 */
export type Ambition = TargetMode;

/**
 * Does this project owe its users the things a real product owes them?
 *
 * The line falls between "people I know are looking at it" and "people I do not
 * know are relying on it". Crossing it is what makes sign-in, backups and
 * monitoring obligations rather than nice-to-haves.
 */
export function isForRealUsers(mode: TargetMode): boolean {
  return modeAtLeast(mode, 'customer_pilot');
}

/** Where the requirements come from. */
export type RequirementsSource =
  /** They have a spec, brief, or notes already written. */
  | 'document'
  /** They have an idea, and Claude interviews them to turn it into one. */
  | 'conversation';

/** What gets built first. */
export type BuildOrder =
  /** Every screen, filled with made-up data, before anything is wired up. */
  | 'screens-first'
  /** One complete slice at a time, screen and logic together. */
  | 'end-to-end';

export interface IntakeAnswers {
  /** Their own words. The single most valuable input we get. */
  idea: string;
  ambition: Ambition;
  requirements: RequirementsSource;
  /** Pasted or imported when `requirements` is 'document'. */
  requirementsDocument?: string;
  buildOrder: BuildOrder;
  /** Folder name. Derived from the idea, editable. */
  name: string;
}

/**
 * One stage of work with something visible at the end of it.
 *
 * Phases are defined by what the user can SEE when the phase is done, not by
 * what was implemented. "Data model complete" means nothing to someone who
 * cannot read a schema.
 */
export interface BuildPhase {
  title: string;
  /** What exists at the end, in their terms. */
  outcome: string;
  /** Roughly how long, honestly hedged. */
  effort: string;
}

/** Something the project needs that has to exist before it can run. */
export interface EnvironmentNeed {
  name: string;
  /** Why this project needs it, in plain language. */
  reason: string;
  status:
    /** Shipyard ships it; nothing for the user to do. */
    | 'included'
    /** Installed on demand from the project's own dependencies. */
    | 'automatic'
    /** We cannot provide it, and the plan says so rather than failing later. */
    | 'unsupported';
  /** Shown when status is 'unsupported'. */
  note?: string;
}

/** Everything the wizard produces, for review before anything is written. */
export interface ProjectPlan {
  answers: IntakeAnswers;
  /** Absolute path the folder will be created at. */
  path: string;
  phases: BuildPhase[];
  environment: EnvironmentNeed[];
  /** Skill files copied into the project so Claude works to our conventions. */
  skills: SkillSummary[];
  /** The full text of PROJECT.md. Editable before it is written. */
  projectMarkdown: string;
  /**
   * The opening message for the session. Pre-filled and NOT sent: the user
   * presses send, so the first thing that spends their Claude usage is theirs.
   */
  firstMessage: string;
}

/**
 * The wizard's three answers, as the intent everything downstream speaks.
 *
 * The wizard does not yet ask about regions, sensitive data, payments or
 * automated decisions — that is the outstanding half of P2. Until it does, the
 * unknowns default the **cautious** way: assume there is personal data, assume
 * it is public facing. Getting that backwards would let a project skip
 * obligations it actually has, and the mistake would only surface once real
 * people were involved.
 *
 * The opposite error — a concept build being told it needs an audit log — is
 * visible immediately and costs a conversation.
 */
export function intentFromAnswers(answers: IntakeAnswers): ProjectIntent {
  const real = isForRealUsers(answers.ambition);
  return {
    targetMode: answers.ambition,
    regions: [],
    // Assumed until asked. A project that turns out to hold nothing sensitive
    // loses nothing by having been careful.
    sensitiveData: real,
    payments: false,
    aiAffectsConsequentialDecision: false,
    humanReviewRequired: false,
    publicFacing: real,
    existingCodeSource: 'new_project',
  };
}

export interface SkillSummary {
  id: string;
  title: string;
  /** Recorded so a project can be told its skills have moved on. */
  version?: string;
  /** One line, so the review screen can say what each one is for. */
  description: string;
}

/**
 * The honest comparison behind question 2.
 *
 * Kept as data rather than JSX so the wording is reviewable in one place, and
 * so it can be repeated in PROJECT.md without drifting from what the user was
 * shown when they chose.
 */
export interface AmbitionProfile {
  id: Ambition;
  title: string;
  /** The one-line version. */
  summary: string;
  /** What you get. */
  includes: string[];
  /** What is deliberately left out, stated plainly. */
  excludes: string[];
  /** Honest time language. Never a single number. */
  effort: string;
  /** Who this is the right answer for. */
  bestWhen: string;
}

/**
 * The comparison a solo founder actually needs.
 *
 * Written for someone who has never shipped software and is deciding how to
 * spend the next month of their life. Two rules held throughout: no jargon, and
 * no pretending the cheap option is free. The costs of each are stated as
 * plainly as the benefits, because a founder who picks "prototype" without
 * understanding that sign-in is fake will show it to a customer.
 */
export const AMBITION_PROFILES: readonly AmbitionProfile[] = [
  {
    id: 'ui_concept',
    title: 'Something to look at',
    summary:
      'The screens, and the path between them, filled with made-up information. Nothing behind it is real.',
    includes: [
      'Every screen, and working navigation between them',
      'Made-up information that looks like the real thing',
      'Runs on your computer, ready to show on a call',
    ],
    excludes: [
      'Anything you type being there tomorrow',
      'Signing in — it is drawn, not built',
      'Any of it working when you are not in the room',
    ],
    effort: 'A day or two.',
    bestWhen:
      'You are trying to explain the idea to someone, and words are not doing it. Wrong if anyone might mistake it for a product.',
  },
  {
    id: 'functional_prototype',
    title: 'A working prototype',
    summary:
      'The main thing your product does, actually working. Not something strangers should sign into.',
    includes: [
      'Every screen, working, with real navigation between them',
      'Real information you can add, change and delete, that is still there tomorrow',
      'Runs on your computer, and can go behind a private link when you want to show someone',
    ],
    excludes: [
      'Proper accounts and passwords — signing in is pretended',
      'Taking payments',
      'Standing up to anyone deliberately trying to break it',
      'Backups. If the information goes, it is gone.',
    ],
    effort: 'Days of building, not weeks.',
    bestWhen:
      'You want to find out whether the idea works, show an investor, or put it in front of a handful of people you already know.',
  },
  {
    id: 'customer_pilot',
    title: 'A pilot with real people',
    summary:
      'A controlled group of real users, doing real work in it. The first version where their bad day is your problem.',
    includes: [
      'Real accounts, passwords, and password resets',
      'Their work is still there next week, and backed up',
      'One person cannot see another person’s information',
      'You find out it is broken before they tell you',
      'The journeys that matter are checked automatically, every time',
    ],
    excludes: [
      'Being able to walk away from it. People are depending on this now.',
      'Cheap changes of mind — once real data is in it, rework costs more',
    ],
    effort: 'Weeks. Most of the work is the part nobody sees.',
    bestWhen:
      'You have people willing to try it, you invited them by name, and you can ring them if something goes wrong.',
  },
  {
    id: 'production_product',
    title: 'A product people pay for',
    summary:
      'Strangers sign up, pay, and depend on it. Someone is accountable for it staying up.',
    includes: [
      'Everything a pilot has, plus the things that only matter at 3am',
      'Payments, if you are charging',
      'A backup someone has actually restored from, rather than hoping',
      'A written answer to “it is down, what now?”',
      'The legal obligations that come with holding other people’s information',
    ],
    excludes: [
      'A quick answer to “is this idea any good?” — you commit before you see it',
      'Doing it alone. Some of this needs a person to sign it off.',
    ],
    effort:
      'Weeks, not days — usually three to five times the work of a prototype, and most of that work is invisible.',
    bestWhen: 'You already know what you are building and who is going to pay for it.',
  },
] as const;

/**
 * Which to recommend, and why.
 *
 * Shown next to the choice rather than buried in a help link. It is the single
 * most consequential decision on this screen and the one the user is least
 * equipped to make alone.
 */
export const AMBITION_ADVICE =
  'If this is your first product, start with a prototype. You will change your mind about ' +
  'what it should do — everyone does — and changing it is cheap now and expensive later. ' +
  'The screens you build now mostly survive the move; it is the plumbing underneath that ' +
  'gets replaced, and that would have been replaced anyway.';
