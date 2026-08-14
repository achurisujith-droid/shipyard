import type { AuthStatus } from '@shipyard/shared';

import { authStatus as claudeAuthStatus } from '../auth';
import { resolveExecutable as resolveClaudeExecutable } from '../detect';
import { buildSessionEnv as buildClaudeEnv, sessionArgs as claudeSessionArgs } from '../env';
import { findInputBox, isBusy, isReady, wasSubmitted } from '../parse/chrome';
import { MIN_SUPPORTED_CLI_VERSION } from '../constants';

import { codexProvider } from './codex';
import type { ProviderDescriptor, ProviderId } from './types';

export type { ProviderChrome, ProviderDescriptor, ProviderId } from './types';
export { codexProvider } from './codex';

const IS_WINDOWS = process.platform === 'win32';

/**
 * Anthropic's Claude Code.
 *
 * A thin descriptor over the modules that already drive it. Those were written
 * before there was a second provider and are covered by the Milestone 1
 * acceptance gate, so they are wrapped rather than moved — a refactor of tested
 * transport code is not worth the risk of adding a second CLI.
 */
export const claudeProvider: ProviderDescriptor = {
  id: 'claude',
  name: 'Claude Code',
  accountName: 'Claude',
  binaryNames: IS_WINDOWS ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'],
  minVersion: MIN_SUPPORTED_CLI_VERSION,

  knownLocations(): string[] {
    // Owned by detect.ts, which already walks these.
    return [];
  },

  resolveExecutable: resolveClaudeExecutable,

  parseVersion(output: string): string | undefined {
    return /(\d+\.\d+\.\d+)/.exec(output.trim())?.[1];
  },

  authStatus(executable: string): Promise<AuthStatus> {
    return claudeAuthStatus(executable);
  },

  sessionArgs: claudeSessionArgs,
  buildSessionEnv: buildClaudeEnv,
  chrome: { isReady, isBusy, findInputBox, wasSubmitted },
};

export const PROVIDERS: Record<ProviderId, ProviderDescriptor> = {
  claude: claudeProvider,
  codex: codexProvider,
};

/** In the order the chooser should offer them. */
export const PROVIDER_LIST: readonly ProviderDescriptor[] = [claudeProvider, codexProvider];

export function providerFor(id: ProviderId): ProviderDescriptor {
  return PROVIDERS[id];
}
