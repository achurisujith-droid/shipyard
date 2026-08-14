import { useEffect, useRef, useState } from 'react';

import type {
  DetectedProblem,
  PermissionRequest,
  RunnerStatus,
  SessionErrorInfo,
  SessionHandle,
  SessionState,
} from '@shipyard/shared';

import { ChoiceDialog } from '../components/ChoiceDialog';
import { PreviewPane } from '../components/PreviewPane';
import { basename, describeActivity, formatElapsed, isPreformatted } from '../lib/format';

/** Runner states where something is happening that the user should see. */
const RUNNER_BUSY: RunnerStatus['state'][] = ['installing', 'preparing', 'starting'];

const RUNNER_LABEL: Record<string, string> = {
  installing: 'Installing the pieces your app needs',
  preparing: 'Getting your database ready',
  starting: 'Starting your app',
};

interface Props {
  session: SessionHandle;
  /** Pre-filled but NOT sent, per the Milestone 3 spec. */
  prefill?: string;
  onExit: () => void;
  onOpenLibrary: () => void;
  onOpenConnectors: () => void;
}

type Entry =
  | { kind: 'you'; text: string }
  | { kind: 'claude'; text: string }
  | { kind: 'activity'; toolName: string; summary: string }
  | { kind: 'problem'; problem: DetectedProblem };

const SUGGESTIONS = [
  'Read PROJECT.md and tell me what you understand about this project.',
  'What files are in this project right now?',
  'Make a simple page that says hello, so I can see it working.',
];

