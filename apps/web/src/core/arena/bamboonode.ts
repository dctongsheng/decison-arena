/** Server-only BambooNode account-to-model bridge. Never return upstream tokens. */
import type { ModelProfile } from '@decision-arena/core';
import {
  encryptSecret,
  ENDPOINTS,
  isBambooNodeProvider,
} from '@decision-arena/providers';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import { getAuth } from '@/core/auth';
import {
  BAMBOO_ISSUER,
  bambooSettings,
  decryptBambooToken,
  encryptBambooToken,
  getBambooIdentity,
  hasBambooGatewayScopes,
  refreshBambooTokens,
} from '@/core/auth/bamboonode';
import { db } from '@/core/db';
import { envConfigs } from '@/config';
import {
  account,
  arenaCredential,
  arenaBambooConnection as connection,
} from '@/config/db/schema';

import { ArenaError, vaultMasterKey } from './runtime';

type Connection = typeof connection.$inferSelect;
type Account = typeof account.$inferSelect;
export interface BambooConnectionStatus {
  enabled: boolean;
  status:
    | 'not_connected'
    | 'connected'
    | 'reauthorize'
    | 'disconnected'
    | 'syncing'
    | 'error';
  models: number;
  expiresAt?: number;
  message?: string;
}
const specs = [
  {
    id: 'startlux-decision-27b-autothink',
    name: 'StartLux · BambooNode',
    provider: 'bamboonode-systemone' as const,
    path: '/v1/decisions',
    protocol: 'systemone',
    thinking: true,
  },
  {
    id: 'typesafe/jev-1.13',
    name: 'Jev 1.13 · BambooNode',
    provider: 'bamboonode-decisions' as const,
    path: '/jev/v1/decisions',
    protocol: 'openrouter-decisions',
    thinking: false,
  },
  {
    id: 'typesafe/jev-1.14',
    name: 'Jev 1.14 · BambooNode',
    provider: 'bamboonode-decisions' as const,
    path: '/jev/v1/decisions',
    protocol: 'openrouter-decisions',
    thinking: false,
  },
];
const modelsSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        endpointPath: z.string(),
        protocol: z.string(),
        supportsThinking: z.boolean(),
      })
    )
    .max(32),
});
const keySchema = z.object({
  key: z.string().startsWith('sk-bag_').max(4096),
  expires_at: z.number().int().positive(),
  models: z.array(z.string()).max(32),
});
class GatewayError extends Error {
  constructor(readonly reauthorize: boolean) {
    super('BambooNode connection failed.');
  }
}
const fingerprint = async (value: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
    ),
    (b) => b.toString(16).padStart(2, '0')
  ).join('');
const ownerWhere = (ownerId: string) => eq(connection.ownerId, ownerId);
async function readConnection(
  ownerId: string
): Promise<Connection | undefined> {
  return (
    await db().select().from(connection).where(ownerWhere(ownerId)).limit(1)
  )[0];
}
async function readAccount(ownerId: string): Promise<Account | undefined> {
  return (
    await db()
      .select()
      .from(account)
      .where(
        and(eq(account.userId, ownerId), eq(account.providerId, 'bamboonode'))
      )
      .limit(1)
  )[0];
}
const enabled = () => envConfigs.auth_mode === 'bamboonode';
function statusOf(row?: Connection): BambooConnectionStatus {
  let status = (row?.status ||
    'not_connected') as BambooConnectionStatus['status'];
  if (
    status === 'connected' &&
    (!row?.expiresAt || row.expiresAt <= Date.now())
  )
    status = 'reauthorize';
  return {
    enabled: enabled(),
    status,
    models: status === 'connected' ? JSON.parse(row!.modelsJson).length : 0,
    ...(row?.expiresAt ? { expiresAt: row.expiresAt } : {}),
    ...(row?.lastError ? { message: row.lastError } : {}),
  };
}

