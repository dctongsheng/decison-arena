import { createFileRoute } from '@tanstack/react-router';

import { getAuth } from '@/core/auth';
import {
  adminDeleteIdea,
  adminUpdateIdea,
  getIdeaById,
  IDEA_ADMIN_NOTE_MAX,
  IDEA_STATUSES,
  type IdeaStatus,
} from '@/modules/ideas/service';
import { hasPermission } from '@/modules/rbac/service';
import { respErr, respOk } from '@/lib/resp';

async function checkAdmin(request: Request) {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) throw new Error('Unauthorized');
  const isAdmin = await hasPermission(session.user.id, 'admin.*');
  if (!isAdmin) throw new Error('Forbidden');
  return session;
}

// Admin sets status / visibility / the public reply
async function PATCH({
  request,
  params,
}: {
  request: Request;
  params: { id: string };
}) {
  try {
    await checkAdmin(request);
    const row = await getIdeaById(params.id);
    if (!row) return respErr('Idea not found');

    const body = await request.json().catch(() => ({}));
    const patch: {
      status?: IdeaStatus;
      isPublic?: boolean;
      adminNote?: string | null;
    } = {};

    if (body.status !== undefined) {
      if (!IDEA_STATUSES.includes(body.status))
        return respErr('Invalid status');
      patch.status = body.status;
    }
    if (body.isPublic !== undefined) {
      if (typeof body.isPublic !== 'boolean')
        return respErr('Invalid visibility');
      patch.isPublic = body.isPublic;
    }
    if (body.adminNote !== undefined) {
      if (body.adminNote !== null && typeof body.adminNote !== 'string')
        return respErr('Invalid note');
      const note =
        typeof body.adminNote === 'string' ? body.adminNote.trim() : '';
      if (note.length > IDEA_ADMIN_NOTE_MAX) return respErr('Note is too long');
      patch.adminNote = note || null; // empty string clears the note
    }

    if (!Object.keys(patch).length) return respErr('Nothing to update');

    await adminUpdateIdea(params.id, patch);
    return respOk();
  } catch (error: any) {
    return respErr(error.message || 'Internal error');
  }
}

async function DELETE({
  request,
  params,
}: {
  request: Request;
  params: { id: string };
}) {
  try {
    await checkAdmin(request);
    const row = await getIdeaById(params.id);
    if (!row) return respErr('Idea not found');

    await adminDeleteIdea(params.id);
    return respOk();
  } catch (error: any) {
    return respErr(error.message || 'Internal error');
  }
}

export const Route = createFileRoute('/api/admin/ideas/$id')({
  server: {
    handlers: { PATCH, DELETE },
  },
});
