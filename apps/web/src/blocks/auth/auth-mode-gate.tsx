import { useEffect, useRef, useState, type ReactNode } from 'react';

import { authClient, useSession } from '@/core/auth/client';
import { envConfigs } from '@/config';
import { m } from '@/paraglide/messages.js';
import { getLocale } from '@/paraglide/runtime.js';
import { usePublicConfig } from '@/hooks/use-public-config';
import { AuthStatusCard } from '@/components/auth/auth-status-card';

import {
  bambooAccountUrl,
  bambooDestinations,
  bambooMode,
  bambooReady,
  createBambooLoginFlow,
  type BambooEntry,
  type BambooPhase,
} from './bamboonode-flow';

type AuthIntent = 'sign-in' | 'sign-up' | 'account';
/** Local forms remain unmounted until the server has resolved the auth mode. */
export function AuthModeGate({
  intent,
  children,
}: {
  intent: AuthIntent;
  children: ReactNode;
}) {
  const config = usePublicConfig();
  const brand = config.data?.app_name || envConfigs.app_name;
  if (
    config.isPending ||
    (!config.isFetchedAfterMount && config.isFetching) ||
    (!config.data && !config.isError)
  )
    return (
      <AuthStatusCard
        brand={brand}
        title={m['common.bamboo.loading_title']()}
        description={m['common.bamboo.loading_description']()}
        busy
        homeLabel={m['common.bamboo.home']()}
      />
    );
  if (config.isError)
    return (
      <AuthStatusCard
        brand={brand}
        title={m['common.bamboo.config_error_title']()}
        description={m['common.bamboo.config_error_description']()}
        error
        actionLabel={m['common.bamboo.retry']()}
        onAction={() => void config.refetch()}
        actionDisabled={config.isFetching}
        homeLabel={m['common.bamboo.home']()}
      />
    );
  if (!bambooMode(config.data)) return <>{children}</>;
  const accountUrl = bambooAccountUrl(config.data?.bamboonode_account_url);
  if (!bambooReady(config.data))
    return (
      <AuthStatusCard
        brand={brand}
        title={m['common.bamboo.unavailable_title']()}
        description={m['common.bamboo.unavailable_description']()}
        error
        accountUrl={accountUrl}
        accountLabel={m['common.bamboo.manage_account']()}
        homeLabel={m['common.bamboo.home']()}
      />
    );
  if (intent === 'account')
    return (
      <AuthStatusCard
        brand={brand}
        title={m['common.bamboo.account_title']()}
        description={
          accountUrl
            ? m['common.bamboo.account_description']()
            : m['common.bamboo.account_no_url']()
        }
        accountUrl={accountUrl}
        accountLabel={m['common.bamboo.manage_account']()}
        homeLabel={m['common.bamboo.home']()}
      />
    );
  return (
    <BambooSignIn
      brand={brand}
      entry={intent === 'sign-up' ? '/sign-up' : '/sign-in'}
      accountUrl={accountUrl}
    />
  );
}

function BambooSignIn({
  brand,
  entry,
  accountUrl,
}: {
  brand: string;
  entry: BambooEntry;
  accountUrl?: string;
}) {
  const { data: session, isPending: sessionPending } = useSession();
  const locale = useRef(getLocale());
  const [phase, setPhase] = useState<BambooPhase>('ready');
  const [initializing, setInitializing] = useState(true);
  const [manualAvailable, setManualAvailable] = useState(false);
  const flow = useRef<ReturnType<typeof createBambooLoginFlow> | null>(null);
  const destination = useRef<string | null>(null);
  const callbackFailed = useRef(false);
  const navigating = useRef(false);
  useEffect(() => {
    const current = bambooDestinations(
      window.location.search,
      locale.current,
      entry
    );
    destination.current = current.input.callbackURL;
    callbackFailed.current = current.callbackFailed;
    flow.current ??= createBambooLoginFlow({
      input: current.input,
      callbackFailed: current.callbackFailed,
      signIn: (input) => authClient.signIn.oauth2(input),
      onPhase: setPhase,
    });
    if (current.callbackFailed) {
      setPhase('error');
      setManualAvailable(true);
    }
    setInitializing(false);
  }, [entry]);
  useEffect(() => {
    if (
      initializing ||
      sessionPending ||
      !flow.current ||
      callbackFailed.current
    )
      return;
    if (session?.user) {
      if (!navigating.current && destination.current) {
        navigating.current = true;
        window.location.replace(destination.current);
      }
      return;
    }
    void flow.current.start('auto');
  }, [initializing, sessionPending, session?.user]);
  useEffect(() => {
    if (phase !== 'redirecting') return;
    // Some browsers block a navigation. A manual retry remains possible without
    // making another automatic request or claiming a completed authentication.
    setManualAvailable(false);
    const timer = window.setTimeout(() => setManualAvailable(true), 8000);
    return () => window.clearTimeout(timer);
  }, [phase]);
  const pending =
    initializing ||
    sessionPending ||
    (phase === 'redirecting' && !manualAvailable);
  const failed = phase === 'error';
  return (
    <AuthStatusCard
      brand={brand}
      title={
        failed
          ? m['common.bamboo.failed_title']()
          : m['common.bamboo.redirect_title']()
      }
      description={
        failed
          ? m['common.bamboo.failed_description']()
          : m['common.bamboo.redirect_description']()
      }
      busy={pending}
      error={failed}
      actionLabel={
        failed ? m['common.bamboo.retry']() : m['common.bamboo.continue']()
      }
      onAction={() => void flow.current?.start('manual')}
      actionDisabled={pending}
      accountUrl={accountUrl}
      accountLabel={m['common.bamboo.manage_account']()}
      homeLabel={m['common.bamboo.home']()}
    >
      <p className="text-muted-foreground text-center text-xs leading-6">
        {m['common.bamboo.account_only']()}
      </p>
    </AuthStatusCard>
  );
}
