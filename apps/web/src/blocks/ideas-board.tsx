import { useState } from 'react';
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { useSession } from '@/core/auth/client';
import { tDynamic } from '@/core/i18n/dynamic';
import { Link } from '@/core/i18n/navigation';
import { apiGet, apiPost, type PageResult } from '@/lib/api-client';
import { formatRelativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { m } from '@/paraglide/messages.js';
import { getLocale } from '@/paraglide/runtime.js';
import { IdeaItem } from '@/components/idea-item';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';

const PAGE_SIZE = 20;
const CONTENT_MAX = 2000;

type IdeaStatus = 'pending' | 'planned' | 'in_progress' | 'done' | 'declined';

type Sort = 'hot' | 'new';
const SORTS: Sort[] = ['hot', 'new'];

const STATUS_BADGE: Record<
  IdeaStatus,
  'default' | 'secondary' | 'outline' | 'destructive'
> = {
  pending: 'outline',
  planned: 'secondary',
  in_progress: 'default',
  done: 'secondary',
  declined: 'outline',
};

export interface IdeaRow {
  id: string;
  content: string;
  status: IdeaStatus;
  isPublic: boolean;
  voteCount: number;
  adminNote: string | null;
  createdAt: string;
  authorName: string | null;
  authorAvatar: string | null;
  isOwn: boolean;
  hasVoted: boolean;
}

export interface IdeasBoardProps {
  /**
   * `feed` mixes the signed-in user's own private ideas into the list;
   * `public` shows only ideas that are public for everyone.
   */
  scope: 'public' | 'feed';
  /** SSR-rendered first page (sort=hot), used as react-query initialData. */
  initialData?: PageResult<IdeaRow>;
}

export function IdeasBoard({ scope, initialData }: IdeasBoardProps) {
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const locale = getLocale();
  const signedIn = !!session?.user;

  const [sort, setSort] = useState<Sort>('hot');
  const [page, setPage] = useState(1);
  const [content, setContent] = useState('');

  const listQuery = useQuery({
    queryKey: ['ideas', scope, sort, page],
    queryFn: () => {
      const params = new URLSearchParams({
        scope,
        sort,
        page: String(page),
        pageSize: String(PAGE_SIZE),
      });
      return apiGet<PageResult<IdeaRow>>(`/api/ideas?${params}`);
    },
    placeholderData: keepPreviousData,
    // Only the first hot page matches what the server rendered.
    initialData: sort === 'hot' && page === 1 ? initialData : undefined,
  });

  const items = listQuery.data?.items ?? [];
  const total = listQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['ideas', scope] });

  const voteMutation = useMutation({
    mutationFn: (ideaId: string) =>
      apiPost<{ voted: boolean; voteCount: number }>('/api/ideas/vote', {
        ideaId,
      }),
    onSuccess: () => refresh(),
    onError: (e: Error) => toast.error(e.message || m['ideas.vote_failed']()),
  });

  const createMutation = useMutation({
    mutationFn: (value: string) => apiPost('/api/ideas', { content: value }),
    onSuccess: () => {
      setContent('');
      toast.success(m['ideas.submit_success']());
      // A brand-new idea has no votes, so it is only visible under "newest".
      setSort('new');
      setPage(1);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function handleVote(ideaId: string) {
    if (!signedIn) {
      toast.error(m['ideas.sign_in_to_vote']());
      return;
    }
    voteMutation.mutate(ideaId);
  }

  function handleSubmit() {
    const value = content.trim();
    if (!value) {
      toast.error(m['ideas.content_required']());
      return;
    }
    if (value.length > CONTENT_MAX) {
      toast.error(m['ideas.content_too_long']());
      return;
    }
    createMutation.mutate(value);
  }

  return (
    <div className="space-y-4">
      <div className="border-border flex items-center justify-between gap-4 border-b">
        <div className="flex gap-1">
          {SORTS.map((s) => (
            <button
              key={s}
              onClick={() => {
                setSort(s);
                setPage(1);
              }}
              className={cn(
                '-mb-px border-b-2 px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors',
                sort === s
                  ? 'border-primary text-foreground'
                  : 'text-muted-foreground hover:text-foreground border-transparent'
              )}
            >
              {tDynamic(`ideas.sort_${s}`)}
            </button>
          ))}
        </div>
        {total > 0 && (
          <span className="text-muted-foreground pb-2 text-xs">
            {m['ideas.total']({ count: total })}
          </span>
        )}
      </div>

      <Card>
        <CardContent className="divide-border divide-y">
          {listQuery.isPending ? (
            <div className="text-muted-foreground flex items-center justify-center gap-2 py-12 text-sm">
              <Loader2 className="size-4 animate-spin" />
            </div>
          ) : items.length === 0 ? (
            <p className="text-muted-foreground py-12 text-center text-sm">
              {m['ideas.empty']()}
            </p>
          ) : (
            items.map((row) => (
              <IdeaItem
                key={row.id}
                content={row.content}
                authorLabel={
                  row.isOwn ? m['ideas.you']() : `@${row.authorName || '—'}`
                }
                authorAvatar={row.authorAvatar}
                statusLabel={tDynamic(`ideas.status_${row.status}`)}
                statusVariant={STATUS_BADGE[row.status] ?? 'outline'}
                timeLabel={formatRelativeTime(row.createdAt, locale)}
                voteCount={row.voteCount}
                hasVoted={row.hasVoted}
                voteLabel={
                  signedIn ? m['ideas.upvote']() : m['ideas.sign_in_to_vote']()
                }
                onVote={() => handleVote(row.id)}
                voteDisabled={voteMutation.isPending}
                adminNote={row.adminNote}
                adminNoteLabel={m['ideas.admin_note_label']()}
                privateLabel={row.isPublic ? null : m['ideas.private_badge']()}
              />
            ))
          )}
        </CardContent>
      </Card>

      {totalPages > 1 && page < totalPages && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            onClick={() => setPage((p) => p + 1)}
            disabled={listQuery.isFetching}
          >
            {m['ideas.load_more']()}
          </Button>
        </div>
      )}

      <Card>
        <CardContent className="space-y-3">
          {signedIn ? (
            <>
              <Textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={m['ideas.composer_placeholder']()}
                maxLength={CONTENT_MAX}
                rows={3}
                className="resize-none"
              />
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground text-xs tabular-nums">
                  {content.length}/{CONTENT_MAX}
                </span>
                <Button
                  onClick={handleSubmit}
                  disabled={createMutation.isPending || !content.trim()}
                >
                  {createMutation.isPending
                    ? m['ideas.submitting']()
                    : m['ideas.submit']()}
                </Button>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center gap-3 py-4">
              <p className="text-muted-foreground text-sm">
                {m['ideas.composer_placeholder']()}
              </p>
              <Link href="/sign-in" className={cn(buttonVariants())}>
                {m['ideas.sign_in_to_submit']()}
              </Link>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
