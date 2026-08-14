import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  TARGET_MODE_ORDER,
  modeAtLeast,
  type AskWhen,
  type ConnectionState,
  type ConnectionStatus,
  type Evidence,
  type LeadTime,
  type ProjectIntent,
  type Recipe,
  type SetupPrompt,
  type TargetMode,
} from '@shipyard/shared';

/**
 * Connectors, and the question that actually matters: when to ask.
 *
 * The obvious answer — ask for an account when the thing that needs it gets
 * built — is wrong in both directions, and each way of being wrong has a
 * distinct cost.
 *
 * **Ask too late and the wait becomes the launch date.** Stripe verifies who
 * you are before it will pay out, and that takes days. A founder told about it
 * on the morning they wanted to launch has already lost the week. Same for
 * email: a sending domain needs DNS records that take a day to spread, and
 * until they have, the email either does not send or goes to spam.
 *
 * **Ask too early and nobody does any of it.** A founder asked at project
 * creation to open five accounts for a thing that does not exist yet will skip
 * all five, and will keep skipping the sixth — which is the one that mattered.
 * Sentry takes two minutes; asking for it before there is an app to break is
 * noise, and noise is what teaches people to ignore setup steps.
 *
 * So the timing comes from two facts, neither of which is a guess: **how long
 * the founder has to wait** (a property of the vendor) and **when the thing is
 * actually needed** (a property of the project). Long wait, ask now, even
 * though it is not needed for weeks. Short wait, ask at the moment of need.
 */

const ID_RE = /^[a-z][a-z0-9_]*$/;
const LEAD_TIMES: readonly LeadTime[] = ['instant', 'short', 'long'];

function fail(id: string, message: string): never {
  throw new Error(`recipe "${id}": ${message}`);
}

/** Load the recipes, refusing a broken one. */
export async function loadRecipes(
  directory: string,
  options: { knownGates?: readonly string[]; knownVendors?: readonly string[]; knownCapabilities?: readonly string[] } = {},
): Promise<Recipe[]> {
  const entries = await readdir(directory).catch(() => [] as string[]);
  const files = entries.filter((name) => name.endsWith('.json')).sort();

  const recipes: Recipe[] = [];
  for (const file of files) {
    const parsed: unknown = JSON.parse(await readFile(path.join(directory, file), 'utf8'));
    if (!Array.isArray(parsed)) throw new Error(`${file}: expected an array`);
    recipes.push(...(parsed as Recipe[]));
  }

  const seen = new Set<string>();
  for (const recipe of recipes) {
    const id = recipe.id ?? '(no id)';
    if (!ID_RE.test(id)) fail(id, 'the id must be lower_snake_case');
    if (seen.has(id)) fail(id, 'is defined twice');
    seen.add(id);

    if (!recipe.name?.trim()) fail(id, 'needs a name a person would read');
    if (!recipe.summary?.trim()) fail(id, 'needs a one-line summary');
    if (!LEAD_TIMES.includes(recipe.leadTime)) fail(id, `"${recipe.leadTime}" is not a lead time`);
    if (!recipe.steps?.length) fail(id, 'has no steps');

    // A recipe with no check is a set of instructions nobody can confirm was
    // followed — which is exactly the state this whole layer exists to end.
    if (!recipe.verifiedBy?.trim()) fail(id, 'has no check that would prove it worked');
    if (options.knownGates && !options.knownGates.includes(recipe.verifiedBy)) {
      fail(id, `is proved by "${recipe.verifiedBy}", which nothing runs`);
    }
    if (options.knownVendors && !options.knownVendors.includes(recipe.vendorId)) {
      fail(id, `names vendor "${recipe.vendorId}", which is not in the catalog`);
    }
    if (options.knownCapabilities) {
      for (const capability of recipe.capabilities ?? []) {
        if (!options.knownCapabilities.includes(capability)) {
          fail(id, `serves "${capability}", which is not in the catalog`);
        }
      }
    }

    for (const step of recipe.steps) {
      if (!step.instruction?.trim()) fail(id, 'has a step with no instruction');
      if (!['founder', 'shipyard', 'agent'].includes(step.actor)) {
        fail(id, `"${step.actor}" is not somebody who can do a step`);
      }
    }

    // The rule that keeps this honest: Shipyard never asks for a password.
    for (const step of recipe.steps) {
      if (/\b(password|passphrase|login details|sign in with your)\b/i.test(step.instruction)) {
        fail(id, 'asks the founder for a password. Connectors use keys the founder can revoke.');
      }
    }
    for (const secret of recipe.secrets ?? []) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(secret)) fail(id, `"${secret}" is not an environment variable name`);
    }
  }

  return recipes;
}

