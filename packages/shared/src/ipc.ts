/**
 * The IPC contract between the Electron main process and the renderer.
 *
 * Defined before either side is written, deliberately: the renderer has
 * `nodeIntegration: false` and `contextIsolation: true`, so this file is the
 * ONLY surface it can reach. Anything not described here, the UI cannot do.
 *
 * Two directions:
 *  - `ShipyardBridge` — request/response calls the renderer makes (ipcRenderer.invoke)
 *  - `ShipyardEvents` — pushes from main to renderer (webContents.send)
 */
import type {
  AuthStatus,
  DetectResult,
  LoginEvent,
  PermissionRequest,
  RateLimitInfo,
  SessionErrorInfo,
  SessionState,
  ToolSummary,
} from './claude-types';
import type { IntakeAnswers, ProjectPlan } from './intake';
import type {
  ComponentInstallPlan,
  ComponentInstallResult,
  ComponentManifest,
  LibraryEntry,
} from './components';

/** Channel names. Kept in one place so main and preload cannot drift. */
export const IPC_CHANNELS = {
  invoke: 'shipyard:invoke',
  event: 'shipyard:event',
} as const;

export interface SessionHandle {
  sessionId: string;
  cwd: string;
}

/** A project directory Shipyard created and tracks. */
export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. When the user last opened it, so the list can lead with it. */
  lastOpenedAt: string;
  /**
   * Whether the folder is still on disk. Users move and delete folders, and a
   * list that silently fails to open one is worse than one that says so.
   */
  missing?: boolean;
}

/** One of the project's scripts that could start it. */
export interface RunnableScript {
  /** The npm script name, e.g. `dev`. */
  name: string;
  /**
   * What that script actually runs, e.g. `vite`. Shown alongside the name,
   * because "dev" and "start" tell a non-programmer nothing about which is
   * which and the underlying command sometimes does.
   */
  command: string;
  /**
   * The script watches the project and restarts itself. Shipyard must not also
   * restart it: two watchers on one project fight, and the user sees their app
   * bounce twice for every edit.
   */
  selfReloading: boolean;
}

/** What we learned about how (or whether) this project can be run. */
export interface RunnerInfo {
  canRun: boolean;
  /** The command we would run, e.g. "npm run dev". Display only. */
  command?: string;
  /** Why it cannot run, in plain language. */
  reason?: string;
  /**
   * Dependencies are missing, so starting will install them first. Worth
   * surfacing: it turns a fast action into a slow one and the user should know
   * before they press the button.
   */
  needsInstall?: boolean;
  /**
   * This project talks to Postgres, so starting it also starts a database.
   * The first run creates one, which takes a few seconds longer.
   */
  needsDatabase?: boolean;
  /**
   * Every script that could start this project, likeliest first. Absent for a
   * static site, which has no scripts at all.
   *
   * More than one entry means our pick is a guess. A project with both `dev`
   * and `start` usually means one is the real entry point and the other builds
   * for production, and only the person who asked for it knows which.
   */
  scripts?: RunnableScript[];
  /** The script that runs unless the user chooses another. */
  script?: string;
}

export type RunnerState =
  | 'idle'
  | 'installing'
  /** Starting the database and bringing its tables up to date. */
  | 'preparing'
  | 'starting'
  | 'running'
  | 'stopped'
  | 'failed';

export interface RunnerStatus {
  state: RunnerState;
  /** Local URL once we have seen the dev server announce one. */
  url?: string;
  command?: string;
  /** Plain-language explanation, shown when state is `failed`. */
  message?: string;
  /** The script name this run started from, so the UI can keep showing it. */
  script?: string;
  /**
   * Shipyard is watching the project and will restart the app when Claude
   * changes a file. Only true for apps that cannot reload themselves.
   */
  watching?: boolean;
}

/**
 * Something went wrong in the running app.
 *
 * Deliberately not called an "error": it covers failed builds, runtime
 * exceptions, and failed page loads, and the user only cares that their app is
 * broken and that one button will try to fix it.
 */
