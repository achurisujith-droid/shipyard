import type { TargetMode } from '@shipyard/shared';

/**
 * What a deployment is, and what each stage of it honestly claims.
 *
 * The whole risk of a deploy button is one sentence — "it's live" — collapsing
 * three separate facts. The files reaching a server, the address answering, and
 * a person being able to do the thing the app is for are different claims, and
 * only the first is true when a build finishes.
 *
 * A founder who sends a link at the wrong moment gets a white page in front of
 * whoever they were trying to impress. So the link is not handed over until
 * something has actually loaded.
 */

export type DeploymentState =
  /** Accepted, nothing started. */
  | 'queued'
  /** Installing and building on our side. */
  | 'building'
  /** Built, starting up. */
  | 'starting'
  /** Started, and the address answered. */
  | 'live'
  /** The build failed. Their code, usually. */
  | 'build_failed'
  /** It built and would not stay up. */
  | 'crashed'
  /** Replaced by a newer one. */
  | 'superseded';

export interface Deployment {
  id: string;
  projectId: string;
  state: DeploymentState;
  /** Only ever set once the address has answered. */
  url?: string;
  startedAt: string;
  finishedAt?: string;
  /** The last lines of the build, when it failed. Never the whole log. */
  failureOutput?: string;
  /** Which commit or snapshot this was. */
  sourceHash?: string;
}

/**
 * What the founder is told at each stage.
 *
 * `building` deliberately gives no link. It is the moment they most want one,
 * and it is the moment a link is most likely to show a white page.
 */
export function describeState(state: DeploymentState, mode: TargetMode): {
  headline: string;
  detail: string;
  linkSafeToShare: boolean;
} {
  switch (state) {
    case 'queued':
      return {
        headline: 'Waiting to start',
        detail: 'Your app is in the queue. This is usually a few seconds.',
        linkSafeToShare: false,
      };
    case 'building':
      return {
        headline: 'Building your app',
        detail:
          'Installing what it needs and building it, the same way the server will run it. This takes a minute or two the first time.',
        linkSafeToShare: false,
      };
    case 'starting':
      return {
        headline: 'Starting it up',
        detail: 'It built. Waiting for it to answer before giving you the link.',
        linkSafeToShare: false,
      };
    case 'live':
      return {
        headline: 'It is live',
        detail:
          mode === 'ui_concept' || mode === 'functional_prototype'
            ? 'Anyone with the link can open it. It is kept out of search results and says on the page that it is not finished.'
            : 'Anyone with the link can open it.',
        linkSafeToShare: true,
      };
    case 'build_failed':
      return {
        headline: 'It did not build',
        detail:
          'Something in the code stopped it building. This is the same build that runs on your computer, so the error will be reproducible there.',
        linkSafeToShare: false,
      };
    case 'crashed':
      return {
        headline: 'It built but would not stay running',
        detail:
          'It started and stopped again. The usual cause is a missing setting — the live app has none of your .env until you add them here.',
        linkSafeToShare: false,
      };
    case 'superseded':
      return {
        headline: 'Replaced by a newer version',
        detail: 'A later deploy took over. This one is kept so you can go back to it.',
        linkSafeToShare: false,
      };
  }
}

/** Deploys that are finished, one way or another. */
export function isFinished(state: DeploymentState): boolean {
  return state === 'live' || state === 'build_failed' || state === 'crashed' || state === 'superseded';
}

/**
 * The states a deploy may move between.
 *
 * Written down because the one that matters is the absence of an edge: nothing
 * reaches `live` without passing through `starting`, and `starting` is only left
 * when the address has actually answered. There is no path from "the build
 * finished" straight to "it is live".
 */
const TRANSITIONS: Record<DeploymentState, DeploymentState[]> = {
  queued: ['building', 'build_failed'],
  building: ['starting', 'build_failed'],
  starting: ['live', 'crashed'],
  live: ['superseded', 'crashed'],
  build_failed: ['superseded'],
  crashed: ['superseded'],
  superseded: [],
};

export function canMove(from: DeploymentState, to: DeploymentState): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * What still has to be true before real people use this.
 *
 * A deployment being live is not the same as a project being ready, and the two
 * are easy to conflate the moment there is a working URL. Readiness is scored
 * separately, from evidence; this only says what hosting itself settles.
 */
export function hostingProves(): { settled: string[]; notSettled: string[] } {
  return {
    settled: [
      'The code builds the way a server builds it.',
      'The address answers.',
      'It has the settings you gave it here.',
    ],
    notSettled: [
      'That anyone can actually complete the thing your app is for.',
      'That the parts talking to other services work — nothing on the internet could reach your computer while you were building.',
      'That it stays up with more than one person using it.',
      'That your data is backed up.',
    ],
  };
}

/**
 * Settings the live app needs, as names.
 *
 * Values arrive from the founder typing them here, never from reading `.env` on
 * their machine. That file is theirs, and Shipyard's not reading it is the same
 * promise whether or not we are also hosting.
 */
export interface HostedSetting {
  name: string;
  /** True once a value exists on our side. The value itself is never returned. */
  provided: boolean;
  secret: boolean;
  /** Where it came from, in their words. */
  description?: string;
}

export function missingSettings(settings: readonly HostedSetting[]): string[] {
  return settings.filter((setting) => !setting.provided).map((setting) => setting.name);
}

/** Can this be deployed at all? */
export function readyToDeploy(input: {
  bundleOk: boolean;
  settings: readonly HostedSetting[];
  buildPasses: boolean;
}): { ready: boolean; reason?: string } {
  if (!input.bundleOk) {
    return { ready: false, reason: 'Some of what would be uploaded should not leave your computer. See the list.' };
  }
  if (!input.buildPasses) {
    return { ready: false, reason: 'The app does not build yet. It will not build on the server either.' };
  }
  const missing = missingSettings(input.settings);
  if (missing.length > 0) {
    return {
      ready: false,
      reason: `The live app needs ${missing.length} setting${missing.length === 1 ? '' : 's'} that ${missing.length === 1 ? 'has' : 'have'} not been given yet: ${missing.join(', ')}.`,
    };
  }
  return { ready: true };
}
