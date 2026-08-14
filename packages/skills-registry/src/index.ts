import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  TARGET_MODE_ORDER,
  modeAtLeast,
  type IntentFlag,
  type ProjectIntent,
  type TargetMode,
} from '@shipyard/shared';

/**
 * The skills the agent is given, and what vouches for each one.
 *
 * A skill is an instruction file written into `.claude/skills/` before the
 * agent starts, and it is the most direct influence Shipyard has over what gets
 * built. That makes it the last place to be casual about correctness: a skill
 * that tells the agent PostgreSQL 18 is available when the app now ships 17 is
 * not a stale document, it is a confident instruction to build something that
 * will not run.
 *
 * So three things are declared rather than inferred.
 *
 * **When it applies**, in the same vocabulary as everything else — target modes
 * and intent flags. Until now this was decided by whether the filename started
 * with `prototype-` or `production-`, which worked until somebody named a file
 * badly and nothing said so.
 *
 * **A version**, so that a project created last month can be told its skills
 * have moved on.
 *
 * **Its factual claims**, as data. `asserts: node 24, postgres 18` is checkable
 * against what the app actually ships, and there is a test that checks it. A
 * skill whose claims drift from the toolchain is the failure this catches.
 */

export type SkillTrust =
  /** Reviewed, and any factual claims check out against what ships. */
  | 'verified'
  /** Useful, and nothing has verified its claims. */
  | 'provisional'
  /** Being tried out. Not written into projects unless asked for. */
  | 'experimental';

export interface SkillManifest {
  id: string;
  /** What the agent sees as the skill's name. */
  title: string;
  /** One line. Shown to the founder when explaining what the agent was told. */
  description: string;
  version: string;
  trust: SkillTrust;
  /**
   * Applies from this target mode upwards. Absent means every mode.
   */
  appliesFrom?: TargetMode;
  /**
   * Applies up to and including this mode. Used by the prototype-only skills,
   * whose advice becomes actively wrong once real people are involved.
   */
  appliesUntil?: TargetMode;
  /** Any of these facts being true pulls the skill in regardless of mode. */
  triggeredBy?: IntentFlag[];
  /**
   * Factual claims the skill makes about the environment, as data. Checked
   * against the toolchain rather than trusted.
   */
  asserts?: Record<string, string>;
  /** The markdown, including its front matter, exactly as it is written out. */
  body: string;
}

const ID_RE = /^[a-z][a-z0-9-]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const TRUST: readonly SkillTrust[] = ['verified', 'provisional', 'experimental'];

function fail(id: string, message: string): never {
  throw new Error(`skill "${id}": ${message}`);
}

