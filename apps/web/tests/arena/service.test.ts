import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateEndpoint } from '@decision-arena/providers';
import { createClient, type Client } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { publicReplay } from '@/core/arena/public-replay';
import {
  ArenaError,
  assertSameOrigin,
  matchQuery,
  runnerFetch,
} from '@/core/arena/runtime';
import {
  arenaCredential,
  arenaMatch,
  arenaProfile,
  arenaPublication,
  permission,
  role,
  rolePermission,
  user,
  userRole,
} from '@/config/db/schema';
import * as arena from '@/modules/arena/service';

let database: ReturnType<typeof drizzle>;
let client: Client;
vi.mock('@/core/db', () => ({ db: () => database }));
vi.mock('@decision-arena/providers', async (original) => ({
  ...(await original<typeof import('@decision-arena/providers')>()),
  decide: vi.fn(async () => ({
    actionId: 'ready',
    metrics: { elapsedMs: 12, actualModel: 'test-model' },
  })),
}));

const fakeKey = 'test-fixture-key-not-a-live-credential';
const profile = {
  name: 'Jev test',
  provider: 'openrouter',
  model: 'typesafe/test',
  apiKey: fakeKey,
  thinkMode: 'never',
};
const replay = {
  version: 1,
  matchId: 'match-a',
  gameId: 'gomoku',
  rulesVersion: '1',
  promptVersion: '1',
  seed: 'fixture',
  config: { size: 9 },
  seats: [
    {
      kind: 'ai',
      profile: {
        name: 'Jev',
        provider: 'openrouter',
        model: 'test',
        thinkMode: 'always',
        thinkBudget: 2048,
      },
    },
    { kind: 'human' },
  ],
  result: { winner: 0, reason: 'five-in-row' },
  createdAt: 1,
  finishedAt: 2,
  frames: [
    {
      gameId: 'gomoku',
      rows: 9,
      cols: 9,
      cells: Array(81).fill(null),
      turn: 0,
      phase: 'finished',
      ply: 9,
      legalActions: [],
      result: { winner: 0, reason: 'five-in-row' },
    },
  ],
  events: [],
};
let runnerCalls: Request[];
const globals = globalThis as typeof globalThis & { __CF_ENV__?: unknown };

beforeEach(async () => {
  client = createClient({ url: ':memory:' });
  database = drizzle(client);
  const migrations = fileURLToPath(new URL('../../drizzle/', import.meta.url));
  for (const file of readdirSync(migrations)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    await client.executeMultiple(readFileSync(`${migrations}/${file}`, 'utf8'));
  }
  await database.insert(user).values([
    { id: 'owner-a', name: 'Alice', email: 'alice@fixture.invalid' },
    { id: 'owner-b', name: 'Bob', email: 'bob@fixture.invalid' },
  ]);
  runnerCalls = [];
  globals.__CF_ENV__ = {
    ARENA_ENCRYPTION_KEY:
      'fixture-master-key-with-at-least-thirty-two-characters',
    MATCH_SERVICE: {
      fetch: async (request: Request) => {
        runnerCalls.push(request);
        if (new URL(request.url).pathname.endsWith('/replay'))
          return Response.json(replay);
        if (new URL(request.url).pathname === '/provider-test')
          return Response.json({
            actionId: 'ready',
            metrics: { elapsedMs: 12, actualModel: 'test-model' },
          });
        if (new URL(request.url).pathname === '/validate-endpoint') {
          const body = await request.clone().json();
          try {
            return Response.json({
              endpoint: await validateEndpoint(body.endpoint, body.provider, {
                resolve: false,
              }),
            });
          } catch {
            return Response.json(
              { error: 'Invalid custom endpoint.' },
              { status: 400 }
            );
          }
        }
        return Response.json({ id: 'match-created', status: 'ready' });
      },
    },
  };
});
afterEach(() => {
  client?.close();
  delete globals.__CF_ENV__;
  vi.unstubAllEnvs();
});