export interface DetectedProblem {
  id: string;
  /** Where we saw it: the dev server's output, or the previewed page. */
  source: 'server' | 'browser';
  /** One-line headline, already trimmed of noise. */
  message: string;
  /** Full text: stack trace, compiler output. Shown on expand and sent to Claude. */
  detail: string;
  /** `src/App.tsx:24` when we can parse it out. */
  location?: string;
}

export interface InstallPlan {
  /** The official one-line install command, shown with a Copy button. */
  command: string;
  /** Human-readable note about what it does. */
  description: string;
  /** False when we have no supported automatic install for this platform. */
  runnable: boolean;
}

/**
 * Everything the renderer can call. Each method is asynchronous because every
 * one crosses a process boundary.
 */
export interface ShipyardBridge {
  claude: {
    /** Cached where possible; safe to call on every screen mount. */
    detect(): Promise<DetectResult>;
    /** Forces a fresh look, ignoring the cached path. Used after an install. */
    redetect(): Promise<DetectResult>;
    authStatus(): Promise<AuthStatus>;
    /** Begins the browser sign-in flow. Progress arrives as `login:*` events. */
    startLogin(): Promise<void>;
    cancelLogin(): Promise<void>;
    /** Keystrokes for the embedded terminal behind "Show details". */
    writeLogin(data: string): Promise<void>;
    installPlan(): Promise<InstallPlan>;
    /** "Run this for me" - output arrives as `install:*` events. */
    runInstall(): Promise<void>;
  };

  session: {
    create(projectPath: string): Promise<SessionHandle>;
    send(sessionId: string, text: string): Promise<void>;
    /** 1-based index into the prompt's own option list. Never a boolean. */
    respondToPermission(sessionId: string, optionIndex: number): Promise<void>;
    restart(sessionId: string): Promise<void>;
    kill(sessionId: string): Promise<void>;
    state(sessionId: string): Promise<SessionState | null>;
  };

  projects: {
    /** Most recently opened first. */
    list(): Promise<ProjectRecord[]>;
    /** Default parent folder for new projects, e.g. ~/Shipyard. */
    defaultRoot(): Promise<string>;
    /** Lets the user pick a different parent folder. Returns null if cancelled. */
    chooseRoot(): Promise<string | null>;
    /** Adopt a folder that already exists. Returns null if cancelled. */
    addExisting(): Promise<ProjectRecord | null>;
    /** Take it off the list. Never deletes the folder. */
    forget(id: string): Promise<void>;
    /** Show the folder in Explorer / Finder / the file manager. */
    reveal(projectPath: string): Promise<void>;
  };

  /**
   * Running the user's project and watching it for problems. This is the loop
   * that makes the product useful: run it, see it, catch the break, fix it.
   */
  runner: {
    /** Can this project be started, and with what command? */
    inspect(projectPath: string): Promise<RunnerInfo>;
    /**
     * Start it. `script` overrides our pick and is remembered for this project,
     * because a user who has already said "it's `serve`, not `dev`" should not
     * have to say it again every time they press Run.
     */
    start(projectPath: string, script?: string): Promise<void>;
    stop(): Promise<void>;
    status(): Promise<RunnerStatus>;
    /**
     * The renderer owns the preview webview, so browser-side problems are
     * observed there and handed back to main for de-duplication and dispatch.
     */
    reportBrowserProblem(message: string, detail: string, location?: string): Promise<void>;
    /** Forget the problems we have already seen, e.g. after a successful fix. */
    clearProblems(): Promise<void>;
  };

  /**
   * Starting a project: three questions, then a plan the user reviews before
   * anything is written to disk.
   */
  intake: {
    /** Turn the answers into a plan. Writes nothing. */
    plan(answers: IntakeAnswers, projectPath: string): Promise<ProjectPlan>;
    /** Create the folder, PROJECT.md and the skill files. */
    create(plan: ProjectPlan, markdown: string): Promise<void>;
    /** Suggested folder path for a project with this name. */
    suggestPath(name: string): Promise<string>;
  };

