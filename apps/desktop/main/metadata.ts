import type Database from 'better-sqlite3';

import type {
  Evidence,
  Incident,
  ProjectIntent,
  RuleOutcome,
  SecurityFinding,
  ServiceRecommendation,
  TelemetryEvent,
  VerificationRun,
} from '@shipyard/shared';

/**
 * Everything Shipyard remembers about a project's intent and its progress.
 *
 * Separate from `Store`, which holds the app's own state — the CLI path, the
 * project list, wizard drafts. This holds the record of what a project is for
 * and what has been observed about it, which is the thing readiness is computed
 * from and the thing an escalation packet is built out of.
 *
 * Append-only where it matters. Evidence is never updated in place: a gate that
 * passed on Tuesday and failed on Wednesday is two observations, and being able
 * to see that is how "readiness went down" becomes explicable rather than
 * alarming.
 */
export class Metadata {
  constructor(private readonly db: Database.Database) {
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_intents (
        project_id TEXT PRIMARY KEY,
        intent     TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_states (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id    TEXT NOT NULL,
        state         TEXT NOT NULL,
        previous_state TEXT,
        evidence      TEXT NOT NULL DEFAULT '[]',
        changed_by    TEXT NOT NULL DEFAULT 'system',
        note          TEXT,
        changed_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS project_states_by_project
        ON project_states (project_id, changed_at DESC);

      CREATE TABLE IF NOT EXISTS project_contracts (
        project_id     TEXT PRIMARY KEY,
        project_md     TEXT,
        architecture_md TEXT,
        plan_json      TEXT,
        version        INTEGER NOT NULL DEFAULT 1,
        updated_at     TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_capabilities (
        project_id   TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        status       TEXT NOT NULL,
        reason       TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        PRIMARY KEY (project_id, capability_id)
      );

      -- Append-only. See the class comment.
      CREATE TABLE IF NOT EXISTS evidence (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  TEXT NOT NULL,
        gate_id     TEXT NOT NULL,
        status      TEXT NOT NULL,
        summary     TEXT,
        ref         TEXT,
        observed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS evidence_by_project
        ON evidence (project_id, gate_id, observed_at DESC);

      CREATE TABLE IF NOT EXISTS verification_runs (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL,
        trigger     TEXT NOT NULL,
        status      TEXT NOT NULL,
        started_at  TEXT NOT NULL,
        finished_at TEXT,
        gates       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_by_project
        ON verification_runs (project_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS rule_evaluations (
        project_id  TEXT NOT NULL,
        rule_id     TEXT NOT NULL,
        satisfied   INTEGER NOT NULL,
        severity    TEXT NOT NULL,
        explanation TEXT NOT NULL,
        missing     TEXT NOT NULL DEFAULT '[]',
        evaluated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, rule_id)
      );

      CREATE TABLE IF NOT EXISTS readiness_scores (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        score      INTEGER NOT NULL,
        threshold  INTEGER NOT NULL,
        ready      INTEGER NOT NULL,
        blockers   TEXT NOT NULL DEFAULT '[]',
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS readiness_by_project
        ON readiness_scores (project_id, recorded_at DESC);

      CREATE TABLE IF NOT EXISTS incidents (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        severity   TEXT NOT NULL,
        fix_status TEXT NOT NULL,
        record     TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS incidents_by_project
        ON incidents (project_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS service_recommendations (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL,
        service_id  TEXT NOT NULL,
        status      TEXT NOT NULL,
        record      TEXT NOT NULL,
        offered_at  TEXT NOT NULL,
        snoozed_until TEXT
      );

      CREATE TABLE IF NOT EXISTS security_findings (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        type       TEXT NOT NULL,
        severity   TEXT NOT NULL,
        status     TEXT NOT NULL,
        record     TEXT NOT NULL,
        found_at   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS escalations (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        status     TEXT NOT NULL,
        record     TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS telemetry_events (
        id         TEXT PRIMARY KEY,
        project_id TEXT,
        type       TEXT NOT NULL,
        payload    TEXT NOT NULL,
        at         TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS telemetry_by_type ON telemetry_events (type, at DESC);
    `);
  }

  // --- intent ---------------------------------------------------------------

  saveIntent(projectId: string, intent: ProjectIntent): void {
    this.db
      .prepare(
        'INSERT INTO project_intents (project_id, intent, updated_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(project_id) DO UPDATE SET intent = excluded.intent, updated_at = excluded.updated_at',
      )
      .run(projectId, JSON.stringify(intent), new Date().toISOString());
  }

  intent(projectId: string): ProjectIntent | undefined {
    const row = this.db
      .prepare('SELECT intent FROM project_intents WHERE project_id = ?')
      .get(projectId) as { intent: string } | undefined;
    return row ? (JSON.parse(row.intent) as ProjectIntent) : undefined;
  }

  // --- lifecycle ------------------------------------------------------------

  recordState(
    projectId: string,
    state: string,
    options: { previous?: string; evidence?: string[]; changedBy?: string; note?: string } = {},
  ): void {
    this.db
      .prepare(
        'INSERT INTO project_states (project_id, state, previous_state, evidence, changed_by, note, changed_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        projectId,
        state,
        options.previous ?? null,
        JSON.stringify(options.evidence ?? []),
        options.changedBy ?? 'system',
        options.note ?? null,
        new Date().toISOString(),
      );
  }

  currentState(projectId: string): string {
    const row = this.db
      .prepare('SELECT state FROM project_states WHERE project_id = ? ORDER BY id DESC LIMIT 1')
      .get(projectId) as { state: string } | undefined;
    return row?.state ?? 'created';
  }

  /** The whole history, oldest first. What happened, and who decided it. */
  stateHistory(projectId: string): { state: string; changedBy: string; changedAt: string; note?: string }[] {
    const rows = this.db
      .prepare(
        'SELECT state, changed_by, changed_at, note FROM project_states WHERE project_id = ? ORDER BY id ASC',
      )
      .all(projectId) as { state: string; changed_by: string; changed_at: string; note: string | null }[];
    return rows.map((r) => ({
      state: r.state,
      changedBy: r.changed_by,
      changedAt: r.changed_at,
      ...(r.note ? { note: r.note } : {}),
    }));
  }

  // --- the contract ---------------------------------------------------------

  saveContract(
    projectId: string,
    contract: { projectMd?: string; architectureMd?: string; plan?: unknown },
  ): void {
    const existing = this.db
      .prepare('SELECT version FROM project_contracts WHERE project_id = ?')
      .get(projectId) as { version: number } | undefined;
    this.db
      .prepare(
        'INSERT INTO project_contracts (project_id, project_md, architecture_md, plan_json, version, updated_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET ' +
          'project_md = excluded.project_md, architecture_md = excluded.architecture_md, ' +
          'plan_json = excluded.plan_json, version = excluded.version, updated_at = excluded.updated_at',
      )
      .run(
        projectId,
        contract.projectMd ?? null,
        contract.architectureMd ?? null,
        contract.plan === undefined ? null : JSON.stringify(contract.plan),
        (existing?.version ?? 0) + 1,
        new Date().toISOString(),
      );
  }

  contract(projectId: string):
    | { projectMd?: string; architectureMd?: string; plan?: unknown; version: number }
    | undefined {
    const row = this.db
      .prepare('SELECT project_md, architecture_md, plan_json, version FROM project_contracts WHERE project_id = ?')
      .get(projectId) as
      | { project_md: string | null; architecture_md: string | null; plan_json: string | null; version: number }
      | undefined;
    if (!row) return undefined;
    return {
      ...(row.project_md ? { projectMd: row.project_md } : {}),
      ...(row.architecture_md ? { architectureMd: row.architecture_md } : {}),
      ...(row.plan_json ? { plan: JSON.parse(row.plan_json) as unknown } : {}),
      version: row.version,
    };
  }

  // --- capabilities ---------------------------------------------------------

  saveCapabilities(
    projectId: string,
    capabilities: { id: string; status: string; reason: string }[],
  ): void {
    const at = new Date().toISOString();
    const insert = this.db.prepare(
      'INSERT INTO project_capabilities (project_id, capability_id, status, reason, updated_at) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(project_id, capability_id) DO UPDATE SET status = excluded.status, reason = excluded.reason, updated_at = excluded.updated_at',
    );
    const all = this.db.transaction(() => {
      for (const c of capabilities) insert.run(projectId, c.id, c.status, c.reason, at);
    });
    all();
  }

  capabilities(projectId: string): { id: string; status: string; reason: string }[] {
    const rows = this.db
      .prepare('SELECT capability_id, status, reason FROM project_capabilities WHERE project_id = ? ORDER BY capability_id')
      .all(projectId) as { capability_id: string; status: string; reason: string }[];
    return rows.map((r) => ({ id: r.capability_id, status: r.status, reason: r.reason }));
  }

  // --- evidence -------------------------------------------------------------

  addEvidence(projectId: string, evidence: Evidence[]): void {
    const insert = this.db.prepare(
      'INSERT INTO evidence (project_id, gate_id, status, summary, ref, observed_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const all = this.db.transaction(() => {
      for (const e of evidence) {
        insert.run(projectId, e.gateId, e.status, e.summary ?? null, e.ref ?? null, e.observedAt);
      }
    });
    all();
  }

  /**
   * The latest observation per gate.
   *
   * The history is kept, but readiness is computed from the newest of each,
   * which is what makes a score able to go down when something breaks.
   */
  latestEvidence(projectId: string): Evidence[] {
    const rows = this.db
      .prepare(
        'SELECT gate_id, status, summary, ref, observed_at FROM evidence e WHERE project_id = ? ' +
          'AND observed_at = (SELECT MAX(observed_at) FROM evidence WHERE project_id = e.project_id AND gate_id = e.gate_id) ' +
          'GROUP BY gate_id',
      )
      .all(projectId) as {
      gate_id: string;
      status: Evidence['status'];
      summary: string | null;
      ref: string | null;
      observed_at: string;
    }[];
    return rows.map((r) => ({
      gateId: r.gate_id,
      status: r.status,
      observedAt: r.observed_at,
      ...(r.summary ? { summary: r.summary } : {}),
      ...(r.ref ? { ref: r.ref } : {}),
    }));
  }

  /** Everything ever observed about one gate, newest first. */
  gateHistory(projectId: string, gateId: string): Evidence[] {
    const rows = this.db
      .prepare(
        'SELECT gate_id, status, summary, ref, observed_at FROM evidence WHERE project_id = ? AND gate_id = ? ORDER BY observed_at DESC',
      )
      .all(projectId, gateId) as {
      gate_id: string;
      status: Evidence['status'];
      summary: string | null;
      ref: string | null;
      observed_at: string;
    }[];
    return rows.map((r) => ({
      gateId: r.gate_id,
      status: r.status,
      observedAt: r.observed_at,
      ...(r.summary ? { summary: r.summary } : {}),
      ...(r.ref ? { ref: r.ref } : {}),
    }));
  }

  // --- verification ---------------------------------------------------------

  saveRun(run: VerificationRun): void {
    this.db
      .prepare(
        'INSERT INTO verification_runs (id, project_id, trigger, status, started_at, finished_at, gates) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ' +
          'status = excluded.status, finished_at = excluded.finished_at, gates = excluded.gates',
      )
      .run(
        run.id,
        run.projectId,
        run.trigger,
        run.status,
        run.startedAt,
        run.finishedAt ?? null,
        JSON.stringify(run.gates),
      );
  }

  runs(projectId: string, limit = 20): VerificationRun[] {
    const rows = this.db
      .prepare('SELECT * FROM verification_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT ?')
      .all(projectId, limit) as {
      id: string;
      project_id: string;
      trigger: VerificationRun['trigger'];
      status: VerificationRun['status'];
      started_at: string;
      finished_at: string | null;
      gates: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      trigger: r.trigger,
      status: r.status,
      startedAt: r.started_at,
      ...(r.finished_at ? { finishedAt: r.finished_at } : {}),
      gates: JSON.parse(r.gates) as VerificationRun['gates'],
    }));
  }

  // --- rules and readiness --------------------------------------------------

  saveRuleEvaluations(projectId: string, outcomes: RuleOutcome[]): void {
    const at = new Date().toISOString();
    const insert = this.db.prepare(
      'INSERT INTO rule_evaluations (project_id, rule_id, satisfied, severity, explanation, missing, evaluated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, rule_id) DO UPDATE SET ' +
        'satisfied = excluded.satisfied, severity = excluded.severity, explanation = excluded.explanation, ' +
        'missing = excluded.missing, evaluated_at = excluded.evaluated_at',
    );
    const all = this.db.transaction(() => {
      for (const o of outcomes.filter((x) => x.applies)) {
        insert.run(
          projectId,
          o.ruleId,
          o.satisfied ? 1 : 0,
          o.severity,
          o.message,
          JSON.stringify(o.missingGates),
          at,
        );
      }
    });
    all();
  }

  recordReadiness(
    projectId: string,
    score: number,
    threshold: number,
    ready: boolean,
    blockers: string[],
  ): void {
    this.db
      .prepare(
        'INSERT INTO readiness_scores (project_id, score, threshold, ready, blockers, recorded_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(projectId, score, threshold, ready ? 1 : 0, JSON.stringify(blockers), new Date().toISOString());
  }

  /** Score over time, oldest first — so the UI can show it going up, or down. */
  readinessHistory(projectId: string): { score: number; threshold: number; ready: boolean; at: string }[] {
    const rows = this.db
      .prepare('SELECT score, threshold, ready, recorded_at FROM readiness_scores WHERE project_id = ? ORDER BY id ASC')
      .all(projectId) as { score: number; threshold: number; ready: number; recorded_at: string }[];
    return rows.map((r) => ({ score: r.score, threshold: r.threshold, ready: r.ready === 1, at: r.recorded_at }));
  }

  // --- incidents, offers, findings, escalations -----------------------------

  saveIncident(incident: Incident): void {
    this.db
      .prepare(
        'INSERT INTO incidents (id, project_id, severity, fix_status, record, updated_at) VALUES (?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET severity = excluded.severity, fix_status = excluded.fix_status, ' +
          'record = excluded.record, updated_at = excluded.updated_at',
      )
      .run(
        incident.id,
        incident.projectId,
        incident.severity,
        incident.fixStatus,
        JSON.stringify(incident),
        new Date().toISOString(),
      );
  }

  incidents(projectId: string, options: { openOnly?: boolean } = {}): Incident[] {
    const rows = this.db
      .prepare(
        `SELECT record FROM incidents WHERE project_id = ?${options.openOnly ? " AND fix_status != 'fixed'" : ''} ORDER BY updated_at DESC`,
      )
      .all(projectId) as { record: string }[];
    return rows.map((r) => JSON.parse(r.record) as Incident);
  }

  saveRecommendation(recommendation: ServiceRecommendation, snoozedUntil?: string): void {
    this.db
      .prepare(
        'INSERT INTO service_recommendations (id, project_id, service_id, status, record, offered_at, snoozed_until) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, ' +
          'record = excluded.record, snoozed_until = excluded.snoozed_until',
      )
      .run(
        recommendation.id,
        recommendation.projectId,
        recommendation.serviceId,
        recommendation.status,
        JSON.stringify(recommendation),
        recommendation.offeredAt,
        snoozedUntil ?? null,
      );
  }

  /** Service ids the user has declined, so they are not asked twice. */
  declinedServices(projectId: string): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT service_id FROM service_recommendations WHERE project_id = ? AND status = 'declined'")
      .all(projectId) as { service_id: string }[];
    return rows.map((r) => r.service_id);
  }

  snoozedServices(projectId: string): Record<string, string> {
    const rows = this.db
      .prepare(
        "SELECT service_id, snoozed_until FROM service_recommendations WHERE project_id = ? AND status = 'snoozed' AND snoozed_until IS NOT NULL",
      )
      .all(projectId) as { service_id: string; snoozed_until: string }[];
    return Object.fromEntries(rows.map((r) => [r.service_id, r.snoozed_until]));
  }

  saveFindings(findings: SecurityFinding[]): void {
    const insert = this.db.prepare(
      'INSERT INTO security_findings (id, project_id, type, severity, status, record, found_at) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET status = excluded.status, record = excluded.record',
    );
    const all = this.db.transaction(() => {
      for (const f of findings) {
        insert.run(f.id, f.projectId, f.type, f.severity, f.status, JSON.stringify(f), f.foundAt);
      }
    });
    all();
  }

  findings(projectId: string): SecurityFinding[] {
    const rows = this.db
      .prepare('SELECT record FROM security_findings WHERE project_id = ? ORDER BY found_at DESC')
      .all(projectId) as { record: string }[];
    return rows.map((r) => JSON.parse(r.record) as SecurityFinding);
  }

  saveEscalation(packet: { id: string; projectId: string; status: string }): void {
    this.db
      .prepare(
        'INSERT INTO escalations (id, project_id, status, record, created_at) VALUES (?, ?, ?, ?, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET status = excluded.status, record = excluded.record',
      )
      .run(packet.id, packet.projectId, packet.status, JSON.stringify(packet), new Date().toISOString());
  }

  // --- telemetry ------------------------------------------------------------

  /**
   * Record a measurement.
   *
   * Numbers and ids only. The payload is checked here rather than trusted,
   * because the one way this file becomes a privacy problem is by quietly
   * accumulating project content.
   */
  record(event: TelemetryEvent): void {
    const safe: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(event.payload)) {
      if (typeof value === 'number' || typeof value === 'boolean') safe[key] = value;
      // Strings are allowed only when short and identifier-shaped: `sentry`,
      // `customer_pilot`, a gate id. Never a message, never a path.
      else if (typeof value === 'string' && value.length <= 64 && /^[\w.:-]+$/.test(value)) {
        safe[key] = value;
      }
    }
    this.db
      .prepare('INSERT INTO telemetry_events (id, project_id, type, payload, at) VALUES (?, ?, ?, ?, ?)')
      .run(event.id, event.projectId ?? null, event.type, JSON.stringify(safe), event.at);
  }

  telemetry(options: { type?: string; since?: string } = {}): TelemetryEvent[] {
    const rows = this.db
      .prepare(
        'SELECT id, project_id, type, payload, at FROM telemetry_events WHERE ' +
          '(? IS NULL OR type = ?) AND (? IS NULL OR at >= ?) ORDER BY at ASC',
      )
      .all(options.type ?? null, options.type ?? null, options.since ?? null, options.since ?? null) as {
      id: string;
      project_id: string | null;
      type: string;
      payload: string;
      at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      ...(r.project_id ? { projectId: r.project_id } : {}),
      type: r.type,
      at: r.at,
      payload: JSON.parse(r.payload) as TelemetryEvent['payload'],
    }));
  }

  /** Export for the pilot dashboard. CSV because that is what a spreadsheet eats. */
  telemetryCsv(options: { type?: string; since?: string } = {}): string {
    const events = this.telemetry(options);
    const keys = [...new Set(events.flatMap((e) => Object.keys(e.payload)))].sort();
    const header = ['at', 'type', 'project_id', ...keys];
    const rows = events.map((e) =>
      [e.at, e.type, e.projectId ?? '', ...keys.map((k) => String(e.payload[k] ?? ''))]
        .map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell))
        .join(','),
    );
    return [header.join(','), ...rows].join('\n');
  }

  /**
   * The number that decides whether Shipyard is a product or an agency.
   *
   * Human engineering hours per launched application, and how much of each
   * project came from the library rather than being generated. If the first
   * does not fall as the second rises, nothing else in the plan matters.
   */
  deliveryEconomics(): {
    projects: number;
    medianHumanHours: number | null;
    componentReusePercent: number | null;
    averageReadinessAtHandoff: number | null;
  } {
    const hours = (
      this.db
        .prepare(
          "SELECT json_extract(payload, '$.hours') AS h FROM telemetry_events WHERE type = 'human_hours' ORDER BY h",
        )
        .all() as { h: number | null }[]
    )
      .map((r) => r.h)
      .filter((h): h is number => typeof h === 'number');

    const reuse = (
      this.db
        .prepare(
          "SELECT json_extract(payload, '$.percent') AS p FROM telemetry_events WHERE type = 'component_reuse'",
        )
        .all() as { p: number | null }[]
    )
      .map((r) => r.p)
      .filter((p): p is number => typeof p === 'number');

    const handoff = (
      this.db.prepare('SELECT score FROM readiness_scores').all() as { score: number }[]
    ).map((r) => r.score);

    const median = (values: number[]): number | null =>
      values.length === 0 ? null : (values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? null);
    const mean = (values: number[]): number | null =>
      values.length === 0 ? null : Math.round(values.reduce((a, b) => a + b, 0) / values.length);

    return {
      projects: (this.db.prepare('SELECT COUNT(*) AS n FROM project_intents').get() as { n: number }).n,
      medianHumanHours: median(hours),
      componentReusePercent: mean(reuse),
      averageReadinessAtHandoff: mean(handoff),
    };
  }
}