describe('community moderator authorization', () => {
  it('requires an active, unexpired role with an undeleted content permission', async () => {
    await database.insert(role).values({
      id: 'editor',
      name: 'editor',
      title: 'Editor',
      status: 'active',
    });
    await database.insert(permission).values({
      id: 'moderate',
      code: 'admin.posts.write',
      resource: 'posts',
      action: 'write',
      title: 'Moderate',
    });
    await database
      .insert(rolePermission)
      .values({ id: 'grant', roleId: 'editor', permissionId: 'moderate' });
    await database
      .insert(userRole)
      .values({ id: 'assignment', userId: 'owner-a', roleId: 'editor' });
    expect(await arena.canModerate('owner-a')).toBe(true);
    expect(await arena.canModerate('owner-b')).toBe(false);
    await database.update(role).set({ status: 'disabled' });
    expect(await arena.canModerate('owner-a')).toBe(false);
    await database.update(role).set({ status: 'active' });
    await database.update(rolePermission).set({ deletedAt: new Date() });
    expect(await arena.canModerate('owner-a')).toBe(false);
    await database.update(rolePermission).set({ deletedAt: null });
    await database
      .update(userRole)
      .set({ expiresAt: new Date(Date.now() - 1_000) });
    expect(await arena.canModerate('owner-a')).toBe(false);
    await database
      .update(userRole)
      .set({ expiresAt: new Date(Date.now() + 60_000) });
    expect(await arena.canModerate('owner-a')).toBe(true);
  });
});