/** Incomplete/reduced grants must invalidate the same snapshot we inspected. */
async function requireAuthorization(
  ownerId: string,
  row: Connection | undefined,
  linked: Account | undefined
): Promise<BambooConnectionStatus> {
  const message =
    'BambooNode model permission is required. Sign in and authorize again.';
  if (!row) return { enabled: true, status: 'reauthorize', models: 0, message };
  // A deliberate disconnect remains a tombstone, even after its account expires.
  if (row.status === 'disconnected') return statusOf(row);
  const sameAccount = linked
    ? sql`exists(select 1 from account where id=${linked.id} and user_id=${ownerId} and provider_id='bamboonode' and access_token is ${linked.accessToken} and refresh_token is ${linked.refreshToken} and scope is ${linked.scope})`
    : sql`not exists(select 1 from account where user_id=${ownerId} and provider_id='bamboonode')`;
  const updated: Connection[] = await db()
    .update(connection)
    .set({
      status: 'reauthorize',
      lockId: null,
      lockExpiresAt: null,
      phase: null,
      lastError: message,
      updatedAt: Date.now(),
    })
    .where(
      and(
        ownerWhere(ownerId),
        eq(connection.status, row.status),
        eq(connection.oauthFingerprint, row.oauthFingerprint),
        eq(connection.accountId, row.accountId),
        sameAccount
      )
    )
    .returning();
  // Another callback/sync/disconnect won. The next status poll re-reads it;
  // this stale request must neither claim its privileges nor overwrite it.
  return updated.length
    ? statusOf(updated[0])
    : { enabled: true, status: 'syncing', models: 0 };
}

export async function getBambooConnection(
  ownerId: string
): Promise<BambooConnectionStatus> {
  if (!enabled()) return { enabled: false, status: 'not_connected', models: 0 };
  const row = await readConnection(ownerId);
  const linked = await readAccount(ownerId);
  if (
    !linked?.refreshToken ||
    !linked.accessToken ||
    !hasBambooGatewayScopes(linked.scope)
  )
    return requireAuthorization(ownerId, row, linked);
  if (row) {
    if (row.lockId && (row.lockExpiresAt || 0) > Date.now())
      return { ...statusOf(row), status: 'syncing' };
    if (
      row.accountId !== linked.id ||
      row.oauthFingerprint !== (await fingerprint(linked.refreshToken))
    )
      return { enabled: true, status: 'not_connected', models: 0 };
    return statusOf(row);
  }
  return {
    enabled: true,
    status:
      linked && hasBambooGatewayScopes(linked.scope) && linked.refreshToken
        ? 'not_connected'
        : 'reauthorize',
    models: 0,
  };
}

