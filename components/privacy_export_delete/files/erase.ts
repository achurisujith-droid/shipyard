import { PERSONAL_DATA, type ErasureAction, type PersonalDataTable } from '@/components/privacy_export_delete/registry';

/**
 * Erasing someone, and being able to say exactly what that meant.
 *
 * The plan is computed before anything is deleted, and it is the thing worth
 * showing to whoever approves the request. "We deleted their account" is not an
 * answer to a regulator; "we deleted these four tables, anonymised these two,
 * and kept the audit log for this stated reason" is.
 */

export interface ErasureStep {
  model: string;
  action: ErasureAction;
  describes: string;
  subjectField: string;
  anonymiseFields?: string[];
  retentionReason?: string;
}

export interface ErasurePlan {
  subjectId: string;
  steps: ErasureStep[];
  /** Tables kept, with the reason, for the person answering the request. */
  retained: ErasureStep[];
  /** Problems that mean this plan should not be run yet. */
  problems: string[];
  runnable: boolean;
}

/**
 * The order matters.
 *
 * Deletions run before anonymisations, and both run before anything retained is
 * touched at all. Anonymising a row another table still points at leaves a
 * dangling reference that a later delete then fails on — halfway through an
 * erasure is the worst place to stop.
 */
const ORDER: Record<ErasureAction, number> = { delete: 0, anonymise: 1, retain: 2 };

export function planErasure(
  subjectId: string,
  tables: readonly PersonalDataTable[] = PERSONAL_DATA,
): ErasurePlan {
  const problems: string[] = [];

  if (!subjectId) problems.push('No person was named in this request.');
  if (tables.length === 0) {
    problems.push('No tables are listed as holding personal data, so there is nothing to erase. Fill in the registry.');
  }

  const steps: ErasureStep[] = [...tables]
    .sort((a, b) => ORDER[a.onErasure] - ORDER[b.onErasure] || a.model.localeCompare(b.model))
    .map((table) => ({
      model: table.model,
      action: table.onErasure,
      describes: table.describes,
      subjectField: table.subjectField,
      ...(table.anonymiseFields ? { anonymiseFields: table.anonymiseFields } : {}),
      ...(table.retentionReason ? { retentionReason: table.retentionReason } : {}),
    }));

  for (const step of steps) {
    if (step.action === 'anonymise' && !step.anonymiseFields?.length) {
      problems.push(`${step.model} is set to be anonymised but no fields are named, so nothing would change.`);
    }
    if (step.action === 'retain' && !step.retentionReason) {
      problems.push(`${step.model} is being kept and no reason is given. Keeping data needs a stated reason.`);
    }
  }

  return {
    subjectId,
    steps,
    retained: steps.filter((step) => step.action === 'retain'),
    problems,
    runnable: problems.length === 0,
  };
}

/** The replacement value for a field being anonymised. */
export function anonymisedValue(field: string, subjectId: string): string {
  // Deterministic and unique. A blank email would collide with every other
  // erased account on the unique index and fail the second time.
  if (/email/i.test(field)) return `erased-${subjectId}@removed.invalid`;
  if (/name/i.test(field)) return 'Removed';
  if (/hash|password|token|secret/i.test(field)) return `erased-${subjectId}`;
  return 'Removed';
}

/** A sentence for the audit log and for whoever asked. */
export function describePlan(plan: ErasurePlan): string {
  const deleted = plan.steps.filter((step) => step.action === 'delete').length;
  const anonymised = plan.steps.filter((step) => step.action === 'anonymise').length;
  const kept = plan.retained.length;
  return [
    `${deleted} table${deleted === 1 ? '' : 's'} deleted`,
    `${anonymised} anonymised`,
    kept > 0 ? `${kept} kept for a stated reason` : 'nothing kept',
  ].join(', ');
}
