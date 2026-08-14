import { contextBridge, ipcRenderer } from 'electron';

import {
  IPC_CHANNELS,
  type EventMessage,
  type ShipyardApi,
  type ShipyardEventName,
  type ShipyardEvents,
} from '@shipyard/shared';

/**
 * The entire bridge between the renderer and the rest of the app.
 *
 * The renderer has `contextIsolation: true` and `nodeIntegration: false`, so
 * this object is all it can reach. Nothing here forwards raw Node APIs; every
 * method is a named route the main process validates before acting on.
 */
function invoke(path: string, ...args: unknown[]): Promise<unknown> {
  return ipcRenderer.invoke(IPC_CHANNELS.invoke, { path, args });
}

/** Typed wrapper so each API method keeps its declared return type. */
function call<T>(path: string, ...args: unknown[]): Promise<T> {
  return invoke(path, ...args) as Promise<T>;
}

const api: ShipyardApi = {
  claude: {
    detect: () => call('claude.detect'),
    redetect: () => call('claude.redetect'),
    authStatus: () => call('claude.authStatus'),
    startLogin: () => call('claude.startLogin'),
    cancelLogin: () => call('claude.cancelLogin'),
    writeLogin: (data) => call('claude.writeLogin', data),
    installPlan: () => call('claude.installPlan'),
    runInstall: () => call('claude.runInstall'),
  },
  session: {
    create: (projectPath) => call('session.create', projectPath),
    send: (sessionId, text) => call('session.send', sessionId, text),
    respondToPermission: (sessionId, optionIndex) =>
      call('session.respondToPermission', sessionId, optionIndex),
    restart: (sessionId) => call('session.restart', sessionId),
    kill: (sessionId) => call('session.kill', sessionId),
    state: (sessionId) => call('session.state', sessionId),
  },
  projects: {
    list: () => call('projects.list'),
    defaultRoot: () => call('projects.defaultRoot'),
    chooseRoot: () => call('projects.chooseRoot'),
    addExisting: () => call('projects.addExisting'),
    forget: (id) => call('projects.forget', id),
    reveal: (projectPath) => call('projects.reveal', projectPath),
  },
  runner: {
    inspect: (projectPath) => call('runner.inspect', projectPath),
    start: (projectPath, script) => call('runner.start', projectPath, script),
    stop: () => call('runner.stop'),
    status: () => call('runner.status'),
    reportBrowserProblem: (message, detail, location) =>
      call('runner.reportBrowserProblem', message, detail, location),
    clearProblems: () => call('runner.clearProblems'),
  },
  library: {
    list: (projectPath, search) => call('library.list', projectPath, search),
    detail: (id) => call('library.detail', id),
    plan: (id, projectPath) => call('library.plan', id, projectPath),
    install: (id, projectPath) => call('library.install', id, projectPath),
    planRemoval: (id, projectPath) => call('library.planRemoval', id, projectPath),
    uninstall: (id, projectPath) => call('library.uninstall', id, projectPath),
    planUpgrade: (id, projectPath) => call('library.planUpgrade', id, projectPath),
    upgrade: (id, projectPath) => call('library.upgrade', id, projectPath),
    installed: (projectPath) => call('library.installed', projectPath),
    tampering: (projectPath) => call('library.tampering', projectPath),
  },
  intake: {
    plan: (answers, projectPath) => call('intake.plan', answers, projectPath),
    create: (plan, markdown) => call('intake.create', plan, markdown),
    suggestPath: (name) => call('intake.suggestPath', name),
  },
  app: {
    info: () => call('app.info'),
    openExternal: (url) => call('app.openExternal', url),
    toolchain: () => call('app.toolchain'),
  },

  on<K extends ShipyardEventName>(
    event: K,
    listener: (payload: ShipyardEvents[K]) => void,
  ): () => void {
    const handler = (_e: unknown, message: EventMessage): void => {
      if (message.event !== event) return;
      listener(message.payload as ShipyardEvents[K]);
    };
    ipcRenderer.on(IPC_CHANNELS.event, handler);
    return () => {
      ipcRenderer.off(IPC_CHANNELS.event, handler);
    };
  },
};

contextBridge.exposeInMainWorld('shipyard', api);
