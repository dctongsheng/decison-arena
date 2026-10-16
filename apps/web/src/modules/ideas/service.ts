import {
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  like,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import { db } from '@/core/db';
import { idea, ideaVote, user, type Idea } from '@/config/db/schema';
import { getUuid } from '@/lib/hash';

export type IdeaStatus =
  | 'pending'
  | 'planned'
  | 'in_progress'
  | 'done'
  | 'declined';

export const IDEA_STATUSES: IdeaStatus[] = [
  'pending',
  'planned',
  'in_progress',
  'done',
  'declined',
];

export type IdeaSort = 'hot' | 'new';

export const IDEA_SORTS: IdeaSort[] = ['hot', 'new'];

export const IDEA_CONTENT_MAX = 2000;
export const IDEA_ADMIN_NOTE_MAX = 1000;

/**
 * A board row as returned to the client. Deliberately carries neither the
 * author's user id nor their email — `isOwn` is everything the UI needs.
 */
export interface IdeaView {
  id: string;
  content: string;
  status: IdeaStatus;
  isPublic: boolean;
  voteCount: number;
  adminNote: string | null;
  createdAt: Date;
  authorName: string | null;
  authorAvatar: string | null;
  isOwn: boolean;
  hasVoted: boolean;
}

export interface AdminIdeaView extends Idea {
  userName: string | null;
  userEmail: string | null;
  userAvatar: string | null;
}

// parseInt('abc') yields NaN, which sqlite silently coerces but Postgres
// rejects outright — normalize here so all three dialects behave the same.
function clampPage(page?: number) {
  if (!Number.isFinite(page)) return 1;
  return Math.max(1, Math.floor(page as number));
}

function clampPageSize(pageSize?: number, max = 50) {
  if (!Number.isFinite(pageSize)) return 20;
  return Math.min(max, Math.max(1, Math.floor(pageSize as number)));
}

/**
 * Cap free-text search. `%`/`_` are LIKE wildcards, so an unbounded pattern
 * from an anonymous caller is a cheap way to make the database work hard.
 */
function clampSearch(search?: string) {
  if (!search) return undefined;
  const trimmed = search.trim().slice(0, 100);
  return trimmed || undefined;
}

/**
 * List ideas for the public board or a signed-in user's feed.
 *
 * Visibility is expressed in the WHERE clause — never filtered after the
 * fetch. `viewerId` (who is asking, drives hasVoted/isOwn) is kept separate
 * from `includeOwnPrivate` (whether their private ideas join the result), so
 * the public page can show correct vote state without ever leaking a private
 * idea.
 *
 * Runs a fixed three queries regardless of page size — no N+1.
 */
export async function listIdeas(params: {
  viewerId?: string;
  includeOwnPrivate?: boolean;
  page?: number;
  pageSize?: number;
  sort?: IdeaSort;
  status?: IdeaStatus;
  search?: string;
}): Promise<{ items: IdeaView[]; total: number }> {
  const page = clampPage(params.page);
  const pageSize = clampPageSize(params.pageSize);
  const search = clampSearch(params.search);
  const sort: IdeaSort = params.sort === 'new' ? 'new' : 'hot';

  const visibility: SQL =
    params.viewerId && params.includeOwnPrivate
      ? or(eq(idea.isPublic, true), eq(idea.userId, params.viewerId))!
      : eq(idea.isPublic, true);

  const conditions: SQL[] = [visibility];
  if (params.status) conditions.push(eq(idea.status, params.status));
  if (search) conditions.push(like(idea.content, `%${search}%`));
  const where = and(...conditions);

  const [totalResult] = await db()
    .select({ count: count() })
    .from(idea)
    .where(where);

  const orderBy =
    sort === 'hot'
      ? [desc(idea.voteCount), desc(idea.createdAt)]
      : [desc(idea.createdAt)];

  const rows = await db()
    .select({
      id: idea.id,
      userId: idea.userId,
      content: idea.content,
      status: idea.status,
      isPublic: idea.isPublic,
      voteCount: idea.voteCount,
      adminNote: idea.adminNote,
      createdAt: idea.createdAt,
      authorName: user.name,
      authorAvatar: user.image,
      // user.email is deliberately not selected — see listAllIdeas for admins.
    })
    .from(idea)
    .leftJoin(user, eq(idea.userId, user.id))
    .where(where)
    .orderBy(...orderBy)
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  let votedIds = new Set<string>();
  if (params.viewerId && rows.length) {
    const voteRows = await db()
      .select({ ideaId: ideaVote.ideaId })
      .from(ideaVote)
      .where(
        and(
          eq(ideaVote.userId, params.viewerId),
          inArray(
            ideaVote.ideaId,
            rows.map((r: { id: string }) => r.id)
          )
        )
      );
    votedIds = new Set(voteRows.map((v: { ideaId: string }) => v.ideaId));
  }

  const items: IdeaView[] = rows.map((r: (typeof rows)[number]) => ({
    id: r.id,
    content: r.content,
    status: r.status as IdeaStatus,
    isPublic: !!r.isPublic,
    voteCount: r.voteCount,
    adminNote: r.adminNote ?? null,
    createdAt: r.createdAt,
    authorName: r.authorName,
    authorAvatar: r.authorAvatar,
    isOwn: !!params.viewerId && r.userId === params.viewerId,
    hasVoted: votedIds.has(r.id),
  }));

  return { items, total: totalResult.count };
}

/**
 * Create an idea. Public and pending review by default.
 *
 * The row is built first and returned as-is rather than via `.returning()`,
 * which MySQL does not support.
 */
export async function createIdea(params: {
  userId: string;
  content: string;
}): Promise<Idea> {
  const now = new Date();
  const row = {
    id: getUuid(),
    userId: params.userId,
    content: params.content,
    status: 'pending',
    isPublic: true,
    voteCount: 0,
    adminNote: null,
    createdAt: now,
    updatedAt: now,
  };
  await db().insert(idea).values(row);
  return row as Idea;
}

/**
 * Toggle the caller's vote on an idea and return the fresh count.
 *
 * `voteCount` is denormalized onto `idea` so the hot sort stays index-only;
 * it is only ever mutated here, inside the same transaction as the vote row.
 * `updatedAt` is intentionally left alone — a vote is not an edit.
 */
export async function toggleVote(params: {
  ideaId: string;
  userId: string;
}): Promise<{ voted: boolean; voteCount: number }> {
  return db().transaction(async (tx: any) => {
    const [existing] = await tx
      .select({ id: ideaVote.id })
      .from(ideaVote)
      .where(
        and(
          eq(ideaVote.ideaId, params.ideaId),
          eq(ideaVote.userId, params.userId)
        )
      )
      .limit(1);

    if (existing) {
      await tx.delete(ideaVote).where(eq(ideaVote.id, existing.id));
      // The gt() guard keeps the counter off negative numbers without needing
      // GREATEST/MAX, which differ across sqlite/postgres/mysql.
      await tx
        .update(idea)
        .set({ voteCount: sql`${idea.voteCount} - 1` })
        .where(and(eq(idea.id, params.ideaId), gt(idea.voteCount, 0)));
    } else {
      try {
        await tx.insert(ideaVote).values({
          id: getUuid(),
          ideaId: params.ideaId,
          userId: params.userId,
          createdAt: new Date(),
        });
        await tx
          .update(idea)
          .set({ voteCount: sql`${idea.voteCount} + 1` })
          .where(eq(idea.id, params.ideaId));
      } catch (e: any) {
        // A concurrent double-click hit the unique index. Treat it as already
        // voted and do NOT bump the counter a second time.
        if (!/unique|duplicate/i.test(String(e?.message))) throw e;
      }
    }

    const [row] = await tx
      .select({ voteCount: idea.voteCount })
      .from(idea)
      .where(eq(idea.id, params.ideaId))
      .limit(1);

    return { voted: !existing, voteCount: row?.voteCount ?? 0 };
  });
}

export async function getIdeaById(id: string): Promise<Idea | undefined> {
  const [row] = await db().select().from(idea).where(eq(idea.id, id)).limit(1);
  return row;
}

/**
 * Admin: list every idea regardless of visibility, with submitter info.
 * This is the only listing that exposes the author's email.
 */
export async function listAllIdeas(params: {
  page?: number;
  pageSize?: number;
  status?: IdeaStatus;
  isPublic?: boolean;
  search?: string;
}): Promise<{ items: AdminIdeaView[]; total: number }> {
  const page = clampPage(params.page);
  const pageSize = clampPageSize(params.pageSize, 100);
  const search = clampSearch(params.search);

  const conditions: SQL[] = [];
  if (params.status) conditions.push(eq(idea.status, params.status));
  if (params.isPublic !== undefined)
    conditions.push(eq(idea.isPublic, params.isPublic));
  if (search) {
    conditions.push(
      or(
        like(idea.content, `%${search}%`),
        like(user.email, `%${search}%`),
        like(user.name, `%${search}%`)
      )!
    );
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const base = db()
    .select({ count: count() })
    .from(idea)
    .leftJoin(user, eq(idea.userId, user.id));
  const [totalResult] = await (where ? base.where(where) : base);

  const query = db()
    .select({
      id: idea.id,
      userId: idea.userId,
      content: idea.content,
      status: idea.status,
      isPublic: idea.isPublic,
      voteCount: idea.voteCount,
      adminNote: idea.adminNote,
      createdAt: idea.createdAt,
      updatedAt: idea.updatedAt,
      userName: user.name,
      userEmail: user.email,
      userAvatar: user.image,
    })
    .from(idea)
    .leftJoin(user, eq(idea.userId, user.id));

  const items = await (where ? query.where(where) : query)
    .orderBy(desc(idea.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return { items: items as AdminIdeaView[], total: totalResult.count };
}

/**
 * Admin: update status, visibility and/or the public reply.
 * Only the keys present in `patch` are written.
 */
export async function adminUpdateIdea(
  id: string,
  patch: {
    status?: IdeaStatus;
    isPublic?: boolean;
    adminNote?: string | null;
  }
): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.isPublic !== undefined) set.isPublic = patch.isPublic;
  if (patch.adminNote !== undefined) set.adminNote = patch.adminNote;
  await db().update(idea).set(set).where(eq(idea.id, id));
}

/**
 * Admin: hard-delete an idea. Votes go first — they hold the foreign key,
 * and leaving them behind would strand rows the counter can never reconcile.
 */
export async function adminDeleteIdea(id: string): Promise<void> {
  await db().transaction(async (tx: any) => {
    await tx.delete(ideaVote).where(eq(ideaVote.ideaId, id));
    await tx.delete(idea).where(eq(idea.id, id));
  });
}
