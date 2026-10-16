import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { eq } from 'drizzle-orm';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { publicReplay } from '@/core/arena/public-replay';
import { createArcadeInput } from '@/core/arena/validation';
import { arenaMatch, arenaPublication, user } from '@/config/db/schema';
import * as arena from '@/modules/arena/service';

let database: ReturnType<typeof drizzle>, client: Client;
vi.mock('@/core/db', () => ({ db: () => database }));
const globals = globalThis as typeof globalThis & { __CF_ENV__?: unknown };
const calls: Request[] = [];
const score = { points: 10, food: 1, survivedTicks: 60 };
const view = { gameId: 'snake', tick: 60, status: 'finished', score, width: 20, height: 20,
  currentButtons: [], snake: [{ x: 10, y: 10 }], food: { x: 2, y: 2 }, reason: 'wall' };
const replay = {
  version: 2, engineKind: 'arcade', matchId: 'arcade-a', gameId: 'snake', mode: 'ai-ai', rulesVersion: 'snake-v1',
  promptVersion: 'arcade-v1', seed: 'same-food-seed', config: {}, maxTicks: 7200, runIds: ['run-0', 'run-1'],
  controllers: [0, 1].map(() => ({ kind: 'ai', profile: { name: 'Public model', provider: 'openrouter', model: 'fixture/version', thinkMode: 'always', thinkBudget: 4096 } })),
  result: { winner: null, reason: 'tie', scores: [score, score], aborted: false }, createdAt: 1, finishedAt: 1001,
  frames: [{ tick: 60, views: [view, view] }],
  events: [{ seq: 1, type: 'decision', tick: 30, at: 501, runId: 'run-0', observedTick: 10, appliedTick: 30,
    input: { buttons: ['up'] }, outcome: 'applied', metrics: { elapsedMs: 333 }, reasoning: { text: 'private-thought', truncated: false } }],
};

beforeEach(async () => {
  client = createClient({ url: ':memory:' }); database = drizzle(client); calls.length = 0;
  const dir = fileURLToPath(new URL('../../drizzle/', import.meta.url));
  for (const file of readdirSync(dir).filter(name => name.endsWith('.sql')).sort())
    await client.executeMultiple(readFileSync(dir + file, 'utf8'));
  await database.insert(user).values([{ id: 'alice', name: 'Alice', email: 'alice@fixture.invalid' }, { id: 'bob', name: 'Bob', email: 'bob@fixture.invalid' }]);
  globals.__CF_ENV__ = { ARENA_ENCRYPTION_KEY: 'fixture-master-key-long-enough-never-a-real-secret',
    MATCH_SERVICE: { fetch: async (request: Request) => {
      calls.push(request);
      return Response.json(new URL(request.url).pathname.endsWith('/replay') ? replay : { id: 'created', status: 'ready' });
    } },
  };
});
afterEach(() => { client.close(); delete globals.__CF_ENV__; });

async function profile(owner = 'alice') {
  return arena.saveProfile(owner, { name: 'Own model', provider: 'openrouter', model: 'own/version', apiKey: 'fixture-provider-key', thinkMode: 'never' });
}
async function indexed() {
  await database.insert(arenaMatch).values({ id: 'arcade-a', ownerId: 'alice', gameId: 'snake', status: 'finished',
    summaryJson: JSON.stringify({ engineKind: 'arcade', result: replay.result }), resultJson: JSON.stringify(replay.result), createdAt: 1, updatedAt: 2 });
}

