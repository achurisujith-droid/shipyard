/**
 * The component library: reusable code with a warranty attached.
 *
 * The claim Shipyard makes is that a founder gets further by installing proven
 * pieces than by asking an agent to invent them. That claim is only worth
 * anything if a "component" is more than a folder of files somebody liked. So a
 * component carries four things a snippet does not:
 *
 *   - **Provenance.** Where the code came from and under what licence. Vendored
 *     code with no licence record is a legal problem handed to a founder who has
 *     no way to notice it. Every component names its origin, and the licence
 *     scanner reads this rather than guessing from file headers.
 *   - **A contract.** Tests that come with the component and are run after it is
 *     installed, in the project it was installed into. This is what makes
 *     `component_contract_tests_pass` mean something.
 *   - **Protected paths.** The parts the agent must not rewrite. A verified
 *     component that gets casually regenerated is an unverified component with a
 *     version number.
 *   - **Extension points.** The parts it is *meant* to edit. Without these,
 *     "protected" reads as "do not touch this feature", which is not the
 *     intention and would make the library useless.
 */

/**
 * How much Shipyard is willing to vouch for a component.
 *
 * The distinction that matters is not how good the code looks, it is whether
 * anything ran. `verified` means the contract tests were executed against a
 * real install and passed; nothing else earns it.
 */
export type TrustLevel =
  /** Contract tests run against a real install of the starter template and pass. */
  | 'verified'
  /** Installs and typechecks; the contract has not been proven end to end. */
  | 'provisional'
  /** Here to be looked at. Never installed without the user being told. */
  | 'experimental';

/** Where the code came from. Required — there is no "unknown" option. */
export interface Provenance {
  /**
   * `authored` — written for Shipyard.
   * `adapted` — an existing implementation reshaped for the starter stack.
   * `vendored` — copied substantially unchanged.
   */
  origin: 'authored' | 'adapted' | 'vendored';
  /** The project it came from, in words. Empty only when `origin` is `authored`. */
  source?: string;
  sourceUrl?: string;
  /** SPDX identifier. `UNLICENSED` is a valid answer and blocks distribution. */
  license: string;
  licenseUrl?: string;
  /** Set when the upstream licence requires the notice to travel with the code. */
  noticeRequired?: boolean;
  /** What was changed, for anyone comparing against upstream. */
  changes?: string;
  /** ISO date the adaptation was made, so drift from upstream is visible. */
  adaptedAt?: string;
}

/** What a file is for, which decides whether the agent may rewrite it. */
export type FileRole =
  /** The component's implementation. Protected. */
  | 'source'
  /** Wired up for you and expected to be edited. */
  | 'example'
  /** The contract. Protected — a test you may edit is not a test. */
  | 'test'
  /** Prisma schema fragment, merged into the project's schema. */
  | 'schema'
  /** Config the installer merges rather than copies. */
  | 'config'
  /** Documentation for the founder. */
  | 'doc';

export interface ComponentFile {
  /** Path inside the component directory. */
  from: string;
  /** Path inside the target project. */
  to: string;
  role: FileRole;
  /**
   * When true, an existing file at `to` is left alone rather than overwritten.
   * Used for files a project is expected to already have its own version of.
   */
  skipIfExists?: boolean;
}

/** A Prisma model the component needs, merged into the project schema. */
export interface SchemaFragment {
  /** Model names this fragment declares, used to detect collisions. */
  models: string[];
  /** Enum names it declares. */
  enums?: string[];
  /** Path inside the component directory holding the Prisma source. */
  file: string;
}

/** An environment variable the component needs. */
export interface ComponentEnv {
  name: string;
  /** What it is, in a sentence a non-programmer can act on. */
  description: string;
  /** Where to get it. */
  obtainFrom?: string;
  required: boolean;
  /**
   * True when the value is a credential. Written to `.env.example` as a
   * placeholder and never to anything Shipyard transmits.
   */
  secret: boolean;
  /** A safe default for local development, when one exists. */
  devDefault?: string;
}

/** Somewhere the project is meant to write its own code. */
export interface ExtensionPoint {
  /** Path in the target project. */
  path: string;
  /** What belongs here, in the founder's words. */
  description: string;
}

export interface ComponentManifest {
  id: string;
  /** What the user reads. Never the id. */
  name: string;
  /** One sentence, plain language, no jargon. Shown in the library list. */
  summary: string;
  /** Semver. Installs are recorded with it so upgrades are a diff, not a guess. */
  version: string;
  category:
    | 'foundation'
    | 'identity'
    | 'data'
    | 'money'
    | 'communication'
    | 'operations'
    | 'compliance';
  trust: TrustLevel;
  provenance: Provenance;

  /** The stack this component is written against. */
  stack: {
    framework: 'nextjs';
    orm?: 'prisma';
    database?: 'postgresql';
  };

  /** Capability ids from the catalog that this component provides. */
  provides: string[];
  /** Gate ids this component's contract tests are able to satisfy. */
  satisfies: string[];
  /** Other component ids that must be installed first. */
  requires?: string[];
  /** Component ids that solve the same problem a different way. */
  conflictsWith?: string[];

  files: ComponentFile[];
  schema?: SchemaFragment;
  env?: ComponentEnv[];
  /** Runtime dependencies to add to the project's package.json. */
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  /** Scripts to add. An existing script of the same name is never replaced. */
  scripts?: Record<string, string>;

  /**
   * Paths the agent must not rewrite once installed, as globs relative to the
   * project root. Derived from `source` and `test` files at load time, so a
   * manifest cannot forget to protect its own implementation.
   */
  protectedPaths?: string[];
  extensionPoints?: ExtensionPoint[];

