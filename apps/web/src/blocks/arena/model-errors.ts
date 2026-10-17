import { BAMBOONODE_INSUFFICIENT_QUOTA } from '@decision-arena/core';

import { m } from '@/paraglide/messages.js';

export type ModelErrorProviders = readonly (string | undefined)[];
export const BAMBOONODE_ACCOUNT_URL = 'https://bamboonode.dev/recharge';

export function isBambooJev(profile?: { provider?: string }) {
  return profile?.provider === 'bamboonode-decisions';
}

export function modelErrorKind(
  error: unknown,
  providers: ModelErrorProviders = []
) {
  const message = error instanceof Error ? error.message : String(error || '');
  if (message === BAMBOONODE_INSUFFICIENT_QUOTA) return 'quota';
  // A historical HTTP status alone never proves insufficient funds. Only add
  // account guidance when this activity includes a BambooNode connection.
  if (
    /^(?:Model provider returned )?HTTP 403$/.test(message) &&
    providers.some((provider) =>
      ['bamboonode-systemone', 'bamboonode-decisions'].includes(provider || '')
    )
  )
    return 'forbidden';
  return undefined;
}

export function modelErrorText(
  error: unknown,
  providers: ModelErrorProviders = []
) {
  switch (modelErrorKind(error, providers)) {
    case 'quota':
      return m['arena.bamboo.insufficient_quota']();
    case 'forbidden':
      return m['arena.bamboo.forbidden_help']();
    default:
      return error instanceof Error ? error.message : String(error || '');
  }
}