describe('arcade activity validation and tenant boundaries', () => {
  it('accepts exactly the four controller layouts and rejects unrelated modes and unsafe input', () => {
    for (const [mode, kinds] of [['practice', ['human']], ['ai-solo', ['ai']], ['human-ai', ['human', 'ai']], ['ai-ai', ['ai', 'ai']]] as const)
      expect(createArcadeInput.safeParse({ gameId: 'snake', mode, controllers: kinds.map(kind => ({ kind, profileId: kind === 'ai' ? 'mine' : undefined })) }).success).toBe(true);
    for (const controllers of [[{ kind: 'ai', profileId: 'mine' }], [{ kind: 'human' }, { kind: 'human' }], []])
      expect(createArcadeInput.safeParse({ gameId: 'snake', mode: 'practice', controllers }).success).toBe(false);
    expect(createArcadeInput.safeParse({ gameId: 'platformer', mode: 'practice', config: { level: 4 }, controllers: [{ kind: 'human' }] }).success).toBe(false);
    for (const controllers of [[], [{ kind: 'human' }], [{ kind: 'ai' }], [{ kind: 'ai', profileId: 'mine' }, { kind: 'ai', profileId: 'mine' }]])
      expect(createArcadeInput.safeParse({ gameId: 'snake', mode: 'ai-solo', controllers }).success).toBe(false);
  });
  it.each(['snake', 'tetris', 'platformer'])('creates %s with one owned AI profile and rejects a foreign saved selection', async gameId => {
    const own = await profile();
    const body = { gameId, mode: 'ai-solo', controllers: [{ kind: 'ai', profileId: own.id }] };
    await expect(arena.createArcadeSession('bob', body)).rejects.toMatchObject({ status: 404 });
    await arena.createArcadeSession('alice', body);
    const payload = await calls.at(-1)!.clone().json();
    expect(payload.mode).toBe('ai-solo');
    expect(payload.controllers).toHaveLength(1);
    expect(payload.controllers[0]).toMatchObject({ kind: 'ai', profile: { ownerId: 'alice', id: own.id } });
  });
  it.each(['snake', 'tetris', 'platformer'])('forces thinking off in %s regardless of saved settings or submitted overrides', async gameId => {
    const own = await arena.saveProfile('alice', { name: 'Thinking model', provider: 'systemone', apiKey: 'fixture-provider-key', thinkMode: 'always', thinkBudget: 4096 });
    const payload = { gameId, mode: 'human-ai', controllers: [{ kind: 'human' }, { kind: 'ai', profileId: own.id, thinkMode: 'always', thinkBudget: 8192 }] };
    expect(createArcadeInput.parse(payload).controllers[1]).toEqual({ kind: 'ai', profileId: own.id });
    await expect(arena.createArcadeSession('bob', payload)).rejects.toMatchObject({ status: 404 });
    await arena.createArcadeSession('alice', { ...payload, ownerId: 'bob' });
    const request = calls.at(-1)!;
    expect(request.headers.get('X-Arena-Owner')).toBe('alice');
    const body = await request.clone().json();
    expect(body.controllers[1].profile).toMatchObject({ ownerId: 'alice', thinkMode: 'never', thinkBudget: 4096 });
    expect((await arena.listProfiles('alice')).items[0]).toMatchObject({ thinkMode: 'always', thinkBudget: 4096 });
  });
  it('separates chess and arcade indices and never lists another owner’s sessions', async () => {
    await indexed();
    await database.insert(arenaMatch).values({ id: 'chess-a', ownerId: 'alice', gameId: 'gomoku', status: 'ready', summaryJson: '{}', createdAt: 1, updatedAt: 2 });
    expect((await arena.listMatches('alice')).items.map((x: { id: string }) => x.id)).toEqual(['chess-a']);
    expect((await arena.listArcadeSessions('alice')).items.map((x: { id: string }) => x.id)).toEqual(['arcade-a']);
    expect((await arena.listArcadeSessions('bob')).items).toEqual([]);
  });
});

