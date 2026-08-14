export { detectClaude, resolveExecutable, compareVersions } from './detect';
export type { DetectOptions } from './detect';
export { authStatus } from './auth';
export { startLogin } from './login';
export type { LoginSession } from './login';
export { createSession } from './session';
export type { CreateSessionOptions } from './session';
export { buildSessionEnv, sessionArgs } from './env';
export { ScreenBuffer } from './screen';
export type { ScreenSnapshot } from './screen';
export { parseMenu, keysToSelect } from './parse/menu';
export type { ParsedMenu, ParsedMenuOption } from './parse/menu';
export { parseTranscript } from './parse/transcript';
export type { TranscriptBlock } from './parse/transcript';
export { findInputBox, isReady, isBusy, statusLine, transcriptEndIndex, wasSubmitted } from './parse/chrome';
export { classifyInterstitial, looksLikePermission } from './parse/interstitial';
export { typeAndSubmit, typeText } from './input';
export {
  MIN_SUPPORTED_CLI_VERSION,
  AUTH_POLL_INTERVAL_MS,
  LOGIN_TIMEOUT_MS,
  PTY_COLS,
  PTY_ROWS,
} from './constants';

export {
  PROVIDERS,
  PROVIDER_LIST,
  claudeProvider,
  codexProvider,
  providerFor,
} from './providers';
export type { ProviderChrome, ProviderDescriptor, ProviderId } from './providers';
