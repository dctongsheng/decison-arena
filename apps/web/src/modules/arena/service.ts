import type {
  ArcadeReplayV2,
  ArcadeSession,
  CreateArcadeInput,
  CreateMatchInput,
  DecisionResponse,
  MatchSnapshot,
  ModelProfile,
  ReplayManifest,
  SeatConfig,
} from '@decision-arena/core';
import {
  decryptSecret,
  encryptSecret,
  isBambooNodeProvider,
  maskSecret,
  validateEndpoint,
} from '@decision-arena/providers';
import {
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  or,
  sql,
} from 'drizzle-orm';
import { z } from 'zod';

import {
  assertBambooProfileAvailable,
  assertUnmanagedCredential,
  bambooAvailableModels,
} from '@/core/arena/bamboonode';
import { publicReplay, type PublicReplay } from '@/core/arena/public-replay';
import {
  arenaBindings,
  ArenaError,
  runnerJson,
  vaultMasterKey,
} from '@/core/arena/runtime';
import {
  arcadeCommandInput,
  commandInput,
  communityActionInput,
  createArcadeInput,
  createMatchInput,
  credentialInput,
  profileInput,
  publicationInput,
} from '@/core/arena/validation';
import { matchPermission, RoleStatus } from '@/core/auth/rbac';
import { db } from '@/core/db';
import {
  arenaComment,
  arenaCredential,
  arenaLike,
  arenaMatch,
  arenaProfile,
  arenaPublication,
  arenaReport,
  permission,
  role,
  rolePermission,
  user,
  userRole,
  type ArenaProfile,
  type ArenaPublication,
} from '@/config/db/schema';
import { getUuid } from '@/lib/hash';

/** Reuse the template content-moderator permission, honoring revocation. */
export async function canModerate(ownerId: string): Promise<boolean> {
  const permissions: { code: string }[] = await db()
    .select({ code: permission.code })
    .from(userRole)
    .innerJoin(role, eq(userRole.roleId, role.id))
    .innerJoin(rolePermission, eq(rolePermission.roleId, role.id))
    .innerJoin(permission, eq(rolePermission.permissionId, permission.id))
    .where(
      and(
        eq(userRole.userId, ownerId),
        eq(role.status, RoleStatus.ACTIVE),
        isNull(rolePermission.deletedAt),
        or(isNull(userRole.expiresAt), gt(userRole.expiresAt, new Date()))
      )
    );
  return matchPermission(
    'admin.posts.write',
    permissions.map((item) => item.code)
  );
}

export async function listCredentials(ownerId: string) {
  return {
    items: await db()
      .select({
        id: arenaCredential.id,
        name: arenaCredential.name,
        masked: arenaCredential.masked,
        createdAt: arenaCredential.createdAt,
      })
      .from(arenaCredential)
      .where(
        and(
          eq(arenaCredential.ownerId, ownerId),
          isNull(arenaCredential.deletedAt)
        )
      )
      .orderBy(desc(arenaCredential.createdAt)),
  };
}

export async function saveCredential(ownerId: string, input: unknown) {
  const data = credentialInput.parse(input);
  if (data.id) await assertUnmanagedCredential(ownerId, data.id);
  if (/^(?:sk-)?bag_/.test(data.apiKey))
    throw new ArenaError(
      'Use your BambooNode account connection for this credential.',
      403
    );
  const ciphertext = await encryptSecret(
    data.apiKey,
    vaultMasterKey(),
    ownerId
  );
  const id = data.id || getUuid();
  if (data.id) {
    const changed = await db()
      .update(arenaCredential)
      .set({ name: data.name, ciphertext, masked: maskSecret(data.apiKey) })
      .where(
        and(
          eq(arenaCredential.id, id),
          eq(arenaCredential.ownerId, ownerId),
          isNull(arenaCredential.deletedAt)
        )
      )
      .returning({ id: arenaCredential.id });
    if (!changed.length) throw new ArenaError('Credential not found.', 404);
  } else {
    await db()
      .insert(arenaCredential)
      .values({
        id,
        ownerId,
        name: data.name,
        ciphertext,
        masked: maskSecret(data.apiKey),
        createdAt: Date.now(),
      });
  }
  return { id, name: data.name, masked: maskSecret(data.apiKey) };
}

