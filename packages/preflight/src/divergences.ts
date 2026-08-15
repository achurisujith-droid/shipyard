/**
 * Every way "it works on my machine" turns out not to mean anything.
 *
 * This list is the honest answer to the question every founder asks before
 * their first deploy: *will what works here work there?* No. Not reliably. And
 * the reasons are not mysterious — there are about a dozen of them, they are
 * the same dozen every time, and most can be checked before anybody deploys
 * anything.
 *
 * Writing them down as data rather than prose is the point. A paragraph in a
 * README saying "watch out for case sensitivity" helps nobody at midnight; a
 * check that reads the imports and says *`src/app/page.tsx` imports `./Button`
 * and the file is called `button.tsx`* stops the outage happening.
 *
 * Each entry says what differs, what it costs, and — where possible — how to
 * find out before it matters.
 */

export type DivergenceSeverity =
  /** The deploy will fail, or the app will be broken for everybody. */
  | 'breaks_everything'
  /** One feature silently does not work. Worse, because nobody notices. */
  | 'breaks_quietly'
  /** It works, until there is more than one person using it. */
  | 'breaks_under_load';

export interface Divergence {
  id: string;
  /** What is different, in the founder's words. */
  what: string;
  /** What goes wrong because of it. */
  cost: string;
  severity: DivergenceSeverity;
  /**
   * Can this be found before deploying, on the machine the code is on?
   *
   * `false` is not an admission of defeat — it is the reason the deploy is
   * followed by checks against the live site rather than treated as finished.
   */
  checkableLocally: boolean;
  /** The preflight check that finds it, when one exists. */
  check?: string;
  /** What to do about it. */
  fix: string;
}

