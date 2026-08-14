/**
 * A person deciding, rather than a machine.
 *
 * This component exists for one situation: your app produces a recommendation
 * about a person — an application rejected, an account suspended, a payout
 * withheld — and that recommendation must not become the outcome by itself.
 *
 * The rules below are what make "a person reviewed it" a fact rather than a
 * claim. They are deliberately awkward: a reviewer cannot approve their own
 * submission, cannot decide without giving a reason, and cannot revisit a
 * decision that has already taken effect. Each of those is a rule somebody will
 * eventually want waived, and each is the reason the record is worth anything.
 */

export type ReviewStatus = 'PENDING' | 'DECIDED' | 'APPLIED' | 'WITHDRAWN';
export type ReviewOutcome = 'APPROVED' | 'REJECTED' | 'CHANGED';

export interface ReviewItem {
  id: string;
  status: ReviewStatus;
  /** What the machine suggested, before anyone looked. */
  suggestedOutcome: ReviewOutcome | null;
  suggestedReason: string | null;
  /** Who the decision is about. */
  subjectRef: string;
  /** Who raised it. */
  submittedBy: string | null;
  reviewedBy: string | null;
  outcome: ReviewOutcome | null;
  reviewerReason: string | null;
}

export interface DecisionAttempt {
  reviewerId: string;
  outcome: ReviewOutcome;
  reason: string;
}

export type DecisionRefusal = { ok: false; reason: string };
export type DecisionAccepted = { ok: true; changes: Partial<ReviewItem> & { status: 'DECIDED' } };

/** The shortest reason that could possibly be one. */
const MIN_REASON_LENGTH = 10;

export function canDecide(item: ReviewItem, attempt: DecisionAttempt): DecisionRefusal | DecisionAccepted {
  if (item.status === 'APPLIED') {
    return { ok: false, reason: 'This decision has already taken effect and cannot be changed here.' };
  }
  if (item.status === 'DECIDED') {
    return { ok: false, reason: 'Someone has already reviewed this.' };
  }
  if (item.status === 'WITHDRAWN') {
    return { ok: false, reason: 'This was withdrawn and no longer needs a decision.' };
  }

  // The reviewer must not be the person who raised it. Otherwise the review
  // step is a formality that the same person performs on themselves.
  if (item.submittedBy && item.submittedBy === attempt.reviewerId) {
    return { ok: false, reason: 'You raised this, so somebody else has to review it.' };
  }

  // Nor the person it is about.
  if (item.subjectRef === attempt.reviewerId) {
    return { ok: false, reason: 'This decision is about you, so somebody else has to review it.' };
  }

  const reason = attempt.reason?.trim() ?? '';
  if (reason.length < MIN_REASON_LENGTH) {
    return {
      ok: false,
      reason: 'Please say why. A decision about a person has to come with a reason somebody could read back.',
    };
  }

  return {
    ok: true,
    changes: {
      status: 'DECIDED',
      outcome: attempt.outcome,
      reviewerReason: reason,
      reviewedBy: attempt.reviewerId,
    },
  };
}

/**
 * Did a person actually change anything, or did they wave it through?
 *
 * Not a refusal — agreeing with a recommendation is a legitimate review. It is
 * recorded because a reviewer who approves every suggestion within seconds is
 * a pattern worth being able to see.
 */
export function agreedWithSuggestion(item: ReviewItem, outcome: ReviewOutcome): boolean {
  return item.suggestedOutcome !== null && item.suggestedOutcome === outcome;
}

/** Whether a decision may now be acted on. */
export function readyToApply(item: ReviewItem): boolean {
  return item.status === 'DECIDED' && item.outcome !== null && Boolean(item.reviewerReason);
}

/**
 * What the person the decision is about should be told.
 *
 * Written for them, not for the operator. Naming that a person was involved is
 * the part people most want to know and the part most often left out.
 */
export function explainToSubject(item: ReviewItem): string {
  if (!readyToApply(item) && item.status !== 'APPLIED') {
    return 'This is waiting for someone to review it.';
  }
  const verdict =
    item.outcome === 'APPROVED' ? 'went ahead' : item.outcome === 'REJECTED' ? 'was not approved' : 'was changed';
  return `Your request ${verdict}. A person reviewed this before it took effect. The reason given was: ${item.reviewerReason}`;
}