export function ChatScreen({ session, prefill, onExit, onOpenLibrary, onOpenConnectors }: Props): JSX.Element {
  const [entries, setEntries] = useState<Entry[]>([]);
  /** The reply being written. Replaced wholesale on each update, never appended. */
  const [partial, setPartial] = useState('');
  const [state, setState] = useState<SessionState>('starting');
  const [permission, setPermission] = useState<PermissionRequest | null>(null);
  const [error, setError] = useState<SessionErrorInfo | null>(null);
  const [rateLimit, setRateLimit] = useState<string | null>(null);
  const [draft, setDraft] = useState(prefill ?? '');
  const [showPreview, setShowPreview] = useState(true);
  /**
   * The most recent thing Claude did. Shown live in the waiting row, because a
   * spinner that says only "thinking" for ninety seconds is indistinguishable
   * from a hang (PRODUCT.md principle 1).
   */
  const [doingNow, setDoingNow] = useState('');
  const [runner, setRunner] = useState<RunnerStatus>({ state: 'idle' });
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = session.sessionId;
    const offs = [
      window.shipyard.on('session:state', (p) => {
        if (p.sessionId === id) setState(p.state);
      }),
      window.shipyard.on('session:assistant-text', (p) => {
        if (p.sessionId !== id) return;
        setEntries((prev) => [...prev, { kind: 'claude', text: p.text }]);
        setPartial('');
        setDoingNow('');
      }),
      window.shipyard.on('session:assistant-partial', (p) => {
        if (p.sessionId === id) setPartial(p.text);
      }),
      window.shipyard.on('session:tool-summary', (p) => {
        if (p.sessionId !== id) return;
        setEntries((prev) => [
          ...prev,
          { kind: 'activity', toolName: p.tool.name, summary: p.tool.summary },
        ]);
        setDoingNow(describeActivity(p.tool.name, p.tool.summary).label);
      }),
      window.shipyard.on('session:permission-request', (p) => {
        if (p.sessionId === id) setPermission(p.request);
      }),
      window.shipyard.on('session:rate-limited', (p) => {
        if (p.sessionId !== id) return;
        setRateLimit(
          p.info.resetsAt ? `${p.info.message} It resets ${p.info.resetsAt}.` : p.info.message,
        );
      }),
      window.shipyard.on('session:error', (p) => {
        if (p.sessionId === id) setError(p.error);
      }),
      // A problem in the running app is part of the conversation: it appears in
      // the thread where the user is already looking, with the fix one click away.
      window.shipyard.on('runner:problem', (problem) => {
        setEntries((prev) => [...prev, { kind: 'problem', problem }]);
      }),
      // The app came up despite the noise. Take the card back rather than leave
      // a warning sitting next to something that visibly works.
      window.shipyard.on('runner:problems-resolved', ({ source }) => {
        setEntries((prev) =>
          prev.filter((entry) => entry.kind !== 'problem' || entry.problem.source !== source),
        );
      }),
      // Mirrored into the chat because the preview can be hidden, and a user who
      // pressed Run and then collapsed the pane must still be able to tell that
      // a three-minute install is progressing rather than stuck.
      window.shipyard.on('runner:status', setRunner),
    ];
    void window.shipyard.session.state(id).then((s) => {
      if (s) setState(s);
    });
    return () => {
      for (const off of offs) off();
    };
  }, [session.sessionId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [entries, partial, permission, state]);

  const send = (text?: string): void => {
    const message = (text ?? draft).trim();
    if (!message || state === 'exited') return;
    setEntries((prev) => [...prev, { kind: 'you', text: message }]);
    setDraft('');
    void window.shipyard.session.send(session.sessionId, message);
  };

  const restart = async (): Promise<void> => {
    setError(null);
    await window.shipyard.session.restart(session.sessionId);
  };

  /**
   * Hand a detected problem back to Claude. One click, and the user keeps
   * control: nothing is sent on their behalf without them asking.
   */
  const fixProblem = (problem: DetectedProblem): void => {
    const parts = [
      'My app is broken. Please look at this and fix it.',
      '',
      problem.location ? `Where: ${problem.location}` : '',
      `What happened (${problem.source === 'browser' ? 'in the browser' : 'from the dev server'}):`,
      problem.detail || problem.message,
    ].filter((line) => line !== '');

    send(parts.join('\n'));
    void window.shipyard.runner.clearProblems();
  };

  const busy = state === 'thinking' || state === 'tool-running' || state === 'streaming';
  const runnerBusy = RUNNER_BUSY.includes(runner.state);

  return (
    <div className={`workspace${showPreview ? '' : ' workspace-solo'}`}>
      <div className="chat">
        {/* One thin line across the top of the pane whenever anything is
            running. Peripheral by design: it answers "is this alive?" without
            asking the user to read anything. */}
        <div
          className={`progress-rail${busy || runnerBusy ? ' progress-rail-on' : ''}`}
          aria-hidden="true"
        />
        <header className="chat-header">
          <button className="btn btn-quiet btn-sm" onClick={onExit}>
            ← Projects
          </button>
          <div className="chat-header-title">
            <span className="chat-header-name">{basename(session.cwd)}</span>
            <span className="chat-header-path" title={session.cwd}>
              {session.cwd}
            </span>
          </div>
          <StatusChip state={state} />
          {/* Reachable from here rather than only from the home screen: the
              moment somebody wants a sign-in page is while they are asking for
              one, not before they started. */}
          <button className="btn btn-quiet btn-sm" onClick={onOpenLibrary}>
            Ready-made parts
          </button>
          <button className="btn btn-quiet btn-sm" onClick={onOpenConnectors}>
            Accounts
          </button>
          <button
            className="btn btn-quiet btn-sm"
            onClick={() => setShowPreview((v) => !v)}
            aria-pressed={showPreview}
          >
            {showPreview ? 'Hide app' : 'Show app'}
          </button>
        </header>

      <div className="chat-scroll" ref={scrollRef}>
        <div className="chat-thread">
          {entries.length === 0 && !busy && (
            <div className="empty">
              <h2>Claude is ready</h2>
              <p className="muted text-sm">
                It can read and change the files in this project. It will always ask before
                changing anything.
              </p>
              <div className="suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="suggestion" onClick={() => send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {entries.map((entry, i) => (
            <Turn key={i} entry={entry} onFix={fixProblem} />
          ))}

          {partial && (
            <div className="turn">
              <span className="speaker">Claude</span>
              <Reply text={partial} streaming />
            </div>
          )}

          {!partial && busy && <ThinkingRow state={state} doingNow={doingNow} />}
        </div>
      </div>

      <div className="composer">
        <div className="composer-inner">
          {runnerBusy && (
            <div className="running-strip" role="status" aria-live="polite">
              <span className="running-spinner" aria-hidden="true" />
              <span>{runner.message ?? RUNNER_LABEL[runner.state] ?? 'Working on your app'}</span>
              <button
                className="btn btn-quiet btn-sm running-strip-action"
                onClick={() => void window.shipyard.runner.stop()}
              >
                Cancel
              </button>
            </div>
          )}

          {rateLimit && (
            <div className="notice notice-warn">
              <div className="notice-body">
                <div className="notice-title">You&apos;ve hit your Claude usage limit</div>
                <span>{rateLimit}</span>
              </div>
            </div>
          )}

          {error && (
            <div className={`notice ${error.fatal ? 'notice-danger' : ''}`}>
              <div className="notice-body">
                <div className="notice-title">
                  {error.fatal ? 'Claude stopped unexpectedly' : 'Something went wrong'}
                </div>
                <span>{error.message}</span>
              </div>
              {error.fatal ? (
                <button className="btn btn-sm" onClick={() => void restart()}>
                  Start it again
                </button>
              ) : (
                <button className="btn btn-quiet btn-sm" onClick={() => setError(null)}>
                  Dismiss
                </button>
              )}
            </div>
          )}

          <div className="composer-box">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="Describe what you want to build or change…"
              rows={1}
              disabled={state === 'exited'}
              aria-label="Message Claude"
            />
            <button
              className="btn btn-primary"
              onClick={() => send()}
              disabled={!draft.trim() || state === 'exited'}
            >
              Send
            </button>
          </div>
          <span className="text-xs muted">
            Enter to send, Shift+Enter for a new line.
          </span>
        </div>
      </div>

      </div>

      {showPreview && <PreviewPane projectPath={session.cwd} />}

      {permission && (
        <ChoiceDialog
          request={permission}
          onAnswer={(index) => {
            void window.shipyard.session.respondToPermission(session.sessionId, index);
            setPermission(null);
          }}
        />
      )}
    </div>
  );
}

