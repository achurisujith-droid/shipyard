/**
 * Who is responsible for what, once Shipyard hosts the apps it builds.
 *
 * Every hosting provider has this split and most of them publish it. Railway,
 * Vercel and Fly all say roughly the same thing: we keep the platform up and
 * patched, you are responsible for your own code and your own data.
 *
 * Copying that split is right. Copying the *assumption underneath it* is not.
 *
 * Railway's customer is a developer. They know that shipping an app which
 * collects email addresses makes them responsible for those email addresses,
 * that "the platform is up" and "my app works" are different claims, and that
 * nobody else is going to write their privacy notice.
 *
 * Shipyard's customer is a person building their first piece of software. They
 * do not know any of that, and — this is the part that matters — the moment
 * their app goes live and a stranger uses it, **they become legally responsible
 * for that stranger's information** whether or not anybody told them.
 *
 * So this file carries the same split, plus the thing a normal hosting provider
 * can leave out: what the founder has to be *told*, in words they can act on,
 * before it becomes true of them.
 */

export type Owner =
  /** Ours. If it goes wrong, it is our failure and our incident. */
  | 'shipyard'
  /** Theirs. We can help, warn and check, but it is not ours to fix. */
  | 'founder'
  /** Both, at different layers. The most dangerous kind, so each says which half. */
  | 'shared';

export interface Responsibility {
  id: string;
  area: string;
  owner: Owner;
  /** What we do. Empty when the founder owns it outright. */
  ours?: string;
  /** What they do. Empty when we own it outright. */
  theirs?: string;
  /**
   * What a first-time founder has to be told, because they will not know.
   *
   * The field that makes this different from a normal hosting provider's
   * responsibility matrix. A developer reading "you are responsible for your
   * application data" knows what that means; the person this product is for
   * reads it as boilerplate.
   */
  mustBeTold?: string;
}