describe('personal credential vault and model profiles', () => {
  it('encrypts stored keys and only returns masks, including model listings', async () => {
    const saved = await arena.saveProfile('owner-a', profile);
    const [secret] = await database.select().from(arenaCredential);
    expect(secret.ciphertext).toMatch(/^v1\./);
    expect(secret.ciphertext).not.toContain(fakeKey);
    const listed = await arena.listProfiles('owner-a');
    expect(listed.items[0].id).toBe(saved.id);
    expect(JSON.stringify(listed)).not.toContain(fakeKey);
    expect(listed.items[0]).not.toHaveProperty('credentialId');
    expect(await arena.listProfiles('owner-b')).toEqual({ items: [] });
  });

  it('fails closed without a vault key', async () => {
    globals.__CF_ENV__ = {};
    vi.stubEnv('ARENA_ENCRYPTION_KEY', '');
    await expect(
      arena.saveCredential('owner-a', {
        name: 'Missing vault',
        apiKey: fakeKey,
      })
    ).rejects.toMatchObject({ status: 503 });
    expect(await database.select().from(arenaCredential)).toHaveLength(0);
  });

  it('rejects foreign profile reads, edits and deletes', async () => {
    const saved = await arena.saveProfile('owner-a', profile);
    await expect(
      arena.saveProfile('owner-b', { ...profile, id: saved.id })
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      arena.deleteProfile('owner-b', saved.id)
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      arena.testProfile('owner-b', { id: saved.id })
    ).rejects.toMatchObject({ status: 404 });
    expect(await database.select().from(arenaProfile)).toHaveLength(1);
  });

  it('does not allow a foreign credential to be attached', async () => {
    const secret = await arena.saveCredential('owner-a', {
      name: 'Personal',
      apiKey: fakeKey,
    });
    await expect(
      arena.saveProfile('owner-b', {
        ...profile,
        apiKey: undefined,
        credentialId: secret.id,
      })
    ).rejects.toMatchObject({ status: 404 });
  });

  it('revokes a deleted model key and permits repairing a revoked profile', async () => {
    const saved = await arena.saveProfile('owner-a', profile);
    const [row] = await database.select().from(arenaProfile);
    await arena.deleteCredential('owner-a', row.credentialId);
    await expect(
      arena.testProfile('owner-a', { id: saved.id })
    ).rejects.toMatchObject({ status: 404 });
    await arena.saveProfile('owner-a', { ...profile, id: saved.id });
    await arena.deleteProfile('owner-a', saved.id);
    const keys = await database.select().from(arenaCredential);
    expect(keys.every((key) => key.deletedAt && key.ciphertext === '')).toBe(
      true
    );
  });

  it('tests an unsaved model without persisting its key', async () => {
    const result = await arena.testProfile('owner-a', profile);
    expect(result.actualModel).toBe('test-model');
    expect(await database.select().from(arenaCredential)).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(fakeKey);
  });

  it.each(['save', 'test'] as const)(
    'lets the runner reject private endpoints before %s without trusting a body allowlist',
    async (operation) => {
      const run = operation === 'save' ? arena.saveProfile : arena.testProfile;
      await expect(
        run('owner-a', {
          ...profile,
          provider: 'custom-openrouter',
          endpoint: 'http://127.0.0.1:8090',
          localEndpoints: ['http://127.0.0.1:8090'],
        })
      ).rejects.toBeInstanceOf(ArenaError);
      expect(runnerCalls).toHaveLength(1);
      expect(new URL(runnerCalls[0].url).pathname).toBe('/validate-endpoint');
      expect(await runnerCalls[0].clone().json()).toEqual({
        endpoint: 'http://127.0.0.1:8090',
        provider: 'custom-openrouter',
      });
      expect(await database.select().from(arenaCredential)).toHaveLength(0);
      expect(await database.select().from(arenaProfile)).toHaveLength(0);
    }
  );

  it.each(['save', 'test'] as const)(
    'uses an owner-authenticated runner-approved local endpoint for %s',
    async (operation) => {
      const endpoint = 'http://127.0.0.1:18080/v1/systemone';
      const submittedEndpoint = 'http://127.0.0.1:18080/v1/./systemone';
      const bindings = globals.__CF_ENV__ as {
        MATCH_SERVICE: { fetch(request: Request): Promise<Response> };
      };
      const originalFetch = bindings.MATCH_SERVICE.fetch;
      bindings.MATCH_SERVICE.fetch = async (request) => {
        if (new URL(request.url).pathname !== '/validate-endpoint')
          return originalFetch(request);
        runnerCalls.push(request);
        return Response.json({ endpoint });
      };
      const input = {
        ...profile,
        provider: 'custom-systemone',
        endpoint: submittedEndpoint,
        localEndpoints: ['http://attacker.invalid'],
      };
      if (operation === 'save') {
        const saved = await arena.saveProfile('owner-a', input);
        expect(saved.endpoint).toBe(endpoint);
        const [row] = await database.select().from(arenaProfile);
        expect(row.endpoint).toBe(endpoint);
        expect(runnerCalls).toHaveLength(1);
      } else {
        await arena.testProfile('owner-a', input);
        expect(runnerCalls).toHaveLength(2);
        expect(new URL(runnerCalls[1].url).pathname).toBe('/provider-test');
        const request = await runnerCalls[1].clone().json();
        expect(request.profile.endpoint).toBe(endpoint);
        expect(request.profile).not.toHaveProperty('localEndpoints');
        expect(await database.select().from(arenaCredential)).toHaveLength(0);
        expect(await database.select().from(arenaProfile)).toHaveLength(0);
      }
      expect(
        runnerCalls.every(
          (request) => request.headers.get('X-Arena-Owner') === 'owner-a'
        )
      ).toBe(true);
      expect(await runnerCalls[0].clone().json()).toEqual({
        endpoint: submittedEndpoint,
        provider: 'custom-systemone',
      });
    }
  );

  it.each([
    ['openrouter', 'https://openrouter.ai/api/alpha/decisions'],
    ['systemone', 'https://startlux-decision.com/v1/systemone'],
  ])(
    'keeps %s fixed without asking the custom endpoint validator',
    async (provider, endpoint) => {
      const saved = await arena.saveProfile('owner-a', {
        ...profile,
        provider,
        endpoint: 'http://127.0.0.1:18080/v1/systemone',
      });
      expect(saved.endpoint).toBe(endpoint);
      expect(runnerCalls).toHaveLength(0);
    }
  );

  it('validates custom DNS through the owner-authenticated runner before saving', async () => {
    const input = {
      ...profile,
      provider: 'custom-systemone',
      endpoint: 'https://models.provider.io/v1/systemone',
    };
    await arena.saveProfile('owner-a', input);
    const request = runnerCalls[0];
    expect(new URL(request.url).pathname).toBe('/validate-endpoint');
    expect(request.headers.get('X-Arena-Owner')).toBe('owner-a');
    expect(await request.json()).toEqual({
      endpoint: input.endpoint,
      provider: input.provider,
    });
    globals.__CF_ENV__ = {
      MATCH_SERVICE: {
        fetch: async () =>
          Response.json(
            { error: 'Endpoint must resolve only to public addresses' },
            { status: 400 }
          ),
      },
    };
    await expect(arena.saveProfile('owner-b', input)).rejects.toMatchObject({
      status: 400,
    });
    expect((await arena.listProfiles('owner-b')).items).toHaveLength(0);
  });
});

