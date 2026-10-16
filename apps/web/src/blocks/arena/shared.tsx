import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ArcadeGameId,
  ArcadeResult,
  GameId,
  GameResult,
  MatchEvent,
  PublicSeatConfig,
} from '@decision-arena/core';
import {
  ArrowRight,
  ChevronRight,
  CircleHelp,
  Grid2X2,
  History,
  KeyRound,
  LoaderCircle,
  LogOut,
  Sparkles,
  Users,
  Zap,
} from 'lucide-react';

import { signOut, useSession } from '@/core/auth/client';
import { Link, usePathname } from '@/core/i18n/navigation';
import { envConfigs } from '@/config';
import { apiGet } from '@/lib/api-client';
import { getLocale, setLocale } from '@/paraglide/runtime.js';
import { a } from '@/blocks/arcade/messages';
import { Button } from '@/components/ui/button';

import './arena.css';

import { arenaText as t } from './messages';

export { arenaText as t } from './messages';

export const gameName = (id: GameId | ArcadeGameId) =>
  ['snake', 'tetris', 'platformer'].includes(id)
    ? a(`game.${id}`)
    : t(`game.${id}`);
export const statusName = (status: string) => t(`status.${status}`);
export const seatName = (game: GameId, seat: number) =>
  t(`seat.${game}.${seat}`);