function Turn({
  entry,
  onFix,
}: {
  entry: Entry;
  onFix: (problem: DetectedProblem) => void;
}): JSX.Element {
  if (entry.kind === 'you') {
    return (
      <div className="turn turn-you">
        <div className="bubble-you">{entry.text}</div>
      </div>
    );
  }
  if (entry.kind === 'activity') {
    return <ActivityRow toolName={entry.toolName} summary={entry.summary} />;
  }
  if (entry.kind === 'problem') {
    return <ProblemCard problem={entry.problem} onFix={onFix} />;
  }
  return (
    <div className="turn">
      <span className="speaker">Claude</span>
      <Reply text={entry.text} />
    </div>
  );
}

/**
 * Assistant output arrives already rendered by the CLI: markdown fences are
 * stripped and tables are drawn with box characters. Monospace is therefore
 * reserved for content that actually depends on alignment; everything else is
 * ordinary readable text (PRODUCT.md principle 2).
 */
function Reply({ text, streaming }: { text: string; streaming?: boolean }): JSX.Element {
  if (isPreformatted(text)) {
    return <pre className={`reply-pre${streaming ? ' reply-streaming' : ''}`}>{text}</pre>;
  }
  return <div className={`reply${streaming ? ' reply-streaming' : ''}`}>{text}</div>;
}

/**
 * Something broke in the running app.
 *
 * One button, and it does the obvious thing. The user chose "one-click fix"
 * over automatic retries, so nothing is sent to Claude until they press it.
 */