  /**
   * The command that proves the component still works, run in the project after
   * install. A component with no contract cannot be `verified`.
   */
  contractTest?: {
    command: string;
    /** Roughly how long it takes, so the UI can say something truthful. */
    expect?: 'fast' | 'slow';
  };

  /** What to tell the founder after installing. Steps only they can do. */
  postInstall?: string[];
  /** Things this component deliberately does not do. */
  limitations?: string[];
  /** Free-text search terms, in the words a founder would use. */
  keywords?: string[];

  /**
   * Problems this solves, written the way a founder would describe them in
   * their own requirements.
   *
   * Not keywords and not a summary. These are the sentences somebody actually
   * writes — "let candidates upload their CV", "email a receipt after payment"
   * — and they are what the matcher reads. The distinction matters: a founder
   * writing their requirements never uses the word "component", and rarely uses
   * the word the component is named after.
   */
  solves?: string[];

  /**
   * The tier this belongs to.
   *
   * `capability` components answer an obligation the rulebook knows about —
   * signing in, keeping customers apart. `utility` components are jobs of work
   * — reading a PDF, generating an invoice. Both are installed the same way;
   * the difference is that a missing capability blocks a launch and a missing
   * utility just means somebody writes it by hand.
   */
  tier?: 'capability' | 'utility';
}

/** A manifest plus where it was loaded from. */
export interface LibraryComponent {
  manifest: ComponentManifest;
  /** Absolute path to the component directory. */
  directory: string;
}

/** One component's install, as recorded against a project. */
export interface ComponentInstallation {
  componentId: string;
  version: string;
  installedAt: string;
  /** Files actually written, so an uninstall is not guesswork. */
  files: string[];
  protectedPaths: string[];
  /** The verification run that judged the contract, once one exists. */
  contractRunId?: string;
  status: 'installed' | 'contract_failed' | 'removed';
}

/**
 * One row in the library list, as the UI receives it.
 *
 * Lives here rather than in the library package because it crosses the IPC
 * boundary, and the renderer may only depend on the shared contract.
 */
export interface LibraryEntry {
  manifest: ComponentManifest;
  /**
   * `needed` — the project's capability plan asks for it.
   * `suggested` — it fits the project but nothing requires it.
   * `available` — everything else.
   */
  relevance: 'needed' | 'suggested' | 'available';
  /** Why it is being shown, in the founder's words. Empty for `available`. */
  reason: string;
  installed: boolean;
  /** Set when an older version is installed. */
  updateAvailable?: string;
}

/** Something the installer refuses to do, and why. */
export interface InstallConflict {
  kind:
    | 'already_installed'
    | 'missing_requirement'
    | 'conflicting_component'
    | 'file_exists'
    | 'schema_model_exists'
    | 'dependency_version_clash'
    | 'protected_path_overlap'
    | 'not_installable';
  /** Plain language, addressed to the founder. */
  message: string;
  detail?: string;
  /** False when the user can reasonably choose to go ahead anyway. */
  blocking: boolean;
}

/** What an install would do, computed before anything is written. */
export interface ComponentInstallPlan {
  componentId: string;
  version: string;
  /** Components pulled in to satisfy `requires`, in install order. */
  order: string[];
  /** Files that would be created. */
  creates: string[];
  /** Files that already exist and would be left alone. */
  skips: string[];
  /** Dependencies that would be added to package.json. */
  addsDependencies: Record<string, string>;
  /** Prisma models that would be added to the schema. */
  addsModels: string[];
  /** Environment variables the founder will have to supply. */
  needsEnv: ComponentEnv[];
  /** Paths that become off-limits to the agent. */
  protects: string[];
  conflicts: InstallConflict[];
  /** True when nothing blocking stands in the way. */
  installable: boolean;
}

/**
 * What taking a component back out would do.
 *
 * Two things are deliberately not undone, and both are named here rather than
 * left for someone to discover: the database tables stay (dropping one takes
 * the data in it), and the npm packages stay (something else may have started
 * using them).
 */
export interface RemovalPlan {
  componentId: string;
  version: string;
  removes: string[];
  /** Edited since installation, so kept rather than deleted. */
  modified: string[];
  /** Tables whose declaration goes and whose data does not. */
  orphanedTables: string[];
  keptDependencies: string[];
  problems: string[];
  removable: boolean;
}

export interface RemovalResult {
  componentId: string;
  removed: boolean;
  filesRemoved: string[];
  filesKept: string[];
  /** Things the user should know, in their words. */
  notes: string[];
  errors: string[];
}

/** What moving an installed component to a newer version would do. */
export interface UpgradePlan {
  componentId: string;
  from: string;
  to: string;
  replaces: string[];
  adds: string[];
  drops: string[];
  /** Customised examples, left exactly as they are. */
  leaves: string[];
  addsTables: string[];
  orphanedTables: string[];
  /**
   * Edited files standing in the way. An upgrade that silently overwrote one
   * would take away work somebody meant to do, weeks before they noticed.
   */
  blockedBy: string[];
  problems: string[];
  upgradable: boolean;
}

export interface UpgradeResult {
  componentId: string;
  from: string;
  to: string;
  upgraded: boolean;
  filesWritten: string[];
  notes: string[];
  errors: string[];
}

/** The outcome of applying a plan. */
export interface ComponentInstallResult {
  componentId: string;
  version: string;
  installed: boolean;
  filesWritten: string[];
  /** Steps for the founder — API keys to fetch, decisions to make. */
  nextSteps: string[];
  /** The contract test to run, for the verification runner to pick up. */
  contractCommand?: string;
  errors: string[];
}
