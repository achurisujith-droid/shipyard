import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  connectionStatus,
  founderSteps,
  loadRecipes,
  setupQueue,
} from '@shipyard/connectors';
import { loadCatalog, resolve } from '@shipyard/capability-resolver';
import { installedIn } from '@shipyard/component-library';
import type { ConnectionStatus, Recipe, SetupPrompt } from '@shipyard/shared';

import type { Metadata } from './metadata';

/**
 * Connectors, from the app's point of view.
 *
 * The one thing worth being careful about is what this reads. It reads
 * `.env.example`, which is a template Shipyard wrote and which contains
 * variable names and no values. It never reads `.env`.
 *
 * That is not squeamishness — it is what makes the rest of the product's
 * promise true. Shipyard tells a founder it does not hold their credentials, so
 * the code has to be arranged such that it could not, and a support bundle or a
 * crash report cannot contain what was never loaded.
 *
 * The consequence is that Shipyard cannot tell anyone their key is valid. It
 * can only say whether the project's own check passed, which is a better answer
 * anyway: it proves the app works rather than that a string is well formed.
 */
export class Connectors {
  private recipes: Recipe[] | null = null;

  constructor(
    private readonly catalogRoot: string,
    private readonly metadata: Metadata,
  ) {}

  private async load(): Promise<Recipe[]> {
    if (!this.recipes) {
      this.recipes = await loadRecipes(path.join(this.catalogRoot, 'recipes'));
    }
    return this.recipes;
  }

  /**
   * Which variable names the project has been told about.
   *
   * From `.env.example` — the template, not the filled-in file. A name being
   * present means Shipyard asked for it; it says nothing about whether the
   * founder has supplied a value, and this deliberately has no way to find out.
   */
  private async declaredSettings(projectPath: string): Promise<string[]> {
    const template = await readFile(path.join(projectPath, '.env.example'), 'utf8').catch(() => '');
    return template
      .split('\n')
      .map((line) => /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line)?.[1])
      .filter((name): name is string => Boolean(name));
  }

  /** What to ask the founder to go and do, worst first. */
  async queue(projectPath: string, projectId?: string): Promise<SetupPrompt[]> {
    const [recipes, catalog] = await Promise.all([this.load(), loadCatalog(this.catalogRoot)]);
    const intent = projectId ? this.metadata.intent(projectId) : undefined;
    if (!intent) return [];

    const plan = resolve(intent, catalog.capabilities, catalog.vendors);
    const installed = Object.keys(await installedIn(projectPath).catch(() => ({})));
    const evidence = projectId ? this.metadata.latestEvidence(projectId) : [];

    const working = recipes
      .filter((recipe) =>
        evidence.some((entry) => entry.gateId === recipe.verifiedBy && entry.status === 'passed'),
      )
      .map((recipe) => recipe.id);

    return setupQueue(recipes, {
      intent,
      neededCapabilities: plan.included.map((resolved) => resolved.capability.id),
      installedComponents: installed,
      working,
    });
  }

  /** One connector, with the steps only the founder can do. */
  async detail(recipeId: string): Promise<{ recipe: Recipe; steps: ReturnType<typeof founderSteps> } | null> {
    const recipe = (await this.load()).find((entry) => entry.id === recipeId);
    return recipe ? { recipe, steps: founderSteps(recipe) } : null;
  }

  /** Where each connection has actually got to. */
  async statuses(projectPath: string, projectId?: string): Promise<ConnectionStatus[]> {
    const recipes = await this.load();
    const evidence = projectId ? this.metadata.latestEvidence(projectId) : [];
    const declared = await this.declaredSettings(projectPath);
    return recipes.map((recipe) =>
      connectionStatus(recipe, { evidence, declared, claimed: declared }),
    );
  }
}