describe('match ownership', () => {
  it('forwards only a validated viewing seat and event cursor', async () => {
    const query = matchQuery(
      new URLSearchParams('seat=1&since=003&ownerId=owner-b')
    );
    expect(query).toBe('?seat=1&since=3');
    await arena.getMatch('owner-a', 'match-a', query);
    expect(runnerCalls[0].url).toBe(
      'https://match.internal/matches/match-a?seat=1&since=3'
    );
    expect(() => matchQuery(new URLSearchParams('seat=full'))).toThrow();
    expect(() => matchQuery(new URLSearchParams('since=-1'))).toThrow();
  });
  it('resolves model configuration from the owner record, ignoring browser overrides', async () => {
    const saved = await arena.saveProfile('owner-a', profile);
    await arena.createMatch('owner-a', {
      gameId: 'gomoku',
      seats: [
        {
          kind: 'ai',
          profile: {
            id: saved.id,
            ownerId: 'owner-b',
            endpoint: 'https://malicious.invalid',
            credentialId: 'foreign',
          },
        },
        { kind: 'human' },
      ],
    });
    const payload = await runnerCalls[0].json();
    expect(payload.seats[0].profile.ownerId).toBe('owner-a');
    expect(payload.seats[0].profile.endpoint).toBe(
      'https://openrouter.ai/api/alpha/decisions'
    );
    expect(runnerCalls[0].headers.get('X-Arena-Owner')).toBe('owner-a');
    expect(JSON.stringify(payload)).not.toContain(fakeKey);
    await expect(
      arena.createMatch('owner-b', {
        gameId: 'gomoku',
        seats: [{ kind: 'ai', profileId: saved.id }, { kind: 'human' }],
      })
    ).rejects.toMatchObject({ status: 404 });
  });

  it('does not allow a production URL fallback or spoofed internal identity', async () => {
    await runnerFetch('owner-a', '/matches/test', {
      headers: { 'X-Arena-Owner': 'owner-b', 'X-Arena-Admin': '1' },
    });
    expect(runnerCalls[0].headers.get('X-Arena-Owner')).toBe('owner-a');
    expect(runnerCalls[0].headers.get('X-Arena-Admin')).toBeNull();
    globals.__CF_ENV__ = {};
    vi.stubEnv('NODE_ENV', 'production');
    await expect(runnerFetch('owner-a', '/matches/test')).rejects.toMatchObject(
      { status: 503 }
    );
  });
});

