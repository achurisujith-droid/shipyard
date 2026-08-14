import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { TARGET_MODE_ORDER, type Rule, type Severity, type TargetMode } from '@shipyard/shared';

/**
 * Load the rulebook from disk.
 *
 * Rules live in `shipyard-catalog/rules/`, outside application code, so that
 * changing what Shipyard requires before a launch is a data change that can be
 * reviewed and reverted on its own — not a release of the desktop app.
 *
 * Validation is strict and loud. A malformed rule that silently fails to load
 * is a launch gate that quietly stops existing, which is the worst possible
 * failure for this particular file.
 */

const CATEGORIES = new Set<Rule['category']>([
  'mode',
  'security',
  'privacy',
  'payments',
  'deployment',
  'observability',
  'testing',
  'escalation',
]);

const SEVERITIES = new Set<Severity>(['blocker', 'warning', 'recommendation']);

const FLAGS = new Set([
  'sensitiveData',
  'payments',
  'aiAffectsConsequentialDecision',
  'humanReviewRequired',
  'publicFacing',
]);

const MODES = new Set<string>(TARGET_MODE_ORDER);

class RuleError extends Error {
  constructor(source: string, detail: string) {
    super(`${source}: ${detail}`);
    this.name = 'RuleError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, source: string, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new RuleError(source, `${field} must be an array of strings`);
  }
  return value as string[];
}

/** Validate one parsed rule, or throw with enough detail to fix it. */
export function parseRule(input: unknown, source: string): Rule {
  if (!isRecord(input)) throw new RuleError(source, 'rule must be an object');

  const { id, version, category, severity, message } = input;
  if (typeof id !== 'string' || id.length === 0) throw new RuleError(source, 'id is required');
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new RuleError(source, 'version must be an integer');
  }
  if (typeof category !== 'string' || !CATEGORIES.has(category as Rule['category'])) {
    throw new RuleError(source, `category must be one of ${[...CATEGORIES].join(', ')}`);
  }
  if (typeof severity !== 'string' || !SEVERITIES.has(severity as Severity)) {
    throw new RuleError(source, `severity must be one of ${[...SEVERITIES].join(', ')}`);
  }
  if (typeof message !== 'string' || message.length === 0) {
    throw new RuleError(source, 'message is required and is what the user reads');
  }

  const when = isRecord(input['when']) ? input['when'] : {};
  const require = isRecord(input['require']) ? input['require'] : {};

  const minMode = when['minMode'];
  if (minMode !== undefined && (typeof minMode !== 'string' || !MODES.has(minMode))) {
    throw new RuleError(source, `when.minMode must be one of ${[...MODES].join(', ')}`);
  }
  const modeIn = stringArray(when['modeIn'], source, 'when.modeIn');
  for (const mode of modeIn ?? []) {
    if (!MODES.has(mode)) throw new RuleError(source, `when.modeIn has unknown mode "${mode}"`);
  }
  for (const field of ['factsTrue', 'factsFalse'] as const) {
    for (const flag of stringArray(when[field], source, `when.${field}`) ?? []) {
      if (!FLAGS.has(flag)) throw new RuleError(source, `when.${field} has unknown fact "${flag}"`);
    }
  }

  // A rule that requires nothing can never fail, so it can never be a blocker.
  // Catching it here rather than at a launch is the point of validating at all.
  const gates = stringArray(require['gates'], source, 'require.gates');
  const components = stringArray(require['components'], source, 'require.components');
  if (severity === 'blocker' && (gates ?? []).length === 0 && require['humanReview'] !== true) {
    throw new RuleError(source, 'a blocker must require at least one gate or a human review');
  }

  const rule: Rule = {
    id,
    version,
    category: category as Rule['category'],
    severity: severity as Severity,
    message,
    when: {
      ...(minMode ? { minMode: minMode as TargetMode } : {}),
      ...(modeIn ? { modeIn: modeIn as TargetMode[] } : {}),
      ...(when['factsTrue'] ? { factsTrue: when['factsTrue'] as Rule['when']['factsTrue'] } : {}),
      ...(when['factsFalse'] ? { factsFalse: when['factsFalse'] as Rule['when']['factsFalse'] } : {}),
      ...(when['capabilities']
        ? { capabilities: stringArray(when['capabilities'], source, 'when.capabilities') }
        : {}),
    },
    require: {
      ...(gates ? { gates } : {}),
      ...(components ? { components } : {}),
      ...(require['humanReview'] === true ? { humanReview: true } : {}),
      ...(require['serviceTriggers']
        ? { serviceTriggers: stringArray(require['serviceTriggers'], source, 'require.serviceTriggers') }
        : {}),
    },
  };

  return rule;
}

/** Parse a rules file, which holds an array of rules. */
export function parseRules(json: string, source: string): Rule[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (err) {
    throw new RuleError(source, `not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(data)) throw new RuleError(source, 'file must contain an array of rules');
  return data.map((rule, index) => parseRule(rule, `${source}[${index}]`));
}

/**
 * Load every rule in a directory, sorted by id.
 *
 * Sorted so that evaluation output does not change because a filesystem
 * returned entries in a different order, which would make readiness look
 * unstable for no reason.
 */
export async function loadRules(directory: string): Promise<Rule[]> {
  const entries = await readdir(directory);
  const files = entries.filter((name) => name.endsWith('.json')).sort();

  const rules: Rule[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const contents = await readFile(path.join(directory, file), 'utf8');
    for (const rule of parseRules(contents, file)) {
      // Two rules with one id means one of them silently stops applying.
      if (seen.has(rule.id)) throw new RuleError(file, `duplicate rule id "${rule.id}"`);
      seen.add(rule.id);
      rules.push(rule);
    }
  }
  return rules.sort((a, b) => a.id.localeCompare(b.id));
}
