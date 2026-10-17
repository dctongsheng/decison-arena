import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpRight,
  Leaf,
  LoaderCircle,
  RefreshCw,
  Unplug,
} from 'lucide-react';

import { authClient, useSession } from '@/core/auth/client';
import { apiGet, apiPost } from '@/lib/api-client';
import { currentPathWithQuery } from '@/lib/redirect';
import { m } from '@/paraglide/messages.js';
import { getLocale } from '@/paraglide/runtime.js';
import { Button } from '@/components/ui/button';

import {
  bambooConnectionKey,
  bambooReauthorization,
  bambooSyncOptions,
  canAutomaticallySyncBamboo,
  type BambooConnection,
} from './bamboonode-access';

/** Mounted inside AuthGate on model settings and both create pages. */
export function BambooModelConnection() {
  const { data: session } = useSession();
  const userId = session?.user.id || '';
  const client = useQueryClient();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [redirectError, setRedirectError] = useState(false);
  const callbackFailed =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).has('bamboo_error');
  const connection = useQuery({
    queryKey: bambooConnectionKey(userId),
    queryFn: async () => {
      const previous = client.getQueryData<BambooConnection>(
        bambooConnectionKey(userId)
      );
      const next = await apiGet<BambooConnection>('/api/arena/bamboonode');
      if (previous?.status === 'syncing' && next.status !== 'syncing') {
        await client.invalidateQueries({ queryKey: ['arena-models', userId] });
      }
      return next;
    },
    enabled: !!userId,
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      query.state.status !== 'error' && query.state.data?.status === 'syncing'
        ? 1_500
        : false,
  });
  const sync = useQuery({
    ...bambooSyncOptions(client, userId, () =>
      apiPost<BambooConnection>('/api/arena/bamboonode/sync')
    ),
    enabled:
      !!userId &&
      !callbackFailed &&
      canAutomaticallySyncBamboo(connection.data),
  });
  const disconnect = useMutation({
    mutationFn: () =>
      apiPost<BambooConnection>('/api/arena/bamboonode/disconnect'),
    onSuccess: async (data) => {
      client.setQueryData(bambooConnectionKey(userId), data);
      setConfirmDisconnect(false);
      await client.invalidateQueries({ queryKey: ['arena-models', userId] });
    },
  });
  const data = connection.data;
  useEffect(() => {
    if (!redirecting) return;
    const timer = window.setTimeout(() => setRedirecting(false), 8_000);
    return () => window.clearTimeout(timer);
  }, [redirecting]);
  if (!userId || (data && !data.enabled)) return null;
  const busy = sync.isFetching || disconnect.isPending || redirecting;
  const failure =
    redirectError ||
    callbackFailed ||
    connection.isError ||
    sync.isError ||
    disconnect.isError ||
    data?.status === 'error';
  const needsAuthorization =
    data && ['reauthorize', 'disconnected'].includes(data.status);
  const status = sync.isFetching ? 'syncing' : data?.status;
  const statusText =
    status === 'connected'
      ? m['arena.bamboo.connected']({ count: data?.models || 0 })
      : status === 'reauthorize'
        ? m['arena.bamboo.reauthorize_description']()
        : status === 'disconnected'
          ? m['arena.bamboo.disconnected']()
          : status === 'error'
            ? m['arena.bamboo.failed']()
            : status === 'syncing' || connection.isPending
              ? m['arena.bamboo.syncing']()
              : m['arena.bamboo.connecting']();
  async function authorize() {
    if (busy) return;
    setRedirecting(true);
    setRedirectError(false);
    try {
      const result = await authClient.signIn.oauth2(
        bambooReauthorization(currentPathWithQuery('/models'), getLocale())
      );
      if (result.error) throw new Error('OAuth initiation failed');
    } catch {
      setRedirectError(true);
      setRedirecting(false);
    }
  }
  return (
    <section
      className="arena-bamboo-banner"
      aria-label={m['arena.bamboo.title']()}
    >
      <span className="arena-bamboo-icon">
        <Leaf size={23} />
      </span>
      <div className="arena-bamboo-content">
        <strong>{m['arena.bamboo.title']()}</strong>
        <p aria-live="polite">{statusText}</p>
        <small>{m['arena.bamboo.quota_note']()}</small>
        {data?.message && (
          <p className="arena-bamboo-message">{data.message}</p>
        )}
        {failure && (
          <p role="alert" className="arena-bamboo-error">
            {callbackFailed || redirectError
              ? m['arena.bamboo.authorization_failed']()
              : m['arena.bamboo.failed']()}
          </p>
        )}
        {data?.expiresAt && (
          <small>
            {m['arena.bamboo.expires']()} ·{' '}
            {new Date(data.expiresAt).toLocaleString(
              getLocale() === 'zh' ? 'zh-CN' : 'en-US',
              { timeZone: 'UTC', timeZoneName: 'short' }
            )}
          </small>
        )}
        {confirmDisconnect && (
          <p className="arena-bamboo-message">
            {m['arena.bamboo.disconnect_confirm']()}
          </p>
        )}
      </div>
      <div className="arena-bamboo-actions">
        {data?.enabled &&
        (needsAuthorization || callbackFailed || redirectError) ? (
          <Button
            className="arena-button"
            disabled={busy}
            onClick={() => void authorize()}
          >
            {redirecting ? (
              <LoaderCircle size={15} className="animate-spin" />
            ) : (
              <ArrowUpRight size={15} />
            )}
            {m['arena.bamboo.reauthorize']()}
          </Button>
        ) : (
          <Button
            variant="outline"
            className="arena-button secondary"
            disabled={busy || connection.isPending}
            onClick={() =>
              void (connection.isError
                ? connection.refetch()
                : sync.refetch({ cancelRefetch: false }))
            }
          >
            <RefreshCw
              size={15}
              className={sync.isFetching ? 'animate-spin' : ''}
            />
            {m['arena.bamboo.sync']()}
          </Button>
        )}
        {data?.status === 'connected' &&
          (confirmDisconnect ? (
            <>
              <Button
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() => disconnect.mutate()}
              >
                {m['arena.bamboo.confirm_disconnect']()}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setConfirmDisconnect(false)}
              >
                {m['arena.cancel']()}
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setConfirmDisconnect(true)}
            >
              <Unplug size={14} />
              {m['arena.bamboo.disconnect']()}
            </Button>
          ))}
        <a
          href="https://bamboonode.dev"
          target="_blank"
          rel="noreferrer"
          className="arena-text-link"
        >
          {m['arena.bamboo.account']()}
          <ArrowUpRight size={13} />
        </a>
      </div>
    </section>
  );
}