/** Fixed origin, no redirects, no cookies, bounded JSON; provider bodies never reach logs/UI. */
async function gateway(
  path:
    | '/api/bamboo/apps/models'
    | '/api/bamboo/apps/gateway-key'
    | '/api/bamboo/apps/gateway-key/revoke',
  token: string,
  installationId?: string
): Promise<unknown> {
  const response = await fetch(`${BAMBOO_ISSUER}${path}`, {
    method: installationId ? 'POST' : 'GET',
    redirect: 'manual',
    credentials: 'omit',
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(installationId ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(installationId
      ? { body: JSON.stringify({ installation_id: installationId }) }
      : {}),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new GatewayError([401, 403, 409].includes(response.status));
  }
  const reader = response.body?.getReader();
  if (!reader) throw new GatewayError(false);
  const parts: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.length;
    if (size > 32_768) {
      await reader.cancel();
      throw new GatewayError(false);
    }
    parts.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  const envelope = z
    .object({ success: z.literal(true), data: z.unknown() })
    .parse(JSON.parse(new TextDecoder().decode(bytes)));
  return envelope.data;
}

/** Cross-worker lease: refreshed grants and disconnects invalidate stale syncs. */
export async function syncBambooConnection(
  ownerId: string
): Promise<BambooConnectionStatus> {
  if (!enabled()) return getBambooConnection(ownerId);
  const settings = bambooSettings(envConfigs);
  let linked = await readAccount(ownerId);
  if (
    !linked?.refreshToken ||
    !linked.accessToken ||
    !hasBambooGatewayScopes(linked.scope)
  )
    return requireAuthorization(ownerId, await readConnection(ownerId), linked);
  if (!settings)
    return {
      enabled: true,
      status: 'reauthorize',
      models: 0,
      message:
        'BambooNode authentication configuration must be updated before authorizing model access.',
    };
  const now = Date.now();
  const grantFingerprint = await fingerprint(linked.refreshToken);
  await db()
    .insert(connection)
    .values({
      ownerId,
      accountId: linked.id,
      installationId: crypto.randomUUID(),
      credentialId: crypto.randomUUID(),
      oauthFingerprint: grantFingerprint,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  let row = (await readConnection(ownerId))!;
  const newAuthorization =
    row.oauthFingerprint !== grantFingerprint || row.accountId !== linked.id;
  if (
    !newAuthorization &&
    ['disconnected', 'reauthorize'].includes(statusOf(row).status)
  )
    return statusOf(row);
  if (row.lockId && (row.lockExpiresAt || 0) > now)
    return { ...statusOf(row), status: 'syncing' };
  // Never replay a refresh whose single-use result may have been lost on restart.
  if (row.phase === 'refresh' && !newAuthorization) {
    await db()
      .update(connection)
      .set({
        status: 'reauthorize',
        lockId: null,
        lockExpiresAt: null,
        phase: null,
        lastError: 'A token refresh was interrupted. Authorize again.',
      })
      .where(and(ownerWhere(ownerId), eq(connection.lockId, row.lockId!)));
    return statusOf(await readConnection(ownerId));
  }
  const lockId = crypto.randomUUID();
  const claimed: Connection[] = await db()
    .update(connection)
    .set({ lockId, lockExpiresAt: now + 90_000, phase: 'sync', updatedAt: now })
    .where(
      and(
        ownerWhere(ownerId),
        or(isNull(connection.lockId), lt(connection.lockExpiresAt, now)),
        eq(connection.status, row.status),
        eq(connection.oauthFingerprint, row.oauthFingerprint),
        eq(connection.accountId, row.accountId),
        sql`exists(select 1 from account where id=${linked.id} and user_id=${ownerId} and provider_id='bamboonode' and refresh_token=${linked.refreshToken})`
      )
    )
    .returning();
  if (!claimed.length) {
    const current = await readConnection(ownerId);
    return current?.lockId
      ? { ...statusOf(current), status: 'syncing' }
      : getBambooConnection(ownerId);
  }
  row = claimed[0];
  const held = and(ownerWhere(ownerId), eq(connection.lockId, lockId));
  const ownsLease = sql`exists(select 1 from arena_bamboo_connections where owner_id=${ownerId} and lock_id=${lockId})`;
  let refreshing = false;
  try {
    vaultMasterKey();
    const secretConfig = (await (await getAuth()).$context).secretConfig;
    let accessToken = await decryptBambooToken(
      linked.accessToken!,
      secretConfig
    );
    if (
      !linked.accessTokenExpiresAt ||
      linked.accessTokenExpiresAt.getTime() <= Date.now() + 60_000
    ) {
      const oldRefresh = linked.refreshToken!;
      await db().update(connection).set({ phase: 'refresh' }).where(held);
      refreshing = true;
      const tokens = await refreshBambooTokens(
        settings,
        await decryptBambooToken(oldRefresh, secretConfig)
      );
      if (!hasBambooGatewayScopes(tokens.scopes)) throw new GatewayError(true);
      const identity = await getBambooIdentity(settings, tokens.accessToken);
      if (identity.id !== linked.accountId) throw new GatewayError(true);
      const refreshCiphertext = await encryptBambooToken(
        tokens.refreshToken,
        secretConfig
      );
      const accessCiphertext = await encryptBambooToken(
        tokens.accessToken,
        secretConfig
      );
      // Both SQLite/libsql and D1 batch are atomic. A callback or disconnect wins
      // over this refresh via the old-token compare and persisted lease predicate.
      const results = await db().batch([
        db()
          .update(account)
          .set({
            accessToken: accessCiphertext,
            refreshToken: refreshCiphertext,
            accessTokenExpiresAt: tokens.accessTokenExpiresAt,
            refreshTokenExpiresAt: tokens.refreshTokenExpiresAt ?? null,
            scope: tokens.scopes.join(','),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(account.id, linked.id),
              eq(account.userId, ownerId),
              eq(account.providerId, 'bamboonode'),
              eq(account.refreshToken, oldRefresh),
              ownsLease
            )
          )
          .returning({ id: account.id }),
        db()
          .update(connection)
          .set({
            oauthFingerprint: await fingerprint(refreshCiphertext),
            phase: 'sync',
          })
          .where(
            and(
              held,
              sql`exists(select 1 from account where id=${linked.id} and user_id=${ownerId} and refresh_token=${refreshCiphertext})`
            )
          ),
      ]);
      if (!results[0].length) throw new GatewayError(true);
      linked = {
        ...linked,
        accessToken: accessCiphertext,
        refreshToken: refreshCiphertext,
      };
      accessToken = tokens.accessToken;
      refreshing = false;
    }
    const directory = modelsSchema.parse(
      await gateway('/api/bamboo/apps/models', accessToken)
    );
    const allowed = specs.filter((spec) =>
      directory.items.some(
        (item) =>
          item.id === spec.id &&
          item.endpointPath === spec.path &&
          item.protocol === spec.protocol &&
          item.supportsThinking === spec.thinking
      )
    );
    const issued = keySchema.parse(
      await gateway(
        '/api/bamboo/apps/gateway-key',
        accessToken,
        row.installationId
      )
    );
    const expiresAt = issued.expires_at * 1000;
    if (
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= Date.now() ||
      expiresAt > Date.now() + 32 * 86400_000
    )
      throw new GatewayError(true);
    const catalog = allowed.filter((spec) => issued.models.includes(spec.id));
    const ciphertext = await encryptSecret(
      issued.key,
      vaultMasterKey(),
      ownerId
    );
    const tokenUnchanged = sql`exists(select 1 from account where id=${linked.id} and user_id=${ownerId} and provider_id='bamboonode' and refresh_token=${linked.refreshToken})`;
    const guard = sql`${ownsLease} and ${tokenUnchanged}`;
    // Guard every write so a disconnect during network I/O cannot resurrect a key.
    const writes = [
      db()
        .run(sql`insert into arena_credentials(id,owner_id,name,ciphertext,masked,created_at,deleted_at)
      select ${row.credentialId},${ownerId},'BambooNode account',${ciphertext},'BambooNode',${now},null where ${guard}
      on conflict(id) do update set ciphertext=excluded.ciphertext,masked=excluded.masked,deleted_at=null`),
    ];
    for (const spec of catalog) {
      const profileId = `bamboo-${(await fingerprint(`${row.credentialId}:${spec.id}`)).slice(0, 32)}`;
      writes.push(
        db()
          .run(sql`insert into arena_profiles(id,owner_id,name,provider,model,endpoint,credential_id,think_mode,think_budget,created_at,deleted_at)
        select ${profileId},${ownerId},${spec.name},${spec.provider},${spec.id},${ENDPOINTS[spec.provider]},${row.credentialId},${spec.thinking ? 'always' : 'never'},${spec.thinking ? 4096 : 1024},${now},null where ${guard}
        on conflict(id) do update set deleted_at=null`)
      );
    }
    writes.push(
      db()
        .update(connection)
        .set({
          accountId: linked.id,
          status: 'connected',
          expiresAt,
          modelsJson: JSON.stringify(catalog.map((spec) => spec.id)),
          oauthFingerprint: await fingerprint(linked.refreshToken!),
          lockId: null,
          lockExpiresAt: null,
          phase: null,
          lastError: null,
          lastSyncedAt: Date.now(),
          updatedAt: Date.now(),
        })
        .where(and(held, tokenUnchanged))
    );
    await db().batch(writes);
    // A concurrent callback superseded this sync; release without applying its key.
    await db()
      .update(connection)
      .set({ lockId: null, lockExpiresAt: null, phase: null })
      .where(held);
  } catch (error) {
    const reauthorize =
      refreshing || (error instanceof GatewayError && error.reauthorize);
    await db()
      .update(connection)
      .set({
        status: reauthorize ? 'reauthorize' : 'error',
        oauthFingerprint: await fingerprint(linked.refreshToken!),
        lockId: null,
        lockExpiresAt: null,
        phase: null,
        updatedAt: Date.now(),
        lastError: reauthorize
          ? 'BambooNode authorization expired or was revoked. Authorize again.'
          : 'BambooNode model sync failed. Check the service and retry sync.',
      })
      .where(held);
  }
  return statusOf(await readConnection(ownerId));
}

export async function disconnectBambooConnection(
  ownerId: string
): Promise<BambooConnectionStatus> {
  const row = await readConnection(ownerId);
  if (!row) return { enabled: enabled(), status: 'disconnected', models: 0 };
  const linked = await readAccount(ownerId);
  const disconnectedFingerprint = linked?.refreshToken
    ? await fingerprint(linked.refreshToken)
    : row.oauthFingerprint;
  // Local revocation is synchronous and wins even if the upstream service is down.
  await db().batch([
    db()
      .update(connection)
      .set({
        status: 'disconnected',
        oauthFingerprint: disconnectedFingerprint,
        accountId: linked?.id ?? row.accountId,
        lockId: null,
        lockExpiresAt: null,
        phase: null,
        lastError: null,
        updatedAt: Date.now(),
      })
      .where(ownerWhere(ownerId)),
    db()
      .update(arenaCredential)
      .set({ deletedAt: Date.now(), ciphertext: '' })
      .where(
        and(
          eq(arenaCredential.ownerId, ownerId),
          eq(arenaCredential.id, row.credentialId)
        )
      ),
  ]);
  try {
    if (
      !linked?.accessToken ||
      !linked.accessTokenExpiresAt ||
      linked.accessTokenExpiresAt.getTime() <= Date.now()
    )
      throw new GatewayError(true);
    const secretConfig = (await (await getAuth()).$context).secretConfig;
    await gateway(
      '/api/bamboo/apps/gateway-key/revoke',
      await decryptBambooToken(linked.accessToken, secretConfig),
      row.installationId
    );
  } catch {
    await db()
      .update(connection)
      .set({
        lastError:
          'Disconnected locally. Remote revocation was not confirmed; revoke access in BambooNode or retry disconnect.',
      })
      .where(and(ownerWhere(ownerId), eq(connection.status, 'disconnected')));
  }
  return statusOf(await readConnection(ownerId));
}

/** Used by all key/profile mutations, including a BYOK profile referencing this key. */
export async function assertUnmanagedCredential(
  ownerId: string,
  credentialId: string
) {
  const [row] = await db()
    .select({ id: connection.ownerId })
    .from(connection)
    .where(and(ownerWhere(ownerId), eq(connection.credentialId, credentialId)))
    .limit(1);
  if (row)
    throw new ArenaError(
      'BambooNode models are managed by your account connection. Use disconnect to revoke access.',
      403
    );
}
export async function assertBambooProfileAvailable(
  ownerId: string,
  profile: Pick<ModelProfile, 'provider' | 'model' | 'credentialId'>
) {
  if (!isBambooNodeProvider(profile.provider)) return;
  const row = await readConnection(ownerId);
  if (
    !row ||
    row.credentialId !== profile.credentialId ||
    row.status !== 'connected' ||
    !row.expiresAt ||
    row.expiresAt <= Date.now() ||
    !JSON.parse(row.modelsJson).includes(profile.model)
  )
    throw new ArenaError(
      'BambooNode model access is unavailable. Sync or authorize your account again.',
      403
    );
}
export async function bambooAvailableModels(
  ownerId: string
): Promise<string[]> {
  const row = await readConnection(ownerId);
  return row && statusOf(row).status === 'connected'
    ? JSON.parse(row.modelsJson)
    : [];
}
