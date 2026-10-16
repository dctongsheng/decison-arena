import { createFileRoute } from '@tanstack/react-router';

import { getAuth } from '@/core/auth';
import {
  IDEA_STATUSES,
  listAllIdeas,
  type IdeaStatus,
} from '@/modules/ideas/service';
import { hasPermission } from '@/modules/rbac/service';
import { respErr, respPage } from '@/lib/resp';

async function checkAdmin(request: Request) {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) throw new Error('Unauthorized');
  const isAdmin = await hasPermission(session.user.id, 'admin.*');
  if (!isAdmin) throw new Error('Forbidden');
  return session;
}

async function GET({ request }: { request: Request }) {
  try {
    await checkAdmin(request);

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(searchParams.get('pageSize') || '20'))
    );
    const statusParam = searchParams.get('status') as IdeaStatus | null;
    const visibility = searchParams.get('visibility');
    const search = searchParams.get('keyword') || undefined;

    const { items, total } = await listAllIdeas({
      page,
      pageSize,
      status:
        statusParam && IDEA_STATUSES.includes(statusParam)
          ? statusParam
          : undefined,
      isPublic:
        visibility === 'public'
          ? true
          : visibility === 'private'
            ? false
            : undefined,
      search,
    });
    return respPage(items, total);
  } catch (error: any) {
    return respErr(error.message || 'Internal error');
  }
}

export const Route = createFileRoute('/api/admin/ideas')({
  server: {
    handlers: { GET },
  },
});