/** Read the front matter. Deliberately not a YAML parser — this is a fixed shape. */
function parseFrontMatter(body: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
  if (!match?.[1]) return {};
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!pair?.[1]) continue;
    fields[pair[1]] = (pair[2] ?? '').trim().replace(/^["']|["']$/g, '');
  }
  return fields;
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isMode(value: string): value is TargetMode {
  return (TARGET_MODE_ORDER as readonly string[]).includes(value);
}

/** Parse one skill file. */
export function parseSkill(fileName: string, contents: string): SkillManifest {
  const id = fileName.replace(/\.md$/, '');
  const fields = parseFrontMatter(contents);

  if (!ID_RE.test(id)) fail(id, 'the file name must be lower-kebab-case');
  if (fields['id'] && fields['id'] !== id) {
    fail(id, `declares id "${fields['id']}" but lives in ${fileName}`);
  }
  if (!fields['name']?.trim()) fail(id, 'has no name');
  if (!fields['description']?.trim()) fail(id, 'has no description');

  const version = fields['version'] ?? '';
  if (!SEMVER_RE.test(version)) fail(id, `"${version}" is not a version`);

  const trust = (fields['trust'] ?? '') as SkillTrust;
  if (!TRUST.includes(trust)) fail(id, `"${fields['trust']}" is not a trust level`);

  const from = fields['appliesFrom'];
  if (from && !isMode(from)) fail(id, `"${from}" is not a target mode`);
  const until = fields['appliesUntil'];
  if (until && !isMode(until)) fail(id, `"${until}" is not a target mode`);
  const appliesFrom = from as TargetMode | undefined;
  const appliesUntil = until as TargetMode | undefined;
  if (appliesFrom && appliesUntil && !modeAtLeast(appliesUntil, appliesFrom)) {
    fail(id, 'applies from a mode later than the one it applies until, so it applies to nothing');
  }

  // `asserts: node=24, postgres=18`
  const asserts: Record<string, string> = {};
  for (const claim of list(fields['asserts'])) {
    const pair = /^([\w.-]+)\s*=\s*(.+)$/.exec(claim);
    if (!pair?.[1]) fail(id, `"${claim}" is not a claim of the form name=value`);
    asserts[pair[1]] = (pair[2] ?? '').trim();
  }

  // Anything claiming to be verified has to have something to have verified.
  if (trust === 'verified' && Object.keys(asserts).length === 0 && !fields['reviewedAt']) {
    fail(id, 'is marked verified but records neither a claim to check nor a review date');
  }

  return {
    id,
    title: fields['name'] ?? id,
    description: fields['description'] ?? '',
    version,
    trust,
    ...(appliesFrom ? { appliesFrom } : {}),
    ...(appliesUntil ? { appliesUntil } : {}),
    ...(list(fields['triggeredBy']).length
      ? { triggeredBy: list(fields['triggeredBy']) as IntentFlag[] }
      : {}),
    ...(Object.keys(asserts).length ? { asserts } : {}),
    body: contents,
  };
}

/** Load every skill in a directory, refusing a broken one. */
export async function loadSkills(directory: string): Promise<SkillManifest[]> {
  const entries = await readdir(directory).catch(() => [] as string[]);
  const files = entries.filter((name) => name.endsWith('.md')).sort();

  const skills: SkillManifest[] = [];
  for (const file of files) {
    skills.push(parseSkill(file, await readFile(path.join(directory, file), 'utf8')));
  }

  const seen = new Set<string>();
  for (const skill of skills) {
    if (seen.has(skill.id)) fail(skill.id, 'is defined twice');
    seen.add(skill.id);
  }
  return skills;
}

/** Does an intent make this fact true? */
function flagIsSet(intent: Pick<ProjectIntent, IntentFlag>, flag: IntentFlag): boolean {
  return Boolean(intent[flag]);
}

/**
 * The skills this project should be given.
 *
 * `experimental` never arrives by default: a skill nobody has checked is one
 * more confident instruction reaching the agent, and the agent will follow it.
 */
export function skillsFor(
  skills: readonly SkillManifest[],
  intent: Pick<ProjectIntent, 'targetMode'> & Partial<Pick<ProjectIntent, IntentFlag>>,
  options: { includeExperimental?: boolean } = {},
): SkillManifest[] {
  return skills.filter((skill) => {
    if (skill.trust === 'experimental' && !options.includeExperimental) return false;

    const triggered = (skill.triggeredBy ?? []).some((flag) =>
      flagIsSet(intent as Pick<ProjectIntent, IntentFlag>, flag),
    );
    if (triggered) return true;
    // A skill with triggers and no mode range applies only when triggered.
    if (skill.triggeredBy?.length && !skill.appliesFrom && !skill.appliesUntil) return false;

    if (skill.appliesFrom && !modeAtLeast(intent.targetMode, skill.appliesFrom)) return false;
    // `appliesUntil` is inclusive, so a mode above it is out.
    if (skill.appliesUntil && modeAtLeast(intent.targetMode, skill.appliesUntil)) {
      return intent.targetMode === skill.appliesUntil;
    }
    return true;
  });
}

/** One claim that no longer matches reality. */
export interface DriftedClaim {
  skillId: string;
  claim: string;
  says: string;
  actually: string;
}

/**
 * Check what the skills tell the agent against what the app actually ships.
 *
 * This is the whole reason claims are data. A skill saying "Shipyard ships
 * PostgreSQL 18" is not documentation — it is an instruction the agent will act
 * on, and if the bundled runtime moved to 17 the agent will confidently build
 * something that does not run. A prose document cannot be checked; `postgres=18`
 * can.
 */
export function checkClaims(
  skills: readonly SkillManifest[],
  facts: Record<string, string>,
): DriftedClaim[] {
  const drifted: DriftedClaim[] = [];
  for (const skill of skills) {
    for (const [claim, says] of Object.entries(skill.asserts ?? {})) {
      const actually = facts[claim];
      if (actually === undefined) continue;
      // Major-version granularity: a skill saying "Node 24" stays true across
      // 24.19.0 and 24.20.1, and saying otherwise would make the check noise.
      if (!actually.startsWith(says)) {
        drifted.push({ skillId: skill.id, claim, says, actually });
      }
    }
  }
  return drifted;
}

/** What was written into a project, so a later version can be noticed. */
export interface InstalledSkill {
  id: string;
  version: string;
  installedAt: string;
}

/** Skills in the library that are newer than what the project was given. */
export function outdatedSkills(
  skills: readonly SkillManifest[],
  installed: readonly InstalledSkill[],
): { id: string; from: string; to: string }[] {
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  const behind: { id: string; from: string; to: string }[] = [];
  for (const entry of installed) {
    const current = byId.get(entry.id);
    if (!current) continue;
    if (compare(entry.version, current.version) < 0) {
      behind.push({ id: entry.id, from: entry.version, to: current.version });
    }
  }
  return behind;
}

function compare(a: string, b: string): number {
  const parse = (version: string): number[] => version.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [aMajor = 0, aMinor = 0, aPatch = 0] = parse(a);
  const [bMajor = 0, bMinor = 0, bPatch = 0] = parse(b);
  return aMajor - bMajor || aMinor - bMinor || aPatch - bPatch;
}
