/**
 * Does a failure out in the world become work someone can act on?
 *
 * The two things worth proving here are the two the plan is strictest about:
 * that the fix loop is controlled rather than autonomous, and that an escalation
 * packet is complete enough for a developer to start without asking a question.
 *
 *   npx tsx harness/test-incidents.ts
 */
import {
  actionFor,
  buildEscalationPacket,
  composeFixTask,
  normalise,
  recordAttempt,
  riskOf,
  severityOf,
  type RawEvent,
} from '../src/index';
import type { ProjectIntent, RuleOutcome } from '@shipyard/shared';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS  ${name}`);
  else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

function event(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    source: 'sentry',
    environment: 'production',
    title: 'TypeError: cannot read property id of undefined',
    ...overrides,
  };
}

const intent: ProjectIntent = {
  targetMode: 'customer_pilot',
  regions: ['GB'],
  sensitiveData: true,
  payments: true,
  aiAffectsConsequentialDecision: false,
  humanReviewRequired: false,
  publicFacing: true,
  existingCodeSource: 'new_project',
};

function main(): void {
  // --- severity is about consequence, not about how alarming it looks ------
  check(
    'a payment failure in production is the top severity',
    severityOf(event({ title: 'Stripe webhook signature verification failed' })) === 'S0',
  );
  check(
    'so is anything that reads like exposed data',
    severityOf(event({ title: 'Unauthorized access to /api/candidates' })) === 'S0',
  );
  check(
    'a broken sign-in is serious but not an outage',
    severityOf(event({ title: 'Login page throws on submit' })) === 'S1',
  );
  check(
    'a deprecation warning is not an emergency',
    severityOf(event({ title: 'Warning: deprecated API used' })) === 'S3',
  );
  check(
    'the same payment error locally is not a production outage',
    severityOf(event({ environment: 'local', title: 'charge failed' })) === 'S1',
  );

  // --- the incident record -------------------------------------------------
  const incident = normalise(
    event({
      title: 'Connection failed: postgresql://app:hunter2@db.internal/shop',
      route: '/api/orders',
      release: 'v0.3.2',
      commitSha: 'abc123',
    }),
    'proj_1',
  );
  check('an incident carries where and which version', incident.affectedRoute === '/api/orders' && incident.release === 'v0.3.2');
  check(
    'and the password in the error message is gone',
    !JSON.stringify(incident).includes('hunter2'),
    incident.title,
  );
  check('but the host survives, because it is the diagnostic bit', incident.title.includes('db.internal'));

  // --- the component it lives in ------------------------------------------
  const inComponent = normalise(
    event({ title: 'webhook handler threw', stack: 'at src/lib/billing/webhook.ts:44' }),
    'proj_1',
    { componentPaths: { stripe_subscription_billing: ['src/lib/billing/**'] } },
  );
  check('a failure inside a verified component is attributed to it', inComponent.componentId === 'stripe_subscription_billing');

  // --- how much freedom the agent gets ------------------------------------
  check(
    'payments are never fixed without a person',
    riskOf(normalise(event({ title: 'refund webhook failed' }), 'p')) === 'mandatory_human',
  );
  check(
    'nor is anything touching sign-in or permissions',
    riskOf(normalise(event({ title: 'unauthorized read of user records' }), 'p')) === 'mandatory_human',
  );
  check(
    'and neither of those lets the agent try',
    actionFor('mandatory_human').agentMayAttempt === false,
  );
  check(
    'a live outage is answered by going back, not by fixing forward',
    /back to the last working version/.test(actionFor('critical_outage').explanation),
  );
  check(
    'an ordinary bug the agent may attempt',
    actionFor(riskOf(normalise(event({ environment: 'local', title: 'button does nothing' }), 'p')))
      .agentMayAttempt,
  );
  check(
    'a fault inside a verified component wants a developer to read the fix',
    actionFor('high').requiresDeveloper,
  );

  // --- the task the agent is asked to do ----------------------------------
  const task = composeFixTask(incident, {
    failedGates: [
      { gateId: 'unit_tests_pass', status: 'failed', durationMs: 900, failureSummary: 'orders.test.ts: expected 200, got 500' },
    ],
  });
  check('the task asks it to reproduce before changing anything', /reproduce it before changing/.test(task.message));
  check(
    'and to say so rather than guess when it cannot',
    /say so rather/.test(task.message) && /than guessing/.test(task.message),
  );
  check('the failing check is quoted', /expected 200, got 500/.test(task.message));
  check(
    'the fix has to come with a test that would have caught it',
    task.acceptanceCriteria.some((c) => /fails for this reason before the fix/.test(c)),
  );
  check('and the gates to re-run afterwards are named', task.gates.includes('unit_tests_pass'));
  check('no secret survives into the prompt', !task.message.includes('hunter2'));

  const componentTask = composeFixTask(inComponent, { contractGates: ['component_contract_tests_pass'] });
  check(
    'a fix inside a verified component is told not to rewrite it',
    /Do not rewrite its internals/.test(componentTask.message),
  );
  check(
    'and must leave the contract tests passing',
    componentTask.gates.includes('component_contract_tests_pass'),
  );
  check('the risk warning is attached for the user to read', Boolean(componentTask.warning));

  // --- the second attempt --------------------------------------------------
  const second = { ...incident, fixAttempts: 1 };
  check(
    'a repeat attempt is told the cause is probably elsewhere',
    /cause is probably not where it appears/.test(composeFixTask(second).message),
  );

  const first = recordAttempt(incident, 'failed');
  check('one failure is not an escalation', first.escalate === false);
  check('and the incident is still in progress', first.incident.fixStatus === 'in_progress');

  const twice = recordAttempt(first.incident, 'failed');
  check('two failures is', twice.escalate === true);
  check('and the incident is marked escalated', twice.incident.fixStatus === 'escalated');

  const fixed = recordAttempt(incident, 'verified', 'vr_1');
  check('a verified fix closes it', fixed.incident.fixStatus === 'fixed' && fixed.escalate === false);
  check('and records which run judged it', fixed.attempt.verificationRunId === 'vr_1');

  // --- the packet a developer receives ------------------------------------
  const blocker: RuleOutcome = {
    ruleId: 'payments.webhooks.verified',
    ruleVersion: 1,
    category: 'payments',
    severity: 'blocker',
    message: 'Money is changing hands and the webhook is not verified.',
    applies: true,
    satisfied: false,
    requiredGates: ['stripe_webhook_signature_verified'],
    missingGates: ['stripe_webhook_signature_verified'],
    requiredComponents: [],
    humanReviewRequired: true,
    serviceTriggers: ['payment_integration_review'],
  };

  const packet = buildEscalationPacket({
    projectId: 'proj_1',
    projectSummary: 'A booking site where customers pay a deposit.',
    intent,
    currentState: 'pilot_preparation',
    readinessScore: 58,
    blockers: [blocker],
    capabilities: ['subscription_payments', 'authentication'],
    incident: twice.incident,
    failedGates: [
      { gateId: 'stripe_webhook_signature_verified', status: 'failed', durationMs: 1200, output: 'STRIPE_SECRET_KEY=sk' + '_live_' + 'X'.repeat(24) },
    ],
    fixAttempts: [first.attempt, twice.attempt],
    reproduction: ['Send a webhook with a wrong signature to /api/stripe/webhook.'],
    env: { NODE_ENV: 'production', DATABASE_URL: 'postgresql://a:b@c/d', PORT: '3000' },
  });

  check('the packet says what the project is', packet.packet.projectSummary.length > 10);
  check('and how far it is meant to go', packet.packet.targetMode === 'customer_pilot');
  check('and where it had got to', packet.packet.currentState === 'pilot_preparation');
  check('the blockers are listed with their rule ids', packet.packet.rules.includes('payments.webhooks.verified'));
  check('the failing checks come with their output', packet.packet.failedGates.length === 1);
  check('what was already tried is recorded', packet.packet.fixAttempts.length === 2);
  check('and how to make it happen again', packet.packet.reproduction.length === 1);
  check('acceptance criteria are stated', packet.packet.acceptanceCriteria.length > 0);
  check('and a turnaround the severity justifies', /Immediately/.test(packet.packet.turnaroundTarget));
  check('the severity comes from the incident', packet.severity === 'S0');

  // The field most likely to carry a live key, and most likely to be pasted
  // into a chat window.
  check('the environment is redacted', packet.packet.environment['DATABASE_URL'] === '[redacted]');
  check('harmless variables survive', packet.packet.environment['PORT'] === '3000');
  check(
    'and no gate output leaks a key either',
    !JSON.stringify(packet).includes('sk' + '_live_' + 'X'.repeat(24)),
  );

  const routine = buildEscalationPacket({
    projectId: 'p',
    projectSummary: 'x',
    intent: { ...intent, targetMode: 'production_product' },
    currentState: 'production_preparation',
    readinessScore: 80,
    blockers: [],
    capabilities: [],
  });
  check(
    'a production project has its fix read by a second person',
    routine.packet.acceptanceCriteria.some((c) => /second person/.test(c)),
  );

  console.log(`\n${failed === 0 ? 'All incident cases pass.' : `${failed} case(s) failed.`}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
