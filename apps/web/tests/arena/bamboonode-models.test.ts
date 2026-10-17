import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decryptSecret } from '@decision-arena/providers';
import { createClient, type Client } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertBambooProfileAvailable,
  disconnectBambooConnection,
  getBambooConnection,
  syncBambooConnection,
} from '@/core/arena/bamboonode';
import { decryptBambooToken, encryptBambooToken } from '@/core/auth/bamboonode';
import {
  account,
  arenaBambooConnection,
  arenaCredential,
  arenaProfile,
  user,
} from '@/config/db/schema';
import * as arena from '@/modules/arena/service';

const env = vi.hoisted(() => ({
  auth_mode: 'bamboonode',
  bamboonode_issuer: 'https://api.bamboonode.dev',
  bamboonode_authorization_url: 'https://bamboonode.dev/oauth/authorize',
  bamboonode_token_url: 'https://api.bamboonode.dev/oauth/token',
  bamboonode_userinfo_url: 'https://api.bamboonode.dev/oauth/userinfo',
  bamboonode_client_id: 'fixture-client',
  bamboonode_client_secret: 'fixture-client-secret',
  bamboonode_scopes: 'openid profile email quota model_gateway',
}));
const secret = 'test-auth-secret-that-is-long-enough-for-encryption';
const vault = 'test-vault-secret-that-is-long-enough-for-encryption';
vi.mock('@/config', () => ({ envConfigs: env }));
vi.mock('@/core/auth', () => ({
  getAuth: async () => ({
    $context: Promise.resolve({
      secretConfig: 'test-auth-secret-that-is-long-enough-for-encryption',
    }),
  }),
}));
let client: Client;
let database: ReturnType<typeof drizzle>;
vi.mock('@/core/db', () => ({ db: () => database }));
let calls: { path: string; authorization: string | null; body: any }[];
let intercept: ((path: string) => Promise<Response | undefined>) | undefined;
const catalog = [
  {
    id: 'startlux-decision-27b-autothink',
    endpointPath: '/v1/decisions',
    protocol: 'systemone',
    supportsThinking: true,
  },
  {
    id: 'typesafe/jev-1.13',
    endpointPath: '/jev/v1/decisions',
    protocol: 'openrouter-decisions',
    supportsThinking: false,
  },
  {
    id: 'typesafe/jev-1.14',
    endpointPath: '/jev/v1/decisions',
    protocol: 'openrouter-decisions',
    supportsThinking: false,
  },
];
const allScopes = 'openid profile email quota model_gateway';
const globals = globalThis as typeof globalThis & { __CF_ENV__?: unknown };
async function linked(owner = 'alice', scope = allScopes, expired = false) {
  await database.insert(account).values({
    id: `account-${owner}`,
    accountId: `bamboo-${owner}`,
    providerId: 'bamboonode',
    userId: owner,
    scope,
    accessToken: await encryptBambooToken(`access-${owner}`, secret),
    refreshToken: await encryptBambooToken(`refresh-${owner}`, secret),
    accessTokenExpiresAt: new Date(Date.now() + (expired ? -1000 : 3600_000)),
  });
}
async function connection() {
  return (
    await database
      .select()
      .from(arenaBambooConnection)
      .where(eq(arenaBambooConnection.ownerId, 'alice'))
  )[0];
}

/** Pause one real SQL statement, leaving concurrent requests free to use SQLite. */
function pauseStatementOnce(
  matches: (query: string) => boolean,
  phase: 'before' | 'after'
) {
  const execute = client.execute.bind(client);
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let pending = true;
  const spy = vi
    .spyOn(client, 'execute')
    .mockImplementation(async (...args) => {
      const statement = args[0];
      const query = typeof statement === 'string' ? statement : statement.sql;
      if (!pending || !matches(query)) return execute(...args);
      pending = false;
      if (phase === 'before') {
        entered();
        await released;
        return execute(...args);
      }
      const result = await execute(...args);
      entered();
      await released;
      return result;
    });
  return { reached, release, restore: () => spy.mockRestore() };
}

