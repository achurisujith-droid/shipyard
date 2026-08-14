import type { TargetMode } from './production';

/**
 * Connectors: wiring a project up to somebody else's service.
 *
 * Shipyard does not hold accounts on anyone's behalf and does not create them.
 * The founder signs up, in their own name, with their own card, and owns the
 * result — which is the only arrangement where they can leave, and the only one
 * where a service being cut off is not Shipyard's decision to make.
 *
 * So a connector is not an integration. It is: **the instructions, the timing,
 * and the check.** What the founder has to go and do, when they should be asked
 * to do it, and how the project proves afterwards that it worked.
 *
 * Three rules hold everywhere in here.
 *
 * **Shipyard never sees the credential.** The key goes into the project's own
 * `.env`, which Shipyard treats as secret material and does not read. It writes
 * `.env.example` saying what is needed and stops there.
 *
 * **Shipyard therefore cannot verify the key itself.** It has no way to test a
 * secret it never receives. Verification is a check the *project* runs, and its
 * exit code is the evidence — which is stricter than Shipyard trying a key,
 * because it proves the app works rather than that a string is valid.
 *
 * **Nobody is ever asked for a password.** API keys that the founder can revoke,
 * never account credentials.
 */

/**
 * How long the founder has to wait after starting, before the thing is usable.
 *
 * This is the field the whole timing system turns on, and it is a property of
 * the vendor rather than of the code.
 */
export type LeadTime =
  /** Sign up and copy a key. Minutes. */
  | 'instant'
  /** Same day, but not same minute — an email to confirm, a review queue. */
  | 'short'
  /**
   * Days. Identity or business verification, DNS propagation, sending-domain
   * reputation. The ones that ruin a launch date if started on launch day.
   */
  | 'long';

/** Who does a step. */
export type StepActor =
  /** The founder, in a browser, on somebody else's website. */
  | 'founder'
  /** Shipyard, locally. */
  | 'shipyard'
  /** The coding agent, in the project. */
  | 'agent';

export interface RecipeStep {
  actor: StepActor;
  /** What to do, in the second person, plainly. */
  instruction: string;
  /** Where to do it. Shown as a link the founder can open. */
  url?: string;
  /**
   * The environment variable this step produces, when it produces one. Named so
   * the UI can tell the founder exactly what to paste and where.
   */
  produces?: string;
  /** Why this step exists, when it is not obvious. Skipped steps cause outages. */
  because?: string;
  /** True when getting this wrong is expensive rather than merely annoying. */
  critical?: boolean;
}

export interface Recipe {
  id: string;
  /** What the user reads. Never the id. */
  name: string;
  /** One sentence: what the project can do once this is done. */
  summary: string;
  vendorId: string;
  /** Capability ids this connects. */
  capabilities: string[];
  /** Components that should be installed first, if any. */
  requiresComponents?: string[];
  leadTime: LeadTime;
  /**
   * The mode at which this stops being optional. Used with `leadTime` to work
   * out when to ask rather than when it is due.
   */
  requiredFrom?: TargetMode;
  steps: RecipeStep[];
  /** Variables the founder ends up with in their own `.env`. */
  secrets: string[];
  /** Non-secret settings, which may carry a sensible default. */
  settings?: { name: string; description: string; example?: string }[];
  /**
   * The check that proves it works, run in the project. A recipe with no check
   * is a set of instructions nobody can confirm was followed.
   */
  verifiedBy: string;
  /** What it costs, honestly. Free tiers are read from the vendor entry. */
  costNote?: string;
  /** Things this connector does not do. */
  limitations?: string[];
}

/** When the founder should be asked to go and do this. */
export type AskWhen =
  /** Now — the wait is long enough that starting late is what causes the delay. */
  | 'now'
  /** When the capability it serves is first built. */
  | 'at_build'
  /** Before real people are let in. */
  | 'before_pilot'
  /** Not yet, and here is when it will come up. */
  | 'later'
  /** Never for this project — nothing needs it. */
  | 'not_needed';

export interface SetupPrompt {
  recipeId: string;
  name: string;
  when: AskWhen;
  /**
   * Why now, in the founder's words. The sentence that stops "set up Stripe"
   * reading as busywork.
   */
  reason: string;
  /** How long it will take them, honestly hedged. */
  effort: string;
  /** True when this is on the critical path to their launch date. */
  blocksLaunch: boolean;
}

/** What Shipyard can honestly say about a connection. */
export type ConnectionState =
  /** Nobody has started. */
  | 'not_started'
  /** The founder said they have done it; nothing has confirmed it. */
  | 'claimed'
  /** The project's own check ran and passed. This is the only one that counts. */
  | 'working'
  /** The check ran and failed. */
  | 'broken';

export interface ConnectionStatus {
  recipeId: string;
  state: ConnectionState;
  /** Which variables the project's `.env.example` names but `.env` may not set. */
  missingSettings: string[];
  /** The verification run that last judged it. */
  lastCheckedAt?: string;
  /** In the founder's words. */
  summary: string;
}

/** One step the founder does themselves, numbered for a screen. */
export interface FounderStep {
  number: number;
  instruction: string;
  url?: string;
  /** Why it matters. Present on anything marked critical. */
  because?: string;
  /** The variable this step gives them, so the screen can say where it goes. */
  produces?: string;
  critical: boolean;
}
