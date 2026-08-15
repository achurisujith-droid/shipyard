import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  AMBITION_PROFILES,
  isForRealUsers,
  type BuildPhase,
  type EnvironmentNeed,
  type IntakeAnswers,
  type ProjectPlan,
  type SkillSummary,
} from '@shipyard/shared';
import { loadSkills, skillsFor, type SkillManifest } from '@shipyard/skills-registry';
import { briefForAgent, matchRequirements } from '@shipyard/component-matcher';
import { loadLibrary } from '@shipyard/component-library';

/**
 * Turning three answers into a plan.
 *
 * The user answered questions about their own situation. This turns those into
 * the technical decisions — what gets built in what order, what has to be
 * running, what conventions Claude should follow — without ever putting one of
 * those decisions in front of them.
 *
 * Everything here is reviewable before anything is written to disk. The user
 * sees the plan and the PROJECT.md, and can edit both.
 */
export class Intake {
  constructor(
    /** `resources/skills`, packaged or from the repo in development. */
    private readonly skillsDir: string,
    /** The component library, so requirements can be matched against it. */
    private readonly componentsDir?: string,
  ) {}

  async plan(answers: IntakeAnswers, projectPath: string): Promise<ProjectPlan> {
    const skills = await this.skillsFor(answers);
    const phases = phasesFor(answers);
    const environment = environmentFor(answers);

    const alreadyBuilt = await this.libraryBrief(answers);

    return {
      answers,
      path: projectPath,
      phases,
      environment,
      skills,
      projectMarkdown: composeProjectMarkdown(answers, phases, environment, alreadyBuilt),
      firstMessage: composeFirstMessage(answers),
    };
  }

  /**
   * Write the project out: the folder, PROJECT.md, and the skill files.
   *
   * Skills go to `.claude/skills/<id>/SKILL.md`, which is where the CLI looks
   * for them. This is how a Shipyard project gets our conventions — phased
   * delivery, plain language, the locked stack — without every user having to
   * know they exist.
   */
  async create(plan: ProjectPlan, markdownOverride?: string): Promise<void> {
    await mkdir(plan.path, { recursive: true });
    await writeFile(
      path.join(plan.path, 'PROJECT.md'),
      markdownOverride ?? plan.projectMarkdown,
      'utf8',
    );

    for (const skill of plan.skills) {
      const source = path.join(this.skillsDir, `${skill.id}.md`);
      const target = path.join(plan.path, '.claude', 'skills', skill.id);
      try {
        const body = await readFile(source, 'utf8');
        await mkdir(target, { recursive: true });
        await writeFile(path.join(target, 'SKILL.md'), body, 'utf8');
      } catch {
        // A missing skill file must not stop a user creating their project.
        // They lose a convention, not the ability to build.
      }
    }
  }

  /**
   * What the founder asked for that the library already has.
   *
   * This runs before a line of code is written, and its output goes into
   * PROJECT.md — which is the first thing the agent reads. Without it the
   * requirements reach the agent unannotated and it writes its own version of
   * something that already exists with tests around it, and nobody finds out.
   *
   * A failure here is silent on purpose. Not being told about the library is a
   * missed saving; failing to create somebody's project because a manifest is
   * malformed is not a trade worth making.
   */
  private async libraryBrief(answers: IntakeAnswers): Promise<string> {
    if (!this.componentsDir) return '';
    try {
      const library = await loadLibrary(this.componentsDir);
      const requirements = [answers.idea, answers.requirementsDocument ?? ''].join('\n');
      return briefForAgent(matchRequirements(requirements, library));
    } catch (error) {
      console.error('[intake] could not match requirements against the library:', error);
      return '';
    }
  }

  /**
   * Every skill in the library that applies to these answers.
   *
   * Which ones apply is read from each skill's own manifest rather than from
   * its filename. The old rule keyed off a `prototype-` or `production-`
   * prefix, which worked right up until somebody named a file badly — and
   * nothing would have said so.
   *
   * A skills directory that cannot be read is empty rather than fatal. A
   * broken *skill* is a different matter and is reported, because the failure
   * it causes is the agent being told something confidently wrong.
   */
  private async skillsFor(answers: IntakeAnswers): Promise<SkillSummary[]> {
    let skills: SkillManifest[];
    try {
      skills = await loadSkills(this.skillsDir);
    } catch (error) {
      console.error('[intake] a skill file is not valid, so no skills were written:', error);
      return [];
    }

    return skillsFor(skills, { targetMode: answers.ambition }).map((skill) => ({
      id: skill.id,
      title: skill.title,
      description: skill.description,
      version: skill.version,
    }));
  }
}

/* --------------------------------------------------------------- phases -- */

/**
 * The plan, in stages that each end with something the user can look at.
 *
 * Never "the data model is complete". A phase is over when there is something
 * on screen that was not there before, because that is the only kind of
 * progress this audience can verify.
 */
