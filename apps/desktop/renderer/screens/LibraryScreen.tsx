import { useCallback, useEffect, useState } from 'react';

import type {
  ComponentInstallPlan,
  ComponentInstallResult,
  LibraryEntry,
} from '@shipyard/shared';

interface Props {
  projectPath: string;
  onBack: () => void;
}

/**
 * The library: ready-made parts, and what happens if you take one.
 *
 * Two things this screen is built around.
 *
 * **It leads with what this project needs.** The founder was told during
 * onboarding that their app needs somewhere for people to sign in. This is
 * where that sentence turns into a thing they can click, still carrying the
 * same reason. A library sorted alphabetically is a catalogue; a library sorted
 * by relevance is help.
 *
 * **Nothing installs without showing the whole change first.** The person
 * approving it cannot read a diff, so the plan has to say everything: the
 * files, the tables, the keys they will have to go and fetch, and anything it
 * refuses to do. Approving a change you cannot see is not consent.
 */
export function LibraryScreen({ projectPath, onBack }: Props): JSX.Element {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<LibraryEntry | null>(null);
  const [plan, setPlan] = useState<ComponentInstallPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [done, setDone] = useState<ComponentInstallResult | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setEntries(await window.shipyard.library.list(projectPath, search));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setEntries([]);
    }
  }, [projectPath, search]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const choose = async (entry: LibraryEntry): Promise<void> => {
    setSelected(entry);
    setDone(null);
    setPlan(null);
    if (entry.installed) return;
    setPlanning(true);
    try {
      setPlan(await window.shipyard.library.plan(entry.manifest.id, projectPath));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanning(false);
    }
  };

  const confirm = async (): Promise<void> => {
    if (!selected || !plan?.installable || installing) return;
    setInstalling(true);
    try {
      const result = await window.shipyard.library.install(selected.manifest.id, projectPath);
      setDone(result);
      if (result.installed) await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="library">
      <header className="library-header">
        <div>
          <h1>Ready-made parts</h1>
          <p>
            Pieces that have already been built and tested. Using one is quicker
            and safer than asking for it to be written from scratch.
          </p>
        </div>
        <button type="button" className="btn btn-quiet btn-sm" onClick={onBack}>
          Back
        </button>
      </header>

      <input
        className="library-search"
        type="search"
        placeholder="What do you need? Try “sign in” or “take payment”"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        aria-label="Search the library"
      />

      {error ? <p className="library-error">{error}</p> : null}

      <div className="library-body">
        <ul className="library-list">
          {entries === null ? <li className="library-loading">Looking…</li> : null}
          {entries?.length === 0 ? (
            <li className="library-loading">Nothing here matches that.</li>
          ) : null}

          {entries?.map((entry) => (
            <li key={entry.manifest.id}>
              <button
                type="button"
                className={`library-item${selected?.manifest.id === entry.manifest.id ? ' is-selected' : ''}`}
                onClick={() => void choose(entry)}
              >
                <span className="library-item-top">
                  <strong>{entry.manifest.name}</strong>
                  {entry.installed ? <span className="badge badge-installed">Installed</span> : null}
                  {entry.relevance === 'needed' && !entry.installed ? (
                    <span className="badge badge-needed">Your project needs this</span>
                  ) : null}
                  {entry.manifest.trust !== 'verified' ? (
                    <span className="badge badge-provisional" title="Its checks have not all been run against a live service">
                      Not fully proven
                    </span>
                  ) : null}
                </span>
                <span className="library-summary">{entry.manifest.summary}</span>
                {entry.reason ? <span className="library-reason">{entry.reason}</span> : null}
              </button>
            </li>
          ))}
        </ul>

        <section className="library-detail">
          {!selected ? (
            <p className="library-hint">Pick something on the left to see what it does.</p>
          ) : (
            <Detail
              entry={selected}
              plan={plan}
              planning={planning}
              installing={installing}
              done={done}
              onConfirm={() => void confirm()}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function Detail({
  entry,
  plan,
  planning,
  installing,
  done,
  onConfirm,
}: {
  entry: LibraryEntry;
  plan: ComponentInstallPlan | null;
  planning: boolean;
  installing: boolean;
  done: ComponentInstallResult | null;
  onConfirm: () => void;
}): JSX.Element {
  const { manifest } = entry;
  const blocking = plan?.conflicts.filter((conflict) => conflict.blocking) ?? [];

  return (
    <>
      <h2>{manifest.name}</h2>
      <p className="library-detail-summary">{manifest.summary}</p>

      <dl className="library-facts">
        <div>
          <dt>How sure are we</dt>
          <dd>
            {manifest.trust === 'verified'
              ? 'Its own tests are run every time it is installed, and they pass.'
              : manifest.trust === 'provisional'
                ? 'It installs and its logic is tested, but part of it needs a real account to prove. See below.'
                : 'Early. Have a look, but do not rely on it yet.'}
          </dd>
        </div>
        <div>
          <dt>Where it came from</dt>
          <dd>
            {manifest.provenance.origin === 'authored'
              ? 'Written for Shipyard.'
              : `${manifest.provenance.origin === 'adapted' ? 'Adapted from' : 'Taken from'} ${manifest.provenance.source}.`}{' '}
            Licence: {manifest.provenance.license}.
          </dd>
        </div>
      </dl>

      {manifest.limitations?.length ? (
        <section className="library-limits">
          <h3>What it does not do</h3>
          <ul>
            {manifest.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {done ? (
        <Outcome result={done} />
      ) : entry.installed ? (
        <p className="library-note">This is already part of your project.</p>
      ) : planning ? (
        <p className="library-note">Working out what this would change…</p>
      ) : plan ? (
        <>
          <section className="library-change">
            <h3>What would change</h3>
            <ul>
              <li>
                <strong>{plan.creates.length}</strong> new file
                {plan.creates.length === 1 ? '' : 's'}, none of your existing ones touched
              </li>
              {plan.order.length > 1 ? (
                <li>
                  Brings in {plan.order.length - 1} other part
                  {plan.order.length === 2 ? '' : 's'} it depends on
                </li>
              ) : null}
              {plan.addsModels.length ? (
                <li>
                  Adds {plan.addsModels.length} new table{plan.addsModels.length === 1 ? '' : 's'} to
                  your database
                </li>
              ) : null}
              {Object.keys(plan.addsDependencies).length ? (
                <li>
                  Installs {Object.keys(plan.addsDependencies).length} extra package
                  {Object.keys(plan.addsDependencies).length === 1 ? '' : 's'}
                </li>
              ) : null}
              {plan.protects.length ? (
                <li>
                  {plan.protects.length} file{plan.protects.length === 1 ? '' : 's'} become off
                  limits to the assistant, so the tested parts stay tested
                </li>
              ) : null}
            </ul>
          </section>

          {plan.needsEnv.length ? (
            <section className="library-needs">
              <h3>You will need to supply</h3>
              <ul>
                {plan.needsEnv.map((variable) => (
                  <li key={variable.name}>
                    {variable.description}
                    {variable.obtainFrom ? <em> — from {variable.obtainFrom}</em> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {blocking.length ? (
            <section className="library-refusal">
              <h3>This cannot be added right now</h3>
              <ul>
                {blocking.map((conflict) => (
                  <li key={conflict.message}>
                    {conflict.message}
                    {conflict.detail ? <span> {conflict.detail}</span> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <button type="button" className="btn btn-primary" disabled={!plan.installable || installing} onClick={onConfirm}>
            {installing ? 'Adding…' : `Add ${manifest.name.toLowerCase()} to my app`}
          </button>
        </>
      ) : null}
    </>
  );
}

function Outcome({ result }: { result: ComponentInstallResult }): JSX.Element {
  if (!result.installed) {
    return (
      <section className="library-refusal">
        <h3>It was not added</h3>
        <ul>
          {result.errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
        <p>Nothing in your project was changed.</p>
      </section>
    );
  }

  return (
    <section className="library-done">
      <h3>Added</h3>
      <p>
        {result.filesWritten.length} file{result.filesWritten.length === 1 ? '' : 's'} written.
      </p>
      {result.nextSteps.length ? (
        <>
          <h4>Things only you can do</h4>
          <ol>
            {result.nextSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </>
      ) : null}
    </section>
  );
}
