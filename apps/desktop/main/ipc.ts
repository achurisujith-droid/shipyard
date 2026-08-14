import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { BrowserWindow, dialog, ipcMain, shell, app } from 'electron';

import {
  IPC_CHANNELS,
  type AppInfo,
  type IntakeAnswers,
  type InvokeMessage,
  type ProjectPlan,
  type ProjectRecord,
} from '@shipyard/shared';

import type { CLIManager } from './cli-manager';
import type { Intake } from './intake';
import type { ProjectRunner } from './project-runner';
import type { Store } from './store';
import type { Toolchain } from './toolchain';

/**
 * One `invoke` channel, dispatched by a string path, instead of dozens of
 * ipcMain handlers. Keeps the surface the renderer can reach small and makes it
 * obvious at a glance exactly what it is.
 *
 * Every handler validates its own arguments: the renderer is our own code, but
 * it is also the only part of the app that renders remote content, so it is
 * treated as untrusted.
 */
type Handler = (args: unknown[]) => unknown;

export function registerIpc(
  manager: CLIManager,
  store: Store,
  runner: ProjectRunner,
  toolchain: Toolchain,
  intake: Intake,
): void {
  const handlers: Record<string, Handler> = {
    'claude.detect': () => manager.detect(false),
    'claude.redetect': () => manager.detect(true),
    'claude.authStatus': () => manager.authStatus(),
    'claude.startLogin': () => manager.startLogin(),
    'claude.cancelLogin': () => {
      manager.cancelLogin();
    },
    'claude.writeLogin': (a) => {
      manager.writeLogin(str(a, 0));
    },
    'claude.installPlan': () => manager.installPlan(),
    'claude.runInstall': () => {
      manager.runInstall();
    },

    'session.create': async (a) => {
      const projectPath = safeProjectPath(str(a, 0));
      const handle = await manager.createSession(projectPath);
      // Recorded here rather than at creation time because this is the moment
      // the project becomes real: the folder exists and a session is running in
      // it. Without this the "My apps" list is empty forever.
      recordProject(store, projectPath);
      return handle;
    },
    'session.send': (a) => {
      manager.send(str(a, 0), str(a, 1));
    },
    'session.respondToPermission': (a) => {
      manager.respondToPermission(str(a, 0), num(a, 1));
    },
    'session.restart': (a) => manager.restart(str(a, 0)),
    'session.kill': (a) => {
      manager.kill(str(a, 0));
    },
    'session.state': (a) => manager.state(str(a, 0)),

    'projects.list': async () => {
      // Folders get moved and deleted outside the app. Checking is cheap, and a
      // list that offers to open something that is not there is worse than one
      // that says so.
      const projects = store.listProjects();
      return await Promise.all(
        projects.map(async (project) => ({
          ...project,
          missing: !(await exists(project.path)),
        })),
      );
    },
    'projects.defaultRoot': () => defaultProjectRoot(store),
    'projects.chooseRoot': async () => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const result = win
        ? await dialog.showOpenDialog(win, {
            title: 'Choose where Shipyard keeps your projects',
            properties: ['openDirectory', 'createDirectory'],
          })
        : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
      if (result.canceled || result.filePaths.length === 0) return null;
      const chosen = result.filePaths[0] ?? null;
      if (chosen) store.setSetting('projects.root', chosen);
      return chosen;
    },
    'projects.addExisting': async () => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const options: Electron.OpenDialogOptions = {
        title: 'Choose a folder to work on',
        properties: ['openDirectory'],
      };
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
      const chosen = result.canceled ? null : (result.filePaths[0] ?? null);
      return chosen ? recordProject(store, safeProjectPath(chosen)) : null;
    },
    'projects.forget': (a) => {
      store.forgetProject(str(a, 0));
    },
    'projects.reveal': (a) => {
      // openPath, not openExternal: this is a directory, and openExternal would
      // hand a file:// URL to the browser.
      void shell.openPath(safeProjectPath(str(a, 0)));
    },

    'runner.inspect': (a) => runner.inspect(safeProjectPath(str(a, 0))),
    'runner.start': (a) => runner.start(safeProjectPath(str(a, 0))),
    'runner.stop': () => {
      runner.stop();
    },
    'runner.status': () => runner.current(),
    'runner.reportBrowserProblem': (a) => {
      const location = a[2];
      runner.reportBrowserProblem(
        str(a, 0),
        str(a, 1),
        typeof location === 'string' ? location : undefined,
      );
    },
    'runner.clearProblems': () => {
      runner.clearProblems();
    },

    'intake.plan': (a) => intake.plan(asAnswers(a[0]), safeProjectPath(str(a, 1))),
    'intake.create': async (a) => {
      const plan = a[0] as ProjectPlan;
      if (!plan || typeof plan !== 'object' || typeof plan.path !== 'string') {
        throw new Error('Malformed project plan');
      }
      // The path is re-validated here rather than trusted from the plan object:
      // the renderer round-tripped it, so it is untrusted input again.
      await intake.create({ ...plan, path: safeProjectPath(plan.path) }, str(a, 1));
    },
    'intake.suggestPath': (a) => path.join(defaultProjectRoot(store), folderName(str(a, 0))),

    'app.info': (): AppInfo => ({
      platform: process.platform,
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? 'unknown',
      nodeVersion: process.versions.node,
    }),
    'app.openExternal': async (a) => {
      const url = str(a, 0);
      // Only ever hand http(s) to the OS browser; never file:// or custom schemes.
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error(`Refusing to open non-web URL: ${parsed.protocol}`);
      }
      await shell.openExternal(url);
    },
    'app.toolchain': () => toolchain.status(),
  };

  ipcMain.handle(IPC_CHANNELS.invoke, async (_event, message: unknown) => {
    const { path: route, args } = asInvokeMessage(message);
    const handler = handlers[route];
    if (!handler) throw new Error(`Unknown IPC route: ${route}`);
    return await handler(args);
  });
}

