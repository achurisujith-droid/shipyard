import type { GateDefinition } from '@shipyard/shared';

/**
 * The checks Shipyard runs, and what each one proves.
 *
 * This registry is the answer to the question the whole product hangs on: how
 * does Shipyard know? Not by asking the agent whether it finished. By running
 * something and looking at what came back.
 *
 * A gate that cannot be run is still worth defining. `manual` and `external`
 * gates carry evidence a person or another system supplies, and leaving them
 * out would quietly drop them from the readiness score rather than showing them
 * as outstanding.
 */
export const GATES: readonly GateDefinition[] = [
  // --- the project exists and holds together ------------------------------
  {
    id: 'install_dependencies',
    label: 'The pieces your app needs are installed',
    kind: 'command',
    command: 'npm install',
    expect: 'slow',
  },
  {
    id: 'build_passes',
    label: 'Your app builds',
    kind: 'command',
    command: 'npm run build',
    expect: 'slow',
  },
  {
    id: 'typecheck_passes',
    label: 'The code agrees with itself',
    kind: 'command',
    command: 'npm run typecheck',
  },
  {
    id: 'lint_passes',
    label: 'The code follows its own conventions',
    kind: 'command',
    command: 'npm run lint',
  },
  {
    id: 'unit_tests_pass',
    label: 'The unit tests pass',
    kind: 'command',
    command: 'npm test',
  },
  {
    id: 'database_migration_check',
    label: 'The database matches what the code expects',
    kind: 'command',
    command: 'npx prisma migrate diff --from-schema-datamodel prisma/schema.prisma --to-schema-datasource prisma/schema.prisma --exit-code',
    requiresCapability: ['database_schema'],
  },

  // --- it actually does the thing -----------------------------------------
  {
    id: 'core_flow_smoke_test',
    label: 'The main journey through your app works',
    kind: 'command',
    command: 'npm run test:e2e',
    expect: 'slow',
  },
  {
    id: 'critical_flow_tests_pass',
    label: 'The journeys your users depend on are checked every time',
    kind: 'command',
    command: 'npm run test:e2e',
    expect: 'slow',
  },
  {
    id: 'rbac_permission_tests_pass',
    label: 'One person cannot see another person’s information',
    kind: 'command',
    command: 'npm run test:permissions',
    requiresCapability: ['role_permissions', 'organization_tenancy'],
  },
  {
    id: 'component_contract_tests_pass',
    label: 'The parts we already checked still behave the way they should',
    kind: 'command',
    command: 'npm run test:components',
  },

  // --- the risky integrations ---------------------------------------------
  {
    id: 'stripe_webhook_signature_verified',
    label: 'Payment messages are proved genuine before they are believed',
    kind: 'command',
    command: 'npm run test:webhooks',
    requiresCapability: ['subscription_payments'],
  },
  {
    id: 'stripe_idempotency_test_passed',
    label: 'A payment message arriving twice only charges once',
    kind: 'command',
    command: 'npm run test:webhooks',
    requiresCapability: ['subscription_payments'],
  },
  {
    id: 'failed_payment_flow_tested',
    label: 'A declined card is handled rather than ignored',
    kind: 'command',
    command: 'npm run test:billing',
    requiresCapability: ['subscription_payments'],
  },
  {
    id: 'transactional_email_sends',
    label: 'Your app can email your users',
    kind: 'command',
    command: 'npm run test:email',
    requiresCapability: ['transactional_email'],
  },
  {
    id: 'file_storage_round_trip',
    label: 'Uploaded files come back',
    kind: 'command',
    command: 'npm run test:storage',
    requiresCapability: ['file_storage'],
  },

  // --- safety --------------------------------------------------------------
  {
    id: 'secrets_scan_clean',
    label: 'No passwords or keys are sitting in the code',
    kind: 'command',
    command: 'shipyard:secrets-scan',
  },
  {
    id: 'dependency_scan_clean',
    label: 'Nothing you depend on has a known hole in it',
    kind: 'command',
    command: 'npm audit --audit-level=high',
  },
  {
    id: 'license_scan_reviewed',
    label: 'You are allowed to use everything in here',
    kind: 'command',
    command: 'shipyard:license-scan',
  },
  {
    id: 'security_scan_clean',
    label: 'The security checks all pass',
    kind: 'command',
    command: 'shipyard:security-scan',
  },

  // --- things only the outside world can prove ----------------------------
  {
    id: 'error_monitoring_receives_test_event',
    label: 'A test error reaches your monitoring',
    kind: 'external',
    requiresCapability: ['error_monitoring'],
  },
  { id: 'release_tagged_in_monitoring', label: 'Errors say which version they came from', kind: 'external' },
  { id: 'payment_events_logged', label: 'Every payment event is written down', kind: 'external', requiresCapability: ['subscription_payments'] },
  { id: 'deployed_health_check_passes', label: 'The live site answers', kind: 'external' },
  { id: 'domain_ssl_verified', label: 'Your address works and is secure', kind: 'external' },
  { id: 'uptime_check_configured', label: 'Something is watching it for you', kind: 'external' },
  { id: 'database_persists_across_restart', label: 'Information is still there tomorrow', kind: 'external' },
  { id: 'auth_login_works', label: 'People can sign in', kind: 'external' },
  { id: 'protected_routes_enforced', label: 'Signed-out visitors cannot reach private pages', kind: 'external' },
  { id: 'audit_log_records_access', label: 'You can tell who looked at what', kind: 'external' },
  { id: 'privacy_export_delete_works', label: 'You can hand someone their data back, or delete it', kind: 'external' },

  // --- things a person decides --------------------------------------------
  { id: 'intent_captured', label: 'We know what you are building', kind: 'manual' },
  { id: 'plan_approved', label: 'You have read the plan and agreed with it', kind: 'manual' },
  { id: 'supported_stack_selected', label: 'The project uses a stack we support', kind: 'manual' },
  { id: 'capabilities_resolved', label: 'We know which ready-made parts this needs', kind: 'manual' },
  { id: 'not_production_label_present', label: 'It says on screen that this is not finished', kind: 'manual' },
  { id: 'backup_plan_recorded', label: 'You have written down how the data is backed up', kind: 'manual' },
  { id: 'backup_restore_tested', label: 'Someone has actually restored from a backup', kind: 'manual' },
  { id: 'incident_process_recorded', label: 'There is a written answer to "it is down, what now?"', kind: 'manual' },
  { id: 'handoff_documentation_written', label: 'Someone else could pick this up', kind: 'manual' },
  { id: 'data_retention_statement_written', label: 'You have said how long you keep things', kind: 'manual' },
  { id: 'human_review_step_present', label: 'A person reviews the decisions before they take effect', kind: 'manual' },
  { id: 'decision_consent_recorded', label: 'People know a decision is being made about them', kind: 'manual' },
  { id: 'decision_audit_trail_complete', label: 'You can reconstruct why any decision was made', kind: 'manual' },
  { id: 'no_repeated_fix_failures', label: 'Nothing has resisted two attempts to fix it', kind: 'manual' },
];

const BY_ID = new Map(GATES.map((gate) => [gate.id, gate]));

export function gate(id: string): GateDefinition | undefined {
  return BY_ID.get(id);
}

/** The label a user should see. Falls back to the id rather than hiding it. */
export function gateLabel(id: string): string {
  return BY_ID.get(id)?.label ?? id;
}

/** Labels keyed by id, for the rulebook's `explain`. */
export function gateLabels(): Record<string, string> {
  return Object.fromEntries(GATES.map((g) => [g.id, g.label]));
}

/**
 * Which of these gates can be run for this project, right now.
 *
 * A gate whose capability the project does not have is not skipped quietly: it
 * is simply not required, which the rulebook already reflects. This filter
 * stops the runner spending two minutes proving a payment flow works in a
 * project that takes no payments.
 */
export function runnableGates(
  wanted: string[],
  capabilities: string[],
): GateDefinition[] {
  return wanted
    .map((id) => BY_ID.get(id))
    .filter((g): g is GateDefinition => g !== undefined)
    .filter((g) => g.kind === 'command')
    .filter(
      (g) => !g.requiresCapability || g.requiresCapability.some((c) => capabilities.includes(c)),
    );
}
