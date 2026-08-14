import type { IntentFlag, TargetMode } from './production';

/**
 * What a project needs, decided from what the founder told us.
 *
 * The resolver's job is to turn "a booking site where customers pay a deposit"
 * into a list of things that must exist, each attached to the code that
 * provides it, the vendor behind it, the checks that prove it works, and the
 * paid help worth offering if it does not.
 *
 * Every answer carries its reason. A founder who is told their project needs
 * audit logging deserves to know it is because they said they hold personal
 * data — not because a machine said so.
 */

export type CapabilityStatus =
  /** Required at this mode. It will be built or installed. */
  | 'included'
  /** Worth having, and the project works without it. */
  | 'optional'
  /** Needed eventually, but not at this mode. Named so it is not a surprise later. */
  | 'deferred'
  /** Shipyard cannot do this. Said before development starts, not after. */
  | 'unsupported'
  /** Included, and a person has to sign off on how it is done. */
  | 'requires_human_review';

/** One thing a project can need. Catalog data, not code. */
export interface Capability {
  id: string;
  /** What the user reads. Never the id. */
  label: string;
  category:
    | 'foundation'
    | 'identity'
    | 'data'
    | 'money'
    | 'communication'
    | 'operations'
    | 'compliance';
  /** Required from this mode upwards, when nothing else triggers it. */
  requiredFrom?: TargetMode;
  /** Any of these facts being true pulls the capability in. */
  triggeredBy?: IntentFlag[];
  /** Facts that make it need a person's sign-off rather than just a test. */
  humanReviewWhen?: IntentFlag[];
  /** Components that provide it. */
  components?: string[];
  /** Agent skills that know how to work on it. */
  skills?: string[];
  /** Vendor ids, best first. */
  vendors?: string[];
  /** Integration recipes that set it up. */
  recipes?: string[];
  /** Environment variables it needs to exist. */
  env?: string[];
  /** The checks that prove it works. */
  gates?: string[];
  /** Paid help worth offering when it is incomplete. */
  serviceTriggers?: string[];
  /** False when Shipyard has no answer for this yet. */
  supported?: boolean;
  /** Shown when unsupported: what the user can do instead. */
  insteadUse?: string;
}

/** One capability, resolved against one project. */
export interface ResolvedCapability {
  capability: Capability;
  status: CapabilityStatus;
  /**
   * Why it came out this way, in the founder's terms. The plan requires the
   * resolver to be able to explain every choice, and an unexplained
   * requirement is one the user will either ignore or resent.
   */
  reason: string;
  /** The gates this contributes to the project's obligations. */
  gates: string[];
  components: string[];
  recipes: string[];
  /** The vendor we would use, when the capability names any. */
  vendor?: string;
}

export interface CapabilityPlan {
  resolved: ResolvedCapability[];
  /** Everything that will be built or installed. */
  included: ResolvedCapability[];
  /** Named now so they are not a surprise at pilot. */
  deferred: ResolvedCapability[];
  /**
   * Things this project needs that Shipyard cannot do. Surfaced before
   * development starts: finding out at launch is the expensive way.
   */
  unsupported: ResolvedCapability[];
  /** Every gate the capability graph obliges, deduplicated. */
  gates: string[];
  components: string[];
  recipes: string[];
  serviceTriggers: string[];
}

/** A service Shipyard can sell when the project needs a person. */
export interface ServiceOffer {
  id: string;
  name: string;
  /** What the user gets, concretely. */
  deliverable: string;
  priceMin: number;
  priceMax: number;
  /** `project` for one-off, `month` for the Operate plan. */
  priceUnit: 'project' | 'month';
  /**
   * What they could do instead, without paying. Shown next to the price: an
   * offer that hides the free path is an advert, and the plan is explicit that
   * this must read as guidance.
   */
  selfServiceAlternative: string;
  enabled: boolean;
}

/** A third party the project would depend on. */
export interface Vendor {
  id: string;
  name: string;
  capabilities: string[];
  preferred: boolean;
  /** `low` is a vendor we would let a first-time founder wire up alone. */
  setupComplexity: 'low' | 'medium' | 'high';
  riskLevel: 'low' | 'medium' | 'high';
  freeTier?: {
    available: boolean;
    /** Prose, not parsed. Limits change and a stale number is worse than none. */
    limits: string;
    /** What pushes a project onto a paid plan. */
    upgradeTrigger: string;
    /**
     * When a human last checked this against the vendor's own page. Required:
     * free-tier data without a date is a guess presented as a fact.
     */
    lastVerifiedAt: string;
    sourceUrl: string;
  };
  env?: string[];
  webhooks?: boolean;
  regions?: string[];
  /** Vendors we would move to if this one became unusable. */
  alternatives?: string[];
  enabled: boolean;
  notes?: string;
}
