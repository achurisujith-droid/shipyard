import { useCallback, useEffect, useState } from 'react';

import type {
  ComponentInstallPlan,
  ComponentInstallResult,
  LibraryEntry,
  RemovalPlan,
  RemovalResult,
  UpgradePlan,
  UpgradeResult,
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
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ComponentInstallResult | null>(null);
  const [removal, setRemoval] = useState<RemovalPlan | null>(null);
  const [removed, setRemoved] = useState<RemovalResult | null>(null);
  const [upgradePlan, setUpgradePlan] = useState<UpgradePlan | null>(null);
  const [upgraded, setUpgraded] = useState<UpgradeResult | null>(null);
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
    setRemoval(null);
    setUpgradePlan(null);
    setPlanning(true);
    try {
      if (entry.installed) {
        // Both are worked out up front, because the two questions somebody has
        // about something already installed are "can I update it?" and "can I
        // get rid of it?", and both answers can be no.
        const [removal, update] = await Promise.all([
          window.shipyard.library.planRemoval(entry.manifest.id, projectPath),
          window.shipyard.library.planUpgrade(entry.manifest.id, projectPath),
        ]);
        setRemoval(removal);
        setUpgradePlan(update);
      } else {
        setPlan(await window.shipyard.library.plan(entry.manifest.id, projectPath));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanning(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!selected || !removal?.removable || busy) return;
    setBusy(true);
    try {
      setRemoved(await window.shipyard.library.uninstall(selected.manifest.id, projectPath));
      await refresh();
      setSelected(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const update = async (): Promise<void> => {
    if (!selected || !upgradePlan?.upgradable || busy) return;
    setBusy(true);
    try {
      setUpgraded(await window.shipyard.library.upgrade(selected.manifest.id, projectPath));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
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
              busy={busy}
              done={done}
              removal={removal}
              removed={removed}
              upgradePlan={upgradePlan}
              upgraded={upgraded}
              onConfirm={() => void confirm()}
              onRemove={() => void remove()}
              onUpdate={() => void update()}
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
  busy,
  done,
  removal,
  removed,
  upgradePlan,
  upgraded,
  onConfirm,
  onRemove,
  onUpdate,
}: {
  entry: LibraryEntry;
  plan: ComponentInstallPlan | null;
  planning: boolean;
  installing: boolean;
  busy: boolean;
  done: ComponentInstallResult | null;
  removal: RemovalPlan | null;
  removed: RemovalResult | null;
  upgradePlan: UpgradePlan | null;
  upgraded: UpgradeResult | null;
  onConfirm: () => void;
  onRemove: () => void;
  onUpdate: () => void;
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
        <Installed
          removal={removal}
          removed={removed}
          upgradePlan={upgradePlan}
          upgraded={upgraded}
          planning={planning}
          busy={busy}
          onRemove={onRemove}
          onUpdate={onUpdate}
        />
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

/**
 * Something already in the project: can it be updated, and can it be removed?
 *
 * Both answers can be no, and the reason matters more than the button. "You
 * have changed these files, so updating would overwrite your work" is a
 * sentence somebody can act on; a greyed-out button is not.
 */
function Installed({
  removal,
  removed,
  upgradePlan,
  upgraded,
  planning,
  busy,
  onRemove,
  onUpdate,
}: {
  removal: RemovalPlan | null;
  removed: RemovalResult | null;
  upgradePlan: UpgradePlan | null;
  upgraded: UpgradeResult | null;
  planning: boolean;
  busy: boolean;
  onRemove: () => void;
  onUpdate: () => void;
}): JSX.Element {
  if (removed?.removed) {
    return (
      <section className="library-done">
        <h3>Taken out</h3>
        <p>
          {removed.filesRemoved.length} file{removed.filesRemoved.length === 1 ? '' : 's'} removed.
        </p>
        {removed.notes.length ? (
          <ul>
            {removed.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}
      </section>
    );
  }

  if (upgraded?.upgraded) {
    return (
      <section className="library-done">
        <h3>Updated to {upgraded.to}</h3>
        {upgraded.notes.length ? (
          <ul>
            {upgraded.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}
      </section>
    );
  }

  if (planning) return <p className="library-note">Checking what can be done with it…</p>;

  return (
    <>
      <p className="library-note">This is already part of your project.</p>

      {upgradePlan && upgradePlan.upgradable ? (
        <section className="library-change">
          <h3>A newer version is available</h3>
          <p>
            You have {upgradePlan.from}; {upgradePlan.to} is available.{' '}
            {upgradePlan.replaces.length} file
            {upgradePlan.replaces.length === 1 ? '' : 's'} would be replaced.
          </p>
          {upgradePlan.leaves.length ? (
            <p>
              {upgradePlan.leaves.length} file
              {upgradePlan.leaves.length === 1 ? ' you customised would be left as it is' : 's you customised would be left as they are'}.
            </p>
          ) : null}
          <button type="button" className="btn btn-primary" disabled={busy} onClick={onUpdate}>
            {busy ? 'Updating…' : 'Update it'}
          </button>
        </section>
      ) : upgradePlan?.blockedBy.length ? (
        <section className="library-refusal">
          <h3>It cannot be updated right now</h3>
          <p>
            You have changed {upgradePlan.blockedBy.length} of its file
            {upgradePlan.blockedBy.length === 1 ? '' : 's'}, and updating would overwrite that work:
          </p>
          <ul>
            {upgradePlan.blockedBy.map((file) => (
              <li key={file}>
                <code>{file}</code>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {removal?.removable ? (
        <section className="library-remove">
          <h3>Taking it out</h3>
          <p>
            {removal.removes.length} file{removal.removes.length === 1 ? '' : 's'} would be deleted.
          </p>
          {removal.orphanedTables.length ? (
            <p>
              Your {removal.orphanedTables.join(', ')} table
              {removal.orphanedTables.length === 1 ? '' : 's'} and the information in{' '}
              {removal.orphanedTables.length === 1 ? 'it' : 'them'} would be left exactly as{' '}
              {removal.orphanedTables.length === 1 ? 'it is' : 'they are'}. Nothing here deletes your
              data.
            </p>
          ) : null}
          {removal.modified.length ? (
            <p>
              {removal.modified.length} file
              {removal.modified.length === 1 ? ' you changed would be kept' : 's you changed would be kept'}.
            </p>
          ) : null}
          <button type="button" className="btn btn-quiet" disabled={busy} onClick={onRemove}>
            {busy ? 'Removing…' : 'Take it out'}
          </button>
        </section>
      ) : removal?.problems.length ? (
        <section className="library-refusal">
          <h3>It cannot be taken out</h3>
          <ul>
            {removal.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </section>
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
