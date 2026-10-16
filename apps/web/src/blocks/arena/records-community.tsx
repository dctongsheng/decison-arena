import { useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GameId, ReplayManifest } from '@decision-arena/core';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  CalendarDays,
  Copy,
  Flag,
  Heart,
  MessageCircle,
  Play,
  Plus,
  Search,
  Send,
  ShieldCheck,
  Trash2,
  Trophy,
  UserRound,
} from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';

import { useSession } from '@/core/auth/client';
import { Link, useRouter } from '@/core/i18n/navigation';
import { apiGet, apiPost } from '@/lib/api-client';
import { GameArtwork } from '@/components/arena/board';
import { Button } from '@/components/ui/button';

import { ReplayPlayer } from './replay-player';
import {
  ArenaShell,
  AuthGate,
  CommunityPost,
  EmptyState,
  ErrorNotice,
  formatDate,
  gameName,
  Loading,
  MatchItem,
  PageHeading,
  reasonName,
  resultName,
  StatusBadge,
  SubmitButton,
  t,
} from './shared';

export function HistoryPage() {
  return (
    <ArenaShell>
      <AuthGate>
        <HistoryContent />
      </AuthGate>
    </ArenaShell>
  );
}
function HistoryContent() {
  const { data: session } = useSession();
  const [filter, setFilter] = useState('all');
  const query = useQuery({
    queryKey: ['arena-matches', session?.user?.id],
    queryFn: () => apiGet<{ items: MatchItem[] }>('/api/arena/matches'),
  });
  const items = query.data?.items.filter(
    (item) =>
      filter === 'all' ||
      (filter === 'finished'
        ? item.status === 'finished'
        : item.status !== 'finished')
  );
  return (
    <>
      <PageHeading
        eyebrow="YOUR EXPERIMENTS"
        title={t('history.title')}
        description={t('history.description')}
        action={
          <Link className="arena-button" href="/new">
            <Plus size={17} />
            {t('new.create')}
          </Link>
        }
      />
      <div className="arena-tab-bar">
        {['all', 'active', 'finished'].map((value) => (
          <button
            key={value}
            className={filter === value ? 'active' : ''}
            onClick={() => setFilter(value)}
          >
            {t(`history.${value}`)}
            {value === 'all' && <span>{query.data?.items.length || 0}</span>}
          </button>
        ))}
      </div>
      <ErrorNotice error={query.error} />
      {query.isPending ? (
        <Loading />
      ) : items?.length ? (
        <div className="arena-panel arena-records">
          {items.map((item) => (
            <Link
              key={item.id}
              className="arena-record"
              href={`/matches/${item.id}`}
            >
              <div className={`arena-record-art ${item.gameId}`}>
                <GameArtwork gameId={item.gameId} />
              </div>
              <div className="arena-record-title">
                <span>
                  {gameName(item.gameId)} <code>#{item.id.slice(0, 8)}</code>
                </span>
                <h3>
                  {item.seats
                    ?.map((seat) => seat.profile?.name || t('human'))
                    .join(' × ') || t('room.title')}
                </h3>
                <small>{formatDate(item.createdAt)}</small>
              </div>
              <div className="arena-record-result">
                <StatusBadge status={item.status} />
                {item.result && (
                  <strong>{resultName(item.result, item.gameId)}</strong>
                )}
              </div>
              <ArrowRight size={19} />
            </Link>
          ))}
        </div>
      ) : (
        <EmptyState
          title={t('history.empty')}
          description={t('history.empty_description')}
          href="/new"
          label={t('new.create')}
        />
      )}
    </>
  );
}

