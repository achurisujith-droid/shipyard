import { useEffect, useRef, useState } from 'react';

import type { RunnerInfo, RunnerStatus } from '@shipyard/shared';

interface Props {
  projectPath: string;
}

/**
 * The user's app, running on their machine, inside Shipyard.
 *
 * This is the half of the loop that makes the product useful: they see what
 * they built, and when it breaks we catch the break. Errors from the page are
 * reported to the main process, de-duplicated there, and surface in the chat as
 * a card with one button.
 *
 * The webview is a separate process with no Node access and no preload. It only
 * ever loads localhost, which is the user's own dev server.
 */
export function PreviewPane({ projectPath }: Props): JSX.Element {
  const [info, setInfo] = useState<RunnerInfo | null>(null);
  const [status, setStatus] = useState<RunnerStatus>({ state: 'idle' });
  /**
   * The script the user picked in this session, before they pressed Run. Null
   * means "whatever the project says", which is what `info.script` already is.
   */
  const [chosen, setChosen] = useState<string | null>(null);
  const webviewRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    void window.shipyard.runner.inspect(projectPath).then(setInfo);
    void window.shipyard.runner.status().then(setStatus);
    return window.shipyard.on('runner:status', setStatus);
  }, [projectPath]);

  // A different project has different scripts; carrying a name across would
  // silently run the wrong thing or nothing at all.
  useEffect(() => setChosen(null), [projectPath]);

  const run = (): void => {
    void window.shipyard.runner.start(projectPath, chosen ?? undefined);
  };

  // Re-check whether the project is runnable when Claude finishes a turn: the
  // whole point is that it did not exist a minute ago and now it does.
  useEffect(() => {
    const timer = setInterval(() => {
      if (status.state === 'idle' || status.state === 'failed') {
        void window.shipyard.runner.inspect(projectPath).then(setInfo);
      }
    }, 4_000);
    return () => clearInterval(timer);
  }, [projectPath, status.state]);

  /**
   * Console errors and failed loads from the previewed page. `console-message`
   * carries uncaught exceptions too, which is most of what we want.
   */
  useEffect(() => {
    const node = webviewRef.current;
    if (!node) return;

    const onConsole = (event: Event): void => {
      const e = event as Event & { level?: number; message?: string; sourceId?: string; line?: number };
      // Electron levels: 0 verbose, 1 info, 2 warning, 3 error.
      if ((e.level ?? 0) < 3) return;
      const message = e.message ?? '';
      if (!message.trim()) return;
      const location = e.sourceId ? `${shorten(e.sourceId)}${e.line ? `:${e.line}` : ''}` : undefined;
      void window.shipyard.runner.reportBrowserProblem(message, message, location);
    };

    const onFailLoad = (event: Event): void => {
      const e = event as Event & { errorDescription?: string; validatedURL?: string };
      // -3 is ABORTED, which happens on ordinary navigation.
      const description = e.errorDescription ?? '';
      if (!description || description === 'ERR_ABORTED') return;
      void window.shipyard.runner.reportBrowserProblem(
        `The page failed to load: ${description}`,
        `${description}\n${e.validatedURL ?? ''}`,
      );
    };

    node.addEventListener('console-message', onConsole);
    node.addEventListener('did-fail-load', onFailLoad);
    return () => {
      node.removeEventListener('console-message', onConsole);
      node.removeEventListener('did-fail-load', onFailLoad);
    };
  }, [status.url]);

  const reload = (): void => {
    const node = webviewRef.current as (HTMLElement & { reload?: () => void }) | null;
    node?.reload?.();
  };

  return (
    <div className="preview">
      <div className="preview-bar">
        <span className={`status ${statusTone(status)}`}>
          <span className="status-dot" aria-hidden="true" />
          {statusLabel(status)}
        </span>

        {status.url && <code className="preview-url">{status.url}</code>}

        {/* Only when there is a real choice. One script is not a decision, and
            showing a menu of one teaches people to read menus that say nothing. */}
        {(status.state === 'idle' || status.state === 'stopped' || status.state === 'failed') &&
          (info?.scripts?.length ?? 0) > 1 && (
            <label className="preview-script">
              <span>Start with</span>
              <select
                value={chosen ?? info?.script ?? ''}
                onChange={(event) => setChosen(event.target.value)}
              >
                {info?.scripts?.map((script) => (
                  <option key={script.name} value={script.name}>
                    {script.name} — {script.command}
                  </option>
                ))}
              </select>
            </label>
          )}

        <div className="preview-actions">
          {status.state === 'running' && (
            <>
              {/* Says what Shipyard is doing on their behalf, so a restart they
                  did not ask for is not a mystery when it happens. */}
              {status.watching && (
                <span className="preview-watching">Restarts when your files change</span>
              )}
              <button className="btn btn-quiet btn-sm" onClick={reload}>
                Reload
              </button>
              <button
                className="btn btn-quiet btn-sm"
                onClick={() => status.url && void window.shipyard.app.openExternal(status.url)}
              >
                Open in browser
              </button>
              <button
                className="btn btn-quiet btn-sm"
                onClick={() => void window.shipyard.runner.stop()}
              >
                Stop
              </button>
            </>
          )}
          {/* Setting up can take minutes. Leaving the user with no way out of
              it makes an ordinary wait feel like a hang. */}
          {(status.state === 'installing' ||
            status.state === 'preparing' ||
            status.state === 'starting') && (
            <button className="btn btn-quiet btn-sm" onClick={() => void window.shipyard.runner.stop()}>
              Cancel
            </button>
          )}
          {(status.state === 'idle' || status.state === 'stopped' || status.state === 'failed') &&
            info?.canRun && (
              <button className="btn btn-sm" onClick={run}>
                {info.needsInstall || info.needsDatabase ? 'Set up and run' : 'Run my app'}
              </button>
            )}
        </div>
      </div>

      <div className="preview-body">
        {status.state === 'running' && status.url ? (
          <webview
            ref={webviewRef}
            src={status.url}
            className="preview-frame"
            // No Node, no preload: this renders the user's app, nothing more.
            webpreferences="contextIsolation=yes,nodeIntegration=no"
          />
        ) : (
          <div className="preview-placeholder">
            {status.state === 'starting' && <p className="muted">Starting your app…</p>}
            {status.state === 'installing' && (
              <>
                <p className="muted">Installing the pieces your app needs…</p>
                <p className="text-sm muted">
                  This only happens once, and can take a minute or two.
                </p>
              </>
            )}
            {status.state === 'preparing' && (
              <>
                <p className="muted">{status.message ?? 'Getting your database ready…'}</p>
                <p className="text-sm muted">
                  Your app stores information, so it needs a database. Shipyard runs one for you
                  on this computer — there is nothing to install.
                </p>
              </>
            )}
            {status.state === 'failed' && (
              <>
                <p>{status.message ?? "Your app didn't start."}</p>
                <p className="text-sm muted">
                  Ask Claude in the chat and it can look at what went wrong.
                </p>
              </>
            )}
            {(status.state === 'idle' || status.state === 'stopped') && (
              <>
                <p className="muted">{info?.canRun ? 'Your app isn’t running.' : info?.reason}</p>
                {info?.canRun && (
                  <button className="btn" onClick={run}>
                    Run my app
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function statusLabel(status: RunnerStatus): string {
  switch (status.state) {
    case 'installing':
      return 'Getting things ready';
    case 'preparing':
      return 'Setting up your database';
    case 'starting':
      return 'Starting';
    case 'running':
      return 'Running';
    case 'failed':
      return "Didn't start";
    case 'stopped':
      return 'Stopped';
    default:
      return 'Not running';
  }
}

function statusTone(status: RunnerStatus): string {
  switch (status.state) {
    case 'running':
      return 'status-ok';
    case 'installing':
    case 'preparing':
    case 'starting':
      return 'status-busy';
    case 'failed':
      return 'status-danger';
    default:
      return '';
  }
}

/** Turn a long source URL into something a person can read. */
function shorten(sourceId: string): string {
  try {
    return new URL(sourceId).pathname.replace(/^\//, '');
  } catch {
    return sourceId.split(/[\\/]/).slice(-2).join('/');
  }
}
