import { useEffect, useState } from 'react';

import {
  AMBITION_ADVICE,
  AMBITION_PROFILES,
  type Ambition,
  type BuildOrder,
  type IntakeAnswers,
  type ProjectPlan,
  type RequirementsSource,
  type SessionHandle,
} from '@shipyard/shared';

interface Props {
  onStarted: (session: SessionHandle, firstMessage: string) => void;
  onCancel: () => void;
}

const STEPS = ['Your idea', 'How far', 'Requirements', 'Order of work', 'The plan'] as const;

/**
 * Starting a project.
 *
 * A solo founder who has never shipped software does not need a form, they need
 * someone to tell them which decisions matter and what each one costs. So this
 * asks three questions about their situation and then shows them the plan those
 * answers produced, in full, before anything is written.
 *
 * The questions are deliberately not technical. "Prototype or production" is a
 * question about their business; "Postgres or SQLite" is not a question they
 * can answer, and it is the one their answer decides.
 */
export function IntakeScreen({ onStarted, onCancel }: Props): JSX.Element {
  const [step, setStep] = useState(0);
  const [idea, setIdea] = useState('');
  const [ambition, setAmbition] = useState<Ambition | null>(null);
  const [requirements, setRequirements] = useState<RequirementsSource | null>(null);
  const [document, setDocument] = useState('');
  const [buildOrder, setBuildOrder] = useState<BuildOrder | null>(null);

  const [plan, setPlan] = useState<ProjectPlan | null>(null);
  const [markdown, setMarkdown] = useState('');
  const [editingMarkdown, setEditingMarkdown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const answers: IntakeAnswers | null =
    idea.trim() && ambition && requirements && buildOrder
      ? {
          idea: idea.trim(),
          name: '',
          ambition,
          requirements,
          buildOrder,
          ...(requirements === 'document' && document.trim()
            ? { requirementsDocument: document.trim() }
            : {}),
        }
      : null;

  // Building the plan is instant and writes nothing, so it happens on arrival
  // at the review step rather than behind a "generate" button nobody needs.
  useEffect(() => {
    if (step !== 4 || !answers) return;
    let cancelled = false;
    setError('');
    void (async () => {
      try {
        const projectPath = await window.shipyard.intake.suggestPath(idea);
        const built = await window.shipyard.intake.plan(answers, projectPath);
        if (cancelled) return;
        setPlan(built);
        setMarkdown(built.projectMarkdown);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const start = async (): Promise<void> => {
    if (!plan || busy) return;
    setBusy(true);
    setError('');
    try {
      await window.shipyard.intake.create(plan, markdown);
      const session = await window.shipyard.session.create(plan.path);
      onStarted(session, plan.firstMessage);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const canContinue =
    (step === 0 && idea.trim().length >= 10) ||
    (step === 1 && ambition !== null) ||
    (step === 2 && requirements !== null && (requirements === 'conversation' || document.trim())) ||
    (step === 3 && buildOrder !== null);

  return (
    <div className="intake">
      <header className="intake-header">
        <button className="btn btn-quiet btn-sm" onClick={step === 0 ? onCancel : () => setStep(step - 1)}>
          ← {step === 0 ? 'Your apps' : STEPS[step - 1]}
        </button>
        <ol className="intake-steps">
          {STEPS.map((label, i) => (
            <li
              key={label}
              className={i === step ? 'is-current' : i < step ? 'is-done' : ''}
              aria-current={i === step ? 'step' : undefined}
            >
              <span className="intake-step-dot" aria-hidden="true" />
              <span className="intake-step-label">{label}</span>
            </li>
          ))}
        </ol>
      </header>

      <div className="intake-body">
        {step === 0 && <IdeaStep idea={idea} onChange={setIdea} />}
        {step === 1 && <AmbitionStep chosen={ambition} onChoose={setAmbition} />}
        {step === 2 && (
          <RequirementsStep
            chosen={requirements}
            onChoose={setRequirements}
            document={document}
            onDocument={setDocument}
          />
        )}
        {step === 3 && <OrderStep chosen={buildOrder} onChoose={setBuildOrder} ambition={ambition} />}
        {step === 4 && (
          <PlanStep
            plan={plan}
            markdown={markdown}
            onMarkdown={setMarkdown}
            editing={editingMarkdown}
            onToggleEdit={() => setEditingMarkdown((v) => !v)}
          />
        )}
      </div>

      <footer className="intake-actions">
        {error && <p className="error-text">{error}</p>}
        {step < 4 ? (
          <button className="btn btn-primary" disabled={!canContinue} onClick={() => setStep(step + 1)}>
            Continue
          </button>
        ) : (
          <button className="btn btn-primary" disabled={!plan || busy} onClick={() => void start()}>
            {busy ? 'Setting things up…' : 'Start building'}
          </button>
        )}
        {step === 0 && idea.trim().length > 0 && idea.trim().length < 10 && (
          <span className="text-sm muted">A sentence or two is enough.</span>
        )}
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------ step 1 */

const EXAMPLES = [
  'A shop that sells phone cases, where I can add products and take orders',
  'A booking page for my dog-grooming business with a calendar',
  'A place my team logs which jobs they finished each day',
];

function IdeaStep({ idea, onChange }: { idea: string; onChange: (v: string) => void }): JSX.Element {
  return (
    <div className="intake-step">
      <h1>What are you building today?</h1>
      <p className="intake-lede">
        Describe it the way you would to a friend. No technical words needed — that is our job.
      </p>

      <textarea
        className="intake-textarea"
        value={idea}
        onChange={(e) => onChange(e.target.value)}
        placeholder="I want to build…"
        rows={6}
        autoFocus
        aria-label="What are you building"
      />

      <p className="text-sm muted intake-examples-label">Or start from one of these:</p>
      <div className="suggestions">
        {EXAMPLES.map((example) => (
          <button key={example} className="suggestion" onClick={() => onChange(example)}>
            {example}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ step 2 */

function AmbitionStep({
  chosen,
  onChoose,
}: {
  chosen: Ambition | null;
  onChoose: (v: Ambition) => void;
}): JSX.Element {
  return (
    <div className="intake-step">
      <h1>How far are you taking it right now?</h1>
      <p className="intake-lede">
        This is the decision that changes everything else — how long it takes, what it costs, and
        what you can honestly tell people it does.
      </p>

      <div className="choice-grid">
        {AMBITION_PROFILES.map((profile) => (
          <button
            key={profile.id}
            className={`choice-card${chosen === profile.id ? ' is-chosen' : ''}`}
            onClick={() => onChoose(profile.id)}
            aria-pressed={chosen === profile.id}
          >
            <span className="choice-title">{profile.title}</span>
            <span className="choice-summary">{profile.summary}</span>

            <span className="choice-effort">{profile.effort}</span>

            <span className="choice-list-label">You get</span>
            <ul className="choice-list">
              {profile.includes.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>

            <span className="choice-list-label">You do not get</span>
            <ul className="choice-list choice-list-minus">
              {profile.excludes.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>

            <span className="choice-best">{profile.bestWhen}</span>
          </button>
        ))}
      </div>

      <div className="advice">
        <span className="advice-mark" aria-hidden="true">
          ★
        </span>
        <p>{AMBITION_ADVICE}</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ step 3 */

function RequirementsStep({
  chosen,
  onChoose,
  document,
  onDocument,
}: {
  chosen: RequirementsSource | null;
  onChoose: (v: RequirementsSource) => void;
  document: string;
  onDocument: (v: string) => void;
}): JSX.Element {
  return (
    <div className="intake-step">
      <h1>Do you already have this written down?</h1>
      <p className="intake-lede">
        Either answer is fine. Most people do not, and talking it through is often better than a
        document written before you had seen anything.
      </p>

      <div className="choice-grid">
        <button
          className={`choice-card${chosen === 'conversation' ? ' is-chosen' : ''}`}
          onClick={() => onChoose('conversation')}
          aria-pressed={chosen === 'conversation'}
        >
          <span className="choice-title">No — let’s talk it through</span>
          <span className="choice-summary">
            Claude asks you questions, one at a time, and writes the requirements from your answers.
            You approve it before anything gets built.
          </span>
          <span className="choice-effort">About half an hour</span>
          <span className="choice-best">
            Best when the idea is clear in your head but has never been written down.
          </span>
        </button>

        <button
          className={`choice-card${chosen === 'document' ? ' is-chosen' : ''}`}
          onClick={() => onChoose('document')}
          aria-pressed={chosen === 'document'}
        >
          <span className="choice-title">Yes — I have something</span>
          <span className="choice-summary">
            A brief, a spec, notes from a meeting, a list on the back of an envelope. Paste it in
            and it becomes the starting point.
          </span>
          <span className="choice-effort">Straight to building</span>
          <span className="choice-best">
            Best when you have already thought this through with someone else.
          </span>
        </button>
      </div>

      {chosen === 'document' && (
        <div className="field intake-document">
          <label className="label" htmlFor="requirements-doc">
            Paste what you have
          </label>
          <textarea
            id="requirements-doc"
            className="intake-textarea"
            value={document}
            onChange={(e) => onDocument(e.target.value)}
            placeholder="Paste your notes, brief or spec here. Rough is fine."
            rows={10}
            autoFocus
          />
          <p className="text-xs muted">
            It goes into PROJECT.md as written. Claude will tell you what is missing rather than
            quietly guessing.
          </p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ step 4 */

function OrderStep({
  chosen,
  onChoose,
  ambition,
}: {
  chosen: BuildOrder | null;
  onChoose: (v: BuildOrder) => void;
  ambition: Ambition | null;
}): JSX.Element {
  return (
    <div className="intake-step">
      <h1>Do you want to see the screens first?</h1>
      <p className="intake-lede">
        Seeing every screen filled with made-up information is the fastest way to find out what you
        actually want — because you react to what is in front of you, not to a description of it.
      </p>

      <div className="choice-grid">
        <button
          className={`choice-card${chosen === 'screens-first' ? ' is-chosen' : ''}`}
          onClick={() => onChoose('screens-first')}
          aria-pressed={chosen === 'screens-first'}
        >
          <span className="choice-title">Yes — screens first</span>
          <span className="choice-summary">
            Every page, with example information in it. Nothing works yet, but you can click through
            the whole app and say “no, not like that” while changing it is still cheap.
          </span>
          <span className="choice-effort">Something to look at in a day or two</span>
          <span className="choice-list-label">The trade</span>
          <ul className="choice-list choice-list-minus">
            <li>Some screens get reworked once real information arrives</li>
          </ul>
          <span className="choice-best">
            Best when you are still deciding what the thing should do.
          </span>
        </button>

        <button
          className={`choice-card${chosen === 'end-to-end' ? ' is-chosen' : ''}`}
          onClick={() => onChoose('end-to-end')}
          aria-pressed={chosen === 'end-to-end'}
        >
          <span className="choice-title">No — one feature at a time</span>
          <span className="choice-summary">
            Each feature finished properly, screen and everything behind it, before the next one
            starts. Nothing gets built twice.
          </span>
          <span className="choice-effort">Slower to see the whole shape</span>
          <span className="choice-list-label">The trade</span>
          <ul className="choice-list choice-list-minus">
            <li>You will not see the full app for a while, so surprises arrive later</li>
          </ul>
          <span className="choice-best">
            Best when you already know exactly what you want, down to the screens.
          </span>
        </button>
      </div>

      {ambition === 'production' && chosen === 'screens-first' && (
        <div className="advice">
          <span className="advice-mark" aria-hidden="true">
            ★
          </span>
          <p>
            Worth knowing: because you are building for real users, accounts and privacy come right
            after the screens rather than at the end. That ordering is deliberate — it is the part
            that gets expensive if it is left until last.
          </p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ step 5 */

function PlanStep({
  plan,
  markdown,
  onMarkdown,
  editing,
  onToggleEdit,
}: {
  plan: ProjectPlan | null;
  markdown: string;
  onMarkdown: (v: string) => void;
  editing: boolean;
  onToggleEdit: () => void;
}): JSX.Element {
  if (!plan) {
    return (
      <div className="intake-step">
        <h1>Putting your plan together…</h1>
      </div>
    );
  }

  const setup = plan.environment.filter((n) => n.status === 'unsupported');

  return (
    <div className="intake-step">
      <h1>Here is the plan</h1>
      <p className="intake-lede">
        Nothing has been created yet. Read it, change anything you disagree with, then start.
      </p>

      <section className="plan-block">
        <h2 className="plan-heading">What happens, in order</h2>
        <ol className="phase-list">
          {plan.phases.map((phase, i) => (
            <li key={phase.title}>
              <span className="phase-number" aria-hidden="true">
                {i + 1}
              </span>
              <div>
                <div className="phase-title">{phase.title}</div>
                <p className="text-sm">{phase.outcome}</p>
                <p className="text-xs muted">{phase.effort}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="plan-block">
        <h2 className="plan-heading">What runs it</h2>
        <ul className="need-list">
          {plan.environment
            .filter((n) => n.status !== 'unsupported')
            .map((need) => (
              <li key={need.name}>
                <span className="need-mark need-ok" aria-hidden="true">
                  ✓
                </span>
                <div>
                  <span className="need-name">{need.name}</span>
                  <span className="text-sm muted"> — {need.reason}</span>
                  {need.note && <p className="text-xs muted">{need.note}</p>}
                </div>
              </li>
            ))}
        </ul>
        <p className="text-sm muted plan-note">
          All of this is already inside Shipyard. There is nothing for you to install.
        </p>
      </section>

      {setup.length > 0 && (
        <section className="plan-block">
          <h2 className="plan-heading">Things only you can sort out</h2>
          <p className="text-sm muted plan-note">
            Not blockers for starting. Worth knowing now, because a few of them take days.
          </p>
          <ul className="need-list">
            {setup.map((need) => (
              <li key={need.name}>
                <span className="need-mark need-todo" aria-hidden="true">
                  !
                </span>
                <div>
                  <span className="need-name">{need.name}</span>
                  <span className="text-sm muted"> — {need.reason}</span>
                  {need.note && <p className="text-sm">{need.note}</p>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {plan.skills.length > 0 && (
        <section className="plan-block">
          <h2 className="plan-heading">How Claude will work on this</h2>
          <ul className="need-list">
            {plan.skills.map((skill) => (
              <li key={skill.id}>
                <span className="need-mark need-ok" aria-hidden="true">
                  ✓
                </span>
                <div>
                  <span className="need-name">{skill.title}</span>
                  <p className="text-sm muted">{skill.description}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="plan-block">
        <div className="plan-block-head">
          <h2 className="plan-heading">The brief Claude reads</h2>
          <button className="btn btn-quiet btn-sm" onClick={onToggleEdit}>
            {editing ? 'Done editing' : 'Edit'}
          </button>
        </div>
        <p className="text-sm muted plan-note">
          Saved as PROJECT.md in your project folder. You can change it later at any time.
        </p>
        {editing ? (
          <textarea
            className="intake-textarea plan-markdown-edit"
            value={markdown}
            onChange={(e) => onMarkdown(e.target.value)}
            rows={20}
            aria-label="Project brief"
          />
        ) : (
          <pre className="plan-markdown">{markdown}</pre>
        )}
      </section>

      <p className="text-sm muted">
        This will be created at <code>{plan.path}</code>
      </p>
    </div>
  );
}
