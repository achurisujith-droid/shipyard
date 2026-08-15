import type { ComponentManifest, LibraryComponent } from '@shipyard/shared';

/**
 * Reading what somebody wants, and noticing we already have it.
 *
 * A library nobody searches is a library nobody uses. The founder writes "let
 * candidates upload their CV and pull the text out of it" into a requirements
 * document, and unless something connects that sentence to the two components
 * that do exactly it, an agent will spend an afternoon writing a worse version
 * — and the founder will never know that happened.
 *
 * So this reads their words rather than expecting them to read ours. Three
 * things follow from that.
 *
 * **It matches on problems, not names.** Components declare `solves` — the
 * sentences a founder would actually write. Nobody searching for a way to read
 * a CV types "docx text extract".
 *
 * **It is deliberately conservative about confidence.** A weak match is offered
 * as "you might mean this", never asserted. A matcher that confidently proposes
 * the wrong component teaches people to ignore it, and then the strong matches
 * get ignored too.
 *
 * **It never decides.** The output is a suggestion with a reason attached. The
 * founder, or the agent, chooses — because a library that installs things on
 * its own reading of a sentence is a library that surprises people.
 *
 * There is no model call here and no network. This runs on a laptop, offline,
 * in a few milliseconds, over text the user typed.
 */

export interface Match {
  componentId: string;
  name: string;
  summary: string;
  tier: 'capability' | 'utility';
  /** 0–1. See `confidenceOf` for what the bands mean. */
  score: number;
  confidence: 'strong' | 'likely' | 'possible';
  /**
   * The phrase in their requirements that caused this, quoted back. Being able
   * to point at the sentence is what makes a suggestion arguable rather than
   * magic.
   */
  because: string[];
  /** Already in the project. Still worth showing, so it is not built twice. */
  installed: boolean;
}

/** Words that carry no meaning for matching and would otherwise dominate. */
const NOISE = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'with', 'from', 'into', 'that', 'this', 'they',
  'them', 'their', 'there', 'then', 'than', 'have', 'has', 'had', 'will', 'would', 'should',
  'could', 'can', 'able', 'need', 'needs', 'needed', 'want', 'wants', 'wanted', 'like', 'when',
  'where', 'what', 'which', 'who', 'how', 'all', 'any', 'some', 'each', 'every', 'our', 'your',
  'you', 'user', 'users', 'app', 'application', 'system', 'page', 'screen', 'able', 'also',
  'must', 'shall', 'may', 'been', 'being', 'are', 'was', 'were', 'its', 'it', 'as', 'at', 'by',
  'in', 'of', 'on', 'to', 'up', 'we', 'be', 'is', 'do', 'does', 'my', 'me',
]);

/**
 * Reduce a word to something that matches its relatives.
 *
 * Not a real stemmer — a handful of suffix rules. "uploads", "uploading" and
 * "uploaded" all have to reach "upload", and a founder writing requirements
 * uses whichever form the sentence wants.
 */
export function stem(word: string): string {
  let out = word.toLowerCase();
  if (out.length <= 3) return out;
  for (const [suffix, minimum] of [
    ['ing', 5],
    ['ed', 4],
    ['es', 4],
    ['s', 4],
  ] as const) {
    if (out.endsWith(suffix) && out.length >= minimum) {
      out = out.slice(0, -suffix.length);
      break;
    }
  }
  // "uploadd" -> "upload", "generatt" -> "generat"
  return out.replace(/([a-z])\1$/, '$1');
}

export function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !NOISE.has(word))
    .map(stem);
}

/** Overlap between a requirement sentence and one of a component's problems. */
function overlap(requirement: Set<string>, phrase: string): number {
  const words = tokenise(phrase);
  if (words.length === 0) return 0;
  const hits = words.filter((word) => requirement.has(word)).length;
  // Divided by the phrase length, so a short precise phrase matching fully
  // beats a long vague one matching partly.
  return hits / words.length;
}

/**
 * Split requirements into the units people actually write them in.
 *
 * Sentences and bullet points, because a requirements document is a list of
 * intentions and matching the whole document at once turns every component into
 * a weak match for everything.
 */
export function requirementLines(text: string): string[] {
  return text
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map((line) => line.replace(/^\s*[-*•\d.)\]]+\s*/, '').trim())
    .filter((line) => line.length > 8);
}

function confidenceOf(score: number): Match['confidence'] {
  if (score >= 0.7) return 'strong';
  if (score >= 0.45) return 'likely';
  return 'possible';
}

export interface MatchOptions {
  /** Component ids already installed. */
  installed?: readonly string[];
  /** Below this, a match is not worth showing at all. */
  floor?: number;
  /** How many to return. */
  limit?: number;
}