async function freshAuthorization() {
  await database
    .update(account)
    .set({
      accessToken: await encryptBambooToken(
        'access-explicit-new-grant',
        secret
      ),
      refreshToken: await encryptBambooToken(
        'refresh-explicit-new-grant',
        secret
      ),
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      scope: allScopes,
    })
    .where(eq(account.id, 'account-alice'));
}
beforeEach(async () => {
  client = createClient({ url: ':memory:' });
  database = drizzle(client);
  const dir = fileURLToPath(new URL('../../drizzle/', import.meta.url));
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort())
    await client.executeMultiple(readFileSync(dir + file, 'utf8'));
  await database.insert(user).values([
    { id: 'alice', name: 'Alice', email: 'a@fixture.invalid' },
    { id: 'bob', name: 'Bob', email: 'b@fixture.invalid' },
  ]);
  globals.__CF_ENV__ = { ARENA_ENCRYPTION_KEY: vault };
  calls = [];
  intercept = undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://api.bamboonode.dev');
      expect(['manual', 'error']).toContain(init?.redirect);
      const headers = new Headers(init?.headers);
      calls.push({
        path: url.pathname,
        authorization: headers.get('authorization'),
        body: init?.body,
      });
      const custom = await intercept?.(url.pathname);
      if (custom) return custom;
      if (url.pathname === '/oauth/token')
        return Response.json({
          access_token: 'access-refreshed',
          refresh_token: 'refresh-rotated',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: allScopes,
        });
      if (url.pathname === '/oauth/userinfo')
        return Response.json({
          sub: 'bamboo-alice',
          email: 'a@fixture.invalid',
          name: 'Alice',
        });
      if (url.pathname.endsWith('/models'))
        return Response.json({ success: true, data: { items: catalog } });
      if (url.pathname.endsWith('/revoke'))
        return Response.json({ success: true, data: { revoked: true } });
      return Response.json({
        success: true,
        data: {
          key: 'sk-bag_fixture-model-key',
          expires_at: Math.floor(Date.now() / 1000) + 86400,
          models: catalog.map((m) => m.id),
        },
      });
    })
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  client.close();
  delete globals.__CF_ENV__;
  vi.unstubAllGlobals();
});

