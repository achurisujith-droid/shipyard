import type { ComponentManifest, LibraryComponent } from '@shipyard/shared';

/**
 * The library, written into the project for the agent to read.
 *
 * The matcher runs once, when the project is created, and annotates PROJECT.md
 * with what the founder's opening description already covers. That is useful and
 * it is not enough: most requests arrive later. "Can we also let people upload a
 * spreadsheet?" turns up in message forty, which is exactly the moment the
 * library is most likely to have it and least likely to be consulted.
 *
 * So the catalogue goes on disk, next to the code, and a skill tells the agent
 * to read it before building anything substantial. That makes checking a habit
 * rather than an event.
 *
 * On disk rather than fetched, for the same reason everything else here is: it
 * has to work on a laptop with no connection, and code arriving over a network
 * to be written into somebody's project is a supply-chain surface this does not
 * have.
 *
 * Organised by **problem**, not by component name. An agent scanning for
 * "upload a CV" will not find `document_text_extract` by its id, and the id is
 * the least useful thing about it.
 */

const TIER_ORDER = { capability: 0, utility: 1 } as const;

function line(manifest: ComponentManifest, installed: boolean): string {
  const problems = (manifest.solves ?? []).slice(0, 4).join('; ');
  const state = installed ? ' **(already installed)**' : '';
  return `- **${manifest.name}** — \`${manifest.id}\`${state}\n  - ${manifest.summary}\n${
    problems ? `  - Use it when they ask to: ${problems}\n` : ''
  }${
    manifest.trust !== 'verified'
      ? `  - Not fully proven: ${manifest.limitations?.[0] ?? 'part of it needs a real account to confirm.'}\n`
      : ''
  }`;
}

export interface CatalogueOptions {
  /** Component ids already in this project. */
  installed?: readonly string[];
  /** Where a person can browse the same list. */
  url?: string;
  /** How many more are planned but do not exist. Stated, never listed. */
  planned?: number;
}

/** The whole catalogue as markdown, for `.shipyard/library.md`. */
export function catalogueMarkdown(
  components: readonly LibraryComponent[],
  options: CatalogueOptions = {},
): string {
  const installed = new Set(options.installed ?? []);
  const sorted = [...components].sort(
    (a, b) =>
      TIER_ORDER[a.manifest.tier ?? 'capability'] - TIER_ORDER[b.manifest.tier ?? 'capability'] ||
      a.manifest.name.localeCompare(b.manifest.name),
  );

  const capabilities = sorted.filter((entry) => (entry.manifest.tier ?? 'capability') === 'capability');
  const utilities = sorted.filter((entry) => entry.manifest.tier === 'utility');

  const out: string[] = [
    '# What is already built',
    '',
    '<!-- Written by Shipyard. Do not edit — it is regenerated whenever the',
    '     project changes, and anything you add here will be lost. -->',
    '',
    'These are tested components this project can install. **Check this list',
    'before writing anything that sounds like a job many products need.**',
    '',
    'Installing one is quicker and safer than building it. Each comes with tests',
    'that run inside this project, and those tests are part of what proves the',
    'app is safe to launch.',
    '',
    '## How to use this',
    '',
    'If something here covers what has been asked for, **say so rather than',
    'building your own**. Tell the owner which one, and that they can add it from',
    '"Ready-made parts" in Shipyard. Then get on with the part that is specific',
    'to their product.',
    '',
    'If nothing here covers it, build it — most of what any product needs is its',
    'own. Not finding something is the normal case.',
    '',
    'If one of these is genuinely wrong for this project, say which and why, then',
    'build your own. What is not acceptable is quietly writing a parallel version',
    'without mentioning that a tested one existed.',
    '',
    '## Things a product owes its users',
    '',
    'A missing one of these can stop a launch.',
    '',
    ...capabilities.map((entry) => line(entry.manifest, installed.has(entry.manifest.id))),
    '## Jobs of work',
    '',
    'A missing one of these just means somebody writes it by hand, worse.',
    '',
    ...utilities.map((entry) => line(entry.manifest, installed.has(entry.manifest.id))),
  ];

  if (installed.size > 0) {
    out.push(
      '## Already in this project',
      '',
      'Their files are listed in `.shipyard/protected.json` and named in',
      '`CLAUDE.md`. Do not edit inside them — the tests that come with a component',
      'are what make it trustworthy, and one you have rewritten is an untested',
      'component with a version number on it.',
      '',
      'If an installed component needs changing, change the code that calls it, or',
      'say that the component itself needs fixing.',
      '',
    );
  }

  if (options.planned) {
    out.push(
      '## Not built yet',
      '',
      `${options.planned} more are planned and **do not exist**. Do not suggest`,
      'installing something that is not on this page.',
      '',
    );
  }

  if (options.url) {
    out.push('---', '', `A person can browse the same list at ${options.url}.`, '');
  }

  return out.join('\n');
}

/** Where it goes in the project. */
export const CATALOGUE_FILE = '.shipyard/library.md';
