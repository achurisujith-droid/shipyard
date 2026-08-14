/**
 * Does the wizard turn answers into a plan a founder can act on?
 *
 * The output of this step is a document Claude follows for weeks, so the checks
 * are about substance rather than shape: does a production project get accounts
 * before launch, does a payments app get warned about verification delays, does
 * a prototype get told what it is allowed to fake.
 *
 *   npx tsx scripts/test-intake.mts            # assertions
 *   npx tsx scripts/test-intake.mts --show     # print a full PROJECT.md
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { IntakeAnswers } from '@shipyard/shared';

import { Intake } from '../main/intake.js';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const intake = new Intake(path.join(DESKTOP, 'resources', 'skills'));

let failed = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(ok ? `PASS  ${name}` : `FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  if (!ok) failed += 1;
};

function answers(overrides: Partial<IntakeAnswers>): IntakeAnswers {
  return {
    idea: 'A shop that sells phone cases where I can add products and take orders',
    name: 'phone-cases',
    ambition: 'functional_prototype',
    requirements: 'conversation',
    buildOrder: 'screens-first',
    ...overrides,
  };
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shipyard-intake-'));

  try {
    if (process.argv.includes('--show')) {
      const plan = await intake.plan(
        answers({ ambition: 'production_product', idea: 'A booking site where customers pay a deposit' }),
        path.join(root, 'demo'),
      );
      console.log(plan.projectMarkdown);
      console.log('\n--- first message ---\n');
      console.log(plan.firstMessage);
      return;
    }

    // --- a prototype ------------------------------------------------------
    const proto = await intake.plan(answers({}), path.join(root, 'proto'));

    check(
      'a prototype ends with showing someone, not with launching',
      /show it to someone/i.test(proto.phases.at(-1)?.title ?? ''),
      proto.phases.map((p) => p.title).join(' → '),
    );
    check(
      'the phase list leads with agreeing what to build when nothing is written down',
      /what we are building/i.test(proto.phases[0]?.title ?? ''),
      proto.phases[0]?.title,
    );
    check(
      'a prototype is told what it may fake',
      proto.skills.some((s) => s.id === 'prototype-what-you-may-fake'),
      proto.skills.map((s) => s.id).join(', '),
    );
    check(
      'a prototype is NOT given the production checklist',
      !proto.skills.some((s) => s.id.startsWith('production-')),
      proto.skills.map((s) => s.id).join(', '),
    );
    check(
      'every project gets the plain-language and stack conventions',
      ['talking-to-a-non-programmer', 'building-in-phases', 'the-stack'].every((id) =>
        proto.skills.some((s) => s.id === id),
      ),
      proto.skills.map((s) => s.id).join(', '),
    );
    check(
      'skills carry a description the review screen can show',
      proto.skills.every((s) => s.title.length > 0 && s.description.length > 0),
      JSON.stringify(proto.skills),
    );
    check(
      'the brief is honest that a prototype fakes sign-in',
      /signing in is pretended/i.test(proto.projectMarkdown),
    );
    check(
      'Node and Postgres are listed as already provided',
      proto.environment.filter((n) => n.status === 'included').length >= 2,
      JSON.stringify(proto.environment.map((n) => `${n.name}:${n.status}`)),
    );

    // --- production -------------------------------------------------------
    const prod = await intake.plan(
      answers({ ambition: 'production_product', requirements: 'document', requirementsDocument: 'Sell cases. Take card payments. Email a receipt.' }),
      path.join(root, 'prod'),
    );

    const titles = prod.phases.map((p) => p.title);
    const accountsAt = titles.findIndex((t) => /accounts/i.test(t));
    const launchAt = titles.findIndex((t) => /strangers/i.test(t));
    check(
      'accounts and privacy come before launch, not at the end',
      accountsAt >= 0 && launchAt >= 0 && accountsAt < launchAt,
      titles.join(' → '),
    );
    check(
      'production gets the before-real-users checklist',
      prod.skills.some((s) => s.id === 'production-before-real-users'),
      prod.skills.map((s) => s.id).join(', '),
    );
    check(
      'a payments app is warned that verification takes days',
      prod.environment.some((n) => /payment/i.test(n.name) && /days|weeks/i.test(n.note ?? '')),
      JSON.stringify(prod.environment.find((n) => /payment/i.test(n.name))),
    );
    check(
      'an app that emails is told it cannot send from a laptop',
      prod.environment.some((n) => /email/i.test(n.name) && n.status === 'unsupported'),
      JSON.stringify(prod.environment.find((n) => /email/i.test(n.name))),
    );
    check(
      'production is told it needs somewhere to live on the internet',
      prod.environment.some((n) => /internet/i.test(n.name)),
    );
    check(
      'a provided requirements document is carried into the brief verbatim',
      prod.projectMarkdown.includes('Email a receipt.'),
    );

    // --- the Redis question the founder should never have to think about ---
    const queues = await intake.plan(
      answers({ idea: 'A tool that runs scheduled background jobs and a queue' }),
      path.join(root, 'queues'),
    );
    const jobs = queues.environment.find((n) => /background/i.test(n.name));
    check(
      'a queue is solved with Postgres, not by demanding Redis',
      jobs?.status === 'included' && /redis/i.test(jobs.note ?? ''),
      JSON.stringify(jobs),
    );

    // --- what actually lands on disk --------------------------------------
    const target = path.join(root, 'created');
    await intake.create({ ...proto, path: target }, proto.projectMarkdown);
    const written = await readFile(path.join(target, 'PROJECT.md'), 'utf8');
    check('PROJECT.md is written', written.includes('# phone-cases'));

    const skill = await readFile(
      path.join(target, '.claude', 'skills', 'the-stack', 'SKILL.md'),
      'utf8',
    );
    check(
      'skills land where the CLI will find them',
      skill.includes('name: The stack'),
      skill.slice(0, 80),
    );
    check(
      'the stack skill warns against the things we cannot run',
      /docker/i.test(skill) && /redis/i.test(skill),
    );

    // --- the opening message ---------------------------------------------
    check(
      'a project with no requirements opens by asking for them',
      /interview me/i.test(proto.firstMessage),
      proto.firstMessage.slice(0, 100),
    );
    check(
      'a project with requirements opens by starting phase 1',
      /Phase 1/.test(prod.firstMessage) && !/interview me/i.test(prod.firstMessage),
      prod.firstMessage.slice(0, 100),
    );
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${failed === 0 ? 'The wizard produces a usable plan.' : `${failed} case(s) failed.`}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
