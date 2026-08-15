/**
 * Does anything leave the founder's computer that should not?
 *
 * That is the question this package exists for. Everything else here — links,
 * domains, deploy states — is ordinary product work. Uploading somebody's live
 * Stripe key onto infrastructure we run is the mistake that would matter.
 *
 *   npx tsx harness/test-hosting.ts
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_BUNDLE_BYTES,
  NEVER_UPLOAD,
  canMove,
  describeState,
  dnsRecordsFor,
  domainAdvice,
  domainState,
  findSecrets,
  hostingProves,
  isExcluded,
  isFinished,
  isReserved,
  isValidDomain,
  linkPolicy,
  missingSettings,
  planBundle,
  readyToDeploy,
  slugFor,
  temporaryUrl,
  OPERATIONAL_REQUIREMENTS,
  RESPONSIBILITIES,
  blockingRequirements,
  mustBeToldBeforeLaunch,
  ownedBy,
  readyToHost,
  responsibility,
  RETENTION_DAYS,
  describeGroup,
  fingerprint,
  group,
  isExpired,
  looksLikeAnError,
  redactForStorage,
  toRawEvent,
  type LogLine,
} from '../src/index';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS  ${name}`);
  else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shipyard-hosting-'));
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }
  return root;
}

/** Assembled rather than written out, so secret scanning does not reject this file. */
const fakeStripe = `sk${'_live_'}${'A'.repeat(24)}`;
const fakeAws = `AKIA${'B'.repeat(16)}`;

