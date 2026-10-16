import { createFileRoute } from '@tanstack/react-router';

import { getAuth } from '@/core/auth';
import {
  createIdea,
  IDEA_CONTENT_MAX,
  IDEA_SORTS,
  IDEA_STATUSES,
  listIdeas,
  type IdeaSort,
  type IdeaStatus,
} from '@/modules/ideas/service';
import { enforceMinIntervalRateLimit } from '@/lib/rate-limit';
import { respData, respErr, respPage } from '@/lib/resp';

// Readable without a session — the board is public.
async function GET({ request }: { request: Request }) {
  try {
    const auth = getAuth();
    const session = await auth.api
      .getSession({ headers: request.headers })
      .catch(() => null);

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
    const pageSize = Math.min(
      50,
      Math.max(1, parseInt(searchParams.get('pageSize') || '20'))
    );
    const sortParam = searchParams.get('sort') as IdeaSort | null;
    const statusParam = searchParams.get('status') as IdeaStatus | null;
    const search = searchParams.get('keyword') || undefined;
    const scope = searchParams.get('scope') === 'feed' ? 'feed' : 'public';

    // Who is asking (drives hasVoted/isOwn) is deliberately separate from
    // whether their private ideas join the result. On the public board a
    // signed-in visitor still gets correct vote state, but never sees a
    // private idea — not even their own.
    const viewerId = session?.user?.id;
    const includeOwnPrivate = scope === 'feed' && !!viewerId;

    const { items, total } = await listIdeas({
      viewerId,
      includeOwnPrivate,
      page,
      pageSize,
      sort: sortParam && IDEA_SORTS.includes(sortParam) ? sortParam : 'hot',
      status:
        statusParam && IDEA_STATUSES.includes(statusParam)
          ? statusParam
          : undefined,
      search,
    });
    return respPage(items, total);
  } catch (error: any) {
    return respErr(error.message || 'Internal error');
  }
}

async function POST({ request }: { request: Request }) {
  try {
    const auth = getAuth();
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return respErr('Unauthorized');

    // Prevent spam: at most one idea per 30s per user
    const limited = enforceMinIntervalRateLimit(request, {
      intervalMs: 30_000,
      keyPrefix: 'idea-create',
      extraKey: session.user.id,
    });
    if (limited) return limited;

    const body = await request.json().catch(() => ({}));
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!content) return respErr('Content is required');
    if (content.length > IDEA_CONTENT_MAX)
      return respErr('Content is too long');

    const row = await createIdea({ userId: session.user.id, content });
    return respData(row);
  } catch (error: any) {
    return respErr(error.message || 'Internal error');
  }
}

export const Route = createFileRoute('/api/ideas')({
  server: {
    handlers: { GET, POST },
  },
});