export const RESPONSIBILITIES: readonly Responsibility[] = [
  {
    id: 'platform_uptime',
    area: 'The platform staying up',
    owner: 'shipyard',
    ours: 'Keeping the servers, the network and the build system running, and saying so publicly when they are not.',
    mustBeTold:
      'If we go down your app goes down, and that is on us. If your app crashes while our platform is fine, that is a bug in your app — the two look identical from outside, so we say which it was.',
  },
  {
    id: 'app_correctness',
    area: 'Your app working',
    owner: 'founder',
    theirs: 'The code doing what it is supposed to do.',
    mustBeTold:
      'We can host anything, including something broken. A successful deploy means it started, not that it works.',
  },
  {
    id: 'runtime_patching',
    area: 'Security updates',
    owner: 'shared',
    ours: 'Everything underneath your app — the operating system, the container, the version of Node it runs on.',
    theirs: 'The packages your own app depends on.',
    mustBeTold:
      'We patch the floor; you patch what you put on it. Shipyard warns you when one of your packages has a known problem, but updating it is a change to your app and only you can approve that.',
  },
  {
    id: 'isolation',
    area: 'Other people’s apps not reaching yours',
    owner: 'shipyard',
    ours: 'Keeping every app separate from every other app, including their databases and their network.',
    mustBeTold:
      'Nobody else hosted here can reach your app or your data. If that were ever untrue it would be our most serious kind of failure, and you would hear about it from us rather than from somebody else.',
  },
  {
    id: 'app_access_control',
    area: 'Who can see what inside your app',
    owner: 'founder',
    theirs: 'Sign-in, permissions, and one customer not seeing another customer’s records.',
    mustBeTold:
      'This is the most expensive thing to get wrong and it is inside your app, not our platform. The ready-made parts for sign-in and keeping customers separate exist because of it, and they come with tests.',
  },
  {
    id: 'certificates',
    area: 'The padlock in the address bar',
    owner: 'shipyard',
    ours: 'Certificates for your temporary link and for any domain you connect, renewed automatically.',
  },
  {
    id: 'dns',
    area: 'Your own domain',
    owner: 'shared',
    ours: 'Telling you exactly which records to add, and serving the domain once they are there.',
    theirs: 'Adding those records at your registrar, and keeping paying for the domain.',
    mustBeTold:
      'If your domain expires or the records are removed, your site stops working and we cannot fix it from here — the domain is yours, not ours.',
  },
  {
    id: 'backups',
    area: 'Backups of your database',
    owner: 'shipyard',
    ours: 'Taking regular backups of the databases we run for you, and testing that they restore.',
    mustBeTold:
      'A backup nobody has ever restored is a hope, not a backup. Ours are tested. Files you keep somewhere other than the database are not covered by this.',
  },
  {
    id: 'data_you_collect',
    area: 'The information your app collects',
    owner: 'founder',
    theirs: 'Deciding what to collect, why, how long to keep it, and answering the people it is about.',
    // The single most important sentence in this file.
    mustBeTold:
      'The moment a stranger uses your app, the information they give you is your responsibility in law — not ours. You are what the rules call the "controller" and we are the "processor": we hold it on your behalf and do what you tell us with it. That means you need to tell people what you collect and why, and be able to hand it back or delete it when they ask. Shipyard has parts that do the handing back and deleting; deciding what you collect is yours.',
  },
  {
    id: 'sub_processors',
    area: 'Who else touches your data',
    owner: 'shipyard',
    ours: 'Keeping a published list of every company involved in running your app for us, and telling you before it changes.',
    mustBeTold:
      'You are allowed to know where your customers’ information physically is, and to tell your own customers. So we publish it.',
  },
  {
    id: 'breach_notification',
    area: 'If something is exposed',
    owner: 'shared',
    ours: 'Telling you without delay if anything of ours exposed your data, with what we know and when we knew it.',
    theirs: 'Telling the people affected and, where the rules require it, a regulator.',
    mustBeTold:
      'There are deadlines on this measured in hours, not weeks, and they apply to you rather than to us. If it ever happens we tell you fast enough that you can meet yours.',
  },
  {
    id: 'abuse',
    area: 'What may be hosted here',
    owner: 'shared',
    ours: 'Removing anything used to defraud or attack people, and giving you a way to argue if we get it wrong.',
    theirs: 'Not running any of that.',
    mustBeTold:
      'Anything that can host an app can host a fake sign-in page. We take those down quickly, and because we sometimes have to act on incomplete information there is an appeal.',
  },
  {
    id: 'cost',
    area: 'What it costs to run',
    owner: 'shared',
    ours: 'Showing you what you are using before the bill, and stopping runaway usage rather than billing you for it.',
    theirs: 'Paying for it, and for the third-party services your app uses.',
    mustBeTold:
      'A loop that never ends costs money on somebody’s card. We cap it rather than let it run, which occasionally means stopping an app that was legitimately busy — you can raise the cap.',
  },
  {
    id: 'leaving',
    area: 'Taking your app somewhere else',
    owner: 'shipyard',
    ours: 'Giving you your code and a copy of your database whenever you ask, in a form another host can take, and deleting what we hold when you tell us to.',
    mustBeTold:
      'The code was always yours. Nothing here locks you in, and leaving does not require a conversation with anyone.',
  },
];

export function responsibility(id: string): Responsibility | undefined {
  return RESPONSIBILITIES.find((entry) => entry.id === id);
}

export function ownedBy(owner: Owner): Responsibility[] {
  return RESPONSIBILITIES.filter((entry) => entry.owner === owner);
}

/**
 * The things a founder must have been told before their app is public.
 *
 * Not a terms-of-service checkbox. These are the sentences that change what a
 * reasonable person would do, and a hosting provider whose customers are
 * first-time founders cannot claim they were "in the terms".
 */
export function mustBeToldBeforeLaunch(): { area: string; message: string }[] {
  return RESPONSIBILITIES.filter((entry) => entry.mustBeTold).map((entry) => ({
    area: entry.area,
    message: entry.mustBeTold as string,
  }));
}

/* ------------------------------------------------------- operational readiness */

export interface OperationalRequirement {
  id: string;
  what: string;
  /** Why it exists. */
  because: string;
  /**
   * True when nobody's app may be hosted until this exists. The rest can follow;
   * these cannot, because their absence is only discovered at the worst moment.
   */
  blocksFirstCustomer: boolean;
}

/**
 * What has to exist before the first app is hosted.
 *
 * Written down now, while it is cheap. Every item here is something that gets
 * discovered during an incident if it was not decided before one — and an
 * incident is the worst possible time to be working out who is allowed to
 * decide, or where the backups are, or how to reach a customer.
 */
