import type { BrowserWindow } from 'electron';

/**
 * Headless self-check, run only when SHIPYARD_SMOKE=1.
 *
 * Exercises the real thing rather than a mock: the actual preload bridge, the
 * actual IPC dispatch, and the actual cli-bridge underneath. It is the only way
 * to verify wiring without a human looking at the window, and it is what CI
 * would run.
 */
export async function runSmoke(win: BrowserWindow): Promise<number> {
  const results: Record<string, unknown> = {};
  let failures = 0;

  const check = async (name: string, expression: string, ok: (v: unknown) => boolean) => {
    try {
      const value: unknown = await win.webContents.executeJavaScript(expression, true);
      results[name] = value;
      if (!ok(value)) {
        failures += 1;
        results[`${name}__FAILED`] = true;
      }
    } catch (err) {
      failures += 1;
      results[name] = `THREW: ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  // The preload bridge is reachable and nothing else leaked into the renderer.
  await check('bridgeExposed', 'typeof window.shipyard', (v) => v === 'object');
  await check('nodeNotExposed', 'typeof window.require', (v) => v === 'undefined');
  await check('processNotExposed', 'typeof window.process', (v) => v === 'undefined');

  // React actually mounted.
  await check(
    'rootMounted',
    'document.getElementById("root")?.childElementCount ?? 0',
    (v) => typeof v === 'number' && v > 0,
  );
  // Asserts the welcome screen rendered a heading, without pinning the copy —
  // wording is a design decision and should be free to change.
  await check(
    'welcomeHeading',
    'document.querySelector("h1")?.textContent ?? null',
    (v) => typeof v === 'string' && v.length > 0,
  );
  await check(
    'welcomeHasCta',
    'document.querySelector("button")?.textContent ?? null',
    (v) => typeof v === 'string' && v.length > 0,
  );

  // A real round trip through IPC into cli-bridge.
  await check(
    'claudeDetect',
    'window.shipyard.claude.detect()',
    (v) => typeof v === 'object' && v !== null && (v as { installed?: unknown }).installed === true,
  );
  await check(
    'appInfo',
    'window.shipyard.app.info()',
    (v) => typeof v === 'object' && v !== null && typeof (v as { platform?: unknown }).platform === 'string',
  );
  await check(
    'projectsDefaultRoot',
    'window.shipyard.projects.defaultRoot()',
    (v) => typeof v === 'string' && v.length > 0,
  );
  // Unknown routes must be rejected, not silently ignored.
  await check(
    'unknownRouteRejected',
    'window.shipyard.app.openExternal("file:///etc/passwd").then(() => "ALLOWED").catch(() => "REJECTED")',
    (v) => v === 'REJECTED',
  );

  console.log(`SMOKE_RESULT ${JSON.stringify({ failures, results }, null, 2)}`);
  return failures;
}

/**
 * The Milestone 2 acceptance path, run with SHIPYARD_SMOKE=session.
 *
 * Drives a real Claude Code session through the app's own IPC: open a session,
 * exchange a message, provoke a genuine tool permission prompt, answer it the
 * way the dialog would, and confirm the tool actually ran. Everything happens
 * in the renderer so it goes through preload exactly as a user's clicks would.
 */
export async function runSessionSmoke(
  win: BrowserWindow,
  projectDir: string,
  pidOf: (sessionId: string) => number | undefined,
): Promise<number> {
  const js = (expression: string): Promise<unknown> =>
    win.webContents.executeJavaScript(expression, true);

  const poll = async (expression: string, timeoutMs: number): Promise<unknown> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await js(expression);
      if (value !== null && value !== undefined && value !== false) return value;
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 500));
    }
  };

  const results: Record<string, unknown> = {};
  let failures = 0;
  const expect = (name: string, value: unknown, ok: boolean): void => {
    results[name] = value;
    if (!ok) {
      failures += 1;
      results[`${name}__FAILED`] = true;
    }
  };

  // Subscribe before doing anything, so no event is missed.
  await js(`
    (() => {
      const log = { assistant: [], tools: [], states: [], permissions: [], errors: [] };
      window.__log = log;
      window.shipyard.on('session:assistant-text', (p) => log.assistant.push(p.text));
      window.shipyard.on('session:tool-summary', (p) => log.tools.push(p.tool));
      window.shipyard.on('session:state', (p) => log.states.push(p.state));
      window.shipyard.on('session:permission-request', (p) => log.permissions.push(p.request));
      window.shipyard.on('session:error', (p) => log.errors.push(p.error));
      return true;
    })()
  `);

  const created = await js(
    `window.shipyard.session.create(${JSON.stringify(projectDir)}).then(h => (window.__s = h, h))`,
  );
  expect(
    'sessionCreated',
    created,
    typeof created === 'object' && created !== null && typeof (created as { sessionId?: unknown }).sessionId === 'string',
  );
  if (failures > 0) {
    console.log(`SESSION_SMOKE_RESULT ${JSON.stringify({ failures, results }, null, 2)}`);
    return failures;
  }

  // 1. A plain exchange.
  await js(`window.shipyard.session.send(window.__s.sessionId, 'Reply with exactly: SHIPYARD-APP-OK')`);
  const replied = await poll(
    `window.__log.assistant.join('\\n').includes('SHIPYARD-APP-OK')`,
    120_000,
  );
  expect('assistantReplied', replied === true, replied === true);

  // 2. A turn that must ask permission - the criterion is that it surfaces as a
  //    dialog payload with real options, and that our answer reaches the CLI.
  await js(
    `window.shipyard.session.send(window.__s.sessionId, 'Create a file named app-smoke.txt containing only the word ok')`,
  );
  const request = await poll(`window.__log.permissions[0] ?? null`, 120_000);
  expect(
    'permissionSurfaced',
    request,
    typeof request === 'object' && request !== null && Array.isArray((request as { options?: unknown }).options),
  );

  if (request && typeof request === 'object') {
    const options = (request as { options: { index: number; kind: string }[] }).options;
    expect('permissionHasMultipleOptions', options.length, options.length >= 2);
    const allowOnce = options.find((o) => o.kind === 'allow-once') ?? options[0];
    await js(
      `window.shipyard.session.respondToPermission(window.__s.sessionId, ${allowOnce?.index ?? 1})`,
    );
    const ran = await poll(`window.__log.tools.length > 0`, 120_000);
    expect('toolRanAfterAnswer', ran === true, ran === true);
    results['tools'] = await js(`window.__log.tools`);
  }

  results['states'] = await js(`Array.from(new Set(window.__log.states))`);

  // 3. Crash recovery: kill the CLI the way a crash would, and confirm the app
  //    surfaces a recoverable error and can restart into a working session.
  const sessionId = (created as { sessionId: string }).sessionId;
  const pid = pidOf(sessionId);
  expect('sessionHasPid', pid, typeof pid === 'number');

  if (typeof pid === 'number') {
    await js(`(window.__log.errors.length = 0, true)`);
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }

    const fatal = await poll(`window.__log.errors.some((e) => e.fatal) || null`, 30_000);
    expect('fatalErrorSurfaced', fatal === true, fatal === true);

    const exited = await poll(`window.__log.states.includes('exited') || null`, 30_000);
    expect('stateWentExited', exited === true, exited === true);

    await js(`window.shipyard.session.restart(window.__s.sessionId)`);
    await js(`(window.__log.assistant.length = 0, true)`);
    await js(
      `window.shipyard.session.send(window.__s.sessionId, 'Reply with exactly: SHIPYARD-RESTARTED')`,
    );
    const back = await poll(
      `window.__log.assistant.join('\\n').includes('SHIPYARD-RESTARTED')`,
      120_000,
    );
    expect('recoveredAfterRestart', back === true, back === true);
  }

  await js(`window.shipyard.session.kill(window.__s.sessionId)`);
  results['errors'] = await js(`window.__log.errors`);

  console.log(`SESSION_SMOKE_RESULT ${JSON.stringify({ failures, results }, null, 2)}`);
  return failures;
}