describe('explicit community publication', () => {
  async function finished() {
    await database.insert(arenaMatch).values({
      id: 'match-a',
      ownerId: 'owner-a',
      gameId: 'gomoku',
      status: 'finished',
      summaryJson: '{}',
      createdAt: 1,
      updatedAt: 2,
      resultJson: JSON.stringify(replay.result),
    });
  }

  it('only publishes a completed game owned by the requesting user', async () => {
    await finished();
    expect(await arena.listCommunity()).toEqual({ items: [] });
    await expect(
      arena.publishReplay('owner-b', { matchId: 'match-a', title: 'Foreign' })
    ).rejects.toMatchObject({ status: 404 });
    await database
      .update(arenaMatch)
      .set({ status: 'running' })
      .where(eq(arenaMatch.id, 'match-a'));
    await expect(
      arena.publishReplay('owner-a', {
        matchId: 'match-a',
        title: 'Unfinished',
      })
    ).rejects.toMatchObject({ status: 400 });
  });

  it('supports replay, idempotent likes, comments, reports and withdrawal', async () => {
    await finished();
    const post = await arena.publishReplay('owner-a', {
      matchId: 'match-a',
      title: 'A match',
      description: 'Manual sharing',
    });
    expect((await arena.listCommunity()).items).toHaveLength(1);
    expect(
      (await arena.listCommunity(undefined, 'gomoku', 'JEV')).items
    ).toHaveLength(1);
    expect(
      (await arena.listCommunity(undefined, 'gomoku', 'TEST')).items
    ).toHaveLength(1);
    expect(
      (await arena.listCommunity(undefined, 'xiangqi', 'Jev')).items
    ).toHaveLength(0);
    expect(
      (await arena.listCommunity(undefined, undefined, '%')).items
    ).toHaveLength(0);
    expect((await arena.communityDetail(post.id, 'owner-a')).canManage).toBe(
      true
    );
    await arena.communityAction('owner-b', post.id, {
      action: 'like',
      liked: true,
    });
    await arena.communityAction('owner-b', post.id, {
      action: 'like',
      liked: true,
    });
    await arena.communityAction('owner-b', post.id, {
      action: 'comment',
      body: 'Good game',
    });
    await arena.communityAction('owner-b', post.id, {
      action: 'report',
      reason: 'Please review',
    });
    const detail = await arena.communityDetail(post.id, 'owner-b');
    expect(detail.post.likes).toBe(1);
    expect(detail.comments[0].body).toBe('Good game');
    expect((await arena.listReports(true)).items).toHaveLength(1);
    await expect(arena.listReports(false)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      arena.communityAction('owner-b', post.id, { action: 'unpublish' })
    ).rejects.toMatchObject({ status: 404 });
    await arena.communityAction('owner-a', post.id, { action: 'unpublish' });
    await expect(
      arena.communityDetail(post.id, 'owner-a')
    ).rejects.toMatchObject({ status: 404 });
    expect((await arena.listCommunity()).items).toHaveLength(0);
  });

  it('blocks non-admin moderation and republishing after takedown', async () => {
    await finished();
    const post = await arena.publishReplay('owner-a', {
      matchId: 'match-a',
      title: 'A match',
    });
    await expect(
      arena.communityAction('owner-b', post.id, { action: 'moderate' })
    ).rejects.toMatchObject({ status: 403 });
    await arena.communityAction(
      'owner-b',
      post.id,
      { action: 'moderate' },
      true
    );
    await expect(
      arena.publishReplay('owner-a', { matchId: 'match-a', title: 'Again' })
    ).rejects.toMatchObject({ status: 403 });
    await expect(arena.communityDetail(post.id)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('clones frozen public settings using only the new owner credentials', async () => {
    await finished();
    const source = await arena.publishReplay('owner-a', {
      matchId: 'match-a',
      title: 'Clone source',
    });
    const saved = await arena.saveProfile('owner-b', {
      ...profile,
      name: 'My private model',
      model: 'other/model',
      thinkMode: 'never',
      thinkBudget: 512,
    });
    const [original] = await database
      .select()
      .from(arenaProfile)
      .where(eq(arenaProfile.id, saved.id));
    await arena.createMatch('owner-b', {
      cloneId: source.id,
      gameId: 'xiangqi',
      config: { size: 15 },
      seed: 'do-not-copy',
      seats: [{ kind: 'ai', profileId: saved.id }, { kind: 'human' }],
    });
    const payload = await runnerCalls.at(-1)!.json();
    expect(payload.gameId).toBe('gomoku');
    expect(payload.config).toEqual({ size: 9 });
    expect(payload).not.toHaveProperty('seed');
    expect(payload.seats[0].profile).toMatchObject({
      id: saved.id,
      ownerId: 'owner-b',
      credentialId: original.credentialId,
      endpoint: original.endpoint,
      ...replay.seats[0].profile,
    });
    const [unchanged] = await database
      .select()
      .from(arenaProfile)
      .where(eq(arenaProfile.id, saved.id));
    expect(unchanged).toEqual(original);
    const wrongProvider = await arena.saveProfile('owner-b', {
      ...profile,
      provider: 'systemone',
    });
    await expect(
      arena.createMatch('owner-b', {
        cloneId: source.id,
        seats: [{ kind: 'ai', profileId: wrongProvider.id }, { kind: 'human' }],
      })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      arena.createMatch('owner-a', {
        cloneId: source.id,
        seats: [{ kind: 'ai', profileId: saved.id }, { kind: 'human' }],
      })
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      arena.createMatch('owner-b', {
        cloneId: source.id,
        seats: [{ kind: 'human' }, { kind: 'human' }],
      })
    ).rejects.toMatchObject({ status: 400 });
    await arena.communityAction('owner-a', source.id, { action: 'unpublish' });
    await expect(
      arena.createMatch('owner-b', {
        cloneId: source.id,
        seats: [{ kind: 'ai', profileId: saved.id }, { kind: 'human' }],
      })
    ).rejects.toMatchObject({ status: 404 });
  });

  it.each([
    ['bamboonode-systemone', 'startlux-decision-27b-autothink'],
    ['bamboonode-decisions', 'typesafe/jev-1.13'],
  ])('publishes and reads %s chess replays without private account data', async (provider, model) => {
    await finished();
    const privateReplay = {
      ...replay,
      seats: [{ kind: 'ai', profile: { ...replay.seats[0].profile, provider, model,
        ownerId: 'private-owner', credentialId: 'private-credential', endpoint: 'https://private.invalid',
        apiKey: fakeKey, accessToken: 'private-oauth-access', refreshToken: 'private-oauth-refresh' } }, { kind: 'human' }],
      events: [{ seq: 1, type: 'action', at: 2, seat: 0,
        action: { id: 'place:40', label: 'E5', to: 40 },
        reasoning: { text: 'private-account-thought', truncated: false }, metrics: { elapsedMs: 12 } }],
    };
    globals.__CF_ENV__ = { ...(globals.__CF_ENV__ as Record<string, unknown>),
      MATCH_SERVICE: { fetch: async () => Response.json(privateReplay) } };
    const post = await arena.publishReplay('owner-a', { matchId: 'match-a', title: 'BambooNode game' });
    const detail = await arena.communityDetail(post.id);
    if (detail.replay.version !== 1) throw new Error('Expected chess replay');
    expect(detail.replay.seats[0].profile).toMatchObject({ provider, model });
    expect(detail.replay.events[0].metrics?.elapsedMs).toBe(12);
    const serialized = JSON.stringify(detail);
    for (const value of [fakeKey, 'private-owner', 'private-credential', 'private.invalid', 'private-oauth', 'private-account-thought'])
      expect(serialized).not.toContain(value);
  });

  it('strips credential details and raw thoughts from public replay artifacts', () => {
    const leaked = {
      ...replay,
      apiKey: fakeKey,
      endpoint: 'https://private.invalid',
      config: { size: 9, credentialId: 'private' },
      seats: [
        {
          kind: 'ai',
          profile: {
            ...replay.seats[0].profile,
            apiKey: fakeKey,
            endpoint: 'private',
          },
        },
        { kind: 'human' },
      ],
      events: [
        { seq: 1, type: 'error', at: 1, message: fakeKey, thought: fakeKey },
        {
          seq: 2,
          type: 'action',
          at: 2,
          seat: 0,
          action: { id: 'place:40', label: 'E5', to: 40 },
          reasoning: { text: fakeKey, truncated: true },
          metrics: {
            elapsedMs: 12,
            thoughtUsed: true,
            reasoning: { text: fakeKey, truncated: true },
          },
        },
      ],
    };
    const encoded = JSON.stringify(publicReplay(leaked));
    expect(encoded).not.toContain(fakeKey);
    expect(encoded).not.toContain('credentialId');
    expect(encoded).not.toContain('endpoint');
    expect(encoded).not.toContain('"thought":');
    expect(encoded).not.toContain('reasoning');
  });

  it.each([false, true])(
    'retains owner reasoning privately while filtering new and legacy public artifacts (R2=%s)',
    async (useR2) => {
      await finished();
      const thought = 'fixture-private-reasoning-not-for-community';
      const privateReplay = {
        ...replay,
        events: [
          {
            seq: 1,
            type: 'action',
            at: 1,
            seat: 0,
            action: { id: 'place:40', label: 'E5', to: 40 },
            metrics: { elapsedMs: 12, thoughtUsed: true },
            reasoning: { text: thought, truncated: true },
          },
        ],
      };
      const objects = new Map<string, string>();
      const privateKey = 'replays/match-a.json';
      objects.set(privateKey, JSON.stringify(privateReplay));
      globals.__CF_ENV__ = {
        MATCH_SERVICE: {
          fetch: async () => Response.json(privateReplay),
        },
        ...(useR2
          ? {
              REPLAYS: {
                put: async (key: string, value: string) => {
                  objects.set(key, value);
                },
                get: async (key: string) =>
                  objects.has(key)
                    ? { text: async () => objects.get(key)! }
                    : null,
              },
            }
          : {}),
      };
      expect(
        (await arena.getReplay('owner-a', 'match-a')).events[0].reasoning
      ).toEqual({ text: thought, truncated: true });
      const post = await arena.publishReplay('owner-a', {
        matchId: 'match-a',
        title: 'Explicitly shared game',
      });
      const [stored] = await database.select().from(arenaPublication);
      expect(JSON.stringify(stored)).not.toContain(thought);
      expect(JSON.stringify(stored)).not.toContain('reasoning');
      const publicArtifact = useR2
        ? objects.get(stored.replayKey)!
        : stored.replayJson!;
      expect(publicArtifact).not.toContain(thought);
      expect(publicArtifact).not.toContain('reasoning');
      for (const viewer of [undefined, 'owner-a', 'owner-b']) {
        const detail = await arena.communityDetail(post.id, viewer);
        expect(detail.replay.events[0].metrics?.thoughtUsed).toBe(true);
        expect(detail.replay.events[0].reasoning).toBeUndefined();
        expect(JSON.stringify(detail)).not.toContain(thought);
        expect(JSON.stringify(await arena.listCommunity(viewer))).not.toContain(
          thought
        );
      }
      // Defend read paths even if an old stored artifact predates the filter.
      if (useR2) objects.set(stored.replayKey, JSON.stringify(privateReplay));
      else
        await database
          .update(arenaPublication)
          .set({
            replayJson: JSON.stringify(privateReplay),
          })
          .where(eq(arenaPublication.id, post.id));
      for (const viewer of [undefined, 'owner-a']) {
        expect(
          JSON.stringify(await arena.communityDetail(post.id, viewer))
        ).not.toContain(thought);
      }
      expect(objects.get(privateKey)).toContain(thought);
      expect(
        (await arena.getReplay('owner-a', 'match-a')).events[0].reasoning?.text
      ).toBe(thought);
    }
  );
});

it('rejects missing, cross-site, and mismatched Origin for mutations', () => {
  const cases: Record<string, string>[] = [
    {},
    { origin: 'https://other.invalid' },
    { origin: 'https://arena.invalid', 'sec-fetch-site': 'cross-site' },
  ];
  for (const headers of cases) {
    expect(() =>
      assertSameOrigin(
        new Request('https://arena.invalid/api/arena/models', { headers })
      )
    ).toThrow(ArenaError);
  }
  expect(() =>
    assertSameOrigin(
      new Request('https://arena.invalid/api/arena/models', {
        headers: { origin: 'https://arena.invalid' },
      })
    )
  ).not.toThrow();
});