export const OPERATIONAL_REQUIREMENTS: readonly OperationalRequirement[] = [
  {
    id: 'isolation_proven',
    what: 'A test that proves one hosted app cannot reach another’s database or network.',
    because:
      'It is the failure that ends the company rather than costing a weekend, and it is the one most likely to be assumed rather than checked.',
    blocksFirstCustomer: true,
  },
  {
    id: 'restore_tested',
    what: 'A backup that has actually been restored into a working app, by somebody, on purpose.',
    because: 'A backup nobody has restored is a hope. Finding out during a data loss is the expensive way.',
    blocksFirstCustomer: true,
  },
  {
    id: 'processing_agreement',
    what: 'A data processing agreement every customer accepts, naming what we do with their data and where.',
    because:
      'Their customers’ information is on our servers. Without this, the founder cannot lawfully use us for anything involving people in the UK or EU — and they will not know that.',
    blocksFirstCustomer: true,
  },
  {
    id: 'sub_processor_list',
    what: 'A published list of every company involved in running customer apps.',
    because: 'A founder has to be able to tell their own customers where their information is.',
    blocksFirstCustomer: true,
  },
  {
    id: 'acceptable_use',
    what: 'An acceptable use policy, and a way for anyone to report abuse.',
    because:
      'Phishing pages will be hosted here. Without a stated policy and a reported route, takedowns look arbitrary and the domain’s reputation suffers for everybody on it.',
    blocksFirstCustomer: true,
  },
  {
    id: 'abuse_appeal',
    what: 'A way for a founder whose app was removed to argue about it, with a person.',
    because:
      'Acting on incomplete information is unavoidable, so being wrong sometimes is unavoidable, and an unappealable removal of somebody’s live business is not defensible.',
    blocksFirstCustomer: true,
  },
  {
    id: 'spend_cap',
    what: 'A hard ceiling on what one project can consume, set before anything is hosted.',
    because: 'A runaway loop is charged to us first and recovered later, if at all.',
    blocksFirstCustomer: true,
  },
  {
    id: 'status_page',
    what: 'A public page saying whether the platform is up, updated by us rather than inferred.',
    because:
      'When we are down every customer asks at once, and the alternative to a status page is answering each of them individually while trying to fix it.',
    blocksFirstCustomer: true,
  },
  {
    id: 'incident_process',
    what: 'A written answer to "it is down, what now?" — who decides, who writes to customers, how fast.',
    because: 'Deciding during an incident produces slow decisions and inconsistent messages.',
    blocksFirstCustomer: true,
  },
  {
    id: 'breach_clock',
    what: 'A defined path for telling a customer their data may have been exposed, fast enough for them to meet their own deadline.',
    because:
      'Their obligation is measured in hours. Ours is to make theirs possible, and that cannot be improvised.',
    blocksFirstCustomer: true,
  },
  {
    id: 'export_on_demand',
    what: 'A way for a founder to take their code and database elsewhere without asking anybody.',
    because: 'Lock-in that exists because leaving is hard is lock-in either way. Better for it to be deliberate that it is easy.',
    blocksFirstCustomer: false,
  },
  {
    id: 'log_retention',
    what: 'A decision about how long request logs are kept and what is in them.',
    because:
      'Logs from customer apps contain their customers’ information. Keeping them forever by default is a data protection problem nobody chose.',
    blocksFirstCustomer: false,
  },
  {
    id: 'uptime_commitment',
    what: 'A stated availability target, or an explicit statement that there is none yet.',
    because:
      'Saying nothing is read as a promise. Saying "no guarantee while we are new" is honest and perfectly acceptable — silence is not.',
    blocksFirstCustomer: false,
  },
];

/** Nothing may be hosted for anybody until these exist. */
export function blockingRequirements(): OperationalRequirement[] {
  return OPERATIONAL_REQUIREMENTS.filter((entry) => entry.blocksFirstCustomer);
}

/**
 * Is Shipyard in a position to host somebody's app?
 *
 * Takes the ids that are genuinely done. Deliberately blunt: this either says
 * yes or lists what is missing, because "mostly ready" is how a hosting
 * business launches without a restore having ever been tested.
 */
export function readyToHost(completed: readonly string[]): {
  ready: boolean;
  missing: OperationalRequirement[];
  summary: string;
} {
  const done = new Set(completed);
  const missing = blockingRequirements().filter((entry) => !done.has(entry.id));

  return {
    ready: missing.length === 0,
    missing,
    summary:
      missing.length === 0
        ? 'Everything that has to exist before hosting somebody else’s app exists.'
        : `${missing.length} thing${missing.length === 1 ? '' : 's'} must exist before the first customer app is hosted: ${missing.map((entry) => entry.what).join(' ')}`,
  };
}
