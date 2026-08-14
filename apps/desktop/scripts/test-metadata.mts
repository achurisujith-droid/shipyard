/**
 * Does the record survive, and does it stay honest?
 *
 * Two things are worth proving. That the whole loop round-trips: intent in,
 * evidence in, readiness out, incidents and offers alongside. And that the
 * evidence trail is append-only, because "your score went down" is only
 * acceptable if the app can show exactly which check changed its mind and when.
 *
 *   npx tsx scripts/test-metadata.mts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import type { Incident, ProjectIntent, RuleOutcome, ServiceRecommendation } from '@shipyard/shared';

import { Metadata } from '../main/metadata';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS  ${name}`);
  else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

const intent: ProjectIntent = {
  targetMode: 'customer_pilot',
  projectType: 'booking_saas',
  regions: ['GB', 'IE'],
  sensitiveData: true,
  payments: true,
  aiAffectsConsequentialDecision: false,
  humanReviewRequired: false,
  publicFacing: true,
  expectedMonthlyUsers: 500,
  launchDateTarget: '2026-10-31',
  existingCodeSource: 'new_project',
};

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shipyard-metadata-'));
  const db = new Database(path.join(dir, 'test.db'));
  const meta = new Metadata(db);
  const P = 'proj_1';

  // --- intent ---------------------------------------------------------------
  meta.saveIntent(P, intent);
  check('intent round-trips', meta.intent(P)?.targetMode === 'customer_pilot');
  check('including the facts rules key on', meta.intent(P)?.payments === true);
  check('a project with no intent yet returns nothing', meta.intent('unknown') === undefined);

  meta.saveIntent(P, { ...intent, targetMode: 'production_product' });
  check('and changing the mode replaces it rather than piling up', meta.intent(P)?.targetMode === 'production_product');

  // --- lifecycle ------------------------------------------------------------
  check('a project with no recorded state has not started', meta.currentState(P) === 'created');
  meta.recordState(P, 'onboarding_complete', { previous: 'created', evidence: ['intent_captured'] });
  meta.recordState(P, 'blueprint_ready', { previous: 'onboarding_complete', changedBy: 'founder', note: 'Read the plan.' });
  check('the current state is the latest one', meta.currentState(P) === 'blueprint_ready');
  check('and the history is kept in order', meta.stateHistory(P).map((s) => s.state).join(',') === 'onboarding_complete,blueprint_ready');
  check('with who decided it', meta.stateHistory(P)[1]?.changedBy === 'founder');
  check('and why', meta.stateHistory(P)[1]?.note === 'Read the plan.');

  // --- evidence is append-only ---------------------------------------------
  meta.addEvidence(P, [
    { gateId: 'build_passes', status: 'passed', observedAt: '2026-08-14T09:00:00.000Z', ref: 'vr_1' },
    { gateId: 'unit_tests_pass', status: 'passed', observedAt: '2026-08-14T09:00:00.000Z', ref: 'vr_1' },
  ]);
  check('evidence is stored', meta.latestEvidence(P).length === 2);

  meta.addEvidence(P, [
    {
      gateId: 'build_passes',
      status: 'failed',
      observedAt: '2026-08-14T12:00:00.000Z',
      summary: 'Cannot find module ./auth',
      ref: 'vr_2',
    },
  ]);
  const latest = meta.latestEvidence(P);
  check('the newest observation wins', latest.find((e) => e.gateId === 'build_passes')?.status === 'failed');
  check('and it is still one row per gate', latest.length === 2, JSON.stringify(latest.map((e) => e.gateId)));

  // This is what makes "your score went down" explicable rather than alarming.
  const history = meta.gateHistory(P, 'build_passes');
  check('the earlier pass is not overwritten', history.length === 2);
  check('and the history is newest first', history[0]?.status === 'failed' && history[1]?.status === 'passed');
  check('with the reason attached', history[0]?.summary === 'Cannot find module ./auth');

  // --- verification runs ----------------------------------------------------
  meta.saveRun({
    id: 'vr_2',
    projectId: P,
    trigger: 'after_fix',
    status: 'failed',
    startedAt: '2026-08-14T11:59:00.000Z',
    finishedAt: '2026-08-14T12:00:00.000Z',
    gates: [{ gateId: 'build_passes', status: 'failed', durationMs: 42_000, failureSummary: 'Cannot find module ./auth' }],
  });
  check('a run is stored with its gates', meta.runs(P)[0]?.gates.length === 1);
  check('and why it was run', meta.runs(P)[0]?.trigger === 'after_fix');

  // --- rules and readiness --------------------------------------------------
  const outcomes: RuleOutcome[] = [
    {
      ruleId: 'mode.customer_pilot.foundations',
      ruleVersion: 1,
      category: 'mode',
      severity: 'blocker',
      message: 'Real people are about to use this.',
      applies: true,
      satisfied: false,
      requiredGates: ['auth_login_works'],
      missingGates: ['auth_login_works'],
      requiredComponents: [],
      humanReviewRequired: false,
      serviceTriggers: [],
    },
    {
      ruleId: 'does.not.apply',
      ruleVersion: 1,
      category: 'testing',
      severity: 'warning',
      message: 'x',
      applies: false,
      satisfied: true,
      requiredGates: [],
      missingGates: [],
      requiredComponents: [],
      humanReviewRequired: false,
      serviceTriggers: [],
    },
  ];
  meta.saveRuleEvaluations(P, outcomes);
  const evaluated = db.prepare('SELECT rule_id FROM rule_evaluations WHERE project_id = ?').all(P) as {
    rule_id: string;
  }[];
  check('applicable rules are recorded', evaluated.some((r) => r.rule_id === 'mode.customer_pilot.foundations'));
  check('rules that do not apply are not', !evaluated.some((r) => r.rule_id === 'does.not.apply'));

  meta.recordReadiness(P, 44, 70, false, ['mode.customer_pilot.foundations']);
  meta.recordReadiness(P, 71, 70, true, []);
  meta.recordReadiness(P, 62, 70, false, ['testing.critical_flows.covered']);
  const scores = meta.readinessHistory(P);
  check('readiness is kept over time', scores.length === 3);
  check('and can go down, which is the point', scores.map((s) => s.score).join(',') === '44,71,62');

  // --- capabilities ---------------------------------------------------------
  meta.saveCapabilities(P, [
    { id: 'authentication', status: 'included', reason: 'Needed because you are building a pilot.' },
    { id: 'native_mobile', status: 'unsupported', reason: 'Shipyard cannot build this yet.' },
  ]);
  check('capabilities are stored with their reasons', meta.capabilities(P).length === 2);
  check(
    'and the reason survives, because that is the whole point',
    /Needed because/.test(meta.capabilities(P).find((c) => c.id === 'authentication')?.reason ?? ''),
  );

  // --- incidents and offers -------------------------------------------------
  const incident: Incident = {
    id: 'inc_1',
    projectId: P,
    source: 'sentry',
    environment: 'production',
    severity: 'S1',
    title: 'Checkout fails',
    firstSeenAt: '2026-08-14T10:00:00.000Z',
    reproductionStatus: 'pending',
    fixStatus: 'in_progress',
    fixAttempts: 1,
  };
  meta.saveIncident(incident);
  meta.saveIncident({ ...incident, id: 'inc_2', fixStatus: 'fixed' });
  check('incidents are stored', meta.incidents(P).length === 2);
  check('and the open ones can be asked for alone', meta.incidents(P, { openOnly: true }).length === 1);

  meta.saveIncident({ ...incident, fixAttempts: 2, fixStatus: 'escalated' });
  check('updating an incident does not duplicate it', meta.incidents(P).length === 2);
  check('and keeps the newer attempt count', meta.incidents(P).find((i) => i.id === 'inc_1')?.fixAttempts === 2);

  const offer: ServiceRecommendation = {
    id: randomUUID(),
    projectId: P,
    serviceId: 'fix_sprint',
    reason: 'It has come back twice.',
    evidence: ['inc_1'],
    status: 'declined',
    offeredAt: '2026-08-14T12:00:00.000Z',
  };
  meta.saveRecommendation(offer);
  check('a declined service is remembered, so they are not asked twice', meta.declinedServices(P).includes('fix_sprint'));
  meta.saveRecommendation({ ...offer, id: randomUUID(), serviceId: 'sentry_setup', status: 'snoozed' }, '2026-09-01T00:00:00.000Z');
  check('and a snoozed one knows when it may return', meta.snoozedServices(P)['sentry_setup'] === '2026-09-01T00:00:00.000Z');

  // --- contract -------------------------------------------------------------
  meta.saveContract(P, { projectMd: '# Booking site', plan: { phases: [] } });
  check('the contract is stored', meta.contract(P)?.projectMd === '# Booking site');
  check('and starts at version 1', meta.contract(P)?.version === 1);
  meta.saveContract(P, { projectMd: '# Booking site, revised' });
  check('a revision bumps the version', meta.contract(P)?.version === 2);

  // --- telemetry ------------------------------------------------------------
  // The one way this file becomes a privacy problem is by quietly accumulating
  // project content, so the payload is filtered rather than trusted.
  meta.record({
    id: randomUUID(),
    projectId: P,
    type: 'human_hours',
    at: '2026-08-14T12:00:00.000Z',
    payload: {
      hours: 96,
      capability: 'subscription_payments',
      note: 'the founder said the checkout looked wrong on their iPhone',
      ok: true,
    },
  });
  const recorded = meta.telemetry({ type: 'human_hours' })[0];
  check('numbers are kept', recorded?.payload['hours'] === 96);
  check('and booleans', recorded?.payload['ok'] === true);
  check('and short identifiers', recorded?.payload['capability'] === 'subscription_payments');
  check('but free text never is', recorded?.payload['note'] === undefined, JSON.stringify(recorded?.payload));

  meta.record({ id: randomUUID(), projectId: P, type: 'component_reuse', at: '2026-08-14T12:00:00.000Z', payload: { percent: 45 } });
  const economics = meta.deliveryEconomics();
  check('the number that matters is computed', economics.medianHumanHours === 96, JSON.stringify(economics));
  check('alongside how much came from the library', economics.componentReusePercent === 45);
  check('and readiness at handoff', economics.averageReadinessAtHandoff === 59, JSON.stringify(economics));

  const csv = meta.telemetryCsv();
  check('telemetry exports as CSV', csv.split('\n').length === 3, csv);
  check('with a header a spreadsheet understands', csv.startsWith('at,type,project_id,'));

  db.close();
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log(`\n${failed === 0 ? 'All metadata cases pass.' : `${failed} case(s) failed.`}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