function phasesFor(answers: IntakeAnswers): BuildPhase[] {
  const screensFirst = answers.buildOrder === 'screens-first';
  const production = isForRealUsers(answers.ambition);

  const phases: BuildPhase[] = [];

  if (answers.requirements === 'conversation') {
    phases.push({
      title: 'Work out what we are building',
      outcome:
        'A written description of your app that you agree with, saved as PROJECT.md. Claude asks; you correct it.',
      effort: 'Half an hour of talking',
    });
  }

  if (screensFirst) {
    phases.push({
      title: 'See the whole thing',
      outcome:
        'Every screen, with made-up information in it. Nothing works yet, but you can click through the entire app and say what is wrong while it is still cheap to change.',
      effort: 'A day or two',
    });
    phases.push({
      title: 'Make it real',
      outcome:
        'The made-up information becomes yours. What you add stays there when you close it and open it again.',
      effort: production ? 'Several days' : 'Two or three days',
    });
  } else {
    phases.push({
      title: 'The first real feature',
      outcome:
        'One thing, finished properly — the screen and everything behind it. It tells us the shape of the rest.',
      effort: 'A day or two',
    });
    phases.push({
      title: 'The rest of the features',
      outcome: 'Each one finished before the next one starts, so the app is never half-broken.',
      effort: production ? 'A week or more' : 'Several days',
    });
  }

  if (production) {
    phases.push({
      title: 'Accounts and privacy',
      outcome:
        'People sign up with a real email and password. One customer can never see another customer’s information — this is the part that is expensive to add later, which is why it is here and not at the end.',
      effort: 'Several days',
    });
    phases.push({
      title: 'Ready for strangers',
      outcome:
        'Backups running, a warning when something breaks, and the privacy notices you are legally required to have. Then it goes live.',
      effort: 'A few days',
    });
  } else {
    phases.push({
      title: 'Show it to someone',
      outcome:
        'A private link you can send. Still a prototype: sign-in is pretended and the information is not backed up, so do not put anything real in it.',
      effort: 'An hour or two',
    });
  }

  return phases;
}

/* ---------------------------------------------------------- environment -- */

/** Words in the idea that imply something has to be running for it to work. */
const SIGNALS: { pattern: RegExp; need: (production: boolean) => EnvironmentNeed }[] = [
  {
    pattern: /\b(pay|payment|checkout|subscription|billing|stripe|charge)\w*\b/i,
    need: (production) => ({
      name: 'Taking payments',
      reason: 'Your app takes money.',
      status: 'unsupported',
      note: production
        ? 'Payments need an account with a payment company (Stripe is the usual one) and they verify your business before you can take real money. Start that early — it can take a few days. Until then we will use their test mode, which behaves identically with fake cards.'
        : 'For a prototype we will use Stripe’s test mode, which uses fake card numbers. No account needed to see it working.',
    }),
  },
  {
    pattern: /\b(email|e-mail|newsletter|notify|notification|invite)\w*\b/i,
    need: () => ({
      name: 'Sending email',
      reason: 'Your app sends messages to people.',
      status: 'unsupported',
      note: 'Email cannot be sent from your computer — the internet blocks it to stop spam. While building, messages are written to a file so you can read them. Sending real email needs a free account with a service like Resend or Postmark.',
    }),
  },
  {
    pattern: /\b(redis|queue|background job|cron|scheduled|worker)\w*\b/i,
    need: () => ({
      name: 'Background jobs',
      reason: 'Your app does work after the user has moved on.',
      status: 'included',
      note: 'Handled by the database Shipyard already runs, rather than adding Redis. Redis has no official version for Windows, and at your size Postgres does this job perfectly well.',
    }),
  },
  {
    pattern: /\b(upload|photo|image|picture|file|document|attachment)\w*\b/i,
    need: (production) => ({
      name: 'Storing uploaded files',
      reason: 'People upload things to your app.',
      status: production ? 'unsupported' : 'included',
      note: production
        ? 'Files are kept on your computer while building. Before real users, they need to move to a storage service (S3, Cloudflare R2 or similar) or they disappear the first time the app restarts.'
        : 'Files are kept in a folder inside your project. Fine for a prototype.',
    }),
  },
  {
    pattern: /\b(chat|realtime|real-time|live|presence|collaborat)\w*\b/i,
    need: () => ({
      name: 'Live updates',
      reason: 'People see each other’s changes without refreshing.',
      status: 'automatic',
      note: 'Built into the app itself. Nothing extra to run.',
    }),
  },
];

/**
 * What has to be running, and whether we can provide it.
 *
 * The honesty here matters more than the completeness. Telling someone their
 * app needs an email service on day one is a small annoyance; letting them find
 * out on launch day is a disaster.
 */
