import { useCallback, useEffect, useState } from 'react';

import type { ProjectRecord, SessionHandle } from '@shipyard/shared';

import { formatWhen } from '../lib/format';

interface Props {
  onOpened: (session: SessionHandle) => void;
  onNew: () => void;
}

/**
 * Home: everything the user has built, and the way back into any of it.
 *
 * The first screen after setup, and the one they return to. Its whole job is to
 * answer "where are my apps?" without the user having to remember a folder
 * path, which is exactly the kind of thing this audience should never need to
 * hold in their head.
 */
export function HomeScreen({ onOpened, onNew }: Props): JSX.Element {
  const [projects, setProjects] = useState<ProjectRecord[] | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async (): Promise<void> => {
    setProjects(await window.shipyard.projects.list());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = async (project: ProjectRecord): Promise<void> => {
    if (opening || project.missing) return;
    setOpening(project.id);
    setError('');
    try {
      onOpened(await window.shipyard.session.create(project.path));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setOpening(null);
    }
  };

  const addExisting = async (): Promise<void> => {
    const added = await window.shipyard.projects.addExisting();
    if (!added) return;
    await refresh();
    void open(added);
  };

  const forget = async (project: ProjectRecord): Promise<void> => {
    await window.shipyard.projects.forget(project.id);
    await refresh();
  };

  return (
    <div className="home">
      <header className="home-header">
        <div>
          <h1 className="home-title">Your apps</h1>
          <p className="home-lede">
            {projects === null
              ? 'Looking…'
              : projects.length === 0
                ? 'Nothing here yet.'
                : `${projects.length} ${projects.length === 1 ? 'app' : 'apps'} on this computer.`}
          </p>
        </div>
        <div className="home-header-actions">
          <button className="btn btn-quiet" onClick={() => void addExisting()}>
            Open a folder
          </button>
          <button className="btn btn-primary" onClick={onNew}>
            New app
          </button>
        </div>
      </header>

      {error && <p className="error-text home-error">{error}</p>}

      {projects !== null && projects.length === 0 ? (
        <div className="home-empty">
          <h2>Start with something small</h2>
          <p className="muted">
            Describe what you want in plain words and Claude builds it here on your computer. You
            can see it running before anyone else ever does.
          </p>
          <button className="btn btn-primary" onClick={onNew}>
            Build my first app
          </button>
          <p className="text-sm muted home-empty-note">
            Already have a folder of code? <button className="linkish" onClick={() => void addExisting()}>Open it instead</button>.
          </p>
        </div>
      ) : (
        <ul className="project-list">
          {(projects ?? []).map((project) => (
            <li key={project.id}>
              <div className={`project-card${project.missing ? ' project-card-missing' : ''}`}>
                <button
                  className="project-main"
                  onClick={() => void open(project)}
                  disabled={project.missing || opening !== null}
                >
                  <span className="project-name">{project.name}</span>
                  <span className="project-meta">
                    {project.missing
                      ? 'This folder has moved or been deleted'
                      : `Opened ${formatWhen(project.lastOpenedAt)}`}
                  </span>
                  <span className="project-path" title={project.path}>
                    {project.path}
                  </span>
                </button>

                <div className="project-actions">
                  {opening === project.id ? (
                    <span className="text-sm muted">Starting…</span>
                  ) : project.missing ? (
                    <button className="btn btn-quiet btn-sm" onClick={() => void forget(project)}>
                      Remove
                    </button>
                  ) : (
                    <>
                      <button
                        className="btn btn-quiet btn-sm"
                        onClick={() => void window.shipyard.projects.reveal(project.path)}
                      >
                        Show folder
                      </button>
                      <button className="btn btn-sm" onClick={() => void open(project)}>
                        Open
                      </button>
                    </>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
