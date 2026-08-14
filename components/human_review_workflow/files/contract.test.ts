import { describe, expect, it } from 'vitest';

import {
  agreedWithSuggestion,
  canDecide,
  explainToSubject,
  readyToApply,
  type ReviewItem,
} from '@/components/human_review_workflow/review';

/**
 * The contract for human review.
 *
 * Every rule here is one somebody will eventually want waived — "just let the
 * submitter approve their own", "the reason field is annoying". Each is also
 * the reason the record is worth anything afterwards, so each has a test with
 * its name on it.
 */

function item(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: 'rev_1',
    status: 'PENDING',
    suggestedOutcome: 'REJECTED',
    suggestedReason: 'Score below threshold.',
    subjectRef: 'person_1',
    submittedBy: 'user_submitter',
    reviewedBy: null,
    outcome: null,
    reviewerReason: null,
    ...overrides,
  };
}

const goodReason = 'Checked the application by hand and the score was misread.';

describe('who may decide', () => {
  it('somebody other than the person who raised it', () => {
    expect(canDecide(item(), { reviewerId: 'user_other', outcome: 'APPROVED', reason: goodReason }).ok).toBe(true);
  });

  it('never the person who raised it', () => {
    // Otherwise the review step is a formality the same person performs on
    // themselves.
    const verdict = canDecide(item(), { reviewerId: 'user_submitter', outcome: 'APPROVED', reason: goodReason });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/somebody else has to review it/);
  });

  it('never the person it is about', () => {
    const verdict = canDecide(item({ subjectRef: 'user_x', submittedBy: null }), {
      reviewerId: 'user_x',
      outcome: 'APPROVED',
      reason: goodReason,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/about you/);
  });
});

describe('a decision needs a reason', () => {
  it('and an empty one is not a reason', () => {
    expect(canDecide(item(), { reviewerId: 'u', outcome: 'APPROVED', reason: '' }).ok).toBe(false);
  });

  it('nor is a single word', () => {
    const verdict = canDecide(item(), { reviewerId: 'u', outcome: 'REJECTED', reason: 'no' });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/somebody could read back/);
  });

  it('nor is whitespace', () => {
    expect(canDecide(item(), { reviewerId: 'u', outcome: 'APPROVED', reason: '              ' }).ok).toBe(false);
  });

  it('and the reason is kept with the decision', () => {
    const verdict = canDecide(item(), { reviewerId: 'u', outcome: 'APPROVED', reason: goodReason });
    expect(verdict.ok === true && verdict.changes.reviewerReason).toBe(goodReason);
    expect(verdict.ok === true && verdict.changes.reviewedBy).toBe('u');
  });
});

describe('a decision that has already been made', () => {
  it('cannot be made twice', () => {
    expect(canDecide(item({ status: 'DECIDED' }), { reviewerId: 'u', outcome: 'APPROVED', reason: goodReason }).ok).toBe(false);
  });

  it('cannot be changed after it has taken effect', () => {
    const verdict = canDecide(item({ status: 'APPLIED' }), { reviewerId: 'u', outcome: 'APPROVED', reason: goodReason });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/already taken effect/);
  });

  it('is not needed once withdrawn', () => {
    expect(canDecide(item({ status: 'WITHDRAWN' }), { reviewerId: 'u', outcome: 'APPROVED', reason: goodReason }).ok).toBe(false);
  });
});

describe('agreeing with the machine', () => {
  it('is allowed', () => {
    expect(canDecide(item(), { reviewerId: 'u', outcome: 'REJECTED', reason: goodReason }).ok).toBe(true);
  });

  it('but it is recorded', () => {
    expect(agreedWithSuggestion(item(), 'REJECTED')).toBe(true);
    expect(agreedWithSuggestion(item(), 'APPROVED')).toBe(false);
  });

  it('and means nothing when there was no suggestion', () => {
    expect(agreedWithSuggestion(item({ suggestedOutcome: null }), 'APPROVED')).toBe(false);
  });
});

describe('acting on a decision', () => {
  it('waits until a person has decided', () => {
    expect(readyToApply(item())).toBe(false);
  });

  it('is ready once they have', () => {
    expect(readyToApply(item({ status: 'DECIDED', outcome: 'APPROVED', reviewerReason: goodReason }))).toBe(true);
  });

  it('is not ready if the reason went missing', () => {
    expect(readyToApply(item({ status: 'DECIDED', outcome: 'APPROVED', reviewerReason: null }))).toBe(false);
  });
});

describe('what the person is told', () => {
  it('says a person was involved', () => {
    const explanation = explainToSubject(
      item({ status: 'DECIDED', outcome: 'REJECTED', reviewerReason: goodReason }),
    );
    expect(explanation).toMatch(/A person reviewed this/);
  });

  it('includes the reason they were given', () => {
    expect(
      explainToSubject(item({ status: 'DECIDED', outcome: 'APPROVED', reviewerReason: goodReason })),
    ).toContain(goodReason);
  });

  it('is written for them rather than for the operator', () => {
    const explanation = explainToSubject(item({ status: 'DECIDED', outcome: 'REJECTED', reviewerReason: goodReason }));
    expect(explanation).not.toMatch(/REJECTED|subjectRef|status/);
  });

  it('says so plainly while it is still waiting', () => {
    expect(explainToSubject(item())).toBe('This is waiting for someone to review it.');
  });
});