  /**
   * The component library: browsing verified parts and putting them into a
   * project. Every install is a two-step — plan, then apply — because the
   * person approving it cannot read the diff, so the description has to be
   * complete before anything is written.
   */
  library: {
    /**
     * The list to show. Ordered by what this project needs rather than
     * alphabetically, so the first thing on screen is the thing they were told
     * they need.
     */
    list(projectPath?: string, search?: string): Promise<LibraryEntry[]>;
    detail(id: string): Promise<ComponentManifest | null>;
    /** Everything installing this would do. Writes nothing. */
    plan(id: string, projectPath: string): Promise<ComponentInstallPlan>;
    /** Do it. Refuses rather than overwriting anything the user already has. */
    install(id: string, projectPath: string): Promise<ComponentInstallResult>;
    /** Component id → installed version. */
    installed(projectPath: string): Promise<Record<string, string>>;
    /**
     * Files belonging to an installed component that no longer match what was
     * installed. Detection, not prevention — Shipyard cannot stop the agent
     * writing to a file, only notice that it did.
     */
    tampering(projectPath: string): Promise<{ path: string; componentId: string; status: 'modified' | 'deleted' }[]>;
  };

  app: {
    /** Platform + versions, for the "Show details" diagnostics panel. */
    info(): Promise<AppInfo>;
    openExternal(url: string): Promise<void>;
    /** Are the bundled Node and PostgreSQL runtimes present and usable? */
    toolchain(): Promise<ToolchainStatus>;
  };
}

/**
 * Shipyard ships its own Node and PostgreSQL so a user never installs either.
 * If this is not ready the app can still chat, but it cannot run anything.
 */
export interface ToolchainStatus {
  ready: boolean;
  nodeVersion?: string;
  postgresVersion?: string;
  /** Plain-language explanation when `ready` is false. */
  reason?: string;
}

export interface AppInfo {
  platform: NodeJS.Platform;
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
}

/** Pushes from main to renderer. */
export interface ShipyardEvents {
  'login:event': LoginEvent;
  'login:output': { chunk: string };
  'install:output': { chunk: string };
  'install:result': { ok: boolean; message?: string };
  'session:state': { sessionId: string; state: SessionState; previous: SessionState };
  'session:assistant-text': { sessionId: string; text: string };
  /** Replaces the previous partial for this session; never appends. */
  'session:assistant-partial': { sessionId: string; text: string };
  'session:tool-summary': { sessionId: string; tool: ToolSummary };
  'session:permission-request': { sessionId: string; request: PermissionRequest };
  'session:rate-limited': { sessionId: string; info: RateLimitInfo };
  'session:error': { sessionId: string; error: SessionErrorInfo };
  'runner:status': RunnerStatus;
  'runner:log': { chunk: string };
  'runner:problem': DetectedProblem;
  /**
   * Problems from this source turned out not to matter — drop their cards.
   *
   * Sent when the app starts serving pages: whatever it complained about on the
   * way up, it works. Leaving a red card next to a working app teaches people
   * to ignore the cards.
   */
  'runner:problems-resolved': { source: DetectedProblem['source'] };
}

export type ShipyardEventName = keyof ShipyardEvents;

/** The object `preload` exposes on `window.shipyard`. */
export interface ShipyardApi extends ShipyardBridge {
  /** Subscribe to a main-process event. Returns an unsubscribe function. */
  on<K extends ShipyardEventName>(
    event: K,
    listener: (payload: ShipyardEvents[K]) => void,
  ): () => void;
}

/**
 * Shape of a single invoke message. The renderer never names an ipcMain channel
 * directly; it sends {path, args} through one channel and main dispatches.
 */
export interface InvokeMessage {
  /** e.g. "claude.detect", "session.send" */
  path: string;
  args: unknown[];
}

export interface EventMessage<K extends ShipyardEventName = ShipyardEventName> {
  event: K;
  payload: ShipyardEvents[K];
}
