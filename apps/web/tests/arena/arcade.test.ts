import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { eq } from 'drizzle-orm';
import type { SnakeHarnessVersion, TetrisHarnessVersion } from '@decision-arena/core';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { publicReplay } from '@/core/arena/public-replay';
import { createArcadeInput } from '@/core/arena/validation';
import { arenaMatch, arenaPublication, user } from '@/config/db/schema';
import * as arena from '@/modules/arena/service';

let database: ReturnType<typeof drizzle>, client: Client;
vi.mock('@/core/db', () => ({ db: () => database }));
const globals = globalThis as typeof globalThis & { __CF_ENV__?: unknown };
const calls: Request[] = [];
const snakeHarnessVersions = ['snake-harness-a-v1', 'snake-harness-b-v1', 'snake-harness-c-v1'] as const satisfies readonly SnakeHarnessVersion[];
const tetrisHarnessVersions = ['tetris-harness-baseline-v1', 'tetris-harness-v8-realtime-v1'] as const satisfies readonly TetrisHarnessVersion[];
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
  it.each(snakeHarnessVersions)('preserves explicit %s in a new snake session request', async snakeHarnessVersion => {
    const body = { gameId: 'snake', mode: 'practice', config: { snakeHarnessVersion }, controllers: [{ kind: 'human' }] };
    expect(createArcadeInput.parse(body).config).toEqual({ snakeHarnessVersion });
    await arena.createArcadeSession('alice', body);
    expect((await calls.at(-1)!.clone().json()).config).toEqual({ snakeHarnessVersion });
  });
  it('leaves omitted harness versions absent and does not alter other game settings', () => {
    for (const gameId of ['snake', 'tetris', 'platformer']) {
      const config = gameId === 'platformer' ? { level: 2 } : {};
      expect(createArcadeInput.parse({ gameId, mode: 'practice', config, controllers: [{ kind: 'human' }] }).config).toEqual(config);
    }
  });
  it('rejects unknown snake versions and versions attached to other games', () => {
    const body = { gameId: 'snake', mode: 'practice', controllers: [{ kind: 'human' }] };
    for (const snakeHarnessVersion of ['A', 'snake-harness-a-v2', 'snake-harness-d-v1', '', null, 1])
      expect(createArcadeInput.safeParse({ ...body, config: { snakeHarnessVersion } }).success).toBe(false);
    for (const gameId of ['tetris', 'platformer'])
      for (const snakeHarnessVersion of snakeHarnessVersions)
        expect(createArcadeInput.safeParse({ ...body, gameId, config: { snakeHarnessVersion } }).success).toBe(false);
  });
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
    const own = await arena.saveProfile('alice', { name: 'Own model', provider: 'systemone', apiKey: 'fixture-provider-key', thinkMode: 'never' });
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
  it.each(snakeHarnessVersions)('preserves %s session and event metadata through the public whitelist', snakeHarnessVersion => {
    const original = {
      ...replay,
      config: { snakeHarnessVersion, endpoint: 'https://private.invalid' },
      events: [{ ...replay.events[0], snakeHarnessVersion, promptVersion: 'decision-arena-arcade-v4' }],
    };
    const clean = publicReplay(original);
    if (clean.version !== 2) throw new Error('Expected arcade replay');
    expect(clean.config).toEqual({ snakeHarnessVersion });
    expect(clean.events[0].snakeHarnessVersion).toBe(snakeHarnessVersion);
    expect(clean.events[0].promptVersion).toBe('decision-arena-arcade-v4');
    expect(JSON.stringify(clean)).not.toContain('private.invalid');
    expect(JSON.stringify(clean)).not.toContain('private-thought');
    expect(original.config.endpoint).toBe('https://private.invalid');
  });
  it('keeps legacy replay and event metadata absent without backfilling A', () => {
    const clean = publicReplay(replay);
    if (clean.version !== 2) throw new Error('Expected arcade replay');
    expect(clean.config).toEqual({});
    expect(clean.events[0]).not.toHaveProperty('snakeHarnessVersion');
    expect(replay.config).toEqual({});
  });
  it('rejects invalid harness metadata and non-snake replay metadata', () => {
    for (const snakeHarnessVersion of ['A', 'snake-harness-a-v2', 'snake-harness-d-v1', null]) {
      expect(() => publicReplay({ ...replay, config: { snakeHarnessVersion } })).toThrow();
      expect(() => publicReplay({ ...replay, events: [{ ...replay.events[0], snakeHarnessVersion }] })).toThrow();
    }
    for (const gameId of ['tetris', 'platformer']) {
      const otherGame = { ...replay, gameId, frames: replay.frames.map(frame => ({ ...frame, views: frame.views.map(value => ({ ...value, gameId })) })) };
      expect(() => publicReplay(otherGame)).not.toThrow();
      expect(() => publicReplay({ ...otherGame, config: { snakeHarnessVersion: 'snake-harness-a-v1' } })).toThrow();
      expect(() => publicReplay({ ...otherGame, events: [{ ...replay.events[0], snakeHarnessVersion: 'snake-harness-a-v1' }] })).toThrow();
    }
  });
  it.each([undefined, ...snakeHarnessVersions])('clones frozen %s rather than accepting the requested replacement', async snakeHarnessVersion => {
    const source = { ...replay, config: snakeHarnessVersion ? { snakeHarnessVersion } : {} };
    globals.__CF_ENV__ = { ...(globals.__CF_ENV__ as Record<string, unknown>), MATCH_SERVICE: { fetch: async (request: Request) => {
      calls.push(request);
      return Response.json(new URL(request.url).pathname.endsWith('/replay') ? source : { id: 'created', status: 'ready' });
    } } };
    await indexed();
    const post = await arena.publishReplay('alice', { matchId: 'arcade-a', title: 'Frozen harness fixture' });
    const bob = await profile('bob');
    await arena.createArcadeSession('bob', {
      cloneId: post.id, gameId: 'snake', mode: 'ai-ai',
      config: { snakeHarnessVersion: snakeHarnessVersion === 'snake-harness-b-v1' ? 'snake-harness-c-v1' : 'snake-harness-b-v1' },
      controllers: [0, 1].map(() => ({ kind: 'ai', profileId: bob.id })),
    });
    const cloned = await calls.at(-1)!.clone().json();
    expect(cloned.config).toEqual({ snakeHarnessVersion: snakeHarnessVersion ?? 'snake-harness-a-v1' });
    expect(cloned.seed).toBe(source.seed);
    expect(cloned.controllers[0].profile.ownerId).toBe('bob');
    expect((await arena.communityDetail(post.id)).replay.config).toEqual(source.config);
  });
  it.each([
    ['bamboonode-systemone', 'startlux-decision-27b-autothink'],
    ['bamboonode-decisions', 'typesafe/jev-1.14'],
  ])('publishes and reads %s arcade replays without private account data', async (provider, model) => {
    await indexed();
    const privateReplay = { ...replay,
      controllers: replay.controllers.map(controller => ({ ...controller, profile: { ...controller.profile,
        provider, model, thinkMode: 'never', ownerId: 'private-owner', credentialId: 'private-credential',
        endpoint: 'https://private.invalid', apiKey: 'private-gateway-key',
        accessToken: 'private-oauth-access', refreshToken: 'private-oauth-refresh' } })) };
    globals.__CF_ENV__ = { ...(globals.__CF_ENV__ as Record<string, unknown>),
      MATCH_SERVICE: { fetch: async () => Response.json(privateReplay) } };
    const post = await arena.publishReplay('alice', { matchId: 'arcade-a', title: 'BambooNode run' });
    const detail = await arena.communityDetail(post.id);
    if (detail.replay.version !== 2) throw new Error('Expected arcade replay');
    expect(detail.replay.controllers[0].profile).toMatchObject({ provider, model, thinkMode: 'never' });
    expect(detail.replay.events[0].metrics?.elapsedMs).toBe(333);
    const serialized = JSON.stringify(detail);
    for (const value of ['private-owner', 'private-credential', 'private.invalid', 'private-gateway-key', 'private-oauth', 'private-thought'])
      expect(serialized).not.toContain(value);
  });
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

