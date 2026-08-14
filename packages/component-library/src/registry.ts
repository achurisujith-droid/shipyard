import type {
  CapabilityPlan,
  ComponentManifest,
  LibraryComponent,
  LibraryEntry,
  TrustLevel,
} from '@shipyard/shared';

export type { LibraryEntry };

/**
 * Browsing the library.
 *
 * The founder using this does not know what "RBAC" is called. They know they
 * want "only my staff should see the bookings". So search reads the summary,
 * the keywords and the capability labels, not just the id — and the list is
 * ordered by what their project actually needs, because a library sorted
 * alphabetically is a catalogue and a library sorted by relevance is help.
 */

export interface BrowseOptions {
  /** What the project needs, from the capability resolver. */
  plan?: Pick<CapabilityPlan, 'included' | 'deferred'>;
  /** Components already installed, id → version. */
  installed?: Record<string, string>;
  /** Free text from the search box. */
  search?: string;
  category?: ComponentManifest['category'];
  /** Hide anything below this level of assurance. */
  minimumTrust?: TrustLevel;
}

const TRUST_ORDER: Record<TrustLevel, number> = {
  experimental: 0,
  provisional: 1,
  verified: 2,
};

const RELEVANCE_ORDER: Record<LibraryEntry['relevance'], number> = {
  needed: 0,
  suggested: 1,
  available: 2,
};

/** Split a search phrase into terms, ignoring punctuation and noise words. */
function terms(search: string): string[] {
  return search
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 2);
}

function haystack(manifest: ComponentManifest): string {
  return [
    manifest.id,
    manifest.name,
    manifest.summary,
    manifest.category,
    ...(manifest.keywords ?? []),
    ...(manifest.provides ?? []),
  ]
    .join(' ')
    .toLowerCase();
}

/** Compare two semver strings. Returns a negative number when `a` is older. */
export function compareVersions(a: string, b: string): number {
  const parse = (version: string): [number, number, number] => {
    const parts = (version.split('-')[0] ?? '').split('.');
    const at = (index: number) => Number.parseInt(parts[index] ?? '0', 10) || 0;
    return [at(0), at(1), at(2)];
  };
  const [aMajor, aMinor, aPatch] = parse(a);
  const [bMajor, bMinor, bPatch] = parse(b);
  return aMajor - bMajor || aMinor - bMinor || aPatch - bPatch;
}

/**
 * The library, as a list to show someone.
 *
 * Relevance comes from the capability plan rather than from popularity: the
 * project was told it needs "somewhere for people to sign in", and this is the
 * code that provides it. That link is the entire argument for having a library
 * instead of a folder of examples.
 */
export function browse(
  components: readonly LibraryComponent[],
  options: BrowseOptions = {},
): LibraryEntry[] {
  const installed = options.installed ?? {};

  // capability id → the reason the resolver gave for including it.
  const needed = new Map<string, string>();
  const suggested = new Map<string, string>();
  for (const resolved of options.plan?.included ?? []) {
    for (const componentId of resolved.components) needed.set(componentId, resolved.reason);
  }
  for (const resolved of options.plan?.deferred ?? []) {
    for (const componentId of resolved.components) {
      if (!needed.has(componentId)) suggested.set(componentId, resolved.reason);
    }
  }

  const wanted = options.search ? terms(options.search) : [];

  const entries = components
    .map(({ manifest }): LibraryEntry => {
      const relevance = needed.has(manifest.id)
        ? 'needed'
        : suggested.has(manifest.id)
          ? 'suggested'
          : 'available';
      const installedVersion = installed[manifest.id];
      return {
        manifest,
        relevance,
        reason: needed.get(manifest.id) ?? suggested.get(manifest.id) ?? '',
        installed: Boolean(installedVersion),
        updateAvailable:
          installedVersion && compareVersions(installedVersion, manifest.version) < 0
            ? manifest.version
            : undefined,
      };
    })
    .filter((entry) => {
      if (options.category && entry.manifest.category !== options.category) return false;
      if (
        options.minimumTrust &&
        TRUST_ORDER[entry.manifest.trust] < TRUST_ORDER[options.minimumTrust]
      ) {
        return false;
      }
      if (wanted.length === 0) return true;
      const text = haystack(entry.manifest);
      // Every term has to appear. Two words should narrow the list, not widen it.
      return wanted.every((term) => text.includes(term));
    });

  return entries.sort(
    (a, b) =>
      RELEVANCE_ORDER[a.relevance] - RELEVANCE_ORDER[b.relevance] ||
      TRUST_ORDER[b.manifest.trust] - TRUST_ORDER[a.manifest.trust] ||
      a.manifest.name.localeCompare(b.manifest.name),
  );
}

/**
 * How much of what this project needs the library already covers.
 *
 * The plan's own scope test is "the library covers at least half the
 * foundation". This is the number that answers it, and it is worth showing to
 * the founder before they start rather than discovering it at week six.
 */
export function coverage(
  components: readonly LibraryComponent[],
  plan: Pick<CapabilityPlan, 'included'>,
): { covered: string[]; uncovered: string[]; percent: number } {
  const have = new Set(components.map((component) => component.manifest.id));
  const covered: string[] = [];
  const uncovered: string[] = [];

  for (const resolved of plan.included) {
    // A capability with no components is not something the library could have
    // covered — counting it either way would make the number a fiction.
    if (resolved.components.length === 0) continue;
    if (resolved.components.some((id) => have.has(id))) covered.push(resolved.capability.id);
    else uncovered.push(resolved.capability.id);
  }

  const total = covered.length + uncovered.length;
  return {
    covered,
    uncovered,
    percent: total === 0 ? 0 : Math.round((covered.length / total) * 100),
  };
}

/** Find one component, or say so. */
export function find(
  components: readonly LibraryComponent[],
  id: string,
): LibraryComponent | undefined {
  return components.find((component) => component.manifest.id === id);
}