async function main(): Promise<void> {
  // ================================================================ the bundle
  const app = await project({
    'package.json': '{"name":"app"}',
    'src/app/page.tsx': 'export default function P() { return null; }\n',
    '.env': `DATABASE_URL=postgresql://a:realpassword@db/x\nSTRIPE_SECRET_KEY=${fakeStripe}\n`,
    '.env.example': 'DATABASE_URL=\n',
    'node_modules/react/index.js': 'module.exports = {};\n',
    '.git/config': '[remote "origin"]\n',
    'dev.sqlite': 'binary-ish',
  });
  const bundle = await planBundle(app);

  // The single most important assertion in this package.
  check('the .env file is never uploaded', !bundle.files.some((file) => file.path === '.env'));
  check('and it is recorded as kept back', bundle.excluded.includes('.env'));
  check('node_modules is not uploaded', !bundle.files.some((file) => file.path.startsWith('node_modules')));
  check('nor is the git history', !bundle.files.some((file) => file.path.startsWith('.git')));
  check(
    'nor a local database',
    !bundle.files.some((file) => file.path.endsWith('.sqlite')),
    bundle.files.map((f) => f.path).join(', '),
  );
  check('the .env.example template is fine to upload', bundle.files.some((file) => file.path === '.env.example'));
  check('the actual code is uploaded', bundle.files.some((file) => file.path === 'src/app/page.tsx'));
  check('this project is allowed to deploy', bundle.ok, JSON.stringify(bundle.refusals));
  check(
    'and the founder is told their settings stayed behind',
    /your settings never leave this computer/.test(bundle.summary),
    bundle.summary,
  );

  // A copy of .env under another name is the case a pattern list alone misses.
  const backup = await project({
    'package.json': '{}',
    'src/a.ts': 'export const a = 1;\n',
    'config/production.pem': '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
  });
  const withKeyFile = await planBundle(backup);
  check('a private key file stops the upload', !withKeyFile.ok);
  check(
    'and is named so they can find it',
    withKeyFile.refusals.some((refusal) => refusal.path === 'config/production.pem'),
  );
  check(
    'and is not uploaded anyway',
    !withKeyFile.files.some((file) => file.path.endsWith('.pem')),
  );

  // A key pasted into source while debugging, which is how this really happens.
  const pasted = await project({
    'package.json': '{}',
    'src/lib/stripe.ts': `const key = '${fakeStripe}';\nexport default key;\n`,
  });
  const withPastedKey = await planBundle(pasted);
  check('a key hardcoded in source stops the upload', !withPastedKey.ok);
  check(
    'it says which file and what kind of key',
    /Stripe secret key/.test(withPastedKey.refusals[0]?.reason ?? '') &&
      withPastedKey.refusals[0]?.path === 'src/lib/stripe.ts',
  );

  // The refusal ends up in logs and screenshots.
  check(
    'and it never repeats the key back',
    !JSON.stringify(withPastedKey).includes(fakeStripe),
  );
  check(
    'and it tells them to change the key, not just move it',
    /change the key with the provider/.test(withPastedKey.refusals[0]?.fix ?? ''),
  );
  check(
    'the summary leads with the fact that nothing was uploaded',
    /Not uploading anything yet/.test(withPastedKey.summary),
    withPastedKey.summary,
  );

  check('a database URL with a password in it is caught', findSecrets('postgres://u:hunter2@host/db').length === 1);
  check('an AWS key is caught', findSecrets(`id = "${fakeAws}"`).length === 1);
  check('a GitHub token is caught', findSecrets(`ghp_${'c'.repeat(20)}`).length === 1);
  check('ordinary code is not', findSecrets('const total = price * quantity;') .length === 0);
  check(
    'a placeholder in a template is not a secret',
    findSecrets('STRIPE_SECRET_KEY=\nDATABASE_URL=').length === 0,
  );

  check('exclusion works on nested paths', isExcluded('apps/web/node_modules/x/index.js'));
  check('and is not fooled by a similar name', !isExcluded('src/environment.ts'));
  check('the never-upload list covers the obvious ones', NEVER_UPLOAD.includes('.env') && NEVER_UPLOAD.includes('.git'));
  check('there is a size ceiling', MAX_BUNDLE_BYTES > 0);
  check(
    'an empty project says so rather than deploying nothing',
    (await planBundle(await project({}))).summary === 'There is nothing here to deploy yet.',
  );

  // ================================================================== the link
  const slug = slugFor('Acme Invoices', () => 'k3n9x1');
  check('a slug comes from the project name', slug.startsWith('acme-invoices-'));
  // Guessability is the point, not collisions.
  check('with something random on the end', slug === 'acme-invoices-k3n9x1');
  check('a name that is all punctuation still works', slugFor('!!!', () => 'aaa') === 'app-aaa');
  check('a reserved name cannot be taken', slugFor('admin', () => 'aaa') === 'app-aaa');
  check('and reserved names are known', isReserved('www') && isReserved('billing') && !isReserved('acme'));
  check('the URL is https', temporaryUrl('acme-k3n9x1') === 'https://acme-k3n9x1.shipyard.app');

  const prototypeLink = linkPolicy('functional_prototype');
  check('a prototype link is kept out of search results', prototypeLink.noIndex);
  check('and says on the page that it is not finished', Boolean(prototypeLink.banner));
  check(
    'and the reason is given rather than the rule',
    /found by a stranger who thinks it is real/.test(prototypeLink.because),
  );
  check('a pilot loses the banner', !linkPolicy('customer_pilot').banner);
  check('but is still not indexed', linkPolicy('customer_pilot').noIndex);
  check('a live product is indexed', !linkPolicy('production_product').noIndex);

  // =============================================================== the domain
  check('a real domain is accepted', isValidDomain('acme.com') && isValidDomain('app.acme.co.uk'));
  check('nonsense is not', !isValidDomain('not a domain') && !isValidDomain('acme') && !isValidDomain(''));
  check('and nobody can claim one of ours', !isValidDomain('anything.shipyard.app'));

  const records = dnsRecordsFor('acme.com', 'shipyard-verify-abc123');
  check('an apex domain gets an A record', records.some((record) => record.type === 'A'));
  check('a subdomain gets a CNAME', dnsRecordsFor('app.acme.com', 't').some((record) => record.type === 'CNAME'));
  check('there is always an ownership record', records.some((record) => record.type === 'TXT'));

  // The record people skip, and the reason it is not optional.
  check(
    'and it explains what it stops',
    /anybody could point a name they do not own at us/.test(
      records.find((record) => record.type === 'TXT')?.purpose ?? '',
    ),
  );
  check(
    'every record says what it is for',
    records.every((record) => record.purpose.length > 20),
  );

  check(
    'a domain with nothing set up waits, and says waiting is normal',
    /nothing to fix while you wait/.test(
      domainState({ verificationSeen: false, routingSeen: false, certificateIssued: false }).message,
    ),
  );
  check(
    'a half-configured domain says which record is missing',
    /the one that sends visitors/.test(
      domainState({ verificationSeen: true, routingSeen: false, certificateIssued: false }).message,
    ),
  );
  check(
    'a verified domain is not called live until the certificate exists',
    domainState({ verificationSeen: true, routingSeen: true, certificateIssued: false }).state === 'verifying',
  );
  check(
    'and is once it does',
    domainState({ verificationSeen: true, routingSeen: true, certificateIssued: true }).state === 'live',
  );
  check(
    'a domain that stopped working says visitors are seeing an error',
    /Anyone visiting it is seeing an error/.test(
      domainState({ verificationSeen: true, routingSeen: false, certificateIssued: true, wasLive: true }).message,
    ),
  );

  check(
    'a prototype is warned before going on a real company address',
    /anybody who visits your company name sees it/.test(domainAdvice('functional_prototype') ?? ''),
  );
  check('and a pilot is not nagged', domainAdvice('customer_pilot') === null);

  // ============================================================ the deployment
  check('a build cannot jump straight to live', !canMove('building', 'live'));
  check('it has to start first', canMove('building', 'starting') && canMove('starting', 'live'));
  check('a build can fail', canMove('building', 'build_failed'));
  check('and something live can crash later', canMove('live', 'crashed'));
  check('nothing comes back from superseded', !canMove('superseded', 'live'));

  // The moment the founder most wants a link is the moment it would be a white page.
  check('no link is offered while building', !describeState('building', 'customer_pilot').linkSafeToShare);
  check('nor while starting', !describeState('starting', 'customer_pilot').linkSafeToShare);
  check('only once it is live', describeState('live', 'customer_pilot').linkSafeToShare);
  check(
    'a live prototype link says it is not finished',
    /says on the page that it is not finished/.test(describeState('live', 'ui_concept').detail),
  );
  check(
    'a crash points at the likeliest cause rather than a stack trace',
    /the live app has none of your \.env until you add them here/.test(describeState('crashed', 'customer_pilot').detail),
  );
  check(
    'a failed build says the error is reproducible locally',
    /reproducible there/.test(describeState('build_failed', 'customer_pilot').detail),
  );
  check('finished states are known', isFinished('live') && isFinished('crashed') && !isFinished('building'));

  const proves = hostingProves();
  check('what hosting settles is listed', proves.settled.length >= 3);
  check('and what it does not is listed too', proves.notSettled.length >= 3);
  check(
    'including that nothing has tested the parts talking to other services',
    proves.notSettled.some((item) => /nothing on the internet could reach your computer/.test(item)),
  );

  check(
    'a deploy is refused when a setting is missing',
    readyToDeploy({
      bundleOk: true,
      buildPasses: true,
      settings: [{ name: 'DATABASE_URL', provided: false, secret: true }],
    }).reason?.includes('DATABASE_URL') === true,
  );
  check(
    'and when the app does not build',
    /will not build on the server either/.test(
      readyToDeploy({ bundleOk: true, buildPasses: false, settings: [] }).reason ?? '',
    ),
  );
  check(
    'and when something in the bundle should not leave',
    readyToDeploy({ bundleOk: false, buildPasses: true, settings: [] }).ready === false,
  );
  check(
    'and allowed when everything is in place',
    readyToDeploy({
      bundleOk: true,
      buildPasses: true,
      settings: [{ name: 'DATABASE_URL', provided: true, secret: true }],
    }).ready,
  );
  check('missing settings are listed by name', missingSettings([{ name: 'X', provided: false, secret: false }]).length === 1);

  // ========================================================= responsibility
  check('every responsibility says who owns it', RESPONSIBILITIES.every((entry) => Boolean(entry.owner)));
  check('anything we own says what we do', ownedBy('shipyard').every((entry) => Boolean(entry.ours)));
  check('anything they own says what they do', ownedBy('founder').every((entry) => Boolean(entry.theirs)));
  // The dangerous kind: both halves have to be named, or it belongs to nobody.
  check(
    'anything shared says which half is whose',
    ownedBy('shared').every((entry) => Boolean(entry.ours) && Boolean(entry.theirs)),
  );
  check('the platform staying up is ours', responsibility('platform_uptime')?.owner === 'shipyard');
  check('keeping one app away from another is ours', responsibility('isolation')?.owner === 'shipyard');
  check('their code being right is theirs', responsibility('app_correctness')?.owner === 'founder');
  check('who can see what inside their app is theirs', responsibility('app_access_control')?.owner === 'founder');
  check('patching is split, because it is two layers', responsibility('runtime_patching')?.owner === 'shared');

  // The sentence a normal hosting provider leaves in the terms and we cannot.
  const dataDuty = responsibility('data_you_collect');
  check('the information their app collects is theirs', dataDuty?.owner === 'founder');
  check(
    'and they are told they become responsible for it in law',
    /your responsibility in law/.test(dataDuty?.mustBeTold ?? ''),
  );
  check(
    'with the jargon explained rather than used',
    /what the rules call the "controller"/.test(dataDuty?.mustBeTold ?? ''),
  );
  check(
    'and which part Shipyard can actually help with',
    /parts that do the handing back and deleting/.test(dataDuty?.mustBeTold ?? ''),
  );

  const told = mustBeToldBeforeLaunch();
  check('there is a list of what they must be told', told.length >= 8, `${told.length}`);
  check('each a sentence they could act on', told.every((entry) => entry.message.length > 60));
  check(
    'including that a successful deploy is not a working app',
    told.some((entry) => /started, not that it works/.test(entry.message)),
  );
  check(
    'and that a breach deadline is theirs, in hours',
    told.some((entry) => /hours, not weeks/.test(entry.message)),
  );

  // ==================================================== operational readiness
  check('there is a list of what must exist first', OPERATIONAL_REQUIREMENTS.length >= 10);
  check('every item says why', OPERATIONAL_REQUIREMENTS.every((entry) => entry.because.length > 40));
  check('the blocking ones are marked', blockingRequirements().length >= 8);
  check('isolation being proven is one', blockingRequirements().some((e) => e.id === 'isolation_proven'));
  check('and a restore having actually been done', blockingRequirements().some((e) => e.id === 'restore_tested'));
  check(
    'and a processing agreement, because their customers’ data sits on our servers',
    blockingRequirements().some((e) => e.id === 'processing_agreement'),
  );
  check(
    'and a spend cap, because a runaway loop is charged to us first',
    blockingRequirements().some((e) => e.id === 'spend_cap'),
  );

  const nothingDone = readyToHost([]);
  check('with nothing done, hosting is refused', !nothingDone.ready);
  check('and everything missing is listed', nothingDone.missing.length === blockingRequirements().length);
  check('the summary names them rather than counting', /restore/.test(nothingDone.summary));

  const almost = readyToHost(blockingRequirements().slice(1).map((entry) => entry.id));
  check('one thing missing still refuses', !almost.ready && almost.missing.length === 1);

  const allDone = readyToHost(blockingRequirements().map((entry) => entry.id));
  check('everything done allows it', allDone.ready);
  check(
    'without claiming more than that',
    /before hosting somebody else’s app exists/.test(allDone.summary),
    allDone.summary,
  );

  // ================================================= logs coming back to them
  const line = (over: Partial<LogLine> = {}): LogLine => ({
    deploymentId: 'dep_1',
    stream: 'stderr',
    at: '2026-08-15T09:14:00.000Z',
    text: 'Error: something broke',
    ...over,
  });

  // What Shipyard keeps becomes a copy of somebody's customers' data unless
  // this works.
  check(
    'an email address in a log is not stored',
    !redactForStorage('failed for sam@example.com').includes('sam@example.com'),
  );
  check('nor a visitor’s IP address', !redactForStorage('request from 203.0.113.44').includes('203.0.113.44'));
  check('nor a card number', !redactForStorage('card 4242 4242 4242 4242').includes('4242 4242'));
  check('nor a database password', !redactForStorage('connect postgres://app:hunter2@db/x').includes('hunter2'));
  check('nor a token in a URL', !redactForStorage('GET /reset?token=abc123def456').includes('abc123def456'));
  check(
    'but the useful part survives',
    redactForStorage('connect postgres://app:hunter2@db.internal/x').includes('db.internal'),
  );
  check('and a very long line is cut', redactForStorage('x'.repeat(9000)).length < 2100);

  check('our copy does not live forever', RETENTION_DAYS <= 30);
  check('and old lines are droppable', isExpired('2026-01-01T00:00:00.000Z', new Date('2026-08-15T00:00:00.000Z')));
  check(
    'while recent ones are not',
    !isExpired('2026-08-14T00:00:00.000Z', new Date('2026-08-15T00:00:00.000Z')),
  );

  // Crying wolf on day one is how the real alert gets ignored.
  check('a real error is noticed', looksLikeAnError(line({ text: 'Error: cannot read property id' })));
  check('a crash in a stack trace is noticed', looksLikeAnError(line({ text: 'at handler (src/app/api/x.ts:31:9)' })));
  check('a 500 is noticed', looksLikeAnError(line({ stream: 'request', status: 500, text: 'GET /orders' })));
  check('a 404 is not', !looksLikeAnError(line({ stream: 'request', status: 404, text: 'GET /nope' })));
  check('a warning is not', !looksLikeAnError(line({ text: 'warn - deprecated API used' })));
  check('framework narration is not', !looksLikeAnError(line({ text: 'ready - started server on 0.0.0.0:3000' })));
  check('an experimental warning is not', !looksLikeAnError(line({ text: '(node:1) ExperimentalWarning: x' })));
  check('ordinary stdout is not', !looksLikeAnError(line({ stream: 'stdout', text: 'Processed 40 rows' })));

  const event = toRawEvent(line({ text: 'Error: failed for sam@example.com\n    at handler (x.ts:1:1)' }));
  check('an error becomes something the incident engine understands', event?.source === 'shipyard_hosting');
  check('marked as production, because it is', event?.environment === 'production');
  // Everything downstream is built from this, so a leak here leaks everywhere.
  check('with the customer’s email already gone', !JSON.stringify(event).includes('sam@example.com'));
  check('and the stack kept when there is one', Boolean(event?.stack));
  check(
    'a 500 is titled in a way a person can read',
    toRawEvent(line({ stream: 'request', status: 500, route: '/orders', text: 'x' }))?.title === '500 on /orders',
  );
  check('and noise produces nothing at all', toRawEvent(line({ text: 'warn - x' })) === null);

  // One broken page, not four thousand notifications.
  const many = Array.from({ length: 412 }, (_, index) => ({
    event: toRawEvent(line({ text: `Error: order ${index} not found` }))!,
    at: `2026-08-15T09:${String(14 + (index % 40)).padStart(2, '0')}:00.000Z`,
  }));
  const grouped = group(many);
  check('four hundred identical errors are one problem', grouped.length === 1, `${grouped.length} groups`);
  check('with the count kept', grouped[0]?.count === 412);
  check('ids in the message do not defeat the grouping', fingerprint(many[0]!.event) === fingerprint(many[9]!.event));
  check(
    'genuinely different errors stay separate',
    group([
      { event: toRawEvent(line({ text: 'Error: database is unreachable' }))!, at: '2026-08-15T09:00:00.000Z' },
      { event: toRawEvent(line({ text: 'Error: payment declined' }))!, at: '2026-08-15T09:01:00.000Z' },
    ]).length === 2,
  );

  // The number is the decision, not the message.
  check('a repeated error says how many times it happened', /happened 412 times/.test(describeGroup(grouped[0]!)));
  check('and a one-off says so plainly', /happened once/.test(describeGroup({ ...grouped[0]!, count: 1 })));

  console.log(`\n${failed === 0 ? 'All hosting cases pass.' : `${failed} case(s) failed.`}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