export const DIVERGENCES: readonly Divergence[] = [
  {
    id: 'env_not_uploaded',
    what: 'Your .env file stays on your computer. It is never uploaded, by design.',
    cost:
      'The live app starts with none of its settings — no database, no keys — and every page fails. This is the single most common first-deploy failure and it looks like a mysterious crash rather than a missing setting.',
    severity: 'breaks_everything',
    checkableLocally: true,
    check: 'settings_listed_for_deploy',
    fix: 'Copy each setting into your host’s own variables. Shipyard lists the names for you; the values are yours and it never reads them.',
  },
  {
    id: 'dev_is_not_build',
    what: 'Running the app while you work is not the same as building it for real.',
    cost:
      'Development mode compiles one page at a time and forgives a lot. A type error in a page you never opened, an import that only resolves loosely — none of it surfaces until the real build runs, and then the deploy fails.',
    severity: 'breaks_everything',
    checkableLocally: true,
    check: 'production_build',
    fix: 'Run the real build before deploying. It takes a minute and it is the same build the server will run.',
  },
  {
    id: 'case_sensitive_paths',
    what: 'Your computer does not care about capital letters in file names. The server does.',
    cost:
      'Importing `./Button` when the file is `button.tsx` works perfectly here and fails on the server. The page returns an error and nothing about the code looks wrong.',
    severity: 'breaks_everything',
    checkableLocally: true,
    check: 'imports_match_filenames',
    fix: 'Rename either the file or the import so they match exactly. The check tells you which line.',
  },
  {
    id: 'hardcoded_localhost',
    what: 'Addresses like localhost:3000 written into the code.',
    cost:
      'On the server, localhost means the server itself. Links in emails point at nothing, and calls between parts of your app quietly fail.',
    severity: 'breaks_quietly',
    checkableLocally: true,
    check: 'no_hardcoded_addresses',
    fix: 'Use the APP_URL setting instead, which is different on your machine and on the server.',
  },
  {
    id: 'dev_dependency_used_in_app',
    what: 'A package listed as a development tool but used by the app itself.',
    cost:
      'Servers install without development tools. The build succeeds here, and the live app crashes on the first page that needs it.',
    severity: 'breaks_everything',
    checkableLocally: true,
    check: 'no_dev_only_imports',
    fix: 'Move the package from devDependencies to dependencies.',
  },
  {
    id: 'database_is_empty',
    what: 'The live database is a different, empty database.',
    cost:
      'The tables do not exist until the migrations run there. Nothing you typed in while building comes with it — and it should not, because most of it is test data.',
    severity: 'breaks_everything',
    checkableLocally: true,
    check: 'migrations_are_current',
    fix: 'Run the migrations against the live database as part of deploying. Shipyard can do this for you.',
  },
  {
    id: 'secure_cookies',
    what: 'Sign-in cookies marked "secure" only work over HTTPS.',
    cost:
      'The opposite of the usual problem: it works locally over plain HTTP and, if the setting is wrong, silently stops people staying signed in on the live site.',
    severity: 'breaks_quietly',
    checkableLocally: true,
    check: 'cookies_secure_in_production',
    fix: 'The auth component already gets this right. Check anything that sets its own cookies.',
  },
  {
    id: 'webhooks_never_arrived',
    what: 'Nothing on the internet can reach your laptop.',
    cost:
      'Stripe, and anything else that calls you back, has never actually delivered a message to your app. That code path is completely untested however much you clicked around.',
    severity: 'breaks_quietly',
    checkableLocally: false,
    fix: 'After deploying, send a real test event from the vendor and confirm the app acted on it.',
  },
  {
    id: 'test_keys',
    what: 'You have been using test keys.',
    cost:
      'Test keys take no money and send no email. Swapping them for live ones is the moment the behaviour becomes real, and it happens after everything appeared to work.',
    severity: 'breaks_quietly',
    checkableLocally: false,
    fix: 'Change one at a time and test each. Do not swap them all on launch day.',
  },
  {
    id: 'server_timezone',
    what: 'Servers run in UTC. Your computer does not.',
    cost:
      'Dates land a few hours out — a booking on the wrong day, a report covering the wrong window. It is subtle enough to survive a demo and get found by a customer.',
    severity: 'breaks_quietly',
    checkableLocally: false,
    fix: 'Store times in UTC and convert when you show them. Test with your own clock set to another timezone.',
  },
  {
    id: 'connection_limits',
    what: 'One person clicking is not several people clicking.',
    cost:
      'Database connections are limited. Alone you use one; twenty people at once can exhaust the pool, and the app stops responding while looking perfectly healthy.',
    severity: 'breaks_under_load',
    checkableLocally: false,
    fix: 'Use the shared connection the starter template sets up, and watch it after launch rather than assuming.',
  },
  {
    id: 'cold_start',
    what: 'The server may go to sleep when nobody is using it.',
    cost:
      'The first visitor after a quiet period waits several seconds. On the cheap plans this is normal, and it reads as "the site is broken" to somebody you sent a link to.',
    severity: 'breaks_under_load',
    checkableLocally: false,
    fix: 'Know whether your plan does this before you send the link to anybody who matters.',
  },
  {
    id: 'files_on_disk',
    what: 'Files written to the server’s own disk do not survive a restart.',
    cost:
      'Uploads work, and then disappear the next time the app is redeployed. Nobody connects the two events.',
    severity: 'breaks_quietly',
    checkableLocally: true,
    check: 'no_local_file_writes',
    fix: 'Put uploads in file storage rather than on the server. The file storage component does this.',
  },
];

export function divergence(id: string): Divergence | undefined {
  return DIVERGENCES.find((entry) => entry.id === id);
}

/** The ones a deploy cannot honestly be called ready without. */
export function blocking(): Divergence[] {
  return DIVERGENCES.filter((entry) => entry.severity === 'breaks_everything');
}

/**
 * The ones nothing local can find.
 *
 * Worth showing to a founder before they deploy, not to alarm them but because
 * "these are the things we cannot check for you, and here is what to do about
 * each after it is live" is the difference between a deploy and a gamble.
 */
export function onlyCheckableLive(): Divergence[] {
  return DIVERGENCES.filter((entry) => !entry.checkableLocally);
}
