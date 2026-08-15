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

  console.log(`\n${failed === 0 ? 'All hosting cases pass.' : `${failed} case(s) failed.`}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
