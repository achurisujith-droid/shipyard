import { useCallback, useEffect, useRef, useState } from 'react';

import type { AuthStatus, DetectResult, InstallPlan } from '@shipyard/shared';

interface Props {
  onReady: (detect: DetectResult, auth: AuthStatus) => void;
}

type Phase =
  | 'checking'
  | 'updating'
  | 'ready'
  | 'need-login'
  | 'logging-in'
  | 'need-install'
  | 'installing'
  | 'error';

/**
 * Screen 2: is Claude Code installed, and is the user signed in?
 *
 * Three outcomes per the spec, plus one the CLI forced on us: it can be
 * mid-self-update, during which there is briefly no executable on disk. That is
 * not "not installed", and sending a signed-in user to the install screen at
 * that moment would be a lie.
 *
 * Every failure state names what happened and offers the next action in the
 * same view (PRODUCT.md principle 5).
 */
export function ClaudeCheckScreen({ onReady }: Props): JSX.Element {
  const [phase, setPhase] = useState<Phase>('checking');
  const [detect, setDetect] = useState<DetectResult | null>(null);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [plan, setPlan] = useState<InstallPlan | null>(null);
  const [log, setLog] = useState('');
  const [showDetails, setShowDetails] = useState(false);
  const [note, setNote] = useState('');
  const [copied, setCopied] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  const refresh = useCallback(async (force = false) => {
    setPhase((p) => (p === 'installing' || p === 'logging-in' ? p : 'checking'));
    const d = force
      ? await window.shipyard.claude.redetect()
      : await window.shipyard.claude.detect();
    setDetect(d);

    if (!d.installed) {
      if (d.updateInProgress) {
        setPhase('updating');
        setNote('');
        setTimeout(() => void refresh(true), 3_000);
        return;
      }
      setPlan(await window.shipyard.claude.installPlan());
      setPhase('need-install');
      return;
    }
    if (!d.supported) {
      setNote(d.problem ?? 'The version of Claude Code on this computer is too old to use.');
      setPhase('error');
      return;
    }

    const a = await window.shipyard.claude.authStatus();
    setAuth(a);
    setNote('');
    setPhase(a.authed ? 'ready' : 'need-login');
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const offEvent = window.shipyard.on('login:event', (e) => {
      if (e.type === 'url-opened') setNote('We opened your browser. Finish signing in there.');
      else if (e.type === 'waiting') setNote('Waiting for you to finish signing in…');
      else if (e.type === 'success') void refresh(true);
      else {
        setNote(e.reason);
        setPhase('need-login');
      }
    });
    const offOutput = window.shipyard.on('login:output', ({ chunk }) => {
      setLog((prev) => (prev + chunk).slice(-8_000));
    });
    return () => {
      offEvent();
      offOutput();
    };
  }, [refresh]);

  useEffect(() => {
    const offOutput = window.shipyard.on('install:output', ({ chunk }) => {
      setLog((prev) => (prev + chunk).slice(-8_000));
    });
    const offResult = window.shipyard.on('install:result', ({ ok, message }) => {
      if (ok) {
        setNote('Installed. Checking again…');
        void refresh(true);
      } else {
        setNote(message ?? "The installer didn't finish. You can try again, or run the command yourself.");
        setPhase('need-install');
      }
    });
    return () => {
      offOutput();
      offResult();
    };
  }, [refresh]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const signIn = async (): Promise<void> => {
    setLog('');
    setPhase('logging-in');
    setNote('Opening your browser…');
    await window.shipyard.claude.startLogin();
  };

  const install = async (): Promise<void> => {
    setLog('');
    setPhase('installing');
    setNote('This usually takes a minute or two.');
    await window.shipyard.claude.runInstall();
  };

  const copy = async (): Promise<void> => {
    if (!plan) return;
    await navigator.clipboard.writeText(plan.command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1_600);
  };

  return (
    <div className="setup">
      <div className="setup-body">
        <h1>{headingFor(phase)}</h1>

        {phase === 'checking' && (
          <div className="panel">
            <div className="panel-head">
              <span className="status status-busy">
                <span className="status-dot" aria-hidden="true" />
                Checking
              </span>
            </div>
            <p className="muted">
              Looking for Claude Code on this computer. This takes a couple of seconds.
            </p>
          </div>
        )}

        {phase === 'updating' && (
          <div className="panel">
            <div className="panel-head">
              <span className="status status-busy">
                <span className="status-dot" aria-hidden="true" />
                Updating
              </span>
            </div>
            <p className="muted">
              Claude Code is updating itself right now. We&apos;ll pick up again as soon as it
              finishes.
            </p>
          </div>
        )}

        {phase === 'ready' && auth && (
          <div className="panel">
            <div className="panel-head">
              <span className="status status-ok">
                <span className="status-dot" aria-hidden="true" />
                Ready
              </span>
              <span className="text-sm muted">Claude Code {detect?.version}</span>
            </div>
            <p>
              Signed in as <strong>{auth.accountLabel ?? 'your Claude account'}</strong>
              {auth.tier && auth.tier !== 'unknown'
                ? ` on Claude ${auth.tier.charAt(0).toUpperCase()}${auth.tier.slice(1)}`
                : ''}
              .
            </p>
          </div>
        )}

        {phase === 'need-login' && (
          <div className="panel">
            <div className="panel-head">
              <span className="status status-warn">
                <span className="status-dot" aria-hidden="true" />
                Sign in needed
              </span>
            </div>
            <p>Claude Code is installed, but it isn&apos;t signed in yet.</p>
            <p className="text-sm muted">
              This opens claude.ai in your browser so you can sign in with Anthropic directly.
              Shipyard never sees your password.
            </p>
            {note && <p className="error-text">{note}</p>}
          </div>
        )}

        {phase === 'logging-in' && (
          <div className="panel">
            <div className="panel-head">
              <span className="status status-busy">
                <span className="status-dot" aria-hidden="true" />
                Signing in
              </span>
            </div>
            <p>{note || 'Opening your browser…'}</p>
            <p className="text-sm muted">Finish signing in there, then come back to this window.</p>
          </div>
        )}

        {(phase === 'need-install' || phase === 'installing') && plan && (
          <div className="panel">
            <div className="panel-head">
              <span className={`status ${phase === 'installing' ? 'status-busy' : ''}`}>
                <span className="status-dot" aria-hidden="true" />
                {phase === 'installing' ? 'Installing' : 'Not installed yet'}
              </span>
            </div>
            <p>
              {phase === 'installing'
                ? 'Installing Claude Code. You can watch what it’s doing below.'
                : 'Claude Code isn’t on this computer yet. We can install it for you.'}
            </p>
            <p className="text-sm muted">{plan.description}</p>

            <div className="field">
              <span className="label">Or run this yourself</span>
              <div className="command">
                <code>{plan.command}</code>
                <button className="btn btn-sm" onClick={() => void copy()}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>

            {note && <p className="text-sm muted">{note}</p>}
          </div>
        )}

        {phase === 'error' && (
          <div className="panel">
            <div className="panel-head">
              <span className="status status-danger">
                <span className="status-dot" aria-hidden="true" />
                Something&apos;s wrong
              </span>
            </div>
            <p>{note}</p>
          </div>
        )}

        {(log.length > 0 || detect) && (
          <div className="disclosure">
            <button
              className="disclosure-toggle"
              onClick={() => setShowDetails((v) => !v)}
              aria-expanded={showDetails}
            >
              <span className={`disclosure-caret${showDetails ? ' open' : ''}`} aria-hidden="true">
                ▸
              </span>
              {showDetails ? 'Hide technical details' : 'Show technical details'}
            </button>
            {showDetails && (
              <pre className="log" ref={logRef} tabIndex={0}>
                {detect?.path ? `Claude Code: ${detect.path}\n` : 'Claude Code: not found\n'}
                {detect?.problem ? `Note: ${detect.problem}\n` : ''}
                {log ? `\n${log}` : ''}
              </pre>
            )}
          </div>
        )}
      </div>

      <div className="setup-actions">
        {phase === 'ready' && detect && auth && (
          <button className="btn btn-primary" onClick={() => onReady(detect, auth)} autoFocus>
            Continue
          </button>
        )}
        {phase === 'need-login' && (
          <button className="btn btn-primary" onClick={() => void signIn()} autoFocus>
            Sign in to Claude
          </button>
        )}
        {phase === 'logging-in' && (
          <button className="btn" onClick={() => void window.shipyard.claude.cancelLogin()}>
            Cancel
          </button>
        )}
        {phase === 'need-install' && (
          <>
            <button
              className="btn btn-primary"
              onClick={() => void install()}
              disabled={!plan?.runnable}
              autoFocus
            >
              Install it for me
            </button>
            <button className="btn btn-quiet" onClick={() => void refresh(true)}>
              I&apos;ve installed it
            </button>
          </>
        )}
        {phase === 'error' && (
          <button className="btn btn-primary" onClick={() => void refresh(true)} autoFocus>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

function headingFor(phase: Phase): string {
  switch (phase) {
    case 'ready':
      return 'Claude Code is ready';
    case 'need-login':
      return 'Sign in to Claude';
    case 'logging-in':
      return 'Signing you in';
    case 'need-install':
      return 'We need to install one thing';
    case 'installing':
      return 'Installing Claude Code';
    case 'updating':
      return 'Claude Code is updating';
    case 'error':
      return "That didn't work";
    default:
      return 'Checking your setup';
  }
}