async function ownCredential(ownerId: string, id: string) {
  const [row] = await db()
    .select()
    .from(arenaCredential)
    .where(
      and(
        eq(arenaCredential.id, id),
        eq(arenaCredential.ownerId, ownerId),
        isNull(arenaCredential.deletedAt)
      )
    )
    .limit(1);
  if (!row) throw new ArenaError('Credential not found.', 404);
  return row;
}

export async function deleteCredential(ownerId: string, id: string) {
  await ownCredential(ownerId, id);
  await assertUnmanagedCredential(ownerId, id);
  // Revocation is immediate even if a saved profile still refers to this key.
  await db()
    .update(arenaCredential)
    .set({ deletedAt: Date.now(), ciphertext: '' })
    .where(
      and(eq(arenaCredential.id, id), eq(arenaCredential.ownerId, ownerId))
    );
  return { deleted: true };
}

async function ownProfile(
  ownerId: string,
  id: string,
  requireCredential = true
): Promise<ArenaProfile> {
  const [row] = await db()
    .select()
    .from(arenaProfile)
    .where(
      and(
        eq(arenaProfile.id, id),
        eq(arenaProfile.ownerId, ownerId),
        isNull(arenaProfile.deletedAt)
      )
    )
    .limit(1);
  if (!row) throw new ArenaError('Model profile not found.', 404);
  if (requireCredential) {
    await ownCredential(ownerId, row.credentialId);
    await assertBambooProfileAvailable(ownerId, runnerProfile(row));
  }
  return row;
}

function runnerProfile(row: ArenaProfile): ModelProfile {
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    provider: row.provider as ModelProfile['provider'],
    model: row.model,
    endpoint: row.endpoint,
    credentialId: row.credentialId,
    thinkMode: row.thinkMode as ModelProfile['thinkMode'],
    thinkBudget: row.thinkBudget,
  };
}

export async function listProfiles(ownerId: string) {
  const rows = await db()
    .select({
      id: arenaProfile.id,
      name: arenaProfile.name,
      provider: arenaProfile.provider,
      model: arenaProfile.model,
      endpoint: arenaProfile.endpoint,
      thinkMode: arenaProfile.thinkMode,
      thinkBudget: arenaProfile.thinkBudget,
      createdAt: arenaProfile.createdAt,
      keyMask: arenaCredential.masked,
      credentialRevokedAt: arenaCredential.deletedAt,
    })
    .from(arenaProfile)
    .innerJoin(
      arenaCredential,
      eq(arenaProfile.credentialId, arenaCredential.id)
    )
    .where(
      and(
        eq(arenaProfile.ownerId, ownerId),
        eq(arenaCredential.ownerId, ownerId),
        isNull(arenaProfile.deletedAt)
      )
    )
    .orderBy(desc(arenaProfile.createdAt));
  const available = await bambooAvailableModels(ownerId);
  return {
    items: rows.map((row: (typeof rows)[number]) => ({
      ...row,
      source: isBambooNodeProvider(row.provider) ? 'bamboonode' : 'manual',
      available:
        !row.credentialRevokedAt &&
        (!isBambooNodeProvider(row.provider) || available.includes(row.model)),
    })),
  };
}