export function resultName(
  result: GameResult | ArcadeResult | undefined,
  game: GameId | ArcadeGameId
) {
  if (result && 'scores' in result) {
    if (result.aborted) return a('finished');
    if (result.scores.length === 1) return a('solo_complete');
    return result.winner === null
      ? a('draw')
      : `${a(result.winner === 0 ? 'left' : 'right')} · ${a('win')}`;
  }
  return !result
    ? t('in_progress')
    : result.winner === null
      ? t('draw')
      : `${seatName(game as GameId, result.winner)} · ${t('wins')}`;
}
export function reasonName(reason?: string) {
  if (!reason) return '';
  const key = reason.toLowerCase().replaceAll('_', '-');
  const translated = t(`reason.${key}`);
  return translated === `arena.reason.${key}` ? reason : translated;
}
const matchMessages: Record<string, string> = {
  'Match limit reached': 'limit_reached',
  'Another AI match is running in this account': 'another_match',
  'Rules version changed; this match cannot continue': 'rules_changed',
  'The previous model call was interrupted. Its billing status is unknown; retry explicitly.':
    'interrupted',
  'Credential was removed; choose an available model for a new match':
    'credential_removed',
  'Credential was removed during the decision': 'credential_removed',
};
export function eventLabel(event: MatchEvent): string {
  if (event.action?.label) return event.action.label;
  if (!event.message) return t(`event.${event.type}`);
  if (
    ['ready', 'running', 'paused', 'finished', 'error'].includes(event.message)
  )
    return statusName(event.message);
  return matchMessages[event.message]
    ? t(`error.${matchMessages[event.message]}`)
    : event.message;
}
export function formatDate(value: string | number) {
  return new Date(value).toLocaleString(
    getLocale() === 'zh' ? 'zh-CN' : 'en-US',
    { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' }
  );
}
export interface SavedModel {
  id: string;
  name: string;
  provider: string;
  model: string;
  endpoint: string;
  thinkMode?: string;
  thinkBudget?: number;
  keyMask?: string;
}
export interface MatchItem {
  id: string;
  gameId: GameId;
  status: string;
  createdAt: string | number;
  result?: GameResult;
  seats?: [PublicSeatConfig, PublicSeatConfig];
}
export interface CommunityPost {
  id: string;
  matchId: string;
  title: string;
  description: string;
  gameId: GameId | ArcadeGameId;
  engineKind?: 'arcade';
  controllers?: PublicSeatConfig[];
  createdAt: string | number;
  authorName: string;
  likes: number;
  commentCount: number;
  result?: GameResult | ArcadeResult;
  seats?: PublicSeatConfig[];
}
export function useModels(enabled = true) {
  const { data: session } = useSession();
  return useQuery({
    queryKey: ['arena-models', session?.user?.id],
    queryFn: () => apiGet<{ items: SavedModel[] }>('/api/arena/models'),
    enabled: enabled && !!session?.user,
  });
}

export function ArenaShell({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const path = usePathname();
  const { data: session } = useSession();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const links = [
    { href: '/', label: t('nav.lobby'), Icon: Grid2X2 },
    { href: '/community', label: t('nav.community'), Icon: Users },
    { href: '/history', label: t('nav.history'), Icon: History },
    { href: '/models', label: t('nav.models'), Icon: KeyRound },
  ];
  return (
    <div className="arena-root">
      <header className="arena-header">
        <div className="arena-header-inner">
          <Link href="/" className="arena-brand">
            <span className="arena-logo">
              <Zap size={22} fill="currentColor" />
            </span>
            <span>
              {envConfigs.app_name}
              <small>OPEN DECISION PLAYGROUND</small>
            </span>
          </Link>
          <nav aria-label={t('nav.label')}>
            {links.map(({ href, label, Icon }) => (
              <Link
                key={href}
                href={href}
                className={
                  (href === '/' ? path === '/' : path.startsWith(href))
                    ? 'active'
                    : ''
                }
              >
                <Icon size={16} />
                <span>{label}</span>
              </Link>
            ))}
          </nav>
          <div className="arena-user">
            <button
              className="arena-language"
              onClick={() => setLocale(getLocale() === 'zh' ? 'en' : 'zh')}
              aria-label={t('language')}
            >
              {getLocale() === 'zh' ? 'EN' : '中文'}
            </button>
            {mounted && session?.user ? (
              <>
                <Link
                  href="/settings/profile"
                  className="arena-avatar"
                  title={session.user.name}
                >
                  {session.user.name?.slice(0, 1).toUpperCase() || 'U'}
                </Link>
                <button
                  className="arena-signout"
                  title={t('signout')}
                  onClick={async () => {
                    await signOut();
                    queryClient.removeQueries({
                      predicate: (query) =>
                        String(query.queryKey[0]).startsWith('arena-'),
                    });
                  }}
                >
                  <LogOut size={16} />
                </button>
              </>
            ) : (
              <Link className="arena-button small" href="/sign-in">
                {t('signin')}
                <ArrowRight size={15} />
              </Link>
            )}
          </div>
        </div>
      </header>
      <main className="arena-main">{children}</main>
      <footer className="arena-footer">
        <span>
          <span className="arena-dot" />
          {t('footer')}
        </span>
        <span>
          MIT · {t('footer.open')}
          <span className="arena-footer-sep">/</span>
          <Link href="/models">{t('footer.keys')}</Link>
        </span>
      </footer>
    </div>
  );
}
export function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="arena-page-heading">
      <div>
        {eyebrow && <div className="arena-eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action}
    </div>
  );
}
export function AuthGate({ children }: { children: ReactNode }) {
  const { data: session, isPending } = useSession();
  const path = usePathname();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted || isPending) return <Loading />;
  if (!session?.user)
    return (
      <div className="arena-auth arena-panel">
        <span className="arena-icon-box">
          <KeyRound />
        </span>
        <h2>{t('auth.title')}</h2>
        <p>{t('auth.description')}</p>
        <Link
          className="arena-button"
          href={`/sign-in?callbackUrl=${encodeURIComponent(path)}`}
        >
          {t('signin')}
          <ArrowRight size={16} />
        </Link>
        <Link
          href={`/sign-up?callbackUrl=${encodeURIComponent(path)}`}
          className="arena-text-link"
        >
          {t('auth.signup')}
          <ChevronRight size={15} />
        </Link>
      </div>
    );
  return <div key={session.user.id}>{children}</div>;
}
export function Loading() {
  return (
    <div className="arena-empty">
      <LoaderCircle className="arena-spin" size={26} />
      <p>{t('loading')}</p>
    </div>
  );
}
export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="arena-error" role="alert">
      <CircleHelp size={17} />
      <span>{error instanceof Error ? error.message : String(error)}</span>
    </div>
  );
}
export function EmptyState({
  title,
  description,
  href,
  label,
}: {
  title: string;
  description: string;
  href?: string;
  label?: string;
}) {
  return (
    <div className="arena-empty arena-panel">
      <span className="arena-icon-box">
        <Sparkles />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {href && (
        <Link href={href} className="arena-button">
          {label}
          <ArrowRight size={16} />
        </Link>
      )}
    </div>
  );
}
export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`arena-status ${status}`}>
      <i />
      {statusName(status)}
    </span>
  );
}
export function SubmitButton({
  pending,
  children,
  ...props
}: {
  pending: boolean;
  children: ReactNode;
  disabled?: boolean;
  type?: 'submit' | 'button';
  onClick?: () => void;
}) {
  return (
    <Button
      className="arena-button"
      disabled={pending || props.disabled}
      {...props}
    >
      {pending && <LoaderCircle size={16} className="arena-spin" />}
      {children}
    </Button>
  );
}