describe('Tetris V8 frozen web contract', () => {
  const target = { pieceId: 3, leftmostColumn: 7, rotation: 1 };
  function tetrisReplay(version?: TetrisHarnessVersion) {
    const tetrisView = { ...view, gameId: 'tetris', width: 10, height: 20, snake: undefined, food: undefined,
      cells: Array(200).fill(0), pieceId: 3, active: { type: 'I', rotation: 0, cells: [{ x: 3, y: 2 }] } };
    return { ...replay, gameId: 'tetris', rulesVersion: 'tetris-v1', config: version ? { tetrisHarnessVersion: version } : {},
      controllers: replay.controllers.map(controller => ({ ...controller, profile: { ...controller.profile, provider: 'systemone' } })),
      frames: [{ tick: 60, views: [tetrisView, tetrisView] }],
      events: version === 'tetris-harness-v8-realtime-v1' ? [{ seq: 1, type: 'decision', tick: 30, settledTick: 30, observedTick: 10, at: 501,
        runId: 'run-0', pieceId: 3, decisionStage: 'target', tetrisHarnessVersion: version, tetrisGoal: target, outcome: 'applied',
        actionId: 'target:7:1', promptVersion: 'tetris-harness-v8-realtime-v1',
        observationImage: { count: 1, sha256: 'a'.repeat(64), width: 300, height: 480 } }] : [] };
  }
  it.each(tetrisHarnessVersions)('forwards explicit %s and keeps human practice available', async tetrisHarnessVersion => {
    const body = { gameId: 'tetris', mode: 'practice', config: { tetrisHarnessVersion }, controllers: [{ kind: 'human' }] };
    expect(createArcadeInput.parse(body).config).toEqual({ tetrisHarnessVersion });
    await arena.createArcadeSession('alice', body);
    expect((await calls.at(-1)!.clone().json()).config).toEqual({ tetrisHarnessVersion });
  });
  it.each(['ai-solo', 'human-ai', 'ai-ai'] as const)('defaults new %s sessions to V8 for every AI seat', async mode => {
    const own = await arena.saveProfile('alice', { name: 'Decision', provider: 'systemone', apiKey: 'fixture-provider-key', thinkMode: 'always' });
    const kinds = mode === 'ai-solo' ? ['ai'] : mode === 'human-ai' ? ['human', 'ai'] : ['ai', 'ai'];
    await arena.createArcadeSession('alice', { gameId: 'tetris', mode,
      controllers: kinds.map(kind => ({ kind, ...(kind === 'ai' ? { profileId: own.id } : {}) })) });
    const payload = await calls.at(-1)!.clone().json();
    expect(payload.config).toEqual({ tetrisHarnessVersion: tetrisHarnessVersions[1] });
    expect(payload.controllers).toHaveLength(kinds.length);
    for (const seat of payload.controllers.filter((seat: { kind: string }) => seat.kind === 'ai'))
      expect(seat.profile).toMatchObject({ id: own.id, ownerId: 'alice', thinkMode: 'never' });
  });
  it('does not silently fall back when an omitted version selects an incompatible second AI', async () => {
    const own = await arena.saveProfile('alice', { name: 'Decision', provider: 'systemone', apiKey: 'fixture-provider-key', thinkMode: 'never' });
    const jev = await profile();
    const body = { gameId: 'tetris', mode: 'ai-ai', controllers: [own, jev].map(p => ({ kind: 'ai', profileId: p.id })) };
    await expect(arena.createArcadeSession('alice', body)).rejects.toThrow('verified image support');
    expect(calls).toHaveLength(0);
    await arena.createArcadeSession('alice', { ...body, config: { tetrisHarnessVersion: tetrisHarnessVersions[0] } });
    expect((await calls.at(-1)!.clone().json()).config.tetrisHarnessVersion).toBe(tetrisHarnessVersions[0]);
  });
  it('rejects unknown or non-Tetris versions without changing legacy requests', () => {
    const body = { gameId: 'tetris', mode: 'practice', controllers: [{ kind: 'human' }] };
    expect(createArcadeInput.parse(body).config).toEqual({});
    for (const tetrisHarnessVersion of ['v8', 'tetris-harness-v8-realtime-v2', null, 8])
      expect(createArcadeInput.safeParse({ ...body, config: { tetrisHarnessVersion } }).success).toBe(false);
    for (const gameId of ['snake', 'platformer'])
      expect(createArcadeInput.safeParse({ ...body, gameId, config: { tetrisHarnessVersion: tetrisHarnessVersions[1] } }).success).toBe(false);
  });
  it('requires owned image-capable models for V8 and keeps thinking disabled', async () => {
    const jev = await profile('alice');
    const systemone = await arena.saveProfile('alice', { name: 'Image capable fixture', provider: 'systemone', apiKey: 'fixture-provider-key', thinkMode: 'always' });
    const body = { gameId: 'tetris', mode: 'ai-solo', config: { tetrisHarnessVersion: tetrisHarnessVersions[1] }, controllers: [{ kind: 'ai', profileId: jev.id }] };
    await expect(arena.createArcadeSession('alice', body)).rejects.toThrow('verified image support');
    await expect(arena.createArcadeSession('bob', { ...body, controllers: [{ kind: 'ai', profileId: systemone.id }] })).rejects.toMatchObject({ status: 404 });
    await arena.createArcadeSession('alice', { ...body, controllers: [{ kind: 'ai', profileId: systemone.id, thinkMode: 'always' }] });
    expect((await calls.at(-1)!.clone().json()).controllers[0].profile.thinkMode).toBe('never');
    await expect(arena.createArcadeSession('alice', { ...body, config: { tetrisHarnessVersion: tetrisHarnessVersions[0] } })).resolves.toBeDefined();
  });
  it.each(['typesafe/jev-1.13', 'typesafe/jev-1.14'])('defaults mixed %s versus Decision seats to full V8 with owner isolation', async model => {
    const jev = await arena.saveProfile('alice', { name: 'Jev image fixture', provider: 'openrouter', model, apiKey: 'fixture-provider-key', thinkMode: 'always' });
    const decision = await arena.saveProfile('alice', { name: 'Decision image fixture', provider: 'systemone', apiKey: 'fixture-provider-key', thinkMode: 'always' });
    const body = { gameId: 'tetris', mode: 'ai-ai', controllers: [jev, decision].map(p => ({ kind: 'ai', profileId: p.id })) };
    await expect(arena.createArcadeSession('bob', body)).rejects.toMatchObject({ status: 404 });
    expect(calls).toHaveLength(0);
    for (const controllers of [body.controllers, [...body.controllers].reverse()]) {
      await arena.createArcadeSession('alice', { ...body, controllers, ownerId: 'bob' });
      const request = calls.at(-1)!;
      const payload = await request.clone().json();
      expect(request.headers.get('X-Arena-Owner')).toBe('alice');
      expect(payload.config).toEqual({ tetrisHarnessVersion: tetrisHarnessVersions[1] });
      expect(payload.controllers.map((seat: { profile: { id: string } }) => seat.profile.id)).toEqual(controllers.map(c => c.profileId));
      for (const seat of payload.controllers)
        expect(seat.profile).toMatchObject({ ownerId: 'alice', thinkMode: 'never' });
      expect(payload.controllers.find((seat: { profile: { provider: string } }) => seat.profile.provider === 'openrouter').profile.model).toBe(model);
    }
  });
  it('publishes only safe goal, stage and image identity metadata', () => {
    const source = tetrisReplay(tetrisHarnessVersions[1]);
    const privateMarker = 'private-tetris-payload';
    const dirty = { ...source, config: { ...source.config, rawRequest: privateMarker }, predictionState: privateMarker,
      events: source.events.map(event => ({ ...event, tetrisGoal: { ...target, boardKey: privateMarker },
        observationImage: { ...event.observationImage, dataUrl: privateMarker, rawBytes: privateMarker },
        request: privateMarker, rawBody: privateMarker, reasoning: { text: privateMarker, truncated: false } })) };
    const clean = publicReplay(dirty);
    if (clean.version !== 2) throw new Error('Expected arcade replay');
    expect(clean.config.tetrisHarnessVersion).toBe(tetrisHarnessVersions[1]);
    expect(clean.events[0]).toMatchObject({ decisionStage: 'target', settledTick: 30, pieceId: 3, tetrisGoal: target,
      observationImage: { count: 1, sha256: 'a'.repeat(64), width: 300, height: 480 } });
    expect(clean.events[0]).not.toHaveProperty('input');
    expect(clean.frames[0].views[0].active?.rotation).toBe(0);
    expect(JSON.stringify(clean)).not.toContain(privateMarker);
    expect(dirty.events[0].reasoning.text).toBe(privateMarker);
  });
  it('rejects unsafe metadata and never interprets target selection as applied input', () => {
    const source = tetrisReplay(tetrisHarnessVersions[1]);
    for (const change of [{ decisionStage: 'pathfind' }, { tetrisGoal: { ...target, leftmostColumn: 10 } }, { tetrisGoal: { ...target, rotation: 4 } },
      { tetrisHarnessVersion: 'v8' }, { observationImage: { count: 1, sha256: 'data:image/private', width: 1, height: 1 } },
      { input: { buttons: ['hard-drop'] } }, { appliedTick: 31 }])
      expect(() => publicReplay({ ...source, events: [{ ...source.events[0], ...change }] })).toThrow();
    expect(() => publicReplay({ ...replay, events: [{ ...replay.events[0], decisionStage: 'key' }] })).toThrow();
  });
  it.each([undefined, ...tetrisHarnessVersions])('clones source version %s with own credentials, overriding requested replacement without rewriting history', async version => {
    const source = tetrisReplay(version);
    globals.__CF_ENV__ = { ...(globals.__CF_ENV__ as Record<string, unknown>), MATCH_SERVICE: { fetch: async (request: Request) => {
      calls.push(request);
      return Response.json(new URL(request.url).pathname.endsWith('/replay') ? source : { id: 'created', status: 'ready' });
    } } };
    await indexed();
    await database.update(arenaMatch).set({ gameId: 'tetris' }).where(eq(arenaMatch.id, 'arcade-a'));
    const post = await arena.publishReplay('alice', { matchId: 'arcade-a', title: 'Frozen Tetris fixture' });
    const own = await arena.saveProfile('bob', { name: 'Own SystemOne', provider: 'systemone', apiKey: 'fixture-provider-key', thinkMode: 'always' });
    await arena.createArcadeSession('bob', { cloneId: post.id, gameId: 'tetris', mode: 'ai-ai',
      config: { tetrisHarnessVersion: version === tetrisHarnessVersions[1] ? tetrisHarnessVersions[0] : tetrisHarnessVersions[1] },
      controllers: [0, 1].map(() => ({ kind: 'ai', profileId: own.id })) });
    const cloned = await calls.at(-1)!.clone().json();
    expect(cloned.config).toEqual({ tetrisHarnessVersion: version ?? tetrisHarnessVersions[0] });
    expect(cloned.controllers[0].profile).toMatchObject({ ownerId: 'bob', id: own.id, thinkMode: 'never' });
    expect((await arena.communityDetail(post.id)).replay.config).toEqual(source.config);
    if (!version) expect(source.config).not.toHaveProperty('tetrisHarnessVersion');
  });
  it.each([
    ['typesafe/jev-1.13', 'unknown/model', true],
    ['unknown/model', 'typesafe/jev-1.14', false],
  ] as const)('validates frozen clone model %s rather than the credential profile model %s', async (sourceModel, credentialModel, supported) => {
    const source = tetrisReplay(tetrisHarnessVersions[1]);
    source.controllers = source.controllers.map(controller => ({ ...controller, profile: { ...controller.profile, provider: 'openrouter', model: sourceModel } }));
    globals.__CF_ENV__ = { ...(globals.__CF_ENV__ as Record<string, unknown>), MATCH_SERVICE: { fetch: async (request: Request) => {
      calls.push(request);
      return Response.json(new URL(request.url).pathname.endsWith('/replay') ? source : { id: 'created', status: 'ready' });
    } } };
    await indexed();
    await database.update(arenaMatch).set({ gameId: 'tetris' }).where(eq(arenaMatch.id, 'arcade-a'));
    const post = await arena.publishReplay('alice', { matchId: 'arcade-a', title: 'Frozen visual model fixture' });
    const own = await arena.saveProfile('bob', { name: 'Own model credential', provider: 'openrouter', model: credentialModel, apiKey: 'fixture-provider-key', thinkMode: 'always' });
    calls.length = 0;
    const body = { cloneId: post.id, gameId: 'tetris', mode: 'ai-ai', controllers: [0, 1].map(() => ({ kind: 'ai', profileId: own.id })) };
    if (!supported) {
      await expect(arena.createArcadeSession('bob', body)).rejects.toThrow('verified image support');
      expect(calls).toHaveLength(0);
    } else {
      await arena.createArcadeSession('bob', body);
      const payload = await calls.at(-1)!.clone().json();
      expect(payload.config.tetrisHarnessVersion).toBe(tetrisHarnessVersions[1]);
      expect(payload.controllers[0].profile).toMatchObject({ ownerId: 'bob', id: own.id, model: sourceModel, thinkMode: 'never' });
    }
  });
});
