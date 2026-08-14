import path from 'node:path';

import Database from 'better-sqlite3';
import { app } from 'electron';

import type { ProjectRecord } from '@shipyard/shared';

/**
 * Local state: the resolved CLI path, app settings, intake drafts, and the
 * projects we have created.
 *
 * Nothing here is ever transmitted anywhere, and nothing here is a credential.
 * The CLI path is cached because detection costs ~1.5s on Windows; the actual
 * executable is still re-resolved from it on every start (see REPORT.md 3.12).
 */
export class Store {
  private readonly db: Database.Database;

  constructor(file?: string) {
    const target = file ?? path.join(app.getPath('userData'), 'shipyard.db');
    this.db = new Database(target);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projects (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        path       TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS intake_drafts (
        id         TEXT PRIMARY KEY,
        answers    TEXT NOT NULL,
        step       INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
    `);

    // Added after the first release of the schema, so existing databases need
    // it bolted on. SQLite has no `ADD COLUMN IF NOT EXISTS`.
    const columns = this.db.prepare('PRAGMA table_info(projects)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'last_opened_at')) {
      this.db.exec('ALTER TABLE projects ADD COLUMN last_opened_at TEXT');
      this.db.exec('UPDATE projects SET last_opened_at = created_at WHERE last_opened_at IS NULL');
    }
  }

  getSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  /** Forget a setting entirely, rather than storing an empty string for it. */
  clearSetting(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  /** The PATH entry we last resolved the CLI through. Survives CLI upgrades. */
  get cliShimPath(): string | undefined {
    return this.getSetting('cli.shimPath');
  }

  set cliShimPath(value: string | undefined) {
    if (value) this.setSetting('cli.shimPath', value);
  }

  /** Most recently opened first: what you were last working on is what you want. */
  listProjects(): ProjectRecord[] {
    const rows = this.db
      .prepare(
        'SELECT id, name, path, created_at, last_opened_at FROM projects ' +
          'ORDER BY COALESCE(last_opened_at, created_at) DESC',
      )
      .all() as {
      id: string;
      name: string;
      path: string;
      created_at: string;
      last_opened_at: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      path: r.path,
      createdAt: r.created_at,
      lastOpenedAt: r.last_opened_at ?? r.created_at,
    }));
  }

  findProjectByPath(projectPath: string): ProjectRecord | undefined {
    return this.listProjects().find((p) => p.path === projectPath);
  }

  addProject(record: ProjectRecord): void {
    this.db
      .prepare(
        'INSERT INTO projects (id, name, path, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?) ' +
          // Keyed on path, not id: opening the same folder twice is the same
          // project, and the original creation date is the true one.
          'ON CONFLICT(path) DO UPDATE SET name = excluded.name, last_opened_at = excluded.last_opened_at',
      )
      .run(record.id, record.name, record.path, record.createdAt, record.lastOpenedAt);
  }

  /** Record that the user just opened it, so the list stays in a useful order. */
  touchProject(projectPath: string): void {
    this.db
      .prepare('UPDATE projects SET last_opened_at = ? WHERE path = ?')
      .run(new Date().toISOString(), projectPath);
  }

  /** Remove from the list only. The user's files are theirs and stay put. */
  forgetProject(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  /** Intake drafts survive an app restart mid-wizard (Milestone 3). */
  saveDraft(id: string, answers: unknown, step: number): void {
    this.db
      .prepare(
        'INSERT INTO intake_drafts (id, answers, step, updated_at) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET answers = excluded.answers, step = excluded.step, updated_at = excluded.updated_at',
      )
      .run(id, JSON.stringify(answers), step, new Date().toISOString());
  }

  loadDraft(id: string): { answers: unknown; step: number } | undefined {
    const row = this.db.prepare('SELECT answers, step FROM intake_drafts WHERE id = ?').get(id) as
      | { answers: string; step: number }
      | undefined;
    if (!row) return undefined;
    try {
      return { answers: JSON.parse(row.answers) as unknown, step: row.step };
    } catch {
      return undefined;
    }
  }

  clearDraft(id: string): void {
    this.db.prepare('DELETE FROM intake_drafts WHERE id = ?').run(id);
  }

  close(): void {
    this.db.close();
  }
}
