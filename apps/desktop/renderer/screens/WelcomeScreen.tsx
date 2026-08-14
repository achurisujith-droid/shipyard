interface Props {
  onContinue: () => void;
}

/**
 * Screen 1. Three lines of value proposition, one button.
 *
 * The third line is doing real work: the user is about to be asked to sign into
 * their Anthropic account, and telling them where their data goes before they
 * are asked is what makes that request feel reasonable.
 */
export function WelcomeScreen({ onContinue }: Props): JSX.Element {
  return (
    <div className="setup">
      <div className="setup-body">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <h1>Build your app by describing it</h1>
          <p className="setup-lede">
            Answer a few questions. Shipyard does the technical setup and briefs Claude to
            build it.
          </p>
        </div>

        <ul className="value-list">
          <li>
            <span className="marker" aria-hidden="true">
              1
            </span>
            <span>Tell us what you&apos;re building, in your own words.</span>
          </li>
          <li>
            <span className="marker" aria-hidden="true">
              2
            </span>
            <span>We work out how it should be put together, and write it down.</span>
          </li>
          <li>
            <span className="marker" aria-hidden="true">
              3
            </span>
            <span>Claude starts building, and you watch it happen.</span>
          </li>
        </ul>

        <p className="text-sm muted" style={{ maxWidth: '42ch' }}>
          You use your own Claude account. Your code stays on this computer, and Shipyard
          never sees your data or your password.
        </p>
      </div>

      <div className="setup-actions">
        <button className="btn btn-primary" onClick={onContinue} autoFocus>
          Get started
        </button>
      </div>
    </div>
  );
}
