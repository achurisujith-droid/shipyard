/**
 * Does the library notice when somebody asks for something it already has?
 *
 * This is the difference between a library and a folder. A founder writes "let
 * candidates upload their CV and pull the text out" into a requirements
 * document; unless something connects that sentence to the components that do
 * exactly that, an agent spends an afternoon writing a worse version and nobody
 * ever finds out.
 *
 *   npx tsx harness/test-matcher.ts
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadLibrary } from '@shipyard/component-library';

import { briefForAgent, explain, matchRequirements, requirementLines, stem, tokenise, unmatched } from '../src/index';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS  ${name}`);
  else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  const library = await loadLibrary(path.join(repoRoot, 'components'));
  const ids = (text: string, options = {}): string[] =>
    matchRequirements(text, library, options).map((match) => match.componentId);

  // ------------------------------------------------------------------- words
  check('plurals and tenses reach the same stem', stem('uploads') === stem('upload') && stem('uploading') === stem('upload'));
  check('short words are left alone', stem('pdf') === 'pdf');
  check('noise words are dropped', !tokenise('the user should be able to').includes('user'));
  check('meaningful words survive', tokenise('upload their CV').includes('upload'));

  check(
    'requirements are split into the units people write them in',
    requirementLines('- Let people sign in.\n- Send them a receipt.\n* Export to PDF.').length === 3,
  );
  check(
    'bullet markers are stripped',
    requirementLines('- Let people sign in with an email').every((line) => !line.startsWith('-')),
  );
  check('a fragment is not treated as a requirement', requirementLines('ok\nyes').length === 0);

  // -------------------------------------------------- the founder's own words
  const cvApp = `
    We are building a hiring tool for small agencies.
    Let candidates upload their CV and pull the text out of it.
    Recruiters need to sign in with an email and password.
    Each agency should only see their own candidates.
    Send an email to the candidate when they are shortlisted.
  `;
  const found = ids(cvApp);

  check('a CV upload finds the document reader', found.includes('document_text_extract'), found.join(', '));
  check('and the file storage it needs', found.includes('s3_file_storage'), found.join(', '));
  check('signing in finds the auth component', found.includes('auth'));
  check('"only see their own" finds tenancy', found.includes('organization_tenancy'));
  check('"send an email" finds email', found.includes('transactional_email'));
  check(
    'and it does not suggest things nobody asked for',
    !found.includes('stripe_subscription_billing') && !found.includes('pdf_generate'),
    found.join(', '),
  );

  const invoicing = 'Customers should be able to download a receipt as a PDF after they pay by card.';
  const money = ids(invoicing);
  check('a PDF receipt finds the generator', money.includes('pdf_generate'), money.join(', '));
  check('paying by card finds billing', money.includes('stripe_subscription_billing'), money.join(', '));
  check(
    'and reading documents is not suggested for writing one',
    !money.includes('document_text_extract'),
    money.join(', '),
  );

  const bulk = 'Admins need to upload a spreadsheet of customers to import them all at once.';
  check('a spreadsheet import is found', ids(bulk).includes('csv_import'), ids(bulk).join(', '));

  // ------------------------------------------------------------- confidence
  const matches = matchRequirements(cvApp, library);
  check('everything comes back with a score', matches.every((match) => match.score > 0));
  check('sorted strongest first', matches.every((match, index) => index === 0 || match.score <= (matches[index - 1]?.score ?? 1)));
  check(
    'every match quotes the sentence that caused it',
    matches.every((match) => match.because.length > 0 && match.because[0]!.length > 8),
  );
  check(
    'and the quoted sentence really is from their requirements',
    matches.every((match) => cvApp.includes(match.because[0]!.slice(0, 30))),
  );
  check(
    'a strong match reads as a statement',
    /already built/.test(explain({ ...matches[0]!, confidence: 'strong', installed: false })),
  );
  check(
    'a weak one reads as a suggestion',
    /might be covered/.test(explain({ ...matches[0]!, confidence: 'possible', installed: false })),
  );
  check(
    'and something already installed says so instead',
    /already have/.test(explain({ ...matches[0]!, installed: true })),
  );

  check('nothing matches an empty document', matchRequirements('', library).length === 0);
  check(
    'nothing matches something entirely unrelated',
    matchRequirements('We want to train a large language model on protein folding data.', library).length === 0,
    ids('We want to train a large language model on protein folding data.').join(', '),
  );

  check('the two tiers are distinguished', matches.some((match) => match.tier === 'capability'));
  check(
    'and utility components are labelled as such',
    matchRequirements('read the text out of an uploaded PDF', library)[0]?.tier === 'utility',
  );

  check(
    'installed components are still shown, so they are not built twice',
    matchRequirements(cvApp, library, { installed: ['auth'] }).find((match) => match.componentId === 'auth')
      ?.installed === true,
  );

  // ------------------------------------------------------------ the handover
  const brief = briefForAgent(matchRequirements(cvApp, library));
  check('the agent is told what already exists', /already built and tested/.test(brief));
  check('by name', /Signing in/.test(brief));
  check('and told not to write them again', /Do not write these from scratch/.test(brief));
  check('while still allowed to disagree', /say which and why/.test(brief));

  check(
    'nothing already installed is put in the brief',
    !briefForAgent(matchRequirements(cvApp, library, { installed: ['auth'] })).includes('Signing in'),
  );
  check(
    'a hedged match is never given to the agent as an instruction',
    briefForAgent([
      { componentId: 'x', name: 'Maybe', summary: 's', tier: 'utility', score: 0.4, confidence: 'possible', because: ['x'], installed: false },
    ]) === '',
  );
  check('an empty match list produces no brief at all', briefForAgent([]) === '');

  // ------------------------------------------------------- what we do not have
  const gaps = unmatched(cvApp, matchRequirements(cvApp, library));
  check('requirements nothing covers are reported', gaps.length > 0, JSON.stringify(gaps));
  check(
    'and those are the ones worth building next',
    gaps.some((line) => /hiring tool/.test(line)),
    JSON.stringify(gaps),
  );

  console.log(`\n${failed === 0 ? 'All matcher cases pass.' : `${failed} case(s) failed.`}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