async function normalizeProfile(ownerId: string, input: unknown) {
  const data = profileInput.parse(input);
  if (data.credentialId)
    await assertUnmanagedCredential(ownerId, data.credentialId);
  if (data.id) {
    const saved = await ownProfile(ownerId, data.id, false);
    await assertUnmanagedCredential(ownerId, saved.credentialId);
  }
  const endpoint =
    data.provider === 'openrouter'
      ? 'https://openrouter.ai/api/alpha/decisions'
      : data.provider === 'systemone'
        ? 'https://startlux-decision.com/v1/systemone'
        : data.endpoint;
  if (
    (data.provider === 'openrouter' || data.provider === 'custom-openrouter') &&
    !data.model
  )
    throw new ArenaError('A model identifier is required.');
  try {
    let normalized = await validateEndpoint(endpoint, data.provider, {
      resolve: false,
    });
    if (data.provider.startsWith('custom-')) {
      // Public DNS and outbound restrictions must use the same workerd runtime
      // that performs inference, including when the web frontend runs in Node.
      const checked = await runnerJson<{ endpoint: string }>(
        ownerId,
        '/validate-endpoint',
        {
          method: 'POST',
          body: JSON.stringify({
            endpoint: normalized,
            provider: data.provider,
          }),
        }
      );
      normalized = checked.endpoint;
    }
    return {
      ...data,
      endpoint: normalized,
    };
  } catch (error) {
    if (error instanceof ArenaError) throw error;
    throw new ArenaError(
      error instanceof Error ? error.message : 'Invalid endpoint.'
    );
  }
}

export async function saveProfile(ownerId: string, input: unknown) {
  const data = await normalizeProfile(ownerId, input);
  const existing = data.id
    ? await ownProfile(ownerId, data.id, false)
    : undefined;
  let credentialId = data.credentialId || existing?.credentialId;
  if (credentialId && !data.apiKey) await ownCredential(ownerId, credentialId);
  if (data.apiKey) {
    const credential = await saveCredential(ownerId, {
      name: data.name,
      apiKey: data.apiKey,
    });
    credentialId = credential.id;
  }
  if (!credentialId)
    throw new ArenaError('An API key or credential is required.');
  const id = data.id || getUuid();
  const values = {
    name: data.name,
    provider: data.provider,
    model: data.model,
    endpoint: data.endpoint,
    credentialId,
    thinkMode: data.thinkMode,
    thinkBudget: data.thinkBudget,
  };
  if (existing)
    await db()
      .update(arenaProfile)
      .set(values)
      .where(and(eq(arenaProfile.id, id), eq(arenaProfile.ownerId, ownerId)));
  else
    await db()
      .insert(arenaProfile)
      .values({ id, ownerId, ...values, createdAt: Date.now() });
  if (existing && existing.credentialId !== credentialId)
    await revokeUnusedCredential(ownerId, existing.credentialId);
  const credential = await ownCredential(ownerId, credentialId);
  return { id, ...values, credentialId: undefined, keyMask: credential.masked };
}

export async function deleteProfile(ownerId: string, id: string) {
  const [row] = await db()
    .select({ id: arenaProfile.id, credentialId: arenaProfile.credentialId })
    .from(arenaProfile)
    .where(
      and(
        eq(arenaProfile.id, id),
        eq(arenaProfile.ownerId, ownerId),
        isNull(arenaProfile.deletedAt)
      )
    )
    .limit(1);
  if (!row) throw new ArenaError('Model profile not found.', 404);
  await assertUnmanagedCredential(ownerId, row.credentialId);
  await db()
    .update(arenaProfile)
    .set({ deletedAt: Date.now() })
    .where(and(eq(arenaProfile.id, id), eq(arenaProfile.ownerId, ownerId)));
  await revokeUnusedCredential(ownerId, row.credentialId);
  return { deleted: true };
}

async function revokeUnusedCredential(ownerId: string, credentialId: string) {
  const [used] = await db()
    .select({ id: arenaProfile.id })
    .from(arenaProfile)
    .where(
      and(
        eq(arenaProfile.credentialId, credentialId),
        eq(arenaProfile.ownerId, ownerId),
        isNull(arenaProfile.deletedAt)
      )
    )
    .limit(1);
  if (!used)
    await db()
      .update(arenaCredential)
      .set({ deletedAt: Date.now(), ciphertext: '' })
      .where(
        and(
          eq(arenaCredential.id, credentialId),
          eq(arenaCredential.ownerId, ownerId)
        )
      );
}