function ProblemCard({
  problem,
  onFix,
}: {
  problem: DetectedProblem;
  onFix: (problem: DetectedProblem) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);

  return (
    <div className="problem">
      <div className="problem-head">
        <span className="problem-mark" aria-hidden="true">
          !
        </span>
        <div className="problem-body">
          <div className="problem-title">
            {problem.source === 'browser' ? 'Your app hit an error' : "Your app didn't build"}
          </div>
          <p className="text-sm problem-message">{problem.message}</p>
          {problem.location && <p className="text-xs muted">{problem.location}</p>}
        </div>
      </div>

      <div className="problem-actions">
        <button
          className="btn btn-primary btn-sm"
          disabled={sent}
          onClick={() => {
            setSent(true);
            onFix(problem);
          }}
        >
          {sent ? 'Sent to Claude' : 'Fix this'}
        </button>
        {problem.detail && problem.detail !== problem.message && (
          <button className="btn btn-quiet btn-sm" onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide details' : 'Show details'}
          </button>
        )}
      </div>

      {open && <pre className="activity-detail">{problem.detail}</pre>}
    </div>
  );
}

function ActivityRow({ toolName, summary }: { toolName: string; summary: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const activity = describeActivity(toolName, summary);
  const expandable = activity.detail.length > 0 && activity.detail !== activity.label;

  return (
    <div className="activity">
      <button
        className="activity-summary"
        onClick={() => expandable && setOpen((v) => !v)}
        aria-expanded={expandable ? open : undefined}
        style={expandable ? undefined : { cursor: 'default' }}
      >
        <span className="activity-icon" aria-hidden="true">
          {activity.icon}
        </span>
        <span className="activity-label">{activity.label}</span>
        {expandable && (
          <span className="text-xs muted" aria-hidden="true">
            {open ? 'Hide' : 'Details'}
          </span>
        )}
      </button>
      {open && <pre className="activity-detail">{activity.detail}</pre>}
    </div>
  );
}

/**
 * The wait is the most likely moment for a first-time user to think the app is
 * broken, so it names itself, says what it is doing, and counts (PRODUCT.md
 * principle 1).
 *
 * The elapsed clock starts on the first busy state and keeps running across
 * thinking → tool-running → thinking, because that whole span is one wait from
 * the user's side. Resetting it at each transition would make a two-minute turn
 * look like a series of short ones.
 */
function ThinkingRow({
  state,
  doingNow,
}: {
  state: SessionState;
  doingNow: string;
}): JSX.Element {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());

  useEffect(() => {
    startRef.current = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Date.now() - startRef.current), 1_000);
    return () => clearInterval(timer);
  }, []);

  const label = doingNow || (state === 'tool-running' ? 'Working on your project' : 'Thinking');

  return (
    <div className="thinking" role="status" aria-live="polite">
      <span className="thinking-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="thinking-label">{label}</span>
      {/* Under three seconds a timer is noise; past it, it is the difference
          between "slow" and "broken". */}
      {elapsed >= 3_000 && <span className="thinking-clock">{formatElapsed(elapsed)}</span>}
      {elapsed >= 45_000 && (
        <span className="text-xs muted">Long jobs are normal. It is still working.</span>
      )}
    </div>
  );
}

function StatusChip({ state }: { state: SessionState }): JSX.Element {
  const map: Record<SessionState, { label: string; tone: string }> = {
    starting: { label: 'Starting', tone: 'status-busy' },
    idle: { label: 'Ready', tone: 'status-ok' },
    thinking: { label: 'Thinking', tone: 'status-busy' },
    streaming: { label: 'Replying', tone: 'status-busy' },
    'tool-permission-prompt': { label: 'Needs you', tone: 'status-warn' },
    'tool-running': { label: 'Working', tone: 'status-busy' },
    error: { label: 'Problem', tone: 'status-danger' },
    'rate-limited': { label: 'Limit reached', tone: 'status-warn' },
    exited: { label: 'Stopped', tone: 'status-danger' },
  };
  const { label, tone } = map[state];
  return (
    <span className={`status ${tone}`}>
      <span className="status-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