describe('BambooNode automatic model connection', () => {
  it('encrypts the owner-specific key and idempotently exposes the three managed profiles without secrets', async () => {
    await linked();
    expect(await syncBambooConnection('alice')).toMatchObject({
      status: 'connected',
      models: 3,
    });
    const before = await arena.listProfiles('alice');
    expect(before.items).toHaveLength(3);
    expect(
      before.items.every((p: any) => p.source === 'bamboonode' && p.available)
    ).toBe(true);
    expect(JSON.stringify(before)).not.toMatch(
      /sk-bag_|ciphertext|refreshToken|accessToken/
    );
    expect((await arena.listProfiles('bob')).items).toHaveLength(0);
    await syncBambooConnection('alice');
    expect(
      (await arena.listProfiles('alice')).items.map((p: any) => p.id)
    ).toEqual(before.items.map((p: any) => p.id));
    const keys = await database.select().from(arenaCredential);
    expect(keys).toHaveLength(1);
    expect(keys[0].ciphertext).not.toContain('sk-bag_');
    expect(await decryptSecret(keys[0].ciphertext, vault, 'alice')).toBe(
      'sk-bag_fixture-model-key'
    );
    await expect(
      decryptSecret(keys[0].ciphertext, vault, 'bob')
    ).rejects.toThrow();
    expect(
      calls
        .filter((c) => c.path.endsWith('/gateway-key'))
        .map((c) => JSON.parse(c.body).installation_id)[0]
    ).toBe(JSON.parse(calls.at(-1)!.body).installation_id);
  });
  it('requires the newly granted scopes, never assumes identity-only login grants model access', async () => {
    await linked('alice', 'openid profile email');
    expect(await syncBambooConnection('alice')).toMatchObject({
      status: 'reauthorize',
    });
    expect(calls).toHaveLength(0);
    expect((await arena.listProfiles('alice')).items).toHaveLength(0);
  });
  it('rotates expired OAuth tokens exactly once under parallel sync requests and persists encrypted tokens', async () => {
    await linked('alice', allScopes, true);
    await Promise.all([
      syncBambooConnection('alice'),
      syncBambooConnection('alice'),
    ]);
    expect(calls.filter((c) => c.path === '/oauth/token')).toHaveLength(1);
    expect(await getBambooConnection('alice')).toMatchObject({
      status: 'connected',
      models: 3,
    });
    const [row] = await database.select().from(account);
    expect(await decryptBambooToken(row.refreshToken!, secret)).toBe(
      'refresh-rotated'
    );
    expect(
      calls.filter((c) => c.path.endsWith('/models'))[0].authorization
    ).toBe('Bearer access-refreshed');
  });
  it('does not persist a refresh for a different authenticated Bamboo subject', async () => {
    await linked('alice', allScopes, true);
    const [before] = await database.select().from(account);
    intercept = async (path) =>
      path === '/oauth/userinfo'
        ? Response.json({
            sub: 'bamboo-bob',
            email: 'b@fixture.invalid',
            name: 'Bob',
          })
        : undefined;
    expect(await syncBambooConnection('alice')).toMatchObject({
      status: 'reauthorize',
      models: 0,
    });
    expect(calls.map((call) => call.path)).toEqual([
      '/oauth/token',
      '/oauth/userinfo',
    ]);
    const [after] = await database.select().from(account);
    expect(after.refreshToken).toBe(before.refreshToken);
    expect(after.accessToken).toBe(before.accessToken);
    expect(await database.select().from(arenaCredential)).toHaveLength(0);
    const count = calls.length;
    await syncBambooConnection('alice');
    expect(calls).toHaveLength(count);
  });

  it('does not claim a lease from a stale connected snapshot after disconnect completes', async () => {
    await linked();
    await syncBambooConnection('alice');
    const barrier = pauseStatementOnce(
      (query) =>
        query.startsWith('update "arena_bamboo_connections" set "lock_id"'),
      'before'
    );
    const pending = syncBambooConnection('alice');
    try {
      await barrier.reached;
      intercept = async (path) => {
        if (path.endsWith('/revoke'))
          throw new Error('fixture revocation unavailable');
        return undefined;
      };
      expect(await disconnectBambooConnection('alice')).toMatchObject({
        status: 'disconnected',
      });
      const count = calls.length;
      barrier.release();
      expect(await pending).toMatchObject({
        status: 'disconnected',
        models: 0,
      });
      expect(calls).toHaveLength(count);
      expect((await connection()).lockId).toBeNull();
      const [key] = await database.select().from(arenaCredential);
      expect(key.ciphertext).toBe('');
      expect(key.deletedAt).not.toBeNull();
    } finally {
      barrier.release();
      await pending;
      barrier.restore();
    }
  });

  it('does not refresh a stale account snapshot after another sync rotated and committed', async () => {
    await linked('alice', allScopes, true);
    const barrier = pauseStatementOnce(
      (query) =>
        query.startsWith('select ') && query.includes(' from "account" '),
      'after'
    );
    const staleRequest = syncBambooConnection('alice');
    try {
      await barrier.reached;
      expect(await syncBambooConnection('alice')).toMatchObject({
        status: 'connected',
        models: 3,
      });
      const [committedAccount] = await database.select().from(account);
      const committedConnection = await connection();
      const count = calls.length;
      barrier.release();
      expect(await staleRequest).toMatchObject({
        status: 'connected',
        models: 3,
      });
      expect(calls).toHaveLength(count);
      expect(calls.filter((call) => call.path === '/oauth/token')).toHaveLength(
        1
      );
      const [finalAccount] = await database.select().from(account);
      expect(finalAccount.refreshToken).toBe(committedAccount.refreshToken);
      expect((await connection()).oauthFingerprint).toBe(
        committedConnection.oauthFingerprint
      );
      expect((await connection()).lockId).toBeNull();
    } finally {
      barrier.release();
      await staleRequest;
      barrier.restore();
    }
  });

  it.each(['connected', 'disconnected', 'reauthorize'])(
    'GET exposes not_connected after a new explicit OAuth grant supersedes %s',
    async (status) => {
      await linked();
      await syncBambooConnection('alice');
      await database.update(arenaBambooConnection).set({ status });
      await freshAuthorization();
      const count = calls.length;
      expect(await getBambooConnection('alice')).toMatchObject({
        status: 'not_connected',
        models: 0,
      });
      expect(calls).toHaveLength(count);
      expect(await syncBambooConnection('alice')).toMatchObject({
        status: 'connected',
        models: 3,
      });
      expect(await getBambooConnection('alice')).toMatchObject({
        status: 'connected',
        models: 3,
      });
      expect(
        calls.filter((call) => call.path.endsWith('/gateway-key')).at(-1)
          ?.authorization
      ).toBe('Bearer access-explicit-new-grant');
    }
  );

  it('recognizes a new OAuth grant after an abandoned expired lease', async () => {
    await linked();
    await syncBambooConnection('alice');
    await database.update(arenaBambooConnection).set({
      status: 'reauthorize',
      lockId: 'abandoned-worker',
      lockExpiresAt: Date.now() - 1,
      phase: 'refresh',
    });
    await freshAuthorization();
    expect(await getBambooConnection('alice')).toMatchObject({
      status: 'not_connected',
      models: 0,
    });
    expect(await syncBambooConnection('alice')).toMatchObject({
      status: 'connected',
      models: 3,
    });
    expect((await connection()).lockId).toBeNull();
  });

  it.each([
    { label: 'reduced scope', patch: { scope: 'openid profile email' } },
    { label: 'missing refresh token', patch: { refreshToken: null } },
    { label: 'missing access token', patch: { accessToken: null } },
  ])(
    'GET and early sync persist model unavailability for $label',
    async ({ patch }) => {
      await linked();
      await syncBambooConnection('alice');
      const [profile] = await database.select().from(arenaProfile);
      await database
        .update(account)
        .set(patch)
        .where(eq(account.id, 'account-alice'));
      const count = calls.length;
      expect(await getBambooConnection('alice')).toMatchObject({
        status: 'reauthorize',
        models: 0,
      });
      expect((await connection()).status).toBe('reauthorize');
      expect(
        (await arena.listProfiles('alice')).items.every(
          (item: any) => !item.available
        )
      ).toBe(true);
      await expect(
        assertBambooProfileAvailable('alice', profile as any)
      ).rejects.toThrow();
      // Exercise the early POST path independently of GET's persisted invalidation.
      await database.update(arenaBambooConnection).set({ status: 'connected' });
      expect(await syncBambooConnection('alice')).toMatchObject({
        status: 'reauthorize',
        models: 0,
      });
      expect((await connection()).status).toBe('reauthorize');
      expect(calls).toHaveLength(count);
    }
  );

  it.each(['GET', 'sync'])(
    'does not overwrite fresh authorization while %s invalidates an old reduced-scope snapshot',
    async (method) => {
      await linked();
      await syncBambooConnection('alice');
      await database.update(account).set({ scope: 'openid profile email' });
      const barrier = pauseStatementOnce(
        (query) =>
          query.startsWith('update "arena_bamboo_connections" set "status"'),
        'before'
      );
      const pending =
        method === 'GET'
          ? getBambooConnection('alice')
          : syncBambooConnection('alice');
      try {
        await barrier.reached;
        await freshAuthorization();
        expect(await syncBambooConnection('alice')).toMatchObject({
          status: 'connected',
          models: 3,
        });
        const current = await connection();
        const count = calls.length;
        barrier.release();
        expect(await pending).toMatchObject({ status: 'syncing', models: 0 });
        expect((await connection()).status).toBe('connected');
        expect((await connection()).oauthFingerprint).toBe(
          current.oauthFingerprint
        );
        expect(await getBambooConnection('alice')).toMatchObject({
          status: 'connected',
          models: 3,
        });
        expect(calls).toHaveLength(count);
      } finally {
        barrier.release();
        await pending;
        barrier.restore();
      }
    }
  );

  it('tombstones an already-present new OAuth grant when disconnected before its first sync', async () => {
    await linked();
    await syncBambooConnection('alice');
    const previousFingerprint = (await connection()).oauthFingerprint;
    await freshAuthorization();
    expect(await getBambooConnection('alice')).toMatchObject({
      status: 'not_connected',
    });
    intercept = async (path) => {
      if (path.endsWith('/revoke'))
        throw new Error('fixture revocation unavailable');
      return undefined;
    };
    expect(await disconnectBambooConnection('alice')).toMatchObject({
      status: 'disconnected',
      models: 0,
    });
    expect((await connection()).oauthFingerprint).not.toBe(previousFingerprint);
    expect(await getBambooConnection('alice')).toMatchObject({
      status: 'disconnected',
      models: 0,
    });
    const count = calls.length;
    expect(await syncBambooConnection('alice')).toMatchObject({
      status: 'disconnected',
      models: 0,
    });
    expect(calls).toHaveLength(count);
    const [key] = await database.select().from(arenaCredential);
    expect(key.ciphertext).toBe('');
    expect(
      (await arena.listProfiles('alice')).items.every(
        (profile: any) => !profile.available
      )
    ).toBe(true);
  });
  it('does not retry an unknown refresh result until explicit reauthorization', async () => {
    await linked('alice', allScopes, true);
    intercept = async (path) => {
      if (path === '/oauth/token')
        throw new Error('network lost with sensitive response');
      return undefined;
    };
    expect(await syncBambooConnection('alice')).toMatchObject({
      status: 'reauthorize',
    });
    await syncBambooConnection('alice');
    expect(calls.filter((c) => c.path === '/oauth/token')).toHaveLength(1);
    expect(JSON.stringify(await getBambooConnection('alice'))).not.toContain(
      'sensitive'
    );
  });
  it('fails closed after an interrupted persisted refresh lease', async () => {
    await linked();
    await syncBambooConnection('alice');
    calls = [];
    await database.update(arenaBambooConnection).set({
      lockId: 'old-worker',
      lockExpiresAt: Date.now() - 1,
      phase: 'refresh',
    });
    expect(await syncBambooConnection('alice')).toMatchObject({
      status: 'reauthorize',
    });
    expect(calls).toHaveLength(0);
  });
  it('disconnects locally before remote revocation, forbids reuse, and only reconnects on a new explicit OAuth grant', async () => {
    await linked();
    await syncBambooConnection('alice');
    const [profile] = await database.select().from(arenaProfile);
    await expect(
      assertBambooProfileAvailable('bob', profile as any)
    ).rejects.toThrow();
    intercept = async (path) => {
      if (path.endsWith('/revoke')) {
        expect((await connection()).status).toBe('disconnected');
        throw new Error('upstream unavailable');
      }
      return undefined;
    };
    expect(await disconnectBambooConnection('alice')).toMatchObject({
      status: 'disconnected',
      models: 0,
    });
    const count = calls.length;
    expect(await syncBambooConnection('alice')).toMatchObject({
      status: 'disconnected',
    });
    expect(calls).toHaveLength(count);
    await expect(
      assertBambooProfileAvailable('alice', profile as any)
    ).rejects.toThrow();
    const [key] = await database.select().from(arenaCredential);
    expect(key.ciphertext).toBe('');
    await database.update(account).set({
      refreshToken: await encryptBambooToken('explicit-new-grant', secret),
    });
    intercept = undefined;
    expect(await syncBambooConnection('alice')).toMatchObject({
      status: 'connected',
      models: 3,
    });
  });
  it('does not resurrect a key when disconnected during issuance', async () => {
    await linked();
    intercept = async (path) => {
      if (path.endsWith('/gateway-key'))
        await disconnectBambooConnection('alice');
      return undefined;
    };
    expect(await syncBambooConnection('alice')).toMatchObject({
      status: 'disconnected',
    });
    expect(await database.select().from(arenaCredential)).toHaveLength(0);
    expect(await database.select().from(arenaProfile)).toHaveLength(0);
  });
  it('rejects redirected/mismatched model routes and disables removed catalog models', async () => {
    await linked();
    await syncBambooConnection('alice');
    intercept = async (path) =>
      path.endsWith('/models')
        ? Response.json({
            success: true,
            data: {
              items: [
                { ...catalog[0], endpointPath: 'https://evil.invalid' },
                catalog[1],
              ],
            },
          })
        : undefined;
    expect(await syncBambooConnection('alice')).toMatchObject({
      status: 'connected',
      models: 1,
    });
    expect(
      (await arena.listProfiles('alice')).items
        .filter((p: any) => p.available)
        .map((p: any) => p.model)
    ).toEqual(['typesafe/jev-1.13']);
    intercept = async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://bamboonode.cn' },
      });
    expect(await syncBambooConnection('alice')).toMatchObject({
      status: 'error',
    });
  });
  it('prevents BYOK CRUD and profile tests from reusing or changing the managed credential', async () => {
    await linked();
    await syncBambooConnection('alice');
    const [p] = await database.select().from(arenaProfile);
    await expect(
      arena.deleteCredential('alice', p.credentialId)
    ).rejects.toThrow(/managed/);
    await expect(
      arena.saveCredential('alice', {
        id: p.credentialId,
        name: 'change',
        apiKey: 'fixture-secret',
      })
    ).rejects.toThrow(/managed/);
    await expect(arena.deleteProfile('alice', p.id)).rejects.toThrow(/managed/);
    const forged = {
      name: 'Leak',
      provider: 'custom-systemone',
      endpoint: 'https://evil.invalid',
      credentialId: p.credentialId,
    };
    await expect(arena.saveProfile('alice', forged)).rejects.toThrow(/managed/);
    await expect(arena.testProfile('alice', forged)).rejects.toThrow(/managed/);
    await expect(
      arena.saveProfile('alice', {
        id: p.id,
        name: 'Overwrite',
        provider: 'systemone',
        apiKey: 'fixture-manual-key',
      })
    ).rejects.toThrow(/managed/);
  });
});