export async function testProfile(ownerId: string, input: unknown) {
  const object = z
    .object({ id: z.string().optional() })
    .passthrough()
    .parse(input);
  let profile: ModelProfile;
  let key: string;
  if (object.id && !('provider' in object)) {
    profile = runnerProfile(await ownProfile(ownerId, object.id));
    const credential = await ownCredential(ownerId, profile.credentialId);
    key = await decryptSecret(credential.ciphertext, vaultMasterKey(), ownerId);
  } else {
    const data = await normalizeProfile(ownerId, input);
    if (data.apiKey) key = data.apiKey;
    else if (data.credentialId)
      key = await decryptSecret(
        (await ownCredential(ownerId, data.credentialId)).ciphertext,
        vaultMasterKey(),
        ownerId
      );
    else if (data.id) {
      const saved = await ownProfile(ownerId, data.id);
      key = await decryptSecret(
        (await ownCredential(ownerId, saved.credentialId)).ciphertext,
        vaultMasterKey(),
        ownerId
      );
    } else throw new ArenaError('An API key is required.');
    profile = {
      ...data,
      id: data.id || 'connection-test',
      ownerId,
      credentialId: data.credentialId || 'unsaved',
    };
  }
  const decision = await runnerJson<DecisionResponse>(
    ownerId,
    '/provider-test',
    {
      method: 'POST',
      body: JSON.stringify({
        profile,
        key,
        request: {
          state: { task: 'Connection test: choose the only legal action.' },
          actions: [{ id: 'ready', label: 'Ready' }],
          instructions: 'Choose ready to confirm the decision API connection.',
        },
      }),
      signal: AbortSignal.timeout(125_000),
    }
  );
  return {
    actionId: decision.actionId,
    actualModel: decision.metrics.actualModel || profile.model,
    elapsedMs: decision.metrics.elapsedMs,
    thoughtUsed: decision.metrics.thoughtUsed,
  };
}

export async function listMatches(ownerId: string) {
  const rows = await db()
    .select()
    .from(arenaMatch)
    .where(
      and(
        eq(arenaMatch.ownerId, ownerId),
        inArray(arenaMatch.gameId, ['gomoku', 'xiangqi', 'army'])
      )
    )
    .orderBy(desc(arenaMatch.updatedAt))
    .limit(100);
  return {
    items: rows.map((row: typeof arenaMatch.$inferSelect) => {
      const summary = JSON.parse(row.summaryJson);
      return {
        ...summary,
        id: row.id,
        gameId: row.gameId,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        result: row.resultJson ? JSON.parse(row.resultJson) : summary.result,
      };
    }),
  };
}