/**
 * How long the founder is really waiting, in words rather than a category.
 *
 * Written for the person deciding whether to do it now or after lunch, so it
 * separates their effort from the waiting. "Ten minutes, then up to two days
 * waiting" is a sentence somebody can plan around; "medium setup complexity" is
 * not.
 */
export function effortFor(recipe: Recipe): string {
  const steps = recipe.steps.filter((step) => step.actor === 'founder').length;
  const hands = steps <= 2 ? 'about five minutes' : steps <= 4 ? 'ten or fifteen minutes' : 'half an hour';
  switch (recipe.leadTime) {
    case 'instant':
      return `${hands}, and it works straight away.`;
    case 'short':
      return `${hands}, and it should be working within the day.`;
    case 'long':
      return `${hands} of your time, then up to a few days of waiting for them to check things.`;
  }
}

/**
 * When to ask, and why now.
 *
 * The rule in one line: **the longer the wait, the earlier the ask.** Anything
 * with a multi-day wait is raised as soon as the project is known to need it,
 * because starting late is the only thing that makes it late.
 */
export function whenToAsk(
  recipe: Recipe,
  input: {
    intent: Pick<ProjectIntent, 'targetMode'>;
    /** Capability ids this project has been resolved to need. */
    neededCapabilities: readonly string[];
    /** Component ids currently installed. */
    installedComponents?: readonly string[];
    /** True once the connection has been proved working. */
    alreadyWorking?: boolean;
  },
): SetupPrompt {
  const base = {
    recipeId: recipe.id,
    name: recipe.name,
    effort: effortFor(recipe),
  };

  const serves = (recipe.capabilities ?? []).some((capability) =>
    input.neededCapabilities.includes(capability),
  );

  if (!serves) {
    return {
      ...base,
      when: 'not_needed',
      reason: 'Nothing in this project needs it.',
      blocksLaunch: false,
    };
  }

  if (input.alreadyWorking) {
    return { ...base, when: 'not_needed', reason: 'This is already set up and working.', blocksLaunch: false };
  }

  const requiredFrom = recipe.requiredFrom ?? 'customer_pilot';
  const dueNow = modeAtLeast(input.intent.targetMode, requiredFrom);
  const blocksLaunch = dueNow;

  // The case this function exists for. A long wait started on the day it is due
  // is a delay, not a task — so it is raised the moment the project is known to
  // need it, whatever mode the founder is currently building at.
  if (recipe.leadTime === 'long') {
    return {
      ...base,
      when: 'now',
      reason: longWaitReason(recipe, dueNow),
      blocksLaunch,
    };
  }

  if (dueNow) {
    const componentReady =
      !recipe.requiresComponents?.length ||
      recipe.requiresComponents.every((id) => input.installedComponents?.includes(id));
    return {
      ...base,
      when: componentReady ? 'at_build' : 'before_pilot',
      reason: componentReady
        ? `The part of your app that uses this is in place, so this is the step that makes it actually work.`
        : `You will need this before real people use it. It is quick, so there is no rush until the rest is built.`,
      blocksLaunch,
    };
  }

  return {
    ...base,
    when: 'later',
    reason: `Not needed while you are building ${describeMode(input.intent.targetMode)}. It comes up when you move to ${describeMode(requiredFrom)}, and it only takes a few minutes.`,
    blocksLaunch: false,
  };
}

function longWaitReason(recipe: Recipe, dueNow: boolean): string {
  // The reason has to name the wait, or "do this now" reads as busywork for
  // something the founder can see is not needed yet.
  const critical = recipe.steps.find((step) => step.critical && step.because);
  const why = critical?.because ?? 'This one involves someone else checking things, which takes days rather than minutes.';
  return dueNow
    ? `${why} Start it today — it is the most likely thing to hold up your launch.`
    : `${why} You do not need it yet, and that is exactly why it is worth starting now: the waiting happens while you carry on building.`;
}

