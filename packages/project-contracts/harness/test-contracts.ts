/**
 * Do the contracts say what is true, and does ARCHITECTURE.md read like a
 * document a person would keep?
 *
 * The case worth having is the last section: what the project deliberately does
 * not do. Everything else is derivable and boring; that section is the one
 * people wish they had read first, and the one most likely to be dropped.
 *
 *   npx tsx harness/test-contracts.ts
 */
import {
  CONTRACT_FILES,
  architectureMarkdown,
  contracts,
  planContract,
  projectContract,
  readinessContract,
  rulesContract,
  type ContractInput,
} from '../src/index';
import type { ProjectIntent, ResolvedCapability, RuleOutcome } from '@shipyard/shared';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS  ${name}`);
  else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

const intent: ProjectIntent = {
  targetMode: 'customer_pilot',
  projectType: 'booking_saas',
  regions: ['GB'],
  sensitiveData: true,
  payments: true,
  aiAffectsConsequentialDecision: false,
  humanReviewRequired: false,
  publicFacing: true,
  existingCodeSource: 'new_project',
};

const auth: ResolvedCapability = {
  capability: { id: 'authentication', label: 'Signing in', category: 'identity' },
  status: 'included',
  reason: 'Real customers are going to use this, so they need a way to sign in.',
  gates: ['auth_login_works'],
  components: ['auth'],
  recipes: [],
};

const mobile: ResolvedCapability = {
  capability: { id: 'native_mobile', label: 'A phone app', category: 'foundation' },
  status: 'unsupported',
  reason: 'Shipyard cannot build phone apps. A website that works well on a phone is the nearest thing.',
  gates: [],
  components: [],
  recipes: [],
};

const laterOn: ResolvedCapability = {
  capability: { id: 'uptime_monitoring', label: 'Something watching it for you', category: 'operations' },
  status: 'deferred',
  reason: 'Needed before you go live, not while you are still building.',
  gates: [],
  components: [],
  recipes: [],
};

const blocker: RuleOutcome = {
  ruleId: 'privacy.retention.stated',
  ruleVersion: 1,
  category: 'privacy',
  severity: 'blocker',
  message: 'You have not said how long you keep people’s information.',
  applies: true,
  satisfied: false,
  requiredGates: ['data_retention_statement_written'],
  missingGates: ['data_retention_statement_written'],
  requiredComponents: [],
  humanReviewRequired: true,
  serviceTriggers: [],
};

const notApplicable: RuleOutcome = {
  ...blocker,
  ruleId: 'payments.webhooks.verified',
  applies: false,
  satisfied: true,
  humanReviewRequired: false,
};

const input: ContractInput = {
  projectId: 'proj_1',
  name: 'Chair Share',
  idea: 'A booking site where salons rent out chairs by the day.',
  intent,
  phases: [
    { title: 'The booking screen', outcome: 'Somebody can pick a day and confirm it.', effort: 'a few days' },
    { title: 'Payment', outcome: 'The deposit is actually taken.', effort: 'about a week' },
  ],
  capabilityPlan: {
    resolved: [auth, mobile, laterOn],
    included: [auth],
    deferred: [laterOn],
    unsupported: [mobile],
    gates: ['auth_login_works'],
    components: ['auth'],
    recipes: [],
    serviceTriggers: [],
  },
  ruleOutcomes: [blocker, notApplicable],
  readiness: { score: 58, threshold: 70, ready: false, nextActions: ['Say how long you keep information.'] },
  installed: [
    {
      componentId: 'auth',
      version: '1.0.0',
      installedAt: '2026-08-10T09:00:00.000Z',
      files: ['src/components/auth/session.ts'],
      protectedPaths: ['src/components/auth/session.ts'],
      status: 'installed',
    },
    {
      componentId: 'audit_logging',
      version: '1.0.0',
      installedAt: '2026-08-11T09:00:00.000Z',
      files: [],
      protectedPaths: [],
      status: 'removed',
    },
  ],
  evidenceCount: 12,
  generatedAt: '2026-08-14T10:00:00.000Z',
};

function main(): void {
  // ------------------------------------------------------------------ project
  const project = projectContract(input);
  check('the project contract carries the founder’s own words', project.idea.includes('salons'));
  check('and how far it is going', project.targetMode === 'customer_pilot');
  check('and the stack, so nothing has to guess', project.stack.database === 'PostgreSQL');
  check('it is versioned, so a reader knows what shape to expect', project.contractVersion === 1);

  // --------------------------------------------------------------------- plan
  const plan = planContract(input);
  check('phases are numbered', plan.phases[0]?.index === 1 && plan.phases[1]?.index === 2);
  check('every capability is listed with its reason', plan.capabilities.length === 3);
  check(
    'including the ones Shipyard cannot do',
    plan.unsupported[0]?.id === 'native_mobile',
    JSON.stringify(plan.unsupported),
  );
  check('and the ones deferred until later', plan.deferred.includes('uptime_monitoring'));
  check('installed parts are recorded with versions', plan.installedComponents[0]?.version === '1.0.0');
  check(
    'and one that was removed is not listed as installed',
    !plan.installedComponents.some((component) => component.id === 'audit_logging'),
  );

  // -------------------------------------------------------------------- rules
  const rules = rulesContract(input);
  check('only rules that apply are recorded', rules.applicable.length === 1);
  check(
    'a rule that does not apply is left out rather than marked satisfied',
    !rules.applicable.some((rule) => rule.ruleId === 'payments.webhooks.verified'),
  );
  check('blockers are named', rules.blockers.includes('privacy.retention.stated'));
  check('and so is anything needing a person', rules.humanReviewRequired.length === 1);

  // ---------------------------------------------------------------- readiness
  const readiness = readinessContract(input);
  check('readiness carries the score and the bar', readiness.score === 58 && readiness.threshold === 70);
  check('and is honest that it is below it', readiness.ready === false);
  check(
    'the file says what the number is measured against',
    /whole production checklist/.test(readiness.scoredAgainst),
  );
  check('blockers are in the founder’s words, not rule ids', /how long you keep/.test(readiness.blockers[0] ?? ''));
  check('and how much evidence there is behind it', readiness.evidenceCount === 12);

  // ------------------------------------------------------------- all four
  const all = contracts(input);
  check('all four files are produced', Object.keys(all).length === 4);
  check('under the names the plan gave them', Object.keys(all).includes(CONTRACT_FILES.readiness));
  check(
    'and every one is serialisable',
    (() => {
      try {
        JSON.stringify(all);
        return true;
      } catch {
        return false;
      }
    })(),
  );
  check(
    'regenerating with the same input gives the same bytes',
    JSON.stringify(contracts(input)) === JSON.stringify(contracts(input)),
  );

  // ------------------------------------------------------------ architecture
  const doc = architectureMarkdown(input);
  check('the document is titled with the project', doc.startsWith('# Chair Share'));
  check('and says what the app is in the founder’s words', doc.includes('salons rent out chairs'));
  check('and how far it is going, in words rather than an enum', /pilot with real customers/.test(doc));
  check('the stack is stated', doc.includes('PostgreSQL'));
  check('with the reason it is not open to choice', /cannot run on the owner’s machine/.test(doc));

  check('each capability is listed with its reason', /Real customers are going to use this/.test(doc));
  check('and what provides it', /`auth` \(installed\)/.test(doc));
  check(
    'a capability with no component says it will be written',
    architectureMarkdown({
      ...input,
      capabilityPlan: { ...input.capabilityPlan, included: [{ ...auth, components: [] }] },
    }).includes('written for this project'),
  );

  check('installed parts get their own section', /Ready-made parts in use/.test(doc));
  check('with the instruction not to rewrite them', /not to rewrite them/.test(doc));
  check('and a removed one is not listed', !doc.includes('audit_logging'));

  check('the phases are listed in order', doc.indexOf('The booking screen') < doc.indexOf('Payment'));
  check('with what each one produces', /Somebody can pick a day/.test(doc));
  check(
    'and why a phase has to end in something visible',
    /progress and the appearance of\s*progress are the same thing/.test(doc),
  );

  check('readiness is stated with its bar', /58 out of 100.*bar of 70/s.test(doc));
  check('and explained rather than left to be misread', /what changes with ambition is the bar/.test(doc));
  check('blockers are listed in plain words', /how long you keep people’s information/.test(doc));

  // The section this document exists for.
  check('there is a section on what it deliberately does not do', /deliberately does not do/.test(doc));
  check('naming what Shipyard cannot build', /A phone app/.test(doc));
  check('and what is deferred rather than forgotten', /Something watching it for you/.test(doc));
  check('and why that section is there at all', /decided deliberately in week one/.test(doc));

  const conceptDoc = architectureMarkdown({
    ...input,
    intent: { ...intent, targetMode: 'ui_concept', payments: false, sensitiveData: false },
  });
  check(
    'a concept build is told plainly it is not ready for strangers',
    /Being used by strangers/.test(conceptDoc),
  );
  check('and that nothing charges anybody', /Nothing here charges anybody/.test(conceptDoc));
  check(
    'and that the no-sensitive-data assumption has consequences if it changes',
    /the obligations change with it/.test(conceptDoc),
  );

  const emptyDoc = architectureMarkdown({
    ...input,
    phases: [],
    capabilityPlan: { ...input.capabilityPlan, included: [], deferred: [], unsupported: [] },
    installed: [],
    ruleOutcomes: [],
  });
  check('a project with nothing decided yet still produces a document', emptyDoc.length > 400);
  check('that says so rather than showing an empty table', /has not been resolved/.test(emptyDoc));
  check('and does not invent a ready-made parts section', !/Ready-made parts in use/.test(emptyDoc));

  check(
    'the document never lapses into jargon at the founder',
    !/\b(CRUD|ORM layer|DTO|idempotency)\b/.test(doc),
  );
  check(
    'and says it is generated, so nobody edits it by hand',
    /Generated by Shipyard/.test(doc) && /edit the project, not this file/.test(doc),
  );

  console.log(`\n${failed === 0 ? 'All contract cases pass.' : `${failed} case(s) failed.`}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
