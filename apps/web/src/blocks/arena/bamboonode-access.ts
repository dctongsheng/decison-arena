import type { QueryClient } from '@tanstack/react-query';

import { safeInternalPath } from '@/lib/redirect';
import type { Locale } from '@/paraglide/runtime.js';
import { bambooDestinations } from '@/blocks/auth/bamboonode-flow';

export interface BambooConnection {
  enabled: boolean;
  status:
    | 'not_connected'
    | 'connected'
    | 'reauthorize'
    | 'disconnected'
    | 'syncing'
    | 'error';
  message?: string;
  models: number;
  expiresAt?: number;
  quota?: unknown;
}

export const bambooConnectionKey = (userId: string) =>
  ['arena-bamboonode', userId] as const;
export const bambooSyncKey = (userId: string) =>
  ['arena-bamboonode-sync', userId] as const;

export function canAutomaticallySyncBamboo(
  connection: BambooConnection | undefined
) {
  return (
    !!connection?.enabled &&
    ['not_connected', 'connected'].includes(connection.status)
  );
}

/** Shared per-user query prevents concurrent mounts from issuing duplicate POSTs. */
export function bambooSyncOptions(
  client: QueryClient,
  userId: string,
  sync: () => Promise<BambooConnection>
) {
  return {
    queryKey: bambooSyncKey(userId),
    queryFn: async () => {
      const connection = await sync();
      client.setQueryData(bambooConnectionKey(userId), connection);
      await client.invalidateQueries({ queryKey: ['arena-models', userId] });
      return connection;
    },
    retry: false as const,
    retryOnMount: false,
    refetchOnMount: false as const,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: 60_000,
  };
}

export function availableModels<T extends { available?: boolean }>(
  models: T[] | undefined
): T[] {
  return (models || []).filter((model) => model.available !== false);
}

export function canEditModel(model: { source?: 'manual' | 'bamboonode' }) {
  return model.source !== 'bamboonode';
}

export function bambooReauthorization(path: string, locale: Locale) {
  const target = new URL(
    safeInternalPath(path) || '/models',
    'https://internal.invalid'
  );
  target.searchParams.delete('bamboo_error');
  target.searchParams.delete('error');
  const callback = target.pathname + target.search;
  const input = bambooDestinations(
    `?callbackUrl=${encodeURIComponent(callback)}`,
    locale,
    '/sign-in'
  ).input;
  const failure = new URL(input.callbackURL, 'https://internal.invalid');
  failure.searchParams.set('bamboo_error', '1');
  return { ...input, errorCallbackURL: failure.pathname + failure.search };
}
