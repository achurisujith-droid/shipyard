import type { TargetMode } from '@shipyard/shared';

/**
 * The address somebody gets, and the one they bring.
 *
 * Two things live here and the second is the interesting one.
 *
 * A **temporary link** — `something.shipyard.app` — so a founder can send their
 * work to someone within a minute of it existing. That is the whole appeal, and
 * it is also the part with a sharp edge: a link that can be sent is a link that
 * can be found, and most of what gets deployed early is a prototype full of
 * invented data with sign-in that does not really work.
 *
 * So what the temporary link *is* depends on how far the project has got. Below
 * a pilot it is not indexed, and it says on the page that it is not finished.
 * That is not a limitation to apologise for — it is the difference between
 * showing somebody your work and accidentally publishing it.
 *
 * A **custom domain** the founder already owns, once they are ready. Verifying
 * ownership before serving anything is not optional: without it, anybody could
 * point their DNS at us and have us serve a certificate for a name they do not
 * own.
 */

/** Names nobody may take, because they are ours or they mislead. */
const RESERVED = new Set([
  'www', 'app', 'api', 'admin', 'dashboard', 'docs', 'help', 'support', 'status',
  'blog', 'mail', 'email', 'smtp', 'ftp', 'ns', 'ns1', 'ns2', 'cdn', 'static',
  'assets', 'login', 'signin', 'signup', 'account', 'billing', 'pay', 'payment',
  'secure', 'security', 'shipyard', 'internal', 'test', 'staging', 'dev',
  // Anything that could be mistaken for us talking to the user.
  'official', 'verify', 'verification', 'update', 'alert',
]);

export const HOST_SUFFIX = 'shipyard.app';

/**
 * Turn a project name into a subdomain.
 *
 * A random suffix is added rather than left off, and that is a security choice
 * rather than a collision one. `acme-invoices.shipyard.app` is guessable, and a
 * prototype holding real customer data behind sign-in that "works" is exactly
 * the thing somebody should not be able to find by typing a company name.
 */
export function slugFor(
  projectName: string,
  random: () => string = () => Math.random().toString(36).slice(2, 8),
): string {
  const base = projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/, '');

  const safe = base.length >= 3 && !RESERVED.has(base) ? base : 'app';
  return `${safe}-${random()}`;
}

export function isReserved(subdomain: string): boolean {
  return RESERVED.has(subdomain.toLowerCase());
}

export function temporaryUrl(slug: string): string {
  return `https://${slug}.${HOST_SUFFIX}`;
}

/**
 * How a temporary link behaves, given how far the project has got.
 *
 * The founder is not asked. Somebody who has just built their first prototype
 * is in no position to weigh up search indexing, and the safe answer is
 * knowable from what they already told us.
 */
export interface LinkPolicy {
  /** Search engines are asked to stay away. */
  noIndex: boolean;
  /** A banner on the page saying what this is. */
  banner?: string;
  /** Anyone with the link can open it. */
  publiclyReachable: boolean;
  /** Why it is set up this way, for the screen. */
  because: string;
}

export function linkPolicy(mode: TargetMode): LinkPolicy {
  switch (mode) {
    case 'ui_concept':
    case 'functional_prototype':
      return {
        noIndex: true,
        banner: 'This is a work in progress, not a finished product. Some of what you see is made up.',
        publiclyReachable: true,
        because:
          'Anybody with the link can open it, so it is kept out of search results and says on the page that it is not finished. A prototype found by a stranger who thinks it is real is the thing to avoid.',
      };
    case 'customer_pilot':
      return {
        noIndex: true,
        publiclyReachable: true,
        because:
          'Real people are using this, so there is no banner. It stays out of search results until you put it on your own domain, because a temporary address is not where you want customers finding you.',
      };
    case 'production_product':
      return {
        noIndex: false,
        publiclyReachable: true,
        because: 'This is live. Search engines are allowed in.',
      };
  }
}

/* ------------------------------------------------------------- custom domains */

export type DomainState =
  /** They have told us the name; nothing is set up. */
  | 'awaiting_dns'
  /** The records are visible; we are issuing a certificate. */
  | 'verifying'
  /** Serving. */
  | 'live'
  /** The records were there and are not any more. */
  | 'broken';

export interface DnsRecord {
  type: 'CNAME' | 'TXT' | 'A';
  /** What goes in the "name" or "host" box at their registrar. */
  name: string;
  value: string;
  /** What this one is for, in their words. */
  purpose: string;
}

const DOMAIN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export function isValidDomain(input: string): boolean {
  const domain = input.trim().toLowerCase().replace(/\.$/, '');
  if (domain.length > 253 || !DOMAIN.test(domain)) return false;
  // A name under our own suffix is ours to hand out, not theirs to claim.
  if (domain === HOST_SUFFIX || domain.endsWith(`.${HOST_SUFFIX}`)) return false;
  return true;
}

/**
 * The records to add, written for somebody who has never seen a DNS panel.
 *
 * The TXT record is the one that matters and the one people skip. Without proof
 * of ownership, anybody could point `barclays.com` at us and have us obtain a
 * certificate for it — so it is not optional, and the explanation says why
 * rather than just insisting.
 */
export function dnsRecordsFor(domain: string, verificationToken: string): DnsRecord[] {
  const apex = domain.split('.').length === 2;
  return [
    {
      type: 'TXT',
      name: `_shipyard-verify.${domain}`,
      value: verificationToken,
      purpose:
        'Proves the domain is yours. Without it anybody could point a name they do not own at us, so nothing is served until this is visible.',
    },
    apex
      ? {
          type: 'A',
          name: domain,
          value: '76.76.21.21',
          purpose: 'Sends visitors of your domain to your app.',
        }
      : {
          type: 'CNAME',
          name: domain,
          value: `cname.${HOST_SUFFIX}`,
          purpose: 'Sends visitors of your domain to your app.',
        },
  ];
}

/** What we can honestly say about a domain, given what DNS currently shows. */
export function domainState(input: {
  verificationSeen: boolean;
  routingSeen: boolean;
  certificateIssued: boolean;
  wasLive?: boolean;
}): { state: DomainState; message: string } {
  if (input.certificateIssued && input.routingSeen) {
    return { state: 'live', message: 'Your domain is working.' };
  }
  if (input.wasLive && !input.routingSeen) {
    return {
      state: 'broken',
      message:
        'Your domain was working and the records are no longer there. Anyone visiting it is seeing an error. Check whether something changed at your registrar.',
    };
  }
  if (!input.verificationSeen) {
    return {
      state: 'awaiting_dns',
      message:
        'Waiting to see the records at your registrar. DNS changes can take a few minutes and occasionally a day — this is normal and there is nothing to fix while you wait.',
    };
  }
  if (!input.routingSeen) {
    return {
      state: 'awaiting_dns',
      message:
        'We can see the ownership record but not the one that sends visitors to your app. Check the second record was added.',
    };
  }
  return {
    state: 'verifying',
    message: 'Records found. Getting a security certificate for your domain — usually a minute or two.',
  };
}

/**
 * Should this project be on a custom domain yet?
 *
 * Not a refusal — it is their domain. But a prototype on a company's real
 * address is a different kind of mistake from a prototype on a temporary link,
 * and the difference is worth saying once.
 */
export function domainAdvice(mode: TargetMode): string | null {
  if (mode === 'ui_concept' || mode === 'functional_prototype') {
    return 'This is still a prototype, and some of it is made up. Putting it on your real address means anybody who visits your company name sees it. Most people wait until real customers are using it.';
  }
  return null;
}