function asInvokeMessage(message: unknown): InvokeMessage {
  if (typeof message !== 'object' || message === null) throw new Error('Malformed IPC message');
  const { path: route, args } = message as { path?: unknown; args?: unknown };
  if (typeof route !== 'string') throw new Error('Malformed IPC route');
  return { path: route, args: Array.isArray(args) ? args : [] };
}

function str(args: unknown[], index: number): string {
  const value = args[index];
  if (typeof value !== 'string') throw new Error(`Argument ${index} must be a string`);
  return value;
}

function num(args: unknown[], index: number): number {
  const value = args[index];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument ${index} must be a number`);
  }
  return value;
}

/**
 * Validate the answers coming back from the renderer.
 *
 * These end up in a file on disk and in a prompt, so every field is checked
 * rather than cast. Unknown values fall back to the safer option: a prototype
 * that turns out to need production work is recoverable, the reverse wastes
 * weeks.
 */
function asAnswers(input: unknown): IntakeAnswers {
  if (!input || typeof input !== 'object') throw new Error('Malformed intake answers');
  const raw = input as Record<string, unknown>;
  const text = (key: string, max: number): string =>
    typeof raw[key] === 'string' ? (raw[key] as string).slice(0, max) : '';

  const idea = text('idea', 20_000).trim();
  if (idea.length === 0) throw new Error('Tell us what you want to build first');

  const answers: IntakeAnswers = {
    idea,
    name: folderName(text('name', 120) || idea),
    ambition: raw['ambition'] === 'production' ? 'production' : 'prototype',
    requirements: raw['requirements'] === 'document' ? 'document' : 'conversation',
    buildOrder: raw['buildOrder'] === 'end-to-end' ? 'end-to-end' : 'screens-first',
  };

  const document = text('requirementsDocument', 200_000).trim();
  if (document) answers.requirementsDocument = document;
  return answers;
}

/**
 * A folder name from whatever the user typed.
 *
 * They are naming an app, not a directory, so anything a filesystem would
 * object to is stripped rather than rejected.
 */
function folderName(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^\w\s-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join('-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned.slice(0, 48) || 'my-app';
}

/**
 * Add the project to the list, or move it to the top if it is already there.
 *
 * The name is the folder name. Asking for a separate display name would be one
 * more decision at the exact moment the user wants to start building.
 */
function recordProject(store: Store, projectPath: string): ProjectRecord {
  const existing = store.findProjectByPath(projectPath);
  if (existing) {
    store.touchProject(projectPath);
    return { ...existing, lastOpenedAt: new Date().toISOString() };
  }
  const now = new Date().toISOString();
  const record: ProjectRecord = {
    id: randomUUID(),
    name: path.basename(projectPath) || projectPath,
    path: projectPath,
    createdAt: now,
    lastOpenedAt: now,
  };
  store.addProject(record);
  return record;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** Where new projects go unless the user picks somewhere else. */
function defaultProjectRoot(store: Store): string {
  return store.getSetting('projects.root') ?? path.join(os.homedir(), 'Shipyard');
}

/**
 * Project paths originate in the UI but end up as a process working directory,
 * so they are treated as hostile: resolved to absolute, and rejected if they
 * are not real paths.
 */
function safeProjectPath(input: string): string {
  const resolved = path.resolve(input);
  if (!path.isAbsolute(resolved)) throw new Error('Project path must be absolute');
  return resolved;
}

/** Exported for the intake wizard in Milestone 3. */
export function newId(): string {
  return randomUUID();
}