function describeMode(mode: TargetMode): string {
  switch (mode) {
    case 'ui_concept':
      return 'something to look at';
    case 'functional_prototype':
      return 'a working prototype';
    case 'customer_pilot':
      return 'a pilot with real customers';
    case 'production_product':
      return 'a live product';
  }
}

/**
 * Everything worth raising, worst first.
 *
 * Sorted so the things that will hold up a launch come before the things that
 * merely need doing. A founder reading a list does the top item; putting a
 * two-minute Sentry signup above a five-day Stripe verification is how the
 * five-day one gets started on day five.
 */
export function setupQueue(
  recipes: readonly Recipe[],
  input: Parameters<typeof whenToAsk>[1] & { working?: readonly string[] },
): SetupPrompt[] {
  const order: Record<AskWhen, number> = { now: 0, at_build: 1, before_pilot: 2, later: 3, not_needed: 4 };
  return recipes
    .map((recipe) =>
      whenToAsk(recipe, { ...input, alreadyWorking: input.working?.includes(recipe.id) ?? false }),
    )
    .filter((prompt) => prompt.when !== 'not_needed')
    .sort(
      (a, b) =>
        order[a.when] - order[b.when] ||
        Number(b.blocksLaunch) - Number(a.blocksLaunch) ||
        a.name.localeCompare(b.name),
    );
}

/**
 * What Shipyard can honestly say about a connection.
 *
 * Note what is missing: any way to say "your key is valid". Shipyard never
 * receives the key, so it cannot test one. The only evidence that counts is the
 * project's own check having run and passed — which is a stronger claim anyway,
 * because it proves the app works rather than that a string is well formed.
 */
export function connectionStatus(
  recipe: Recipe,
  input: {
    evidence: readonly Evidence[];
    /** Variable names the project's `.env.example` declares. */
    declared?: readonly string[];
    /** Names the founder has said they filled in. Never their values. */
    claimed?: readonly string[];
  },
): ConnectionStatus {
  const proof = input.evidence.find((entry) => entry.gateId === recipe.verifiedBy);
  const wanted = [...(recipe.secrets ?? []), ...(recipe.settings ?? []).map((setting) => setting.name)];
  const missingSettings = wanted.filter((name) => !(input.claimed ?? []).includes(name));

  let state: ConnectionState = 'not_started';
  if (proof?.status === 'passed') state = 'working';
  else if (proof?.status === 'failed') state = 'broken';
  else if (missingSettings.length === 0 && wanted.length > 0) state = 'claimed';

  return {
    recipeId: recipe.id,
    state,
    missingSettings,
    ...(proof?.observedAt ? { lastCheckedAt: proof.observedAt } : {}),
    summary: describeState(state, recipe, missingSettings),
  };
}

function describeState(state: ConnectionState, recipe: Recipe, missing: string[]): string {
  switch (state) {
    case 'working':
      return 'Set up and working — this was proved by running it, not by asking.';
    case 'broken':
      return 'It is set up, but the check for it is failing. Something is wrong with the connection rather than with your app.';
    case 'claimed':
      // The distinction that keeps the readiness score honest.
      return 'The settings are filled in, but nothing has confirmed it works yet. Run the check to find out.';
    case 'not_started':
      return missing.length > 0
        ? `Not set up yet. You will need: ${missing.join(', ')}.`
        : `Not set up yet.`;
  }
}

/** The steps the founder has to do themselves, numbered for a screen. */
export function founderSteps(recipe: Recipe): { number: number; instruction: string; url?: string; because?: string; produces?: string; critical: boolean }[] {
  return recipe.steps
    .filter((step) => step.actor === 'founder')
    .map((step, index) => ({
      number: index + 1,
      instruction: step.instruction,
      ...(step.url ? { url: step.url } : {}),
      ...(step.because ? { because: step.because } : {}),
      ...(step.produces ? { produces: step.produces } : {}),
      critical: step.critical ?? false,
    }));
}

export { TARGET_MODE_ORDER };
