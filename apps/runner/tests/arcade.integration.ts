import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { Miniflare, Log, LogLevel, Response as MockResponse, type MiniflareOptions } from 'miniflare';
import type { ArcadeReplayV2, ArcadeSession, ModelProfile, SeatConfig } from '@decision-arena/core';
import { ARCADE_PROMPT_VERSION, arcadeDecisionInstructions, getArcadeGame } from '@decision-arena/games';
import { encryptSecret, ENDPOINTS } from '@decision-arena/providers';
import { canObserveAfterInput, canSendObservedDecision } from '../src/arcade-scheduling';

const master = 'fixture-arcade-master-do-not-use-in-production', internal = 'fixture-arcade-internal', owner = 'arcade-fixture-alice', stranger = 'arcade-fixture-bob';
const privateThought = 'fixture private arcade reasoning';
const persistence = mkdtempSync(resolve(tmpdir(), 'decision-arena-arcade-test-'));
let mf: Miniflare, options: MiniflareOptions, db: Awaited<ReturnType<Miniflare['getD1Database']>>;
let calls: any[] = [], active = 0, peak = 0;
let reply: (body: any, index: number) => Promise<MockResponse>;
const sessions: string[] = [], releases: (() => void)[] = [], sockets: any[] = [];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); releases.push(release); return { promise, release }; }
function success(body: any, action = '释放所有按键', thought = privateThought) {
  const criteria = body.questions.primary_move.criteria;
  const choice = Object.keys(criteria).find(key => criteria[key].includes(action)) ?? Object.keys(criteria)[0];
  return new MockResponse(JSON.stringify({ model: 'fixture-arcade-model', answers: { primary_move: { choice, confidence: 0.8, details: { thought: { used: true, text: thought, tokens: 8 } } } }, usage: { input_tokens: 20, output_tokens: 5 } }), { headers: { 'content-type': 'application/json' } });
}
async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await sleep(20); }
  throw new Error(`Timed out: ${label}`);
}
async function request(path: string, body?: unknown, account = owner) {
  return mf.dispatchFetch(`https://arcade.test${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Arena-Owner': account, 'X-Arena-Internal': internal, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function snapshot(id: string): Promise<ArcadeSession> { const response = await request(`/arcade-sessions/${id}`); expect(response.status).toBe(200); return response.json() as Promise<ArcadeSession>; }
async function command(id: string, type: string, operationId = crypto.randomUUID()) { return request(`/arcade-sessions/${id}/commands`, { type, operationId }); }
async function create(controllers: SeatConfig[], gameId = 'tetris', mode = controllers.length === 1 ? controllers[0].kind === 'ai' ? 'ai-solo' : 'practice' : controllers.some(controller => controller.kind === 'human') ? 'human-ai' : 'ai-ai') {
  const response = await request('/arcade-sessions', { gameId, mode, config: {}, controllers, seed: 'arcade-fixture-shared-seed' });
  expect(response.status).toBe(201);
  const session = await response.json() as ArcadeSession; sessions.push(session.id); return session;
}
async function profile(account = owner): Promise<ModelProfile> {
  const id = crypto.randomUUID(), ciphertext = await encryptSecret('fixture-model-secret', master, account);
  await db.prepare('INSERT INTO arena_credentials(id,owner_id,name,ciphertext,masked,created_at) VALUES(?,?,?,?,?,?)').bind(id, account, 'fixture', ciphertext, 'fixture-mask', Date.now()).run();
  return { id: crypto.randomUUID(), ownerId: account, credentialId: id, provider: 'openrouter', endpoint: 'https://openrouter.ai/api/alpha/decisions', model: 'fixture-model', name: 'Fixture model' };
}
async function bambooProfile(): Promise<ModelProfile> {
  const own: ModelProfile = { ...await profile(), provider: 'bamboonode-systemone', endpoint: ENDPOINTS['bamboonode-systemone'], model: 'startlux-decision-27b-autothink', thinkMode: 'always', thinkBudget: 512 };
  await db.prepare('INSERT OR REPLACE INTO arena_bamboo_connections(owner_id,credential_id,status,expires_at,models_json) VALUES(?,?,?,?,?)')
    .bind(owner, own.credentialId, 'connected', Date.now() + 60_000, JSON.stringify([own.model])).run();
  return own;
}
async function socket(id: string) {
  const response = await mf.dispatchFetch(`https://arcade.test/arcade-sessions/${id}/socket`, { headers: { 'X-Arena-Owner': owner, 'X-Arena-Internal': internal, Upgrade: 'websocket' } });
  expect(response.status).toBe(101);
  const ws = response.webSocket!; ws.accept(); sockets.push(ws);
  const messages: any[] = []; ws.addEventListener('message', event => messages.push(JSON.parse(String(event.data))));
  return { ws, messages, send: (value: unknown) => ws.send(JSON.stringify(value)) };
}
async function claim(connection: Awaited<ReturnType<typeof socket>>, runId: string) {
  const before = connection.messages.length;
  connection.send({ type: 'claim', runId });
  await until(() => connection.messages.slice(before).some(message => message.type === 'controller'), 'controller claim');
  return connection.messages.filter(message => message.type === 'controller').at(-1).controllerSession as string;
}
async function patch(id: string, update: (record: any) => void) {
  await mf.dispose();
  const directories = [resolve(persistence, 'do')]; let found = false;
  while (directories.length) {
    const directory = directories.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) { directories.push(path); continue; }
      if (!entry.name.endsWith('.sqlite')) continue;
      const sqlite = new DatabaseSync(path);
      try {
        if (!sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='arcade_meta'").get()) continue;
        const row = sqlite.prepare('SELECT value FROM arcade_meta WHERE id=1').get() as { value: string } | undefined;
        if (!row) continue;
        const record = JSON.parse(row.value); if (record.id !== id) continue;
        update(record); sqlite.prepare('UPDATE arcade_meta SET value=? WHERE id=1').run(JSON.stringify(record)); found = true;
      } finally { sqlite.close(); }
    }
  }
  expect(found).toBe(true); mf = new Miniflare(options); await mf.ready; db = await mf.getD1Database('DB');
}