describe('arcade community replay', () => {
  it('publishes a single AI track and clones it with the viewer’s own credentials', async () => {
    const solo = { ...replay, mode: 'ai-solo', controllers: [replay.controllers[0]], runIds: ['run-0'],
      frames: [{ tick: 60, views: [view] }], result: { ...replay.result, scores: [score] } };
    globals.__CF_ENV__ = { ...(globals.__CF_ENV__ as Record<string, unknown>), MATCH_SERVICE: { fetch: async (request: Request) => {
      calls.push(request);
      return Response.json(new URL(request.url).pathname.endsWith('/replay') ? solo : { id: 'created', status: 'ready' });
    } } };
    await indexed();
    const post = await arena.publishReplay('alice', { matchId: 'arcade-a', title: 'One model run' });
    const detail = await arena.communityDetail(post.id);
    if (detail.replay.version !== 2) throw new Error('Expected arcade replay');
    expect(detail.replay.mode).toBe('ai-solo');
    expect(detail.replay.controllers).toHaveLength(1);
    expect(detail.replay.result.scores).toHaveLength(1);
    expect(JSON.stringify(detail.replay)).not.toContain('private-thought');
    const bob = await profile('bob');
    await arena.createArcadeSession('bob', { cloneId: post.id, gameId: 'snake', mode: 'ai-solo', controllers: [{ kind: 'ai', profileId: bob.id }] });
    const cloned = await calls.at(-1)!.clone().json();
    expect(cloned.mode).toBe('ai-solo');
    expect(cloned.controllers).toHaveLength(1);
    expect(cloned.controllers[0].profile).toMatchObject({ ownerId: 'bob', id: bob.id, model: 'fixture/version', thinkMode: 'never' });
    expect(detail.replay.controllers[0].profile?.thinkMode).toBe('always');
    expect(() => publicReplay({ ...solo, controllers: [{ kind: 'human' }] })).toThrow();
    expect(() => publicReplay({ ...solo, result: { ...solo.result, winner: 0 } })).toThrow();
    expect(() => publicReplay({ ...solo, frames: replay.frames })).toThrow();
    await arena.communityAction('alice', post.id, { action: 'unpublish' }, false);
    await expect(arena.communityDetail(post.id)).rejects.toMatchObject({ status: 404 });
  });
  it('retains per-decision prompt versions across upgrades and accepts older events without one', () => {
    const mixed = { ...replay, events: [replay.events[0], { ...replay.events[0], seq: 2, promptVersion: 'decision-arena-arcade-v2' }] };
    const clean = publicReplay(mixed);
    if (clean.version !== 2) throw new Error('Expected arcade replay');
    expect(clean.promptVersion).toBe(replay.promptVersion);
    expect(clean.events[0].promptVersion).toBeUndefined();
    expect(clean.events[1].promptVersion).toBe('decision-arena-arcade-v2');
    expect(JSON.stringify(clean)).not.toContain('private-thought');
    expect(() => publicReplay({ ...mixed, events: [{ ...mixed.events[1], promptVersion: 'https://private.invalid/secret' }] })).toThrow();
  });
  it('whitelists nested tracks, controllers, metrics, input and config on every read', () => {
    const dirty = structuredClone(replay) as any;
    dirty.secret = 'root-secret'; dirty.config.endpoint = 'https://private.invalid';
    dirty.controllers[0].profile.apiKey = 'fixture-key'; dirty.controllers[0].profile.endpoint = 'https://private.invalid';
    dirty.frames[0].views[0].thought = 'nested-thought';
    dirty.frames[0].views[0].predictionState = { rng: 'private-prediction-state' };
    dirty.predictionState = { rng: 'private-prediction-state' };
    dirty.events[0].input.apiKey = 'fixture-key'; dirty.events[0].metrics.raw = 'provider-body';
    dirty.events[0].message = 'provider private detail';
    const clean = publicReplay(dirty);
    expect(clean.version).toBe(2);
    const serialized = JSON.stringify(clean);
    for (const text of ['private-thought', 'root-secret', 'private.invalid', 'fixture-key', 'nested-thought', 'provider-body', 'provider private detail', 'predictionState', 'private-prediction-state'])
      expect(serialized).not.toContain(text);
    expect(clean.events[0].metrics?.elapsedMs).toBe(333);
  });
  it('rejects invalid replay tracks and unsupported versions instead of accepting arbitrary JSON', () => {
    expect(() => publicReplay({ ...replay, frames: [{ tick: 1, views: [view] }] })).toThrow();
    expect(() => publicReplay({ ...replay, version: 3 })).toThrow();
    expect(() => publicReplay({ ...replay, maxTicks: 9999999 })).toThrow();
  });
  it('publishes only the owner’s completed activity and strips thoughts for anonymous viewers', async () => {
    await indexed();
    await expect(arena.publishReplay('bob', { matchId: 'arcade-a', title: 'No' })).rejects.toMatchObject({ status: 404 });
    const post = await arena.publishReplay('alice', { matchId: 'arcade-a', title: 'Snake race' });
    const detail = await arena.communityDetail(post.id);
    expect(detail.replay.version).toBe(2);
    expect(JSON.stringify(detail.replay)).not.toContain('private-thought');
    expect((await arena.listCommunity(undefined, 'snake', 'fixture/version')).items).toHaveLength(1);
    await arena.communityAction('alice', post.id, { action: 'unpublish' }, false);
    await expect(arena.communityDetail(post.id)).rejects.toMatchObject({ status: 404 });
  });
  it('clones seed and public settings but uses the viewer’s own credentials and endpoint', async () => {
    await indexed();
    const post = await arena.publishReplay('alice', { matchId: 'arcade-a', title: 'Race' });
    const bob = await profile('bob');
    await arena.createArcadeSession('bob', { cloneId: post.id, gameId: 'snake', mode: 'ai-ai', controllers: [0, 1].map(() => ({ kind: 'ai', profileId: bob.id })) });
    const body = await calls.at(-1)!.clone().json();
    expect(body.seed).toBe(replay.seed);
    expect(body.controllers[0].profile).toMatchObject({ ownerId: 'bob', id: bob.id, model: 'fixture/version', thinkMode: 'never' });
    expect(body.controllers[1].profile.thinkMode).toBe('never');
    const original = (await arena.communityDetail(post.id)).replay;
    if (original.version !== 2) throw new Error('Expected arcade replay');
    expect(original.controllers[0].profile?.thinkMode).toBe('always');
    await database.update(arenaPublication).set({ status: 'removed' }).where(eq(arenaPublication.id, post.id));
    await expect(arena.createArcadeSession('bob', { cloneId: post.id, gameId: 'snake', mode: 'ai-ai', controllers: [0, 1].map(() => ({ kind: 'ai', profileId: bob.id })) })).rejects.toMatchObject({ status: 404 });
  });
});
