/**
 * Do the skills say what they claim, and do they reach the right projects?
 *
 * The case worth having here is the drift check. A skill is a confident
 * instruction reaching the agent before it writes anything; a skill whose facts
 * have gone stale does not look wrong, it looks authoritative.
 *
 *   npx tsx harness/test-skills.ts
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkClaims,
  loadSkills,
  outdatedSkills,
  parseSkill,
  skillsFor,
  type SkillManifest,
} from '../src/index';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const skillsDir = path.join(repoRoot, 'apps', 'desktop', 'resources', 'skills');

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS  ${name}`);
  else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

function expectThrows(name: string, work: () => unknown, pattern: RegExp): void {
  try {
    work();
    check(name, false, 'it did not refuse');
  } catch (error) {
    const message = (error as Error).message;
    check(name, pattern.test(message), `said: ${message}`);
  }
}

const header = (fields: Record<string, string>): string =>
  ['---', ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), '---', '', '# A skill', ''].join('\n');

const valid = { name: 'A skill', description: 'Does a thing', version: '1.0.0', trust: 'provisional' };

async function main(): Promise<void> {
  // ---------------------------------------------------------------- loading
  const skills = await loadSkills(skillsDir);
  check('the shipped skills load', skills.length === 6, `${skills.length} found`);
  check('every one has a version', skills.every((skill) => /^\d+\.\d+\.\d+$/.test(skill.version)));
  check('and a trust level', skills.every((skill) => Boolean(skill.trust)));
  check(
    'and a description written for a person',
    skills.every((skill) => skill.description.length > 20),
  );
  check('the body is kept whole, front matter and all', skills.every((skill) => skill.body.startsWith('---')));

  // ------------------------------------------------------------- validation
  expectThrows(
    'a skill with no version is refused',
    () => parseSkill('thing.md', header({ name: 'x', description: 'y', trust: 'provisional' })),
    /is not a version/,
  );
  expectThrows(
    'a skill with no trust level is refused',
    () => parseSkill('thing.md', header({ name: 'x', description: 'y', version: '1.0.0' })),
    /is not a trust level/,
  );
  expectThrows(
    'a skill with no description is refused',
    () => parseSkill('thing.md', header({ ...valid, description: '' })),
    /no description/,
  );
  expectThrows(
    'an id that disagrees with the file name is refused',
    () => parseSkill('thing.md', header({ ...valid, id: 'other-thing' })),
    /lives in thing\.md/,
  );
  expectThrows(
    'a mode nobody has heard of is refused',
    () => parseSkill('thing.md', header({ ...valid, appliesFrom: 'when_ready' })),
    /is not a target mode/,
  );
  expectThrows(
    'a range that covers nothing is refused',
    () =>
      parseSkill(
        'thing.md',
        header({ ...valid, appliesFrom: 'production_product', appliesUntil: 'ui_concept' }),
      ),
    /applies to nothing/,
  );
  expectThrows(
    'calling itself verified with nothing to check is refused',
    () => parseSkill('thing.md', header({ ...valid, trust: 'verified' })),
    /neither a claim to check nor a review date/,
  );
  expectThrows(
    'a malformed claim is refused',
    () => parseSkill('thing.md', header({ ...valid, asserts: 'node 24' })),
    /not a claim of the form/,
  );

  const parsed = parseSkill(
    'thing.md',
    header({ ...valid, asserts: 'node=24, postgres=18', triggeredBy: 'payments, sensitiveData' }),
  );
  check('claims are parsed as data', parsed.asserts?.['node'] === '24' && parsed.asserts?.['postgres'] === '18');
  check('triggers are parsed as a list', parsed.triggeredBy?.length === 2);

  // ------------------------------------------------------------- who gets what
  const concept = { targetMode: 'ui_concept' as const };
  const pilot = { targetMode: 'customer_pilot' as const };

  const forConcept = skillsFor(skills, concept).map((skill) => skill.id);
  const forPilot = skillsFor(skills, pilot).map((skill) => skill.id);

  check('a concept build is told what it may fake', forConcept.includes('prototype-what-you-may-fake'));
  check(
    'and is not given the production obligations',
    !forConcept.includes('production-before-real-users'),
    forConcept.join(', '),
  );
  check('a pilot is given the production obligations', forPilot.includes('production-before-real-users'));
  check(
    'and is no longer told what it may fake, because it may not',
    !forPilot.includes('prototype-what-you-may-fake'),
    forPilot.join(', '),
  );
  check('everybody gets the stack', forConcept.includes('the-stack') && forPilot.includes('the-stack'));

  // The library only saves work if the agent is told to look at it, and it is
  // as worth looking at on day one as it is at launch.
  check(
    'every project is told to check the library first',
    forConcept.includes('use-what-exists') && forPilot.includes('use-what-exists'),
    `${forConcept.join(', ')} / ${forPilot.join(', ')}`,
  );
  check('and how to talk to the owner', forConcept.includes('talking-to-a-non-programmer'));

  // The old rule read this off the filename prefix. This is the same answer,
  // now declared rather than inferred.
  check(
    'a functional prototype still gets the prototype skill',
    skillsFor(skills, { targetMode: 'functional_prototype' })
      .map((skill) => skill.id)
      .includes('prototype-what-you-may-fake'),
  );
  check(
    'and a production build does not',
    !skillsFor(skills, { targetMode: 'production_product' })
      .map((skill) => skill.id)
      .includes('prototype-what-you-may-fake'),
  );

  // Deliberately without triggers: this case is about trust, and a fixture
  // that also fails the trigger rule would pass or fail for the wrong reason.
  const experimental: SkillManifest = {
    id: 'an-experiment',
    title: 'An experiment',
    description: 'Something being tried out',
    version: '0.1.0',
    trust: 'experimental',
    body: '---\n---\n',
  };
  check(
    'an unchecked skill is never given out by accident',
    !skillsFor([...skills, experimental], pilot).some((skill) => skill.id === 'an-experiment'),
  );
  check(
    'but can be asked for',
    skillsFor([...skills, experimental], pilot, { includeExperimental: true }).some(
      (skill) => skill.id === 'an-experiment',
    ),
  );

  const triggered: SkillManifest = {
    ...parsed,
    id: 'money-handling',
    trust: 'provisional',
    triggeredBy: ['payments'],
  };
  check(
    'a skill about payments reaches a project that takes payments',
    skillsFor([triggered], { ...concept, payments: true }).length === 1,
  );
  check(
    'and stays away from one that does not',
    skillsFor([triggered], { ...concept, payments: false }).length === 0,
  );

  // ------------------------------------------------------ claims against reality
  const toolchainSource = await readFile(
    path.join(repoRoot, 'apps', 'desktop', 'scripts', 'fetch-toolchain.mjs'),
    'utf8',
  );
  const nodeVersion = /const NODE_VERSION = '([^']+)'/.exec(toolchainSource)?.[1] ?? '';
  const postgresVersion = /const POSTGRES_VERSION = '([^']+)'/.exec(toolchainSource)?.[1] ?? '';

  check('the toolchain versions were found', Boolean(nodeVersion && postgresVersion), `${nodeVersion} / ${postgresVersion}`);

  // This is the case that earns the whole mechanism. If the bundled runtime
  // moves and a skill still says the old number, the agent is being told to
  // build against something that is not there.
  const drift = checkClaims(skills, { node: nodeVersion, postgres: postgresVersion });
  check(
    'what the skills tell the agent matches what the app ships',
    drift.length === 0,
    drift.map((d) => `${d.skillId} says ${d.claim} ${d.says}, actually ${d.actually}`).join('; '),
  );

  check(
    'and a skill that has gone stale is caught',
    checkClaims(skills, { node: '22.0.0', postgres: postgresVersion }).some(
      (d) => d.skillId === 'the-stack' && d.claim === 'node',
    ),
  );
  check(
    'a claim about something we know nothing about is not a failure',
    checkClaims([parsed], {}).length === 0,
  );
  check(
    'a patch release does not count as drift',
    checkClaims(skills, { node: '24.99.1', postgres: postgresVersion }).length === 0,
  );

  // ----------------------------------------------------------------- versions
  const behind = outdatedSkills(skills, [
    { id: 'the-stack', version: '0.9.0', installedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'building-in-phases', version: '1.0.0', installedAt: '2026-01-01T00:00:00.000Z' },
  ]);
  check('a project on an older skill is told', behind.length === 1 && behind[0]?.id === 'the-stack');
  check('with where it is going', behind[0]?.from === '0.9.0' && behind[0]?.to === '1.0.0');
  check(
    'a skill that no longer exists is not reported as outdated',
    outdatedSkills(skills, [{ id: 'gone', version: '0.1.0', installedAt: '2026-01-01T00:00:00.000Z' }]).length === 0,
  );

  console.log(`\n${failed === 0 ? 'All skill cases pass.' : `${failed} case(s) failed.`}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