beforeAll(async () => {
  options = {
    name: 'arcade-integration', modules: true, scriptPath: resolve('apps/runner/dist/index.js'), compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
    host: '127.0.0.1', port: 0, cf: false, log: new Log(LogLevel.ERROR), bindings: { ARENA_ENCRYPTION_KEY: master, ARENA_INTERNAL_SECRET: internal, LOCAL_DEV: 'true' },
    durableObjects: { MATCHES: { className: 'MatchObject', useSQLite: true }, USER_QUOTAS: { className: 'UserQuota', useSQLite: true }, ARCADES: { className: 'ArcadeSessionObject', useSQLite: true } },
    d1Databases: ['DB'], r2Buckets: ['REPLAYS'], durableObjectsPersist: resolve(persistence, 'do'), d1Persist: resolve(persistence, 'd1'), r2Persist: resolve(persistence, 'r2'),
    outboundService: async req => {
      if (!Object.values(ENDPOINTS).some(endpoint => endpoint === req.url)) throw new Error('Unexpected fixture outbound request');
      const body = await req.json(), index = calls.push(body) - 1;
      active++; peak = Math.max(peak, active);
      try { return await reply(body, index); } finally { active--; }
    },
  };
  mf = new Miniflare(options); await mf.ready; db = await mf.getD1Database('DB');
  const statements = readFileSync(resolve('apps/web/drizzle/0000_powerful_solo.sql'), 'utf8').split('--> statement-breakpoint').map(sql => sql.trim());
  for (const name of ['user', 'arena_credentials', 'arena_matches']) await db.prepare(statements.find(sql => sql.startsWith(`CREATE TABLE \`${name}\``))!).run();
  for (const id of [owner, stranger]) await db.prepare('INSERT INTO user(id,name,email) VALUES(?,?,?)').bind(id, id, `${id}@example.test`).run();
  await db.prepare('CREATE TABLE arena_bamboo_connections(owner_id TEXT PRIMARY KEY, credential_id TEXT NOT NULL, status TEXT NOT NULL, expires_at INTEGER NOT NULL, models_json TEXT NOT NULL)').run();
});
beforeEach(() => { calls = []; active = 0; peak = 0; reply = async body => success(body); });
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const ws of sockets.splice(0)) { try { ws.close(); } catch {} }
  for (const id of sessions.splice(0)) await command(id, 'end');
  await until(() => active === 0, 'fixture requests settled'); await sleep(80);
});
afterAll(async () => { await mf?.dispose(); rmSync(persistence, { recursive: true, force: true }); });