function environmentFor(answers: IntakeAnswers): EnvironmentNeed[] {
  const production = isForRealUsers(answers.ambition);
  const needs: EnvironmentNeed[] = [
    {
      name: 'Node',
      reason: 'Runs your app.',
      status: 'included',
    },
    {
      name: 'PostgreSQL',
      reason: 'Remembers everything your app stores.',
      status: 'included',
    },
  ];

  const text = `${answers.idea}\n${answers.requirementsDocument ?? ''}`;
  for (const signal of SIGNALS) {
    if (signal.pattern.test(text)) needs.push(signal.need(production));
  }

  if (production) {
    needs.push({
      name: 'Somewhere to live on the internet',
      reason: 'Real users cannot connect to your laptop.',
      status: 'unsupported',
      note: 'Shipyard deploys to Railway, which needs a free account of your own. We will do this at the “Ready for strangers” phase, not now.',
    });
  }

  return needs;
}

/* -------------------------------------------------------------- writing -- */

function composeProjectMarkdown(
  answers: IntakeAnswers,
  phases: BuildPhase[],
  environment: EnvironmentNeed[],
  alreadyBuilt = '',
): string {
  const profile = AMBITION_PROFILES.find((p) => p.id === answers.ambition);
  const lines: string[] = [];

  lines.push(`# ${answers.name}`, '');
  lines.push(
    '<!-- Written by Shipyard from the answers you gave when you started this project.',
    '     Claude reads this before it does anything. Edit it whenever your plans change. -->',
    '',
  );

  lines.push('## What we are building', '', answers.idea.trim(), '');

  // Placed directly under what is being built, and above the requirements, so
  // it is read before the work is planned rather than after it is done.
  if (alreadyBuilt.trim()) {
    lines.push('## Some of this is already built', '', alreadyBuilt.trim(), '');
  }

  if (answers.requirementsDocument?.trim()) {
    lines.push('## The requirements you provided', '', answers.requirementsDocument.trim(), '');
  } else {
    lines.push(
      '## The requirements',
      '',
      'Not written down yet. The first job is to talk this through and fill in this section,',
      'before any code is written.',
      '',
    );
  }

  if (profile) {
    lines.push(`## How far we are taking it: ${profile.title.toLowerCase()}`, '');
    lines.push(profile.summary, '');
    lines.push('**This includes:**', '');
    for (const item of profile.includes) lines.push(`- ${item}`);
    lines.push('', '**This deliberately does not include:**', '');
    for (const item of profile.excludes) lines.push(`- ${item}`);
    lines.push('', `Expected effort: ${profile.effort}`, '');
  }

  lines.push('## How we are working', '');
  lines.push(
    answers.buildOrder === 'screens-first'
      ? 'Screens first. Build every screen with made-up information so the owner can see the ' +
          'whole app and react to it, then replace the made-up information with real data. ' +
          'Expect some screens to change once real data arrives; that is the point of doing it ' +
          'this way.'
      : 'One feature at a time, finished front to back before the next one starts. The app ' +
          'should be runnable and not visibly broken at the end of every working session.',
    '',
  );

  lines.push('## The plan', '');
  phases.forEach((phase, i) => {
    lines.push(`### Phase ${i + 1}: ${phase.title}`, '', phase.outcome, '', `_${phase.effort}_`, '');
  });

  lines.push('## What runs this', '');
  lines.push('| Piece | Why | Status |', '| --- | --- | --- |');
  for (const need of environment) {
    const status =
      need.status === 'included'
        ? 'Shipyard provides it'
        : need.status === 'automatic'
          ? 'Installed automatically'
          : 'Needs setting up — see below';
    lines.push(`| ${need.name} | ${need.reason} | ${status} |`);
  }
  lines.push('');

  const outstanding = environment.filter((n) => n.status === 'unsupported' && n.note);
  if (outstanding.length > 0) {
    lines.push('### Things that need a decision or an account', '');
    for (const need of outstanding) lines.push(`- **${need.name}.** ${need.note}`, '');
  }

  lines.push('## Working agreement', '');
  lines.push(
    '- The person you are building this for is not a programmer. Explain in ordinary words.',
    '- Always leave the app in a state where it runs. They check it by looking at it.',
    '- Finish a phase before starting the next one, and say when a phase is done.',
    '- If a decision needs their input, ask a question about their business, not about technology.',
    '',
  );

  return `${lines.join('\n')}\n`;
}

/**
 * The opening message, pre-filled and not sent.
 *
 * Pressing send is the user's action, so the first thing that spends their
 * Claude usage is something they chose to do.
 */
function composeFirstMessage(answers: IntakeAnswers): string {
  if (answers.requirements === 'conversation') {
    return (
      'Read PROJECT.md first.\n\n' +
      'I have an idea but I have not written proper requirements. Before writing any code, ' +
      'interview me about it — ask one question at a time, in plain language, about what I want ' +
      'and who it is for. When you have enough, fill in the requirements section of PROJECT.md ' +
      'and show it to me for approval.'
    );
  }

  return (
    'Read PROJECT.md first — it has what we are building, how far we are taking it, and the plan.\n\n' +
    'Tell me in plain words what you understand, flag anything that looks contradictory or ' +
    'missing, then start on Phase 1. Do not start Phase 2 until I have seen Phase 1.'
  );
}