/**
 * What in this library answers what they asked for.
 *
 * Scored per requirement line, then the best line for each component wins.
 * Taking the best rather than the sum matters: a component that weakly matches
 * forty lines is not a better answer than one that exactly matches a single
 * sentence, and summing would say otherwise.
 */
export function matchRequirements(
  text: string,
  components: readonly LibraryComponent[],
  options: MatchOptions = {},
): Match[] {
  const floor = options.floor ?? 0.4;
  const installed = new Set(options.installed ?? []);
  const lines = requirementLines(text);
  if (lines.length === 0) return [];

  const best = new Map<string, { score: number; because: string[]; manifest: ComponentManifest }>();

  for (const line of lines) {
    const words = new Set(tokenise(line));
    if (words.size === 0) continue;

    for (const { manifest } of components) {
      // What the component says it solves is the only thing that can make it a
      // candidate.
      let lineScore = 0;
      for (const phrase of manifest.solves ?? []) {
        const raw = overlap(words, phrase);
        if (raw > lineScore) lineScore = raw;
      }

      /**
       * Keywords are deliberately not consulted here.
       *
       * They were, and it was wrong. Scoring them made "pdf" match the document
       * *reader* in a sentence about generating a receipt, and "data" match the
       * database in a sentence about training a language model. A single word is
       * a coincidence often enough that treating one as evidence produces
       * confident nonsense — and a matcher that is confidently wrong stops being
       * read at all, including when it is right.
       *
       * So keywords serve the search box, where a person is looking and can
       * judge, and `solves` serves the matcher, where nobody is. When a real
       * phrasing is missed, the fix is to add that sentence to the manifest —
       * which is a change somebody can review, unlike a scoring weight.
       */
      if (lineScore < floor) continue;
      const existing = best.get(manifest.id);
      if (!existing || lineScore > existing.score) {
        best.set(manifest.id, { score: lineScore, because: [line], manifest });
      } else if (Math.abs(lineScore - existing.score) < 0.001 && existing.because.length < 3) {
        existing.because.push(line);
      }
    }
  }

  return [...best.values()]
    .map(({ score, because, manifest }): Match => ({
      componentId: manifest.id,
      name: manifest.name,
      summary: manifest.summary,
      tier: manifest.tier ?? 'capability',
      score: Math.round(score * 100) / 100,
      confidence: confidenceOf(score),
      because,
      installed: installed.has(manifest.id),
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, options.limit ?? 12);
}

/**
 * The sentence to put in front of the founder.
 *
 * Hedged in proportion to the score, on purpose. "This is already built" and
 * "you might mean this" are different claims, and a matcher that makes the
 * second sound like the first stops being believed for either.
 */
export function explain(match: Match): string {
  const quote = match.because[0] ?? '';
  const shortened = quote.length > 90 ? `${quote.slice(0, 90)}…` : quote;

  if (match.installed) {
    return `You already have "${match.name}" installed, which covers “${shortened}”.`;
  }
  switch (match.confidence) {
    case 'strong':
      return `“${shortened}” is already built — "${match.name}" does exactly this.`;
    case 'likely':
      return `“${shortened}” looks like something "${match.name}" already does.`;
    case 'possible':
      return `“${shortened}” might be covered by "${match.name}". Worth a look before building it.`;
  }
}

/**
 * The paragraph the agent is given.
 *
 * This is where matching turns into saved work. Without it the founder's
 * requirements reach the agent unannotated, and the agent writes its own
 * version of something that is sitting in the library with tests around it.
 *
 * Only strong and likely matches are named. A "possible" match presented to an
 * agent as an instruction is how the wrong component gets installed, and the
 * agent has no way to tell that the suggestion was hedged.
 */
export function briefForAgent(matches: readonly Match[]): string {
  const worth = matches.filter(
    (match) => !match.installed && (match.confidence === 'strong' || match.confidence === 'likely'),
  );
  if (worth.length === 0) return '';

  return [
    'Some of what has been asked for is already built and tested in the Shipyard',
    'library. Do not write these from scratch — tell the owner to install them',
    'from the ready-made parts list, and carry on with the rest.',
    '',
    ...worth.map((match) => `- **${match.name}** — ${match.summary}`),
    '',
    'If one of them is genuinely wrong for what is being asked, say which and why',
    'rather than quietly building your own.',
  ].join('\n');
}

/**
 * What was asked for and nothing in the library answers.
 *
 * The more useful half of the report over time. Requirements that keep coming
 * back with no match are the list of components worth building next, taken from
 * what people actually asked for rather than from what seemed like a good idea.
 */
export function unmatched(text: string, matches: readonly Match[]): string[] {
  const explained = new Set(matches.flatMap((match) => match.because));
  return requirementLines(text).filter((line) => !explained.has(line));
}