export function CommunityPage() {
  const [game, setGame] = useState('all');
  const [search, setSearch] = useState('');
  const [submittedSearch, setSubmittedSearch] = useState('');
  const query = useQuery({
    queryKey: ['arena-community', game, submittedSearch],
    queryFn: () =>
      apiGet<{ items: CommunityPost[] }>(
        `/api/arena/community?${new URLSearchParams({ ...(game !== 'all' ? { gameId: game } : {}), ...(submittedSearch ? { model: submittedSearch } : {}) })}`
      ),
  });
  return (
    <ArenaShell>
      <PageHeading
        eyebrow="THE COMMUNITY"
        title={t('community.title')}
        description={t('community.description')}
        action={
          <Link href="/history" className="arena-button secondary">
            <Plus size={17} />
            {t('community.share')}
          </Link>
        }
      />
      <div className="arena-community-toolbar">
        <div className="arena-tab-bar">
          {['all', 'gomoku', 'xiangqi', 'army'].map((value) => (
            <button
              key={value}
              className={game === value ? 'active' : ''}
              onClick={() => setGame(value)}
            >
              {value === 'all' ? t('community.all') : gameName(value as GameId)}
            </button>
          ))}
        </div>
        <form
          className="arena-search"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmittedSearch(search.trim());
          }}
        >
          <Search size={17} />
          <input
            aria-label={t('community.search')}
            placeholder={t('community.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button type="submit" aria-label={t('community.search')}>
            <ArrowRight size={16} />
          </button>
        </form>
      </div>
      <ErrorNotice error={query.error} />
      {query.isPending ? (
        <Loading />
      ) : query.data?.items.length ? (
        <div className="arena-post-grid">
          {query.data.items.map((post) => (
            <Link
              className="arena-post-card arena-panel"
              href={`/community/${post.id}`}
              key={post.id}
            >
              <div className="arena-post-art">
                <GameArtwork gameId={post.gameId} />
                <span className="arena-tag">{gameName(post.gameId)}</span>
                <span className="arena-post-play">
                  <Play size={20} fill="currentColor" />
                </span>
              </div>
              <div className="arena-post-body">
                <span className="arena-post-models">
                  {post.seats
                    ?.map((seat) => seat.profile?.name || t('human'))
                    .join(' × ') || t('community.replay')}
                </span>
                <h3>{post.title}</h3>
                <p>{post.description || t('community.no_description')}</p>
                <div className="arena-post-result">
                  <Trophy size={15} />
                  {resultName(post.result, post.gameId)}
                </div>
                <div className="arena-post-footer">
                  <span>
                    <span className="arena-avatar tiny">
                      {post.authorName?.slice(0, 1) || 'A'}
                    </span>
                    {post.authorName}
                  </span>
                  <span>
                    <Heart size={14} />
                    {post.likes || 0}
                    <MessageCircle size={14} />
                    {post.commentCount || 0}
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <EmptyState
          title={t('community.empty')}
          description={t('community.empty_description')}
          href="/new"
          label={t('community.start')}
        />
      )}
    </ArenaShell>
  );
}

interface CommunityDetail {
  post: CommunityPost;
  replay: ReplayManifest;
  comments: {
    id: string;
    body: string;
    authorName: string;
    createdAt: string | number;
  }[];
  liked: boolean;
  canManage: boolean;
  isAdmin?: boolean;
}
export function CommunityDetailPage({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { data: session } = useSession();
  const [report, setReport] = useState(false);
  const [reportText, setReportText] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const query = useQuery({
    queryKey: ['arena-community-detail', id, session?.user?.id],
    queryFn: () =>
      apiGet<CommunityDetail>(`/api/arena/community/${encodeURIComponent(id)}`),
  });
  const mutation = useMutation({
    mutationFn: (payload: {
      action: string;
      body?: string;
      reason?: string;
      liked?: boolean;
    }) => apiPost(`/api/arena/community/${encodeURIComponent(id)}`, payload),
    onSuccess: (_, payload) => {
      queryClient.invalidateQueries({
        queryKey: ['arena-community-detail', id, session?.user?.id],
      });
      queryClient.invalidateQueries({ queryKey: ['arena-community'] });
      if (payload.action === 'unpublish' || payload.action === 'moderate')
        router.push('/community');
      if (payload.action === 'report') {
        setReport(false);
        setReportText('');
        toast.success(t('community.reported'));
      }
    },
  });
  const commentForm = useForm({
    defaultValues: { body: '' },
    validators: {
      onSubmit: z.object({ body: z.string().trim().min(1).max(2000) }),
    },
    onSubmit: async ({ value }) => {
      await mutation.mutateAsync({ action: 'comment', body: value.body });
      commentForm.reset();
    },
  });
  const data = query.data;
  return (
    <ArenaShell>
      <Link href="/community" className="arena-text-link arena-back">
        <ArrowLeft size={16} />
        {t('community.back')}
      </Link>
      {query.isPending ? (
        <Loading />
      ) : !data ? (
        <ErrorNotice error={query.error} />
      ) : (
        <>
          <div className="arena-replay-heading">
            <div>
              <span className="arena-tag">{gameName(data.post.gameId)}</span>
              <h1>{data.post.title}</h1>
              <div className="arena-post-author">
                <span className="arena-avatar tiny">
                  {data.post.authorName?.slice(0, 1) || 'A'}
                </span>
                <strong>{data.post.authorName}</strong>
                <span>·</span>
                <span>{formatDate(data.post.createdAt)}</span>
                <ShieldCheck size={14} />
                <span>{t('community.public')}</span>
              </div>
            </div>
            <Link href={`/new?clone=${id}`} className="arena-button">
              <Copy size={17} />
              {t('community.clone')}
            </Link>
          </div>
          <div className="arena-community-detail">
            <section className="arena-panel arena-replay-panel">
              <ReplayPlayer replay={data.replay} />
            </section>
            <aside className="arena-replay-side">
              <section className="arena-panel arena-replay-result">
                <span className="arena-icon-box">
                  <Trophy size={26} />
                </span>
                <small>{t('room.final_result')}</small>
                <h2>{resultName(data.replay.result, data.replay.gameId)}</h2>
                <p>{reasonName(data.replay.result.reason)}</p>
                <div className="arena-replay-models">
                  {data.replay.seats.map((seat, i) => (
                    <div key={i}>
                      <span>
                        {seat.kind === 'ai' ? (
                          <Bot size={19} />
                        ) : (
                          <UserRound size={19} />
                        )}
                      </span>
                      <div>
                        <strong>{seat.profile?.name || t('human')}</strong>
                        <small>
                          {seat.kind === 'ai'
                            ? seat.profile?.model || t('models.service_default')
                            : t('room.local_player')}
                        </small>
                        {seat.profile?.thinkMode && (
                          <small>
                            {t('room.thought')}:{' '}
                            {t(`models.think_${seat.profile.thinkMode}`)}
                          </small>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="arena-metric-line">
                  <span>{t('room.plies')}</span>
                  <strong>{data.replay.frames.at(-1)?.ply || 0}</strong>
                </div>
                <div className="arena-metric-line">
                  <span>{t('replay.rules_version')}</span>
                  <code>{data.replay.rulesVersion}</code>
                </div>
                <div className="arena-metric-line">
                  <span>{t('replay.prompt_version')}</span>
                  <code>{data.replay.promptVersion}</code>
                </div>
              </section>
              <div className="arena-note">
                <ShieldCheck size={19} />
                <p>{t('community.clone_note')}</p>
              </div>
            </aside>
          </div>
          <section className="arena-panel arena-discussion">
            <div className="arena-discussion-summary">
              <h2>{t('community.notes')}</h2>
              <p>{data.post.description || t('community.no_description')}</p>
              <div className="arena-discussion-actions">
                {data.isAdmin && (
                  <Link href="/moderation" className="arena-text-link">
                    <ShieldCheck size={15} />
                    {t('moderation.title')}
                  </Link>
                )}
                <Button
                  className={`arena-button secondary ${data.liked ? 'liked' : ''}`}
                  disabled={!session?.user || mutation.isPending}
                  onClick={() =>
                    mutation.mutate({ action: 'like', liked: !data.liked })
                  }
                >
                  <Heart
                    size={17}
                    fill={data.liked ? 'currentColor' : 'none'}
                  />
                  {data.post.likes || 0} {t('community.likes')}
                </Button>
                <Button
                  variant="ghost"
                  disabled={!session?.user}
                  onClick={() => setReport(!report)}
                >
                  <Flag size={15} />
                  {t('community.report')}
                </Button>
                {(data.canManage || data.isAdmin) && (
                  <Button
                    variant="ghost"
                    onClick={() => setConfirmRemove(!confirmRemove)}
                  >
                    <Trash2 size={15} />
                    {t(
                      data.canManage
                        ? 'community.unpublish'
                        : 'community.moderate'
                    )}
                  </Button>
                )}
              </div>
              <ErrorNotice error={mutation.error} />
              {report && (
                <div className="arena-report-form">
                  <label className="arena-field">
                    <span>{t('community.report_reason')}</span>
                    <textarea
                      value={reportText}
                      maxLength={1000}
                      onChange={(e) => setReportText(e.target.value)}
                    />
                  </label>
                  <SubmitButton
                    pending={mutation.isPending}
                    disabled={!reportText.trim()}
                    onClick={() =>
                      mutation.mutate({ action: 'report', reason: reportText })
                    }
                  >
                    {t('community.report_submit')}
                  </SubmitButton>
                </div>
              )}
              {confirmRemove && (
                <div className="arena-end-confirm">
                  <p>{t('community.remove_confirm')}</p>
                  <Button
                    variant="destructive"
                    disabled={mutation.isPending}
                    onClick={() =>
                      mutation.mutate({
                        action: data.canManage ? 'unpublish' : 'moderate',
                      })
                    }
                  >
                    {t('confirm')}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => setConfirmRemove(false)}
                  >
                    {t('cancel')}
                  </Button>
                </div>
              )}
            </div>
            <div className="arena-comments">
              <h2>
                <MessageCircle size={20} />
                {t('community.discussion')}
                <span>{data.comments.length}</span>
              </h2>
              {session?.user ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void commentForm.handleSubmit();
                  }}
                >
                  <commentForm.Field name="body">
                    {(field) => (
                      <label className="arena-field">
                        <span className="sr-only">
                          {t('community.comment_placeholder')}
                        </span>
                        <textarea
                          value={field.state.value}
                          maxLength={2000}
                          onChange={(e) => field.handleChange(e.target.value)}
                          placeholder={t('community.comment_placeholder')}
                          required
                        />
                      </label>
                    )}
                  </commentForm.Field>
                  <SubmitButton pending={mutation.isPending} type="submit">
                    <Send size={15} />
                    {t('community.comment_submit')}
                  </SubmitButton>
                </form>
              ) : (
                <div className="arena-comment-signin">
                  <Link className="arena-text-link" href="/sign-in">
                    {t('community.signin_comment')}
                    <ArrowRight size={15} />
                  </Link>
                </div>
              )}
              <div className="arena-comment-list">
                {data.comments.length ? (
                  data.comments.map((comment) => (
                    <article className="arena-comment" key={comment.id}>
                      <span className="arena-avatar">
                        {comment.authorName?.slice(0, 1) || 'A'}
                      </span>
                      <div>
                        <header>
                          <strong>{comment.authorName}</strong>
                          <span>{formatDate(comment.createdAt)}</span>
                        </header>
                        <p>{comment.body}</p>
                      </div>
                    </article>
                  ))
                ) : (
                  <p className="arena-caption">{t('community.no_comments')}</p>
                )}
              </div>
            </div>
          </section>
        </>
      )}
    </ArenaShell>
  );
}