export async function createMatch(ownerId: string, input: unknown) {
  const data = createMatchInput.parse(input);
  const sourcePost = data.cloneId ? await publication(data.cloneId) : undefined;
  const source = sourcePost
    ? await readPublicationReplay(sourcePost)
    : undefined;
  if (source && source.version !== 1)
    throw new ArenaError('Use the arcade creator for this replay.');
  const seats: SeatConfig[] = [];
  for (const [index, seat] of data.seats.entries()) {
    const sourceSeat = source?.seats[index];
    if (sourceSeat && sourceSeat.kind !== seat.kind)
      throw new ArenaError('Cloned games must keep the original seat types.');
    if (seat.kind === 'human') seats.push({ kind: 'human' });
    else {
      const profileId = seat.profileId || seat.profile?.id;
      if (!profileId)
        throw new ArenaError('Choose a saved model for each AI seat.');
      const selected = runnerProfile(await ownProfile(ownerId, profileId));
      if (sourceSeat) {
        if (!sourceSeat.profile)
          throw new ArenaError(
            'The published model configuration is unavailable.',
            502
          );
        if (selected.provider !== sourceSeat.profile.provider)
          throw new ArenaError(
            'Choose your own credentials for the original provider.'
          );
        // Frozen per-match model settings never overwrite the owner's saved profile.
        selected.name = sourceSeat.profile.name;
        selected.model = sourceSeat.profile.model;
        selected.thinkMode = sourceSeat.profile.thinkMode;
        selected.thinkBudget = sourceSeat.profile.thinkBudget;
      }
      await assertBambooProfileAvailable(ownerId, selected);
      seats.push({ kind: 'ai', profile: selected });
    }
  }
  if (sourcePost && (await publication(sourcePost.id)).status !== 'published')
    throw new ArenaError('Community replay not found.', 404);
  const payload: CreateMatchInput = {
    gameId: source?.gameId ?? data.gameId!,
    config: source?.config ?? data.config,
    seats: seats as [SeatConfig, SeatConfig],
    ...(!source && data.seed ? { seed: data.seed } : {}),
  };
  return runnerJson<MatchSnapshot>(ownerId, '/matches', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function getMatch(ownerId: string, id: string, query = '') {
  return runnerJson<MatchSnapshot>(ownerId, `/matches/${id}${query}`);
}
export async function commandMatch(
  ownerId: string,
  id: string,
  input: unknown,
  query = ''
) {
  return runnerJson<MatchSnapshot>(ownerId, `/matches/${id}/commands${query}`, {
    method: 'POST',
    body: JSON.stringify(commandInput.parse(input)),
  });
}
export async function getReplay(ownerId: string, id: string) {
  return runnerJson<ReplayManifest>(ownerId, `/matches/${id}/replay`);
}

export async function listArcadeSessions(ownerId: string) {
  const rows = await db()
    .select()
    .from(arenaMatch)
    .where(
      and(
        eq(arenaMatch.ownerId, ownerId),
        inArray(arenaMatch.gameId, ['snake', 'tetris', 'platformer'])
      )
    )
    .orderBy(desc(arenaMatch.updatedAt))
    .limit(100);
  return {
    items: rows.map((row: typeof arenaMatch.$inferSelect) => ({
      ...JSON.parse(row.summaryJson),
      id: row.id,
      engineKind: 'arcade',
      gameId: row.gameId,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      result: row.resultJson ? JSON.parse(row.resultJson) : undefined,
    })),
  };
}

export async function createArcadeSession(ownerId: string, input: unknown) {
  const data = createArcadeInput.parse(input);
  const sourcePost = data.cloneId ? await publication(data.cloneId) : undefined;
  const source = sourcePost
    ? await readPublicationReplay(sourcePost)
    : undefined;
  if (source && source.version !== 2)
    throw new ArenaError('Use the chess creator for this replay.');
  if (
    source &&
    (source.mode !== data.mode ||
      source.controllers.length !== data.controllers.length)
  )
    throw new ArenaError(
      'Cloned challenges must keep the original controller types.'
    );
  const controllers: SeatConfig[] = [];
  for (const [index, controller] of data.controllers.entries()) {
    const original = source?.controllers[index];
    if (original && original.kind !== controller.kind)
      throw new ArenaError(
        'Cloned challenges must keep the original controller types.'
      );
    if (controller.kind === 'human') {
      controllers.push({ kind: 'human' });
      continue;
    }
    const selected = runnerProfile(
      await ownProfile(ownerId, controller.profileId!)
    );
    if (original) {
      if (!original.profile || original.profile.provider !== selected.provider)
        throw new ArenaError(
          'Choose your own credentials for the original provider.'
        );
      // Only public model parameters are copied. The endpoint/key remain this owner's.
      selected.name = original.profile.name;
      selected.model = original.profile.model;
    }
    // Realtime controls always disable thinking, including cloned older challenges.
    // This is a per-session copy; the saved profile still serves chess unchanged.
    await assertBambooProfileAvailable(ownerId, selected);
    selected.thinkMode = 'never';
    controllers.push({ kind: 'ai', profile: selected });
  }
  if (sourcePost && (await publication(sourcePost.id)).status !== 'published')
    throw new ArenaError('Community replay not found.', 404);
  const payload: CreateArcadeInput = {
    gameId: source?.gameId ?? data.gameId,
    mode: source?.mode ?? data.mode,
    config: source?.config ?? data.config,
    seed: source?.seed ?? data.seed,
    controllers,
  };
  return runnerJson<ArcadeSession>(ownerId, '/arcade-sessions', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function getArcadeSession(
  ownerId: string,
  id: string,
  query = ''
) {
  return runnerJson<ArcadeSession>(ownerId, `/arcade-sessions/${id}${query}`);
}
export async function commandArcadeSession(
  ownerId: string,
  id: string,
  input: unknown
) {
  return runnerJson<ArcadeSession>(ownerId, `/arcade-sessions/${id}/commands`, {
    method: 'POST',
    body: JSON.stringify(arcadeCommandInput.parse(input)),
  });
}
export async function getArcadeReplay(ownerId: string, id: string) {
  return runnerJson<ArcadeReplayV2>(ownerId, `/arcade-sessions/${id}/replay`);
}

async function publication(id: string): Promise<ArenaPublication> {
  const [post] = await db()
    .select()
    .from(arenaPublication)
    .where(eq(arenaPublication.id, id))
    .limit(1);
  if (!post) throw new ArenaError('Community replay not found.', 404);
  return post;
}

async function readPublicationReplay(
  post: ArenaPublication
): Promise<PublicReplay> {
  if (post.status !== 'published')
    throw new ArenaError('Community replay not found.', 404);
  let serialized = post.replayJson;
  if (!serialized) {
    const object = await arenaBindings().REPLAYS?.get(post.replayKey);
    if (!object) throw new ArenaError('Replay artifact is unavailable.', 503);
    serialized = await object.text();
  }
  return publicReplay(JSON.parse(serialized));
}

async function publicationCards(posts: ArenaPublication[], viewerId?: string) {
  if (!posts.length) return [];
  const ids = posts.map((post) => post.id);
  const [authors, likes, comments, liked]: [
    { id: string; name: string }[],
    { id: string; total: number }[],
    { id: string; total: number }[],
    { id: string }[],
  ] = await Promise.all([
    db()
      .select({ id: user.id, name: user.name })
      .from(user)
      .where(inArray(user.id, [...new Set(posts.map((post) => post.ownerId))])),
    db()
      .select({ id: arenaLike.publicationId, total: count() })
      .from(arenaLike)
      .where(inArray(arenaLike.publicationId, ids))
      .groupBy(arenaLike.publicationId),
    db()
      .select({ id: arenaComment.publicationId, total: count() })
      .from(arenaComment)
      .where(
        and(
          inArray(arenaComment.publicationId, ids),
          isNull(arenaComment.deletedAt)
        )
      )
      .groupBy(arenaComment.publicationId),
    viewerId
      ? db()
          .select({ id: arenaLike.publicationId })
          .from(arenaLike)
          .where(
            and(
              inArray(arenaLike.publicationId, ids),
              eq(arenaLike.ownerId, viewerId)
            )
          )
      : Promise.resolve([]),
  ]);
  const authorNames = new Map(
    authors.map((author) => [author.id, author.name])
  );
  const likeCounts = new Map(likes.map((item) => [item.id, item.total]));
  const commentCounts = new Map(comments.map((item) => [item.id, item.total]));
  const likedIds = new Set(liked.map((item) => item.id));
  return posts.map((post) => {
    const summary = JSON.parse(post.summaryJson);
    return {
      id: post.id,
      matchId: post.matchId,
      title: post.title,
      description: post.description,
      gameId: post.gameId,
      status: post.status,
      createdAt: post.createdAt,
      authorName: authorNames.get(post.ownerId) || 'Player',
      likes: likeCounts.get(post.id) || 0,
      commentCount: commentCounts.get(post.id) || 0,
      result: summary.result,
      seats: summary.seats,
      engineKind: summary.engineKind ?? 'chess',
      controllers: summary.controllers,
      mode: summary.mode,
      liked: likedIds.has(post.id),
      canManage: viewerId === post.ownerId,
    };
  });
}

async function publicationCard(post: ArenaPublication, viewerId?: string) {
  return (await publicationCards([post], viewerId))[0];
}

export async function listCommunity(
  viewerId?: string,
  gameId?: string,
  model?: string
) {
  const term = z
    .string()
    .trim()
    .max(200)
    .parse(model || '')
    .toLowerCase();
  const pattern = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
  const rows: ArenaPublication[] = await db()
    .select()
    .from(arenaPublication)
    .where(
      and(
        eq(arenaPublication.status, 'published'),
        gameId ? eq(arenaPublication.gameId, gameId) : undefined,
        term
          ? sql`EXISTS (
              SELECT 1 FROM json_each(${arenaPublication.summaryJson}, '$.seats') AS seat
              WHERE lower(json_extract(seat.value, '$.profile.model')) LIKE ${pattern} ESCAPE '\\'
                OR lower(json_extract(seat.value, '$.profile.name')) LIKE ${pattern} ESCAPE '\\'
            )`
          : undefined
      )
    )
    .orderBy(desc(arenaPublication.createdAt))
    .limit(50);
  return {
    items: await publicationCards(rows, viewerId),
  };
}

export async function listReports(isAdmin: boolean) {
  if (!isAdmin) throw new ArenaError('Administrator access required.', 403);
  const items = await db()
    .select({
      id: arenaReport.id,
      publicationId: arenaReport.publicationId,
      reason: arenaReport.reason,
      createdAt: arenaReport.createdAt,
      title: arenaPublication.title,
      status: arenaPublication.status,
      reporterName: user.name,
    })
    .from(arenaReport)
    .innerJoin(
      arenaPublication,
      eq(arenaReport.publicationId, arenaPublication.id)
    )
    .innerJoin(user, eq(arenaReport.ownerId, user.id))
    .orderBy(desc(arenaReport.createdAt))
    .limit(100);
  return { items };
}

export async function publishReplay(ownerId: string, input: unknown) {
  const data = publicationInput.parse(input);
  const [match] = await db()
    .select()
    .from(arenaMatch)
    .where(
      and(eq(arenaMatch.id, data.matchId), eq(arenaMatch.ownerId, ownerId))
    )
    .limit(1);
  if (!match) throw new ArenaError('Match not found.', 404);
  if (match.status !== 'finished')
    throw new ArenaError('Only completed games can be published.');
  const [existing] = await db()
    .select()
    .from(arenaPublication)
    .where(eq(arenaPublication.matchId, data.matchId))
    .limit(1);
  if (existing?.status === 'removed')
    throw new ArenaError('This replay was removed by a moderator.', 403);
  const isArcade = JSON.parse(match.summaryJson).engineKind === 'arcade';
  const replay = publicReplay(
    await (isArcade
      ? getArcadeReplay(ownerId, data.matchId)
      : getReplay(ownerId, data.matchId))
  );
  if (replay.matchId !== data.matchId)
    throw new ArenaError('Replay identity does not match.', 502);
  const serialized = JSON.stringify(replay);
  if (serialized.length > 8_000_000)
    throw new ArenaError('Replay is too large to publish.', 413);
  const id = existing?.id || getUuid();
  const replayKey = `community/${id}.json`;
  const bucket = arenaBindings().REPLAYS;
  if (!bucket && process.env.NODE_ENV === 'production')
    throw new ArenaError('Community replay storage is not configured.', 503);
  if (bucket)
    await bucket.put(replayKey, serialized, {
      httpMetadata: { contentType: 'application/json' },
    });
  const now = Date.now();
  const values = {
    title: data.title,
    description: data.description,
    status: 'published',
    replayKey,
    replayJson: bucket ? null : serialized,
    summaryJson: JSON.stringify(
      replay.version === 2
        ? {
            engineKind: 'arcade',
            mode: replay.mode,
            result: replay.result,
            seats: replay.controllers,
            controllers: replay.controllers,
          }
        : { result: replay.result, seats: replay.seats }
    ),
    updatedAt: now,
  };
  if (existing)
    await db()
      .update(arenaPublication)
      .set(values)
      .where(
        and(
          eq(arenaPublication.id, id),
          eq(arenaPublication.ownerId, ownerId),
          sql`${arenaPublication.status} != 'removed'`
        )
      );
  else
    await db()
      .insert(arenaPublication)
      .values({
        id,
        ownerId,
        matchId: data.matchId,
        gameId: replay.gameId,
        createdAt: now,
        ...values,
      })
      .onConflictDoNothing();
  const [saved] = await db()
    .select()
    .from(arenaPublication)
    .where(eq(arenaPublication.matchId, data.matchId))
    .limit(1);
  if (!saved || saved.status !== 'published')
    throw new ArenaError(
      'This replay is no longer available for publication.',
      409
    );
  return publicationCard(saved, ownerId);
}

export async function communityDetail(
  id: string,
  viewerId?: string,
  isAdmin = false
) {
  const post = await publication(id);
  // Withdrawn artifacts are not reachable through a remembered community URL.
  const replay = await readPublicationReplay(post);
  const comments = await db()
    .select({
      id: arenaComment.id,
      body: arenaComment.content,
      authorName: user.name,
      createdAt: arenaComment.createdAt,
    })
    .from(arenaComment)
    .innerJoin(user, eq(arenaComment.ownerId, user.id))
    .where(
      and(eq(arenaComment.publicationId, id), isNull(arenaComment.deletedAt))
    )
    .orderBy(arenaComment.createdAt)
    .limit(200);
  const card = await publicationCard(post, viewerId);
  return {
    post: card,
    replay,
    comments,
    liked: card.liked,
    canManage: card.canManage,
    isAdmin,
  };
}

export async function communityAction(
  ownerId: string,
  id: string,
  input: unknown,
  isAdmin = false
) {
  const data = communityActionInput.parse(input);
  const post = await publication(id);
  if (data.action === 'moderate') {
    if (!isAdmin) throw new ArenaError('Administrator access required.', 403);
    await db()
      .update(arenaPublication)
      .set({ status: 'removed', updatedAt: Date.now() })
      .where(eq(arenaPublication.id, id));
    return { status: 'removed' };
  }
  if (data.action === 'unpublish') {
    if (post.ownerId !== ownerId)
      throw new ArenaError('Replay not found.', 404);
    if (post.status === 'removed')
      throw new ArenaError('This replay was removed by a moderator.', 403);
    await db()
      .update(arenaPublication)
      .set({ status: 'unpublished', updatedAt: Date.now() })
      .where(
        and(eq(arenaPublication.id, id), eq(arenaPublication.ownerId, ownerId))
      );
    return { status: 'unpublished' };
  }
  if (post.status !== 'published')
    throw new ArenaError('Community replay not found.', 404);
  if (data.action === 'like') {
    const [existing] = await db()
      .select({ id: arenaLike.id })
      .from(arenaLike)
      .where(
        and(eq(arenaLike.publicationId, id), eq(arenaLike.ownerId, ownerId))
      )
      .limit(1);
    const liked = data.liked ?? !existing;
    if (liked)
      await db()
        .insert(arenaLike)
        .values({
          id: getUuid(),
          publicationId: id,
          ownerId,
          createdAt: Date.now(),
        })
        .onConflictDoNothing();
    else
      await db()
        .delete(arenaLike)
        .where(
          and(eq(arenaLike.publicationId, id), eq(arenaLike.ownerId, ownerId))
        );
    const [total] = await db()
      .select({ total: count() })
      .from(arenaLike)
      .where(eq(arenaLike.publicationId, id));
    return { liked, likes: total.total };
  }
  if (data.action === 'comment') {
    const comment = {
      id: getUuid(),
      publicationId: id,
      ownerId,
      content: data.body,
      createdAt: Date.now(),
    };
    await db().insert(arenaComment).values(comment);
    const [author] = await db()
      .select({ name: user.name })
      .from(user)
      .where(eq(user.id, ownerId))
      .limit(1);
    return {
      id: comment.id,
      body: comment.content,
      authorName: author?.name || 'Player',
      createdAt: comment.createdAt,
    };
  }
  await db()
    .insert(arenaReport)
    .values({
      id: getUuid(),
      publicationId: id,
      ownerId,
      reason: data.reason,
      createdAt: Date.now(),
    })
    .onConflictDoNothing();
  return { reported: true };
}