describe('real-time ArcadeSessionObject in workerd (fixture providers only)', () => {
  it('requires an active owner-and-credential-bound BambooNode connection before creating an arcade session', async () => {
    for (const condition of ['missing', 'expired', 'disconnected', 'foreign-owner', 'different-key', 'model-removed']) {
      const own = await bambooProfile();
      if (condition === 'missing') await db.prepare('DELETE FROM arena_bamboo_connections').run();
      if (condition === 'expired') await db.prepare('UPDATE arena_bamboo_connections SET expires_at=? WHERE owner_id=?').bind(Date.now() - 1, owner).run();
      if (condition === 'disconnected') await db.prepare("UPDATE arena_bamboo_connections SET status='disconnected' WHERE owner_id=?").bind(owner).run();
      if (condition === 'foreign-owner') { await db.prepare('DELETE FROM arena_bamboo_connections WHERE owner_id=?').bind(stranger).run(); await db.prepare('UPDATE arena_bamboo_connections SET owner_id=? WHERE owner_id=?').bind(stranger, owner).run(); }
      if (condition === 'different-key') await db.prepare('UPDATE arena_bamboo_connections SET credential_id=? WHERE owner_id=?').bind(crypto.randomUUID(), owner).run();
      if (condition === 'model-removed') await db.prepare("UPDATE arena_bamboo_connections SET models_json='[]' WHERE owner_id=?").bind(owner).run();
      const response = await request('/arcade-sessions', { gameId: 'snake', mode: 'ai-solo', config: {}, controllers: [{ kind: 'ai', profile: own }] });
      expect(response.status, condition).toBe(400); expect(calls).toHaveLength(0);
    }
  });

  it.each(['snake', 'tetris', 'platformer'])('keeps BambooNode %s requests no-thinking and discards a response after local disconnection', async game => {
    const own = await bambooProfile(), blocker = gate(); reply = async body => { await blocker.promise; return success(body); };
    const session = await create([{ kind: 'ai', profile: own }], game);
    expect((await command(session.id, 'start')).status).toBe(200);
    await until(() => calls.length === 1, 'BambooNode arcade request');
    expect(calls[0]).toMatchObject({ model: own.model, think_mode: 'never', return_thought: false, think_budget: 512 });
    await db.prepare("UPDATE arena_bamboo_connections SET status='disconnected' WHERE owner_id=?").bind(owner).run();
    blocker.release();
    await until(async () => (await snapshot(session.id)).status === 'paused', 'disconnected arcade model pauses');
    const current = await snapshot(session.id);
    expect(current.events.filter(event => event.type === 'input' && !event.release && event.runId === current.runs[0].id)).toHaveLength(0);
    expect(current.runs[0].lastDecision?.outcome).toBe('failed'); expect(calls).toHaveLength(1);
  });

  it.each(['snake', 'tetris', 'platformer'].flatMap(game => [false, true].map(changedKey => ({ game, changedKey }))))('binds a delayed $game result to the sent BambooNode key (new key=$changedKey)', async ({ game, changedKey }) => {
    const own = await bambooProfile(), blocker = gate(), following = gate();
    reply = async (body, index) => { await (index === 0 ? blocker.promise : following.promise); return success(body); };
    const session = await create([{ kind: 'ai', profile: own }], game);
    expect((await command(session.id, 'start')).status).toBe(200);
    await until(() => calls.length === 1, 'BambooNode arcade inference starts before key update');
    const previous = await db.prepare('SELECT ciphertext FROM arena_credentials WHERE id=?').bind(own.credentialId).first<{ ciphertext: string }>();
    if (changedKey) {
      await db.prepare("UPDATE arena_bamboo_connections SET status='disconnected' WHERE owner_id=?").bind(owner).run();
      await db.prepare("UPDATE arena_credentials SET ciphertext='',deleted_at=? WHERE id=?").bind(Date.now(), own.credentialId).run();
    }
    const ciphertext = await encryptSecret(changedKey ? 'fixture-reconnected-arcade-key' : 'fixture-model-secret', master, owner);
    expect(ciphertext).not.toBe(previous!.ciphertext);
    await db.prepare('UPDATE arena_credentials SET ciphertext=?,deleted_at=NULL WHERE id=?').bind(ciphertext, own.credentialId).run();
    await db.prepare("UPDATE arena_bamboo_connections SET status='connected' WHERE owner_id=?").bind(owner).run();
    blocker.release();
    await until(async () => (await snapshot(session.id)).runs[0].lastDecision?.outcome === (changedKey ? 'failed' : 'applied'), 'BambooNode arcade response validates the actual key');
    const current = await snapshot(session.id);
    const decisions = current.events.filter(event => event.type === 'decision');
    expect(decisions[0].outcome).toBe(changedKey ? 'failed' : 'applied');
    expect(current.events.filter(event => event.type === 'input' && !event.release)).toHaveLength(changedKey ? 0 : 1);
    expect(current.status).toBe(changedKey ? 'paused' : 'running');
    if (changedKey) { expect(current.error).toContain('BambooNode authorization changed'); expect(calls).toHaveLength(1); }
    // Stop before releasing any following fixture so it cannot add more controls.
    await command(session.id, 'end'); following.release();
  });

  it('rechecks BambooNode expiry and catalog removal after creation before dispatching any arcade request', async () => {
    for (const condition of ['expired', 'model-removed']) {
      const own = await bambooProfile(), session = await create([{ kind: 'ai', profile: own }], 'tetris');
      if (condition === 'expired') await db.prepare('UPDATE arena_bamboo_connections SET expires_at=? WHERE owner_id=?').bind(Date.now() - 1, owner).run();
      else await db.prepare("UPDATE arena_bamboo_connections SET models_json='[]' WHERE owner_id=?").bind(owner).run();
      expect((await command(session.id, 'start')).status).toBe(200);
      await until(async () => (await snapshot(session.id)).status === 'paused', 'invalid authorization pauses arcade session');
      expect((await snapshot(session.id)).runs[0].lastDecision?.outcome).toBe('failed'); expect(calls).toHaveLength(0);
      await command(session.id, 'end');
    }
  });

  it('simulates new Snake sessions at three cells per second and sends the same speed to the model', async () => {
    const blocker = gate(); reply = async body => { await blocker.promise; return success(body, '向右'); };
    const own = await profile(), session = await create([{ kind: 'ai', profile: own }], 'snake');
    expect(session.rulesVersion).toBe('snake-realtime-v2');
    expect((await command(session.id, 'start')).status).toBe(200);
    await until(() => calls.length === 1, 'one Snake observation');
    const observation = calls[0].state.position;
    expect(observation).toMatchObject({ tickRate: 60, movementEveryTicks: 20, movesPerSecond: 3 });
    expect(observation.nextMoveInTicks).toBe(20 - observation.tick % 20);
    expect(calls[0].state.rules).toMatch(/每秒\s*3\s*格/);
    expect(calls[0].questions.primary_move.instructions).toContain('movesPerSecond');
    await until(async () => (await snapshot(session.id)).tick >= 60, 'at least one second of unassisted Snake physics');
    const moving = await snapshot(session.id);
    expect(moving.status).toBe('running'); expect(calls).toHaveLength(1);
    expect(moving.runs[0].view.snake![0]).toEqual({ x: 4 + Math.floor(moving.tick / 20), y: 10 });
    expect(moving.runs[0].view.score.survivedTicks).toBe(moving.tick);
  });

  it.each(['start', 'resume', 'retry'])('rejects %s for an old Snake v1 save but permits ending and preserves its replay version and position', async operation => {
    const own = await profile(), session = await create([{ kind: 'ai', profile: own }], 'snake');
    await patch(session.id, record => {
      record.rulesVersion = 'snake-realtime-v1';
      record.status = operation === 'start' ? 'ready' : 'paused'; record.needsRetry = operation === 'retry'; record.tick = 60;
      const state = record.runs[0].state;
      // Legacy saves have no movement interval. This is their six-moves-at-tick-60 position.
      state.tick = 60; state.score.survivedTicks = 60; state.body = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }]; state.food = { x: 0, y: 0 };
    });
    const before = await snapshot(session.id), denied = await command(session.id, operation);
    expect(denied.status).toBe(400);
    expect(await denied.json()).toMatchObject({ error: 'Rules version changed; this session cannot continue' });
    const rejected = await snapshot(session.id);
    expect(rejected.tick).toBe(60); expect(rejected.runs[0].view).toEqual(before.runs[0].view);
    expect(rejected.events.some(event => event.type === 'input')).toBe(false); expect(calls).toHaveLength(0);
    expect((await command(session.id, 'end')).status).toBe(200);
    const replay = await (await request(`/arcade-sessions/${session.id}/replay`)).json() as ArcadeReplayV2;
    expect(replay.rulesVersion).toBe('snake-realtime-v1'); expect(replay.result.aborted).toBe(true);
    expect(replay.result.scores[0].survivedTicks).toBe(60);
    expect(replay.frames.at(-1)?.views[0].snake![0]).toEqual({ x: 10, y: 10 });
    expect(calls).toHaveLength(0);
  });

  it.each(['snake', 'tetris', 'platformer'].flatMap(game => ['new', 'ready', 'paused', 'retry'].map(phase => [game, phase])))('forces no-thinking on %s SystemOne requests from %s sessions without rewriting saved profiles', async (game, phase) => {
    const blocker = gate(); reply = async body => { await blocker.promise; return success(body); };
    const source: ModelProfile = { ...await profile(), provider: 'systemone', endpoint: 'https://startlux-decision.com/v1/systemone', thinkMode: 'always', thinkBudget: 1024 };
    const original = structuredClone(source), session = await create([{ kind: 'ai', profile: source }], game);
    expect(session.runs[0].controller.profile?.thinkMode).toBe('never');
    expect(source).toEqual(original);
    const storedMode = phase === 'paused' ? 'auto' : 'always';
    if (phase !== 'new') await patch(session.id, record => {
      record.status = phase === 'ready' ? 'ready' : 'paused'; record.needsRetry = phase === 'retry';
      record.runs[0].controller.profile = { ...source, thinkMode: storedMode };
      record.input.controllers[0].profile = { ...source, thinkMode: storedMode };
    });
    const restored = await snapshot(session.id);
    expect(restored.runs[0].controller.profile?.thinkMode).toBe('never');
    expect(restored.runs[0].controller.profile?.thinkBudget).toBe(1024);
    if (phase === 'retry') expect((await command(session.id, 'resume')).status).toBe(400);
    expect((await command(session.id, phase === 'paused' ? 'resume' : phase === 'retry' ? 'retry' : 'start')).status).toBe(200);
    await until(() => calls.length === 1, 'one no-thinking request');
    expect(calls[0].think_mode).toBe('never'); expect(calls[0].return_thought).toBe(false);
    expect(calls[0].think_budget).toBe(1024); expect(calls[0].return_details).toBe(true);
    expect(source).toEqual(original);
    expect((await command(session.id, 'end')).status).toBe(200);
    blocker.release();
    await until(async () => !(await snapshot(session.id)).runs[0].inflight, 'no-thinking fixture settles');
    const replay = await (await request(`/arcade-sessions/${session.id}/replay`)).json() as ArcadeReplayV2;
    // New sessions freeze the policy; legacy archive metadata retains its original profile.
    expect(replay.controllers[0].profile?.thinkMode).toBe(phase === 'new' ? 'never' : storedMode);
    expect(replay.controllers[0].profile?.thinkBudget).toBe(1024);
    expect(source.thinkMode).toBe('always'); expect(calls).toHaveLength(1);
  });

  it('keeps Jev/OpenRouter requests free of unsupported thinking parameters', async () => {
    const blocker = gate(); reply = async body => { await blocker.promise; return success(body); };
    const source: ModelProfile = { ...await profile(), thinkMode: 'always', thinkBudget: 1024 };
    const session = await create([{ kind: 'ai', profile: source }]);
    expect((await command(session.id, 'start')).status).toBe(200);
    await until(() => calls.length === 1, 'one Jev fixture request');
    for (const key of ['think_mode', 'think_budget', 'return_thought', 'return_details']) expect(calls[0]).not.toHaveProperty(key);
    expect(calls[0].model).toBe(source.model); expect(source.thinkMode).toBe('always');
  });

  it.each(['snake', 'tetris', 'platformer'] as const)('gates persisted %s inputs until a physical frame consumes them', game => {
    const adapter = getArcadeGame(game), original = adapter.create({}, 'scheduler-fixture');
    const action = adapter.candidates(original).find(candidate => candidate.id === `${game === 'snake' ? 'up' : game === 'tetris' ? 'hard-drop' : 'jump'}:100`)!;
    expect(action).toBeDefined();
    const lane = structuredClone({ state: adapter.input(original, action.input), observeAfterTick: 1 });
    expect(canObserveAfterInput(lane)).toBe(false);
    // A model promise settling or a storage sync yielding does not advance this state.
    expect(canObserveAfterInput(structuredClone(lane))).toBe(false);
    lane.state = adapter.step(lane.state);
    expect(canObserveAfterInput(lane)).toBe(true);
    expect(lane.state.held).toEqual(action.input.buttons);
    expect(lane.state.releaseTick).toBeGreaterThan(lane.state.tick);
    if (game === 'tetris') {
      expect(adapter.view(lane.state).pieceId).toBe(adapter.view(original).pieceId! + 1);
      expect(adapter.view(lane.state).cells!.filter(Boolean)).toHaveLength(4);
    } else if (game === 'platformer') {
      expect(adapter.view(lane.state).player!.y).toBeLessThan(adapter.view(original).player!.y);
      expect(adapter.view(lane.state).player!.onGround).toBe(false);
    } else expect((adapter.observe(lane.state) as any).queued).toBe('up');
  });

  it('retains a dispatch boundary when the last decision changes and reads old records without the new field', () => {
    const accepted = { state: { tick: 42 }, lastDecision: { appliedTick: 43 } };
    expect(canObserveAfterInput(accepted)).toBe(false);
    expect(canObserveAfterInput({ ...accepted, state: { tick: 43 } })).toBe(true);
    expect(canObserveAfterInput({ state: { tick: 42 }, observeAfterTick: 43, lastDecision: {} })).toBe(false);
    expect(canObserveAfterInput({ state: { tick: 0 } })).toBe(true);
  });

  it.each(['snake', 'tetris', 'platformer'] as const)('cancels a stale %s request before sending even while the other lane keeps running', game => {
    const adapter = getArcadeGame(game), original = adapter.create({}, 'preflight-fixture');
    const session = { status: 'running', generation: 2 };
    const pending = { requestId: 'fixture-pending', generation: 2, pieceId: adapter.view(original).pieceId };
    const live = { status: original.status, requestId: pending.requestId, pieceId: pending.pieceId };
    expect(canSendObservedDecision(session, live, pending)).toBe(true);
    const finished = adapter.step(original, 7200);
    expect(finished.status).toBe('finished');
    expect(canSendObservedDecision(session, { ...live, status: finished.status }, pending)).toBe(false);
    expect(canSendObservedDecision({ ...session, generation: 3 }, live, pending)).toBe(false);
    expect(canSendObservedDecision(session, { ...live, requestId: 'replacement' }, pending)).toBe(false);
    expect(canSendObservedDecision(session, undefined, pending)).toBe(false);
    if (game === 'tetris') {
      const next = adapter.step(adapter.input(original, { buttons: ['hard-drop'], durationMs: 100 }));
      expect(next.status).toBe('playing');
      expect(canSendObservedDecision(session, { ...live, pieceId: adapter.view(next).pieceId }, pending)).toBe(false);
    }
  });

  it.each(['snake', 'tetris', 'platformer'] as const)('continues %s physics during inference and only observes after the prior accepted input executes', async game => {
    const first = gate(), following = gate();
    const action = game === 'tetris' ? '硬降' : game === 'snake' ? '向上' : '尝试跳跃一次';
    reply = async (body, index) => { await (index < 2 ? first.promise : following.promise); return success(body, action); };
    const own = await profile(), other = { ...own, model: 'fixture-second-lane' };
    const session = await create([{ kind: 'ai', profile: own }, { kind: 'ai', profile: other }], game);
    expect((await command(session.id, 'start')).status).toBe(200);
    await until(() => calls.length === 2, 'initial observations');
    await sleep(550);
    const moving = await snapshot(session.id);
    expect(moving.status).toBe('running'); expect(moving.tick).toBeGreaterThan(25);
    expect(moving.runs.every(run => run.view.score.survivedTicks > 25)).toBe(true);
    expect(calls).toHaveLength(2); expect(peak).toBe(2);
    first.release();
    await until(() => calls.length === 4, 'fresh observations after applying controls');
    const current = await snapshot(session.id);
    for (const [index, model] of [own.model, other.model].entries()) {
      const [before, after] = calls.filter(body => body.model === model);
      const accepted = current.events.find(event => event.type === 'decision' && event.runId === session.runs[index].id && event.outcome === 'applied')!;
      expect(accepted).toBeDefined(); expect(accepted.promptVersion).toBe(ARCADE_PROMPT_VERSION);
      expect(after.state.observedTick).toBeGreaterThanOrEqual(accepted.appliedTick!);
      expect(after.state.position.tick).toBe(after.state.observedTick);
      expect(after.state.promptVersion).toBe(ARCADE_PROMPT_VERSION);
      expect(after.questions.primary_move.instructions).toBe(arcadeDecisionInstructions(game));
      expect(after.state.runtime.tickRate).toBe(60);
      expect(after.state.runtime.lastResponseMs).toBeGreaterThanOrEqual(500);
      if (game === 'tetris') {
        expect(after.state.position.pieceId).toBe(before.state.position.pieceId + 1);
        expect(after.state.position.board.rows.some((row: any) => /[IOTSZJL]/.test(row.cells))).toBe(true);
        expect(after.state.position.controls.pendingEdges).toEqual([]);
      } else if (game === 'platformer') {
        expect(after.state.position.player.y).toBeLessThan(before.state.position.player.y);
        expect(after.state.position.player.onGround).toBe(false);
        expect(after.state.position.controls.pendingEdges).toEqual([]);
      } else expect(after.state.position.queued === 'up' || after.state.position.direction === 'up').toBe(true);
    }
    expect(calls).toHaveLength(4);
  });

  it.each(['tetris', 'platformer'] as const)('does not wait for a 1000ms %s hold to finish before taking another observation', async game => {
    const following = gate(); reply = async (body, index) => {
      if (index >= 2) await following.promise;
      return success(body, '持续向右移动，1000 毫秒');
    };
    const own = await profile(), other = { ...own, model: 'fixture-held-second-lane' };
    const session = await create([{ kind: 'ai', profile: own }, { kind: 'ai', profile: other }], game);
    await command(session.id, 'start'); await until(() => calls.length === 4, 'next observation during long hold');
    const current = await snapshot(session.id);
    for (const [index, model] of [own.model, other.model].entries()) {
      const next = calls.filter(body => body.model === model)[1];
      const previous = current.events.find(event => event.type === 'decision' && event.runId === session.runs[index].id && event.outcome === 'applied')!;
      expect(previous.actionId).toBe('right:1000');
      expect(next.state.observedTick).toBeGreaterThanOrEqual(previous.appliedTick!);
      expect(next.state.observedTick).toBeLessThan(previous.appliedTick! + 59);
      expect(next.state.position.controls.held).toContain('right');
      expect(next.state.position.controls.releaseInTicks).toBeGreaterThan(0);
    }
  });

  it.each(['snake', 'tetris', 'platformer'].flatMap(game => ['practice', 'human-ai', 'ai-ai'].map(mode => [game, mode])))('executes %s / %s with real simulation and fixture decisions', async (game, mode) => {
    const own = await profile();
    const controllers: SeatConfig[] = mode === 'practice' ? [{ kind: 'human' }] : mode === 'human-ai' ? [{ kind: 'human' }, { kind: 'ai', profile: own }] : [{ kind: 'ai', profile: own }, { kind: 'ai', profile: own }];
    const session = await create(controllers, game, mode);
    for (const run of session.runs) {
      if (run.controller.kind === 'human') {
        expect(run.predictionState).toBeDefined();
        expect(getArcadeGame(game as 'snake' | 'tetris' | 'platformer').view(run.predictionState!)).toEqual(run.view);
      } else expect(run.predictionState).toBeUndefined();
    }
    const connection = mode === 'ai-ai' ? undefined : await socket(session.id);
    const token = connection && await claim(connection, session.runs[0].id);
    expect((await command(session.id, 'start')).status).toBe(200);
    if (connection) connection.send({ type: 'input', runId: session.runs[0].id, controllerSession: token, clientSeq: 1, input: { buttons: game === 'snake' ? ['up'] : ['right'] } });
    await until(async () => { const current = await snapshot(session.id); return current.tick > 3 && (mode === 'practice' || current.events.some(event => event.type === 'decision' && event.outcome === 'applied')); }, 'mode simulates and responds');
    const current = await snapshot(session.id);
    if (connection) expect(current.events.some(event => event.type === 'input' && event.runId === session.runs[0].id && event.input?.buttons.length)).toBe(true);
    if (mode !== 'practice') expect(calls.length).toBeGreaterThanOrEqual(mode === 'ai-ai' ? 2 : 1);
    expect(current.result).toBeUndefined();
  });
  it.each(['snake', 'tetris', 'platformer'] as const)('runs one %s AI without any viewer or heartbeat, pauses/resumes and archives one score track', async game => {
    reply = async body => success(body, game === 'snake' ? '向右' : '释放所有按键');
    const own = await profile(), session = await create([{ kind: 'ai', profile: own }], game);
    expect(session.mode).toBe('ai-solo'); expect(session.runs).toHaveLength(1);
    expect(session.runs[0].predictionState).toBeUndefined();
    expect((await command(session.id, 'start')).status).toBe(200);
    // Longer than the human disconnect timeout: there is deliberately no WebSocket.
    await until(async () => (await snapshot(session.id)).tick >= 130, 'solo simulation without viewers');
    const moving = await snapshot(session.id);
    expect(moving.status).toBe('running'); expect(moving.runs[0].view.score.survivedTicks).toBeGreaterThanOrEqual(130);
    expect(moving.runs[0].calls).toBeGreaterThanOrEqual(3); expect(peak).toBe(1);
    expect(moving.events.some(event => event.type === 'input' && event.requestId && event.runId === 'run-0')).toBe(true);
    expect((await command(session.id, 'pause')).status).toBe(200);
    await until(async () => !(await snapshot(session.id)).runs[0].inflight, 'solo request settles before resume');
    const paused = await snapshot(session.id); await sleep(100);
    expect((await snapshot(session.id)).tick).toBe(paused.tick);
    expect((await command(session.id, 'resume')).status).toBe(200);
    await until(async () => (await snapshot(session.id)).tick > paused.tick + 3, 'solo resumes without a controller claim');
    expect((await command(session.id, 'end')).status).toBe(200);
    await until(async () => !(await snapshot(session.id)).runs[0].inflight, 'solo terminal request settles');
    const final = await snapshot(session.id);
    expect(final.result).toEqual({ winner: null, reason: 'ended_by_user', scores: [final.runs[0].view.score], aborted: true });
    const replay = await (await request(`/arcade-sessions/${session.id}/replay`)).json() as ArcadeReplayV2;
    expect(replay.mode).toBe('ai-solo'); expect(replay.runIds).toEqual(['run-0']);
    expect(replay.controllers).toHaveLength(1); expect(replay.result.scores).toHaveLength(1);
    expect(replay.result.winner).toBeNull(); expect(replay.frames.every(frame => frame.views.length === 1)).toBe(true);
    expect(replay.events.filter(event => event.runId).every(event => event.runId === 'run-0')).toBe(true);
    const bucket = await mf.getR2Bucket('REPLAYS');
    await until(async () => !!await bucket.get(`replays/${session.id}.json`), 'solo private replay archive');
    const archived = await (await bucket.get(`replays/${session.id}.json`))!.json() as ArcadeReplayV2;
    expect(archived.runIds).toEqual(['run-0']); expect(archived.result).toEqual(replay.result);
  });

  it('rejects incorrect solo controller layouts and foreign or missing model credentials', async () => {
    const own = await profile(), foreign = await profile(stranger);
    const invalid = [[], [{ kind: 'human' }], [{ kind: 'ai' }],
      [{ kind: 'ai', profile: own }, { kind: 'ai', profile: own }],
      [{ kind: 'human' }, { kind: 'ai', profile: own }], [{ kind: 'ai', profile: foreign }]];
    for (const controllers of invalid) {
      expect((await request('/arcade-sessions', { gameId: 'tetris', mode: 'ai-solo', config: {}, controllers })).status).toBe(400);
    }
    for (const mode of ['practice', 'human-ai', 'ai-ai']) {
      expect((await request('/arcade-sessions', { gameId: 'tetris', mode, config: {}, controllers: [{ kind: 'ai', profile: own }] })).status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it('rejects owner spectator claims and fabricated inputs on a ready or running solo AI track', async () => {
    const blocker = gate(); reply = async body => { await blocker.promise; return success(body); };
    const own = await profile(), session = await create([{ kind: 'ai', profile: own }]);
    const connection = await socket(session.id);
    const attemptTakeover = async () => {
      const before = connection.messages.length;
      connection.send({ type: 'claim', runId: 'run-0' });
      connection.send({ type: 'input', runId: 'run-0', controllerSession: 'fixture-forged-controller', clientSeq: 1, input: { buttons: ['hard-drop'] } });
      await until(() => connection.messages.slice(before).filter(item => item.type === 'error').length === 2, 'both spectator controls rejected');
      const errors = connection.messages.slice(before).filter(item => item.type === 'error');
      expect(errors[0].message).toBe('This run is not controlled by an active human');
      expect(errors[1].message).toBe('Controller session expired; claim again');
      expect(connection.messages.some(item => item.type === 'controller' || item.type === 'ack')).toBe(false);
    };
    await attemptTakeover();
    const ready = await snapshot(session.id);
    expect(ready.runs[0].view).toEqual(session.runs[0].view);
    expect(ready.events.some(event => event.type === 'input')).toBe(false);
    expect(ready.runs[0].controller).toEqual(session.runs[0].controller);
    expect(calls).toHaveLength(0);

    expect((await command(session.id, 'start')).status).toBe(200);
    await until(() => calls.length === 1, 'solo model is waiting');
    await attemptTakeover();
    const running = await snapshot(session.id), adapter = getArcadeGame('tetris');
    expect(running.status).toBe('running');
    expect(running.runs[0].controller).toEqual(session.runs[0].controller);
    expect(running.runs[0].view).toEqual(adapter.view(adapter.step(adapter.create({}, session.seed), running.tick)));
    expect(running.events.some(event => event.type === 'input')).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('keeps the solo AI account lease until a pending request settles, then lets another session start', async () => {
    const blocker = gate(); reply = async body => { await blocker.promise; return success(body); };
    const own = await profile(), session = await create([{ kind: 'ai', profile: own }]);
    const next = await create([{ kind: 'ai', profile: own }]);
    expect((await command(session.id, 'start')).status).toBe(200);
    await until(() => calls.length === 1, 'one solo request');
    expect((await request('/provider-test', { profile: own, key: 'fixture', request: { state: {}, instructions: 'choose', actions: [{ id: 'ok', label: 'ok' }] } })).status).toBe(429);
    expect((await command(next.id, 'start')).status).toBe(400);
    expect((await command(session.id, 'pause')).status).toBe(200);
    expect((await command(next.id, 'start')).status).toBe(400);
    expect(calls).toHaveLength(1);
    blocker.release();
    await until(async () => !(await snapshot(session.id)).runs[0].inflight, 'paused solo call settles');
    await until(async () => (await command(next.id, 'start')).status === 200, 'lease becomes available after settlement');
    await until(() => calls.length === 2, 'one new solo request');
    expect(peak).toBe(1); expect((await snapshot(session.id)).runs[0].lastDecision?.outcome).toBe('dropped');
  });

  it('pauses a solo model exactly at its call budget without inventing a loss', async () => {
    const own = await profile(), session = await create([{ kind: 'ai', profile: own }]);
    await patch(session.id, record => { record.runs[0].calls = 299; });
    expect((await command(session.id, 'start')).status).toBe(200);
    await until(async () => (await snapshot(session.id)).status === 'paused', 'solo budget reached');
    const paused = await snapshot(session.id);
    expect(paused.runs[0].calls).toBe(300); expect(calls).toHaveLength(1); expect(paused.result).toBeUndefined();
    expect(paused.needsRetry).toBe(false); expect((await command(session.id, 'resume')).status).toBe(400);
    expect((await command(session.id, 'end')).status).toBe(200);
    const ended = await snapshot(session.id); expect(ended.result?.winner).toBeNull(); expect(ended.result?.scores).toHaveLength(1);
  });

  it('finishes a naturally ended solo run without an opponent and retains the actual game reason', async () => {
    const own = await profile(), session = await create([{ kind: 'ai', profile: own }], 'snake');
    const adapter = getArcadeGame('snake'); let beforeCollision = adapter.create({}, session.seed);
    while (adapter.step(beforeCollision).status === 'playing') beforeCollision = adapter.step(beforeCollision);
    await patch(session.id, record => { record.tick = beforeCollision.tick; record.runs[0].state = beforeCollision; });
    expect((await command(session.id, 'start')).status).toBe(200);
    await until(async () => (await snapshot(session.id)).status === 'finished', 'solo collision finishes the session');
    const final = await snapshot(session.id);
    expect(final.runs[0].view.reason).toBe('WALL_COLLISION');
    expect(final.result).toEqual({ winner: null, reason: 'runs_finished', scores: [final.runs[0].view.score], aborted: false });
    expect(calls).toHaveLength(0);
    const replay = await (await request(`/arcade-sessions/${session.id}/replay`)).json() as ArcadeReplayV2;
    expect(replay.frames.at(-1)?.views[0].reason).toBe('WALL_COLLISION'); expect(replay.runIds).toEqual(['run-0']);
  });

  it('isolates owners, rejects foreign credentials and invalid seeds/modes, and creates equal seeded boards', async () => {
    const denied = await mf.dispatchFetch('https://arcade.test/arcade-sessions', { method: 'POST', headers: { 'X-Arena-Owner': owner }, body: '{}' });
    expect(denied.status).toBe(401);
    const foreign = await profile(stranger);
    expect((await request('/arcade-sessions', { gameId: 'tetris', mode: 'ai-ai', config: {}, controllers: [{ kind: 'ai', profile: foreign }, { kind: 'ai', profile: foreign }] })).status).toBe(400);
    const own = await profile();
    expect((await request('/arcade-sessions', { gameId: 'tetris', mode: 'practice', config: {}, controllers: [{ kind: 'ai', profile: own }] })).status).toBe(400);
    expect((await request('/arcade-sessions', { gameId: 'tetris', mode: 'practice', config: {}, controllers: [{ kind: 'human' }], seed: 'x'.repeat(129) })).status).toBe(400);
    const session = await create([{ kind: 'ai', profile: own }, { kind: 'ai', profile: own }]);
    expect(session.runs[0].view).toEqual(session.runs[1].view);
    for (const suffix of ['', '/replay', '/commands']) expect((await request(`/arcade-sessions/${session.id}${suffix}`, suffix === '/commands' ? { type: 'end', operationId: crypto.randomUUID() } : undefined, stranger)).status).toBe(404);
    const ws = await mf.dispatchFetch(`https://arcade.test/arcade-sessions/${session.id}/socket`, { headers: { 'X-Arena-Owner': stranger, 'X-Arena-Internal': internal, Upgrade: 'websocket' } });
    expect(ws.status).toBe(404); expect(calls).toHaveLength(0);
  });

  it('continues physics without viewers during two pending models, limits concurrency and drops paused responses', async () => {
    const blocker = gate(); reply = async body => { await blocker.promise; return success(body, '向右'); };
    const own = await profile(), session = await create([{ kind: 'ai', profile: own }, { kind: 'ai', profile: own }]);
    expect((await command(session.id, 'start')).status).toBe(200);
    await until(() => calls.length === 2, 'two concurrent requests');
    await sleep(700);
    const moving = await snapshot(session.id); expect(moving.status).toBe('running'); expect(moving.tick).toBeGreaterThan(30); expect(calls).toHaveLength(2); expect(peak).toBe(2);
    const pauseId = crypto.randomUUID(); expect((await command(session.id, 'pause', pauseId)).status).toBe(200);
    const paused = await snapshot(session.id);
    expect((await command(session.id, 'pause', pauseId)).status).toBe(200);
    expect((await command(session.id, 'end', pauseId)).status).toBe(400);
    blocker.release(); await until(async () => (await snapshot(session.id)).runs.every(run => !run.inflight), 'paused responses settle');
    await sleep(550); const settled = await snapshot(session.id);
    expect(settled.tick).toBe(paused.tick); expect(calls).toHaveLength(2); expect(settled.runs.every(run => run.lastDecision?.outcome === 'dropped')).toBe(true);
    expect(settled.events.filter(event => event.type === 'decision').every(event => !event.input)).toBe(true);
  });

  it('shares the owner lease with connection tests and old chess without dispatching extra paid calls', async () => {
    const blocker = gate(); reply = async body => { await blocker.promise; return success(body); };
    const own = await profile(), session = await create([{ kind: 'ai', profile: own }, { kind: 'ai', profile: own }]);
    await command(session.id, 'start'); await until(() => calls.length === 2, 'two requests');
    expect((await request('/provider-test', { profile: own, key: 'fixture', request: { state: {}, instructions: 'choose', actions: [{ id: 'ok', label: 'ok' }] } })).status).toBe(429);
    const other = await create([{ kind: 'ai', profile: own }, { kind: 'ai', profile: own }]);
    expect((await command(other.id, 'start')).status).toBe(400);
    const chessResponse = await request('/matches', { gameId: 'gomoku', config: { size: 9 }, seats: [{ kind: 'ai', profile: own }, { kind: 'ai', profile: own }] });
    const chess = await chessResponse.json() as any;
    await request(`/matches/${chess.id}/commands`, { type: 'start', operationId: crypto.randomUUID() });
    await until(async () => (await (await request(`/matches/${chess.id}`)).json() as any).status === 'paused', 'old chess obeys shared lease');
    await request(`/matches/${chess.id}/commands`, { type: 'end', operationId: crypto.randomUUID() });
    expect(calls).toHaveLength(2);
  });

  it('applies each successful AI input once, preserves private reasoning and pauses on one provider error', async () => {
    const blocker = gate(); reply = async (body, index) => index === 0 ? success(body, '向右') : (await blocker.promise, new MockResponse('fixture failure', { status: 503 }));
    const own = await profile(), session = await create([{ kind: 'ai', profile: own }, { kind: 'ai', profile: own }]);
    await command(session.id, 'start'); await until(async () => (await snapshot(session.id)).events.some(event => event.type === 'decision' && event.outcome === 'applied'), 'one successful independent input');
    blocker.release(); await until(async () => (await snapshot(session.id)).status === 'paused', 'provider error pauses');
    const current = await snapshot(session.id), applied = current.events.find(event => event.type === 'decision' && event.outcome === 'applied')!;
    const inputs = current.events.filter(event => event.type === 'input' && event.requestId === applied.requestId);
    expect(inputs).toHaveLength(1); expect(inputs[0].appliedTick).toBe(applied.appliedTick); expect(applied.input).toBeUndefined(); expect(applied.reasoning?.text).toBe(privateThought);
    expect((await command(session.id, 'resume')).status).toBe(400);
    const row = await db.prepare('SELECT summary_json FROM arena_matches WHERE id=?').bind(session.id).first<{ summary_json: string }>();
    expect(row!.summary_json).not.toContain(privateThought); expect(JSON.stringify(calls)).not.toContain(privateThought);
  });

  it('claims human controls, deduplicates original input acknowledgements and releases disconnected keys', async () => {
    const session = await create([{ kind: 'human' }], 'platformer');
    expect((await command(session.id, 'start')).status).toBe(400);
    const connection = await socket(session.id), token = await claim(connection, session.runs[0].id);
    const ready = await snapshot(session.id);
    expect(await claim(connection, session.runs[0].id)).toBe(token);
    const readyAfterClaim = await snapshot(session.id);
    expect(readyAfterClaim.version).toBe(ready.version); expect(readyAfterClaim.events).toEqual(ready.events);
    expect((await command(session.id, 'start')).status).toBe(200);
    const input = { type: 'input', runId: session.runs[0].id, controllerSession: token, clientSeq: 1, input: { buttons: ['right'] } };
    connection.send(input); await until(() => connection.messages.some(item => item.type === 'ack'), 'first input ack');
    const firstAck = connection.messages.find(item => item.type === 'ack');
    expect(await claim(connection, session.runs[0].id)).toBe(token);
    await sleep(150); connection.send(input); await until(() => connection.messages.filter(item => item.type === 'ack').length === 2, 'duplicate input ack');
    expect(connection.messages.filter(item => item.type === 'ack')[1].appliedTick).toBe(firstAck.appliedTick);
    expect((await snapshot(session.id)).events.filter(event => event.type === 'input' && event.input?.buttons.includes('right'))).toHaveLength(1);
    await until(async () => !(await snapshot(session.id)).runs[0].view.currentButtons.length, 'keys released after one-second heartbeat gap');
    await until(async () => (await snapshot(session.id)).status === 'paused', 'both boards paused after disconnect');
    const paused = await snapshot(session.id); await sleep(120); expect((await snapshot(session.id)).tick).toBe(paused.tick);
    const pausedToken = connection.messages.filter(item => item.type === 'controller').at(-1).controllerSession;
    expect(await claim(connection, session.runs[0].id)).toBe(pausedToken);
    const pausedAfterClaim = await snapshot(session.id);
    expect(pausedAfterClaim.version).toBe(paused.version); expect(pausedAfterClaim.events).toEqual(paused.events);
    connection.send(input); await until(() => connection.messages.some(item => item.type === 'error' && item.message.includes('expired')), 'old controller generation rejected');
  });

  it.each(['ready', 'paused'])('rejects new human claims at the event budget while %s and still permits ending', async status => {
    const session = await create([{ kind: 'human' }]);
    await patch(session.id, record => { record.status = status; record.eventSeq = 12000; });
    const before = await snapshot(session.id), connection = await socket(session.id);
    for (let attempt = 0; attempt < 3; attempt++) connection.send({ type: 'claim', runId: session.runs[0].id });
    await until(() => connection.messages.filter(item => item.type === 'error').length === 3, 'budget rejects repeated new claims');
    expect(connection.messages.filter(item => item.type === 'error').every(item => item.message === 'The session event budget was reached')).toBe(true);
    expect(connection.messages.some(item => item.type === 'controller')).toBe(false);
    const after = await snapshot(session.id);
    expect(after.status).toBe(status); expect(after.version).toBe(before.version); expect(after.events).toEqual(before.events);
    expect(after.runs[0].view).toEqual(before.runs[0].view);
    expect((await command(session.id, 'end')).status).toBe(200);
    const replay = await (await request(`/arcade-sessions/${session.id}/replay`)).json() as ArcadeReplayV2;
    expect(replay.result.aborted).toBe(true); expect(replay.events.at(-1)).toMatchObject({ type: 'ended', seq: 12001 });
    expect(calls).toHaveLength(0);
  });

  it('acknowledges the existing human claim at the event budget without adding another event', async () => {
    const session = await create([{ kind: 'human' }]);
    await patch(session.id, record => { record.eventSeq = 11999; });
    const connection = await socket(session.id), token = await claim(connection, session.runs[0].id);
    const before = await snapshot(session.id);
    expect(before.events.at(-1)).toMatchObject({ type: 'input', seq: 12000, release: true });
    expect(await claim(connection, session.runs[0].id)).toBe(token);
    const after = await snapshot(session.id);
    expect(after.version).toBe(before.version); expect(after.events).toEqual(before.events);
    expect((await command(session.id, 'end')).status).toBe(200);
  });

  it('archives terminal private replay with an initial frame, run mapping and no second input in decision events', async () => {
    const own = await profile(), session = await create([{ kind: 'ai', profile: own }, { kind: 'ai', profile: own }]);
    await command(session.id, 'start'); await until(async () => (await snapshot(session.id)).events.some(event => event.outcome === 'applied'), 'model applied');
    const endId = crypto.randomUUID(); expect((await command(session.id, 'end', endId)).status).toBe(200); expect((await command(session.id, 'end', endId)).status).toBe(200);
    await until(async () => (await snapshot(session.id)).runs.every(run => !run.inflight), 'terminal requests settle');
    const replay = await (await request(`/arcade-sessions/${session.id}/replay`)).json() as ArcadeReplayV2;
    expect(replay.version).toBe(2); expect(replay.promptVersion).toBe(ARCADE_PROMPT_VERSION); expect(replay.runIds).toEqual(['run-0', 'run-1']); expect(replay.frames[0].tick).toBe(0); expect(replay.result.aborted).toBe(true);
    expect(replay.events.some(event => event.reasoning?.text === privateThought)).toBe(true);
    expect(replay.events.filter(event => event.type === 'decision').every(event => event.input === undefined)).toBe(true);
    expect(replay.events.filter(event => event.type === 'decision').every(event => event.promptVersion === ARCADE_PROMPT_VERSION)).toBe(true);
    expect(JSON.stringify(replay)).not.toContain('credentialId'); expect(JSON.stringify(replay)).not.toContain('fixture-model-secret');
    const bucket = await mf.getR2Bucket('REPLAYS'); await until(async () => !!await bucket.get(`replays/${session.id}.json`), 'private R2 archive');
  });

  it('records successful late metrics after end and only archives once both outstanding requests settle', async () => {
    const blocker = gate(); reply = async body => { await blocker.promise; return success(body, '向右'); };
    const own = await profile(), session = await create([{ kind: 'ai', profile: own }, { kind: 'ai', profile: own }]);
    await command(session.id, 'start'); await until(() => calls.length === 2, 'both paid requests started');
    expect((await command(session.id, 'end')).status).toBe(200);
    const ended = await snapshot(session.id), bucket = await mf.getR2Bucket('REPLAYS');
    expect(ended.status).toBe('finished'); expect(await bucket.get(`replays/${session.id}.json`)).toBeNull();
    blocker.release(); await until(async () => (await snapshot(session.id)).runs.every(run => !run.inflight), 'late metrics recorded');
    const final = await snapshot(session.id); expect(final.tick).toBe(ended.tick);
    expect(final.runs.every(run => run.lastDecision?.outcome === 'dropped' && run.lastDecision.metrics?.actualModel === 'fixture-arcade-model')).toBe(true);
    await until(async () => !!await bucket.get(`replays/${session.id}.json`), 'complete replay archive');
    const archive = await (await bucket.get(`replays/${session.id}.json`))!.json() as ArcadeReplayV2;
    expect(archive.events.filter(event => event.type === 'decision' && event.metrics?.actualModel === 'fixture-arcade-model')).toHaveLength(2);
    expect(archive.events.some(event => event.type === 'input' && event.requestId)).toBe(false);
  });

  it.each(['ai-ai', 'ai-solo'])('restores unknown %s calls as paused without reissuing, and requires explicit retry with a fresh observation', async mode => {
    const own = await profile(), session = await create(mode === 'ai-solo' ? [{ kind: 'ai', profile: own }] : [{ kind: 'ai', profile: own }, { kind: 'ai', profile: own }]);
    const leases = await mf.getDurableObjectNamespace('USER_QUOTAS'), leaseId = `fixture-recovery:${session.id}`;
    expect(await (leases.get(leases.idFromName(owner)) as any).acquire(leaseId)).toBe(true);
    await patch(session.id, record => {
      delete record.promptVersion;
      record.runs.forEach((run: any) => { delete run.observeAfterTick; });
      record.status = 'running'; record.anchorWall = Date.now() - 60000; record.lastBatchWall = record.anchorWall;
      record.leaseId = leaseId; record.leaseRenewedAt = Date.now();
      record.runs[0].calls = 1; record.runs[0].inflight = { requestId: 'fixture-uncertain-call', generation: record.generation, observedTick: 0, startedAt: Date.now() - 1000 };
    });
    const recovered = await snapshot(session.id); expect(recovered.status).toBe('paused'); expect(recovered.tick).toBe(0); expect(recovered.needsRetry).toBe(true); expect(recovered.runs[0].lastDecision?.outcome).toBe('unknown'); expect(calls).toHaveLength(0);
    expect(recovered.events.find(event => event.requestId === 'fixture-uncertain-call')?.promptVersion).toBe('decision-arena-arcade-v1');
    expect((await command(session.id, 'resume')).status).toBe(400);
    expect((await command(session.id, 'retry')).status).toBe(200); await until(() => calls.length >= session.runs.length, 'explicit fresh retry');
    expect(calls[0].state.observedTick).toBeLessThan(30); expect((await snapshot(session.id)).runs[0].calls).toBeGreaterThanOrEqual(2);
    await command(session.id, 'end');
    await until(async () => (await snapshot(session.id)).runs.every(run => !run.inflight), 'mixed-version requests settle');
    const replay = await (await request(`/arcade-sessions/${session.id}/replay`)).json() as ArcadeReplayV2;
    expect(replay.promptVersion).toBe('decision-arena-arcade-v1');
    expect(replay.events.filter(event => event.type === 'decision' && event.requestId !== 'fixture-uncertain-call').every(event => event.promptVersion === ARCADE_PROMPT_VERSION)).toBe(true);
  });

  it('drops a model control after its observed Tetris piece has already locked and spawned another', async () => {
    const own = await profile(), session = await create([{ kind: 'ai', profile: own }, { kind: 'ai', profile: own }]);
    const adapter = getArcadeGame('tetris'); let nearLock: any = adapter.create({}, session.seed);
    for (let i = 0; i < 3000 && nearLock.lockTicks !== 24; i++) nearLock = adapter.step(nearLock);
    expect(nearLock.lockTicks).toBe(24);
    await patch(session.id, record => { record.tick = nearLock.tick; record.runs.forEach((run: any) => { run.state = structuredClone(nearLock); }); });
    const blocker = gate(); reply = async body => { await blocker.promise; return success(body, '硬降'); };
    await command(session.id, 'start'); await until(() => calls.length === 2, 'stale piece requests');
    const observedPiece = calls[0].state.position.pieceId;
    await until(async () => (await snapshot(session.id)).runs[0].view.pieceId !== observedPiece, 'piece advances while waiting');
    blocker.release(); await until(async () => (await snapshot(session.id)).runs[0].lastDecision?.outcome === 'dropped', 'old piece control dropped');
    const current = await snapshot(session.id);
    expect(current.events.some(event => event.type === 'decision' && event.outcome === 'dropped')).toBe(true);
  });

  it('handles a previously finished lane during pause/end and scores the natural 7200-tick limit', async () => {
    const own = await profile(), session = await create([{ kind: 'ai', profile: own }, { kind: 'ai', profile: own }], 'snake');
    await patch(session.id, record => { record.runs[0].state.status = 'finished'; record.runs[0].state.reason = 'collision'; });
    expect((await command(session.id, 'pause')).status).toBe(200); expect((await command(session.id, 'end')).status).toBe(200);
    const capped = await create([{ kind: 'ai', profile: own }, { kind: 'ai', profile: own }]);
    await patch(capped.id, record => { record.tick = 7199; record.runs.forEach((run: any) => { run.state.tick = 7199; run.state.score.survivedTicks = 7199; }); });
    expect((await command(capped.id, 'start')).status).toBe(200);
    await until(async () => (await snapshot(capped.id)).status === 'finished', 'natural time limit');
    const final = await snapshot(capped.id); expect(final.tick).toBe(7200); expect(final.result?.reason).toBe('time_limit'); expect(final.result?.aborted).toBe(false);
    const replay = await (await request(`/arcade-sessions/${capped.id}/replay`)).json() as ArcadeReplayV2;
    expect(replay.events.every(event => (event.appliedTick ?? 0) <= 7200)).toBe(true);
  });

  it('pauses at the model budget without judging a loss and prevents credentials revoked in-flight from applying', async () => {
    const own = await profile(), capped = await create([{ kind: 'ai', profile: own }, { kind: 'ai', profile: own }]);
    await patch(capped.id, record => { record.runs[0].calls = 300; });
    expect((await command(capped.id, 'start')).status).toBe(400); expect((await snapshot(capped.id)).result).toBeUndefined();
    const blocker = gate(); reply = async body => { await blocker.promise; return success(body, '向右'); };
    const session = await create([{ kind: 'ai', profile: own }, { kind: 'ai', profile: own }]);
    await command(session.id, 'start'); await until(() => calls.length === 2, 'requests started');
    await db.prepare('UPDATE arena_credentials SET deleted_at=? WHERE id=?').bind(Date.now(), own.credentialId).run();
    blocker.release(); await until(async () => (await snapshot(session.id)).status === 'paused', 'credential deletion pauses');
    expect((await snapshot(session.id)).events.some(event => event.type === 'decision' && event.outcome === 'applied')).toBe(false);
  });
});
