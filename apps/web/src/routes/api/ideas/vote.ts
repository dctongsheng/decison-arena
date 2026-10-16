import { createFileRoute } from '@tanstack/react-router';

import { getAuth } from '@/core/auth';
import { getIdeaById, toggleVote } from '@/modules/ideas/service';
import { enforceMinIntervalRateLimit } from '@/lib/rate-limit';
import { respData, respErr } from '@/lib/resp';

async function POST({ request }: { request: Request }) {
  try {
    const auth = getAuth();
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return respErr('Unauthorized');

    const limited = enforceMinIntervalRateLimit(request, {
      intervalMs: 1_000,
      keyPrefix: 'idea-vote',
      extraKey: session.user.id,
    });
    if (limited) return limited;

    const body = await request.json().catch(() => ({}));
    const ideaId = typeof body.ideaId === 'string' ? body.ideaId : '';
    if (!ideaId) return respErr('Idea is required');

    // Re-check visibility server-side. "Doesn't exist" and "you can't see it"
    // return the same message so this can't be used as an existence oracle.
    const row = await getIdeaById(ideaId);
    if (!row || (!row.isPublic && row.userId !== session.user.id)) {
      return respErr('Idea not found');
    }

    const result = await toggleVote({ ideaId, userId: session.user.id });
    return respData(result);
  } catch (error: any) {
    return respErr(error.message || 'Internal error');
  }
}

export const Route = createFileRoute('/api/ideas/vote')({
  server: {
    handlers: { POST },
  },
});
