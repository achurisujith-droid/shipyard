# A person checking the decisions

For when your app produces a recommendation about somebody — an application
rejected, an account suspended, a payout withheld — and that recommendation must
not become the outcome by itself.

## Using it

Instead of acting, raise a review:

```ts
await fetch('/api/reviews', {
  method: 'POST',
  body: JSON.stringify({
    kind: 'application_screening',
    subjectRef: applicant.id,
    suggestedOutcome: 'REJECTED',
    suggestedReason: 'Score below threshold',
    evidence: { score },
  }),
});
```

A person then decides at `POST /api/reviews/[id]/decide`.

## Four rules that will annoy someone

Each of these is a rule somebody will eventually want waived, and each is the
reason the record is worth anything afterwards.

1. **The person who raised it cannot review it.** Otherwise the review is a
   formality performed on oneself.
2. **The person it is about cannot review it either.**
3. **A decision needs a reason.** Not a word — something that could be read back
   to the person it concerns.
4. **A decision that has taken effect cannot be quietly changed.**

## Both the suggestion and the decision are kept

Separately. Overwriting the machine's suggestion with the human outcome would
lose the one thing worth knowing later: whether the person agreed or overruled
it. Agreeing is legitimate and is recorded as agreement — a reviewer who
approves every suggestion within seconds is a pattern worth being able to see.

## What it does not do

- It makes the review happen and records it. It cannot make the review
  thoughtful.
- No appeals process. If someone wants to contest a decision, you need one.
- It does not decide which of your decisions are consequential enough to need
  review. That is your judgement, and Shipyard asks you about it during
  onboarding.
