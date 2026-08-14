import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { evaluate, loadRules } from '@shipyard/rulebook';
import { loadCatalog, resolve } from '@shipyard/capability-resolver';
import { assess } from '@shipyard/readiness';
import {
  CONTRACT_FILES,
  architectureMarkdown,
  contracts,
  type ContractInput,
} from '@shipyard/project-contracts';
import type { Evidence, ProjectIntent } from '@shipyard/shared';
import { readInstallRecord } from '@shipyard/component-library';

import type { Metadata } from './metadata';

/**
 * Keeping the project's own documents true.
 *
 * `ARCHITECTURE.md` and the four `shipyard.*.json` files are **derived**,
 * always, from what Shipyard currently knows. Nothing here is authored by hand
 * and nothing is remembered between runs.
 *
 * That is the only arrangement under which documentation stays honest. A file
 * written once at project creation is correct for about a day; after the first
 * component is installed or the first check runs it is a confident account of a
 * project that no longer exists, and nobody notices because it still reads
 * fluently.
 *
 * So this runs after anything that changes the answer: creating the project,
 * installing or removing a component, finishing a verification run.
 */
export class Contracts {
  constructor(
    /** `shipyard-catalog/`, packaged or from the repo. */
    private readonly catalogRoot: string,
    private readonly metadata: Metadata,
  ) {}

  /**
   * Rewrite the documents for one project.
   *
   * Failures are reported and swallowed. A project whose ARCHITECTURE.md could
   * not be written is a project with slightly stale documentation; making that
   * fail an install would be trading a real capability for a cosmetic one.
   */
  async refresh(input: {
    projectId: string;
    projectPath: string;
    name: string;
    idea: string;
    intent: ProjectIntent;
    phases?: ContractInput['phases'];
  }): Promise<{ written: string[]; error?: string }> {
    try {
      const [catalog, rules] = await Promise.all([
        loadCatalog(this.catalogRoot),
        loadRules(path.join(this.catalogRoot, 'rules')),
      ]);

      const capabilityPlan = resolve(input.intent, catalog.capabilities, catalog.vendors);
      const evidence: Evidence[] = this.metadata.latestEvidence(input.projectId);
      const facts = {
        intent: input.intent,
        evidence,
        components: capabilityPlan.components,
        // The rulebook checks obligations against what this project actually
        // needs, so a rule about payments does not fire on a project that takes
        // none.
        capabilities: capabilityPlan.included.map((resolved) => resolved.capability.id),
      };
      const ruleOutcomes = evaluate(rules, facts);
      const readiness = assess(facts, ruleOutcomes);
      const record = await readInstallRecord(input.projectPath);

      const contractInput: ContractInput = {
        projectId: input.projectId,
        name: input.name,
        idea: input.idea,
        intent: input.intent,
        phases: input.phases ?? [],
        capabilityPlan,
        ruleOutcomes,
        readiness: {
          score: readiness.score,
          threshold: readiness.threshold,
          ready: readiness.ready,
          nextActions: readiness.nextActions,
        },
        installed: record.components,
        evidenceCount: evidence.length,
        generatedAt: new Date().toISOString(),
      };

      const written: string[] = [];
      for (const [file, body] of Object.entries(contracts(contractInput))) {
        await writeFile(path.join(input.projectPath, file), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
        written.push(file);
      }
      await writeFile(
        path.join(input.projectPath, 'ARCHITECTURE.md'),
        architectureMarkdown(contractInput),
        'utf8',
      );
      written.push('ARCHITECTURE.md');

      // Keeping Shipyard's own record in step, so readiness history has a point
      // to compare against later.
      this.metadata.saveRuleEvaluations(input.projectId, ruleOutcomes);
      this.metadata.recordReadiness(
        input.projectId,
        readiness.score,
        readiness.threshold,
        readiness.ready,
        readiness.blockers.map((blocker) => blocker.ruleId),
      );

      return { written };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[contracts] could not refresh the project documents:', message);
      return { written: [], error: message };
    }
  }
}

export { CONTRACT_FILES };
