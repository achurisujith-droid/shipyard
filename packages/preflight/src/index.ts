import {
  checkDevOnlyImports,
  checkHardcodedAddresses,
  checkImportCase,
  checkLocalFileWrites,
  checkMigrations,
  settingsForDeploy,
  type Finding,
} from './checks';
import { DIVERGENCES, onlyCheckableLive, type Divergence } from './divergences';

export * from './checks';
export * from './divergences';

/**
 * Before you press deploy.
 *
 * The question this answers is the one every founder asks and nobody answers
 * honestly: *will what works here work there?*
 *
 * The truthful answer is no — local working proves the code runs and very
 * little else. But that is not a useful thing to say on its own, because it
 * sounds like a shrug. The useful version is: here are the dozen specific ways
 * the two differ, here are the eight we just checked, and here are the four
 * nothing local can check, which is why deploying is followed by looking rather
 * than by celebrating.
 *
 * A deploy button that does not say this is a button that turns a founder's
 * first launch into a debugging session in front of whoever they sent the link
 * to.
 */

export interface PreflightResult {
  /** Nothing blocking. Not the same as "it will work". */
  clear: boolean;
  findings: Finding[];
  /** Settings the live app needs. Names only — the values are never read. */
  settingsNeeded: string[];
  /**
   * The differences nothing local can find, with what to do about each one
   * after the site is up.
   */
  checkAfterDeploy: Divergence[];
  /** One honest sentence for the screen. */
  summary: string;
}

export async function preflight(projectPath: string): Promise<PreflightResult> {
  const [imports, addresses, devDeps, fileWrites, migrations, settings] = await Promise.all([
    checkImportCase(projectPath),
    checkHardcodedAddresses(projectPath),
    checkDevOnlyImports(projectPath),
    checkLocalFileWrites(projectPath),
    checkMigrations(projectPath),
    settingsForDeploy(projectPath),
  ]);

  const findings = [
    ...imports,
    ...devDeps,
    ...migrations,
    ...(settings.finding ? [settings.finding] : []),
    ...addresses,
    ...fileWrites,
  ].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'blocking' ? -1 : 1));

  const blocking = findings.filter((finding) => finding.severity === 'blocking');

  return {
    clear: blocking.length === 0,
    findings,
    settingsNeeded: settings.names,
    checkAfterDeploy: onlyCheckableLive(),
    summary: describe(blocking.length, findings.length - blocking.length),
  };
}

function describe(blocking: number, warnings: number): string {
  if (blocking > 0) {
    return `${blocking} thing${blocking === 1 ? '' : 's'} will stop this working once it is live. Worth fixing before you send anybody the link.`;
  }
  if (warnings > 0) {
    return `Nothing will stop the deploy, but ${warnings} thing${warnings === 1 ? '' : 's'} behave differently on a server than on your computer.`;
  }
  return 'Nothing found that we can check from here. The things we cannot check are listed below — those need looking at once it is live.';
}

/**
 * What "deployed" does and does not mean.
 *
 * A deploy that succeeded means files reached a server and a process started.
 * It does not mean anybody can use the thing. Keeping those two claims apart is
 * the whole reason the gates exist, and it is why the demo link is not handed
 * over until something has actually loaded a page.
 */
export const DEPLOY_PROVES = {
  /** True the moment the host says the deploy finished. */
  deployed: 'The files are on a server and it started without crashing.',
  /** True only once `deployed_health_check_passes` has evidence. */
  reachable: 'The address answers, and the app can reach its database.',
  /** True only once somebody, or a test, has been through the main journey. */
  usable: 'A person can actually do the thing your app is for.',
} as const;

/** Every divergence, for the screen that explains why this step exists. */
export function allDivergences(): readonly Divergence[] {
  return DIVERGENCES;
}
