import { useCallback, useEffect, useState } from 'react';

import type { ConnectionStatus, FounderStep, Recipe, SetupPrompt } from '@shipyard/shared';

interface Props {
  projectPath: string;
  onBack: () => void;
}

/**
 * The accounts the founder has to open themselves.
 *
 * Shipyard does not create accounts and does not hold anybody's keys. What it
 * can do is the part that is actually hard: knowing **when** each one is worth
 * doing, and being honest that filling in a key is not the same as it working.
 *
 * The screen leads with the long waits, because those are the ones that turn
 * into a delayed launch if they are started on the day they are needed. Each
 * one carries the reason, since "set up Stripe" reads as busywork to somebody
 * who can see they have nothing to sell yet.
 */
export function ConnectorsScreen({ projectPath, onBack }: Props): JSX.Element {
  const [queue, setQueue] = useState<SetupPrompt[] | null>(null);
  const [statuses, setStatuses] = useState<Record<string, ConnectionStatus>>({});
  const [open, setOpen] = useState<{ recipe: Recipe; steps: FounderStep[] } | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [prompts, states] = await Promise.all([
        window.shipyard.connectors.queue(projectPath),
        window.shipyard.connectors.statuses(projectPath),
      ]);
      setQueue(prompts);
      setStatuses(Object.fromEntries(states.map((state) => [state.recipeId, state])));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setQueue([]);
    }
  }, [projectPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const show = async (recipeId: string): Promise<void> => {
    setOpen(await window.shipyard.connectors.detail(recipeId));
  };

  const urgent = queue?.filter((prompt) => prompt.when === 'now') ?? [];
  const soon = queue?.filter((prompt) => prompt.when === 'at_build' || prompt.when === 'before_pilot') ?? [];
  const later = queue?.filter((prompt) => prompt.when === 'later') ?? [];

  return (
    <div className="connectors">
      <header className="connectors-header">
        <div>
          <h1>Accounts you will need</h1>
          <p>
            These are services your app uses. You open the accounts yourself, in
            your own name — Shipyard never holds your keys and cannot see them.
          </p>
        </div>
        <button type="button" className="btn btn-quiet btn-sm" onClick={onBack}>
          Back
        </button>
      </header>

      {error ? <p className="connectors-error">{error}</p> : null}
      {queue === null ? <p className="muted">Working out what you need…</p> : null}
      {queue?.length === 0 ? (
        <p className="muted">Nothing to set up yet. This fills in as your app grows.</p>
      ) : null}

      {urgent.length > 0 ? (
        <Section
          title="Worth starting now"
          note="Not because you need them today — because somebody else has to check something, and that takes days. Starting these now means the waiting happens while you carry on building."
          prompts={urgent}
          statuses={statuses}
          onOpen={show}
        />
      ) : null}

      {soon.length > 0 ? (
        <Section title="Needed before real people use it" prompts={soon} statuses={statuses} onOpen={show} />
      ) : null}

      {later.length > 0 ? (
        <Section
          title="Later"
          note="Quick to do, and not needed yet. Listed so nothing is a surprise."
          prompts={later}
          statuses={statuses}
          onOpen={show}
        />
      ) : null}

      {open ? <Steps detail={open} status={statuses[open.recipe.id]} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function Section({
  title,
  note,
  prompts,
  statuses,
  onOpen,
}: {
  title: string;
  note?: string;
  prompts: SetupPrompt[];
  statuses: Record<string, ConnectionStatus>;
  onOpen: (recipeId: string) => void;
}): JSX.Element {
  return (
    <section className="connectors-section">
      <h2>{title}</h2>
      {note ? <p className="connectors-note">{note}</p> : null}
      <ul>
        {prompts.map((prompt) => {
          const status = statuses[prompt.recipeId];
          return (
            <li key={prompt.recipeId}>
              <button type="button" className="connectors-item" onClick={() => onOpen(prompt.recipeId)}>
                <span className="connectors-item-top">
                  <strong>{prompt.name}</strong>
                  {status ? <StateBadge state={status.state} /> : null}
                  {prompt.blocksLaunch ? <span className="badge badge-needed">Needed to launch</span> : null}
                </span>
                <span className="connectors-reason">{prompt.reason}</span>
                <span className="connectors-effort">{prompt.effort}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The four states, and the gap between two of them.
 *
 * "Filled in" and "working" are shown differently on purpose. A founder who has
 * pasted a key has done their part and reasonably feels finished; the only
 * thing that establishes it actually works is the project's own check, and
 * blurring that is how a launch happens on an integration nobody exercised.
 */
function StateBadge({ state }: { state: ConnectionStatus['state'] }): JSX.Element | null {
  switch (state) {
    case 'working':
      return <span className="badge badge-installed">Working</span>;
    case 'broken':
      return <span className="badge badge-broken">Not working</span>;
    case 'claimed':
      return <span className="badge badge-provisional">Filled in, not checked</span>;
    default:
      return null;
  }
}

function Steps({
  detail,
  status,
  onClose,
}: {
  detail: { recipe: Recipe; steps: FounderStep[] };
  status?: ConnectionStatus;
  onClose: () => void;
}): JSX.Element {
  const { recipe, steps } = detail;
  return (
    <section className="connectors-detail">
      <header>
        <h2>{recipe.name}</h2>
        <button type="button" className="btn btn-quiet btn-sm" onClick={onClose}>
          Close
        </button>
      </header>
      <p>{recipe.summary}</p>
      {status ? <p className="connectors-status">{status.summary}</p> : null}

      <ol className="connectors-steps">
        {steps.map((step) => (
          <li key={step.number} className={step.critical ? 'is-critical' : undefined}>
            <span>{step.instruction}</span>
            {step.url ? (
              <button
                type="button"
                className="connectors-link"
                onClick={() => void window.shipyard.app.openExternal(step.url ?? '')}
              >
                Open {new URL(step.url).hostname}
              </button>
            ) : null}
            {step.produces ? (
              <span className="connectors-produces">
                Puts <code>{step.produces}</code> in your .env file
              </span>
            ) : null}
            {step.because ? <span className="connectors-because">{step.because}</span> : null}
          </li>
        ))}
      </ol>

      {recipe.costNote ? <p className="connectors-cost">{recipe.costNote}</p> : null}

      {recipe.limitations?.length ? (
        <>
          <h3>What this does not do</h3>
          <ul className="connectors-limits">
            {recipe.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </>
      ) : null}

      <p className="connectors-privacy">
        Your keys go in your project’s <code>.env</code> file and stay on this
        computer. Shipyard does not read that file, so it cannot tell you whether
        a key is right — only whether the check for this passed.
      </p>
    </section>
  );
}
