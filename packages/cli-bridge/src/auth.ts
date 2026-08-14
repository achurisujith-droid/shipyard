import type { AuthStatus, ClaudeAuthMethod, ClaudeTier } from '@shipyard/shared';

import { CLI_EXEC_TIMEOUT_MS } from './constants';
import { runBinary } from './exec';

/**
 * Shape of `claude auth status --json` as observed on 2.1.215. Every field is
 * optional because we must not assume an older or newer CLI emits all of them.
 */
interface RawAuthStatus {
  loggedIn?: unknown;
  authMethod?: unknown;
  apiProvider?: unknown;
  email?: unknown;
  orgName?: unknown;
  subscriptionType?: unknown;
}

/**
 * Ask the CLI whether it is signed in.
 *
 * We run the CLI's own `auth status --json` and read its answer. We never look
 * at ~/.claude, a keychain, or any token store — that is a hard product rule,
 * and it is also why this is the only source of truth here.
 */
export async function authStatus(cliPath: string): Promise<AuthStatus> {
  const result = await runBinary(cliPath, ['auth', 'status', '--json'], {
    timeoutMs: CLI_EXEC_TIMEOUT_MS,
  });

  if (result.timedOut) {
    return { authed: false, tier: 'unknown', problem: 'Timed out running `claude auth status`.' };
  }

  const raw = extractJsonObject(`${result.stdout}\n${result.stderr}`);
  if (!raw) {
    // Older CLI without `auth status`, or an output format we do not know.
    // Per spec: report unknown rather than guessing.
    return {
      authed: false,
      tier: 'unknown',
      problem:
        'Could not parse `claude auth status --json`. This CLI version may predate the command.',
    };
  }

  const loggedIn = raw.loggedIn === true;
  if (!loggedIn) return { authed: false, tier: 'unknown' };

  const label = firstString(raw.email, raw.orgName);

  return {
    authed: true,
    tier: mapTier(raw.subscriptionType),
    // Display only. Never logged, never sent anywhere.
    ...(label ? { accountLabel: label } : {}),
    authMethod: mapAuthMethod(raw.authMethod, raw.apiProvider),
  };
}

function mapTier(value: unknown): ClaudeTier {
  if (typeof value !== 'string') return 'unknown';
  switch (value.toLowerCase()) {
    case 'free':
      return 'free';
    case 'pro':
      return 'pro';
    case 'max':
      return 'max';
    case 'team':
    // Enterprise seats behave like team for our purposes: no per-seat warning.
    case 'enterprise':
      return 'team';
    default:
      return 'unknown';
  }
}

function mapAuthMethod(authMethod: unknown, apiProvider: unknown): ClaudeAuthMethod {
  const m = typeof authMethod === 'string' ? authMethod.toLowerCase() : '';
  const p = typeof apiProvider === 'string' ? apiProvider.toLowerCase() : '';

  if (m === 'claude.ai' || m === 'claudeai' || m === 'oauth') return 'subscription';
  if (m.includes('api') || m === 'console') return 'api-key';
  // Third-party providers bill separately; treat them as api-key for the
  // purposes of the plan-check screen.
  if (p === 'bedrock' || p === 'vertex' || p === 'foundry') return 'api-key';
  if (p === 'firstparty' && m === '') return 'subscription';
  return 'unknown';
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

/**
 * Pull the first JSON object out of mixed output. The CLI can prepend update
 * notices, so `JSON.parse(stdout)` on its own is too brittle.
 */
function extractJsonObject(text: string): RawAuthStatus | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    return parsed as RawAuthStatus;
  } catch {
    return undefined;
  }
}
