import path from 'node:path';

import { BrowserWindow, app, shell } from 'electron';

import { IPC_CHANNELS, type ShipyardEventName, type ShipyardEvents } from '@shipyard/shared';
import { GATES } from '@shipyard/verification-runner';

import { CLIManager } from './cli-manager';
import { Intake } from './intake';
import { registerIpc } from './ipc';
import { Connectors } from './connectors';
import { Contracts } from './contracts';
import { Library, componentsRoot } from './library';
import { PostgresManager } from './postgres';
import { ProjectRunner } from './project-runner';
import { Store } from './store';
import { Toolchain, toolchainRoot } from './toolchain';

/** Set by scripts/dev.mjs; absent in a packaged build. */
const DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];

let mainWindow: BrowserWindow | null = null;
let store: Store | null = null;
let manager: CLIManager | null = null;
let runner: ProjectRunner | null = null;
let toolchain: Toolchain | null = null;
let postgres: PostgresManager | null = null;

// A second instance would fight over the SQLite file and could orphan CLI
// processes, so the first instance takes the lock and later launches just focus it.
if (!app.requestSingleInstanceLock()) {
  // In smoke mode this must be loud. Quitting silently with exit code 0 makes
  // the self-check look like it passed when it never ran at all.
  if (process.env['SHIPYARD_SMOKE']) {
    console.error(
      'SMOKE_ERROR another Shipyard instance is already running and holds the single-instance lock',
    );
    process.exit(2);
  }
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(bootstrap).catch(handleFatal);
}

function bootstrap(): void {
  store = new Store();
  manager = new CLIManager(store, emitToRenderer);
  toolchain = new Toolchain({
    // Packaged: alongside the app's own resources. Development: the repo, where
    // scripts/fetch-toolchain.mjs put them.
    root: toolchainRoot(app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..')),
    cacheDir: path.join(app.getPath('userData'), 'npm-cache'),
    packaged: app.isPackaged,
  });
  // Each project's database lives under userData, so removing a project takes
  // its data with it and nothing is left behind in the user's home directory.
  postgres = new PostgresManager(toolchain, path.join(app.getPath('userData'), 'databases'));
  runner = new ProjectRunner(emitToRenderer, toolchain, postgres, store);
  const intake = new Intake(
    path.join(
      app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..'),
      'resources',
      'skills',
    ),
  );
  const catalogRoot = path.join(
    app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..', '..', '..'),
    'shipyard-catalog',
  );
  const metadata = store.metadata;
  const projects = store;
  const contracts = new Contracts(catalogRoot, metadata);
  const connectors = new Connectors(catalogRoot, metadata);
  const library = new Library({
    root: componentsRoot(app.isPackaged, __dirname),
    // Installing something changes what the project is made of, so the
    // documents that describe it are rewritten rather than left to drift.
    onChanged: async (projectPath, projectId) => {
      const project = projects.findProjectByPath(projectPath);
      const intent = projectId ? metadata.intent(projectId) : undefined;
      if (!project || !intent) return;
      await contracts.refresh({
        projectId: project.id,
        projectPath,
        name: project.name,
        idea: metadata.contract(project.id)?.projectMd?.slice(0, 200) ?? project.name,
        intent,
      });
    },
    // A manifest cannot claim a check that nothing runs, or a capability the
    // catalog has never heard of. Enforced at load rather than trusted.
    knownGates: GATES.map((gate) => gate.id),
    metadata: store.metadata,
  });
  registerIpc(manager, store, runner, toolchain, intake, library, contracts, connectors);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1_100,
    height: 760,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: '#0f1115',
    title: 'Shipyard',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      // The renderer gets no Node APIs and no direct access to main's globals.
      // Everything it can do is the typed surface exposed in preload/index.ts.
      contextIsolation: true,
      nodeIntegration: false,
      // The preload imports the shared IPC contract from disk, which Electron's
      // sandbox would block. Isolation and the lack of nodeIntegration are what
      // actually keep the renderer contained; the preload stays deliberately tiny.
      sandbox: false,
      spellcheck: false,
      // The preview pane renders the user's own app from their local dev
      // server. The <webview> is a separate process with no Node access and no
      // preload of its own; it can only reach what it loads.
      webviewTag: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (process.env['SHIPYARD_SMOKE'] === '1') return; // stay hidden for the self-check
    mainWindow?.show();
  });

  const smokeMode = process.env['SHIPYARD_SMOKE'];
  if (smokeMode === '1' || smokeMode === 'session') {
    mainWindow.webContents.once('did-finish-load', () => {
      const win = mainWindow;
      if (!win) return;
      void import('./smoke')
        .then(async ({ runSmoke, runSessionSmoke }) => {
          let failures = await runSmoke(win);
          if (smokeMode === 'session') {
            const dir = path.join(app.getPath('temp'), `shipyard-smoke-${process.pid}`);
            failures += await runSessionSmoke(win, dir, (id) => manager?.pidOf(id));
          }
          return failures;
        })
        .then((failures) => {
          process.exitCode = failures > 0 ? 1 : 0;
          app.quit();
        })
        .catch((err: unknown) => {
          console.error('SMOKE_ERROR', err);
          process.exitCode = 1;
          app.quit();
        });
    });
  }
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // The renderer only ever shows local content. Anything trying to navigate
  // away or open a window is a bug or an attack; send links to the real browser.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (DEV_SERVER_URL && url.startsWith(DEV_SERVER_URL)) return;
    event.preventDefault();
    void openExternalIfWeb(url);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalIfWeb(url);
    return { action: 'deny' };
  });

  if (DEV_SERVER_URL) {
    void mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }
}

async function openExternalIfWeb(url: string): Promise<void> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      await shell.openExternal(url);
    }
  } catch {
    /* not a URL we can act on */
  }
}

function emitToRenderer<K extends ShipyardEventName>(event: K, payload: ShipyardEvents[K]): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC_CHANNELS.event, { event, payload });
}

/**
 * Quitting must not leave a `claude` process running - that is an explicit
 * Milestone 2 acceptance criterion. `before-quit` fires before windows close,
 * which gives the PTYs a chance to die with us.
 */
app.on('before-quit', () => {
  manager?.shutdown();
  runner?.shutdown();
});

/**
 * Stopping Postgres is asynchronous and quitting is not, so we hold the quit
 * open for one pass.
 *
 * An orphaned database server is worse than an orphaned dev server: it keeps a
 * lock on its data directory, and the user has no way to find it or stop it.
 * The timeout means a wedged server delays quit by two seconds rather than
 * preventing it.
 */
let shuttingDown = false;
app.on('will-quit', (event) => {
  manager?.shutdown();
  runner?.shutdown();

  if (postgres && !shuttingDown) {
    shuttingDown = true;
    event.preventDefault();
    void Promise.race([postgres.stopAll(), delay(2_000)]).finally(() => {
      store?.close();
      app.quit();
    });
    return;
  }

  store?.close();
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

app.on('window-all-closed', () => {
  // macOS convention is to stay alive, but a headless Shipyard has nothing to
  // do and would keep CLI processes around, so quit everywhere.
  app.quit();
});

function handleFatal(error: unknown): void {
  console.error('Shipyard failed to start:', error);
  app.quit();
}
