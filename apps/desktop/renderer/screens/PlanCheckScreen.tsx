import type { AuthStatus, DetectResult } from '@shipyard/shared';

interface Props {
  auth: AuthStatus | null;
  detect: DetectResult | null;
  onContinue: () => void;
  onBack: () => void;
}

/**
 * Screen 3: will their plan actually get them through a build?
 *
 * Continuing is always allowed. This is information, not a gate, and the copy
 * says so explicitly so nobody thinks they are being upsold into a wall.
 *
 * The api-key case is why `authMethod` exists on AuthStatus: an Anthropic
 * Console user is billed per token and has no subscription tier, so telling
 * them to buy Claude Pro would be wrong.
 */
export function PlanCheckScreen({ auth, detect, onContinue, onBack }: Props): JSX.Element {
  const tier = auth?.tier ?? 'unknown';
  const isApiKey = auth?.authMethod === 'api-key';
  const plan = describePlan(tier, isApiKey);

  return (
    <div className="setup">
      <div className="setup-body">
        <h1>{plan.heading}</h1>

        <div className="panel">
          <div className="panel-head">
            <span className={`status ${plan.tone}`}>
              <span className="status-dot" aria-hidden="true" />
              {plan.badge}
            </span>
          </div>
          <p className="muted">{plan.body}</p>
        </div>

        {detect?.version && (
          <p className="text-sm muted">Using Claude Code {detect.version} on this computer.</p>
        )}
      </div>

      <div className="setup-actions">
        <button className="btn btn-primary" onClick={onContinue} autoFocus>
          Continue
        </button>
        <button className="btn btn-quiet" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}

interface PlanCopy {
  heading: string;
  badge: string;
  body: string;
  tone: string;
}

function describePlan(tier: string, isApiKey: boolean): PlanCopy {
  if (isApiKey) {
    return {
      heading: "You're paying per use",
      badge: 'Pay as you go',
      body:
        "You're signed in with an Anthropic API key, so you're charged for what you use rather " +
        "than a monthly fee. There's no usage limit to run into, but it's worth keeping an eye " +
        'on your spend while you build.',
      tone: 'status-ok',
    };
  }

  switch (tier) {
    case 'free':
      return {
        heading: 'Your free plan will run out',
        badge: 'Free plan',
        body:
          "Building an app uses Claude heavily, and on the free plan you'll hit your limit after " +
          'roughly an hour. Claude Pro is $20 a month and is the realistic minimum for finishing ' +
          "something. You can carry on now and upgrade when you run out — nothing will be lost.",
        tone: 'status-warn',
      };
    case 'pro':
    case 'max':
    case 'team':
      return {
        heading: "You're all set",
        badge: `Claude ${tier.charAt(0).toUpperCase()}${tier.slice(1)}`,
        body: 'This plan has enough capacity to build a real app without interruption.',
        tone: 'status-ok',
      };
    default:
      return {
        heading: 'Ready to go',
        badge: 'Plan not detected',
        body:
          "We couldn't tell which Claude plan you're on. That doesn't affect anything — it just " +
          "means we can't warn you in advance if you're getting close to a usage limit.",
        tone: '',
      };
  }
}
