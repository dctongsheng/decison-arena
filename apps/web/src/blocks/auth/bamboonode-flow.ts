import { safeInternalPath } from '@/lib/redirect';
import { localizeHref, type Locale } from '@/paraglide/runtime.js';

export type BambooEntry = '/sign-in' | '/sign-up';
export interface BambooOAuthInput {
  providerId: 'bamboonode';
  callbackURL: string;
  errorCallbackURL: string;
}
export type BambooPhase = 'ready' | 'redirecting' | 'error';
export function bambooMode(config: Record<string, unknown> | undefined) {
  return config?.auth_mode === 'bamboonode';
}
export function bambooReady(config: Record<string, unknown> | undefined) {
  return (
    config?.bamboonode_auth_ready === true ||
    config?.bamboonode_auth_ready === 'true'
  );
}
export function bambooAccountUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'bamboonode.dev' ||
      url.port ||
      url.username ||
      url.password
    )
      return;
    return url.href;
  } catch {
    return;
  }
}
export function bambooDestinations(
  search: string,
  locale: Locale,
  entry: BambooEntry
): { input: BambooOAuthInput; callbackFailed: boolean } {
  const params = new URLSearchParams(search);
  const target =
    safeInternalPath(params.get('callbackUrl')) ||
    safeInternalPath(params.get('redirect')) ||
    '/';
  const errorParams = new URLSearchParams({
    oauth_error: '1',
    callbackUrl: target,
  });
  return {
    input: {
      providerId: 'bamboonode',
      callbackURL: localizeHref(target, { locale }),
      errorCallbackURL: localizeHref(`${entry}?${errorParams}`, { locale }),
    },
    callbackFailed: params.has('oauth_error') || params.has('error'),
  };
}

/** A single attempt gate protects React effect replays and rapid retry clicks. */
export function createBambooLoginFlow(options: {
  input: BambooOAuthInput;
  callbackFailed: boolean;
  signIn: (input: BambooOAuthInput) => Promise<{ error?: unknown }>;
  onPhase: (phase: BambooPhase) => void;
}) {
  let automaticAttempted = options.callbackFailed;
  let pending = false;
  return {
    async start(trigger: 'auto' | 'manual') {
      if (pending || (trigger === 'auto' && automaticAttempted)) return false;
      automaticAttempted = true;
      pending = true;
      options.onPhase('redirecting');
      try {
        const result = await options.signIn(options.input);
        if (result.error) throw new Error('OAuth initiation failed');
        return true;
      } catch {
        options.onPhase('error');
        return false;
      } finally {
        pending = false;
      }
    },
  };
}
