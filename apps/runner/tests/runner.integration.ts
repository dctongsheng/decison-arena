import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { Miniflare, Log, LogLevel, Response as MockResponse, type MiniflareOptions } from 'miniflare';
import type { CreateMatchInput, MatchSnapshot, ModelProfile, ReplayManifest, SeatConfig } from '@decision-arena/core';
import { encryptSecret, ENDPOINTS } from '@decision-arena/providers';

const master = 'fixture-master-key-do-not-use-in-production-2026';
const internal = 'fixture-internal-secret';
const providerKey = 'fixture-provider-secret-never-real';
const privateReasoning = 'fixture-private-reasoning: an unrevealed piece is near my flag';
const owner = 'fixture-alice', stranger = 'fixture-bob';
let mf: Miniflare;
let options: MiniflareOptions;
const persistence = mkdtempSync(resolve(tmpdir(), 'decision-arena-runner-test-'));
let db: Awaited<ReturnType<Miniflare['getD1Database']>>;
let calls: { body: any; authorization: string | null }[] = [];
let dnsAddresses = ['8.8.8.8'];
let reply: (body: any) => Promise<MockResponse>;
const success = (body: any, chosen?: string, thought?: string) => {
  const candidates = Object.keys(body.questions.primary_move.criteria);
  return new MockResponse(JSON.stringify({ model: 'fixture-decision-v1', answers: { primary_move: {
    choice: chosen ?? candidates[0], confidence: 0.75,
    probabilities: Object.fromEntries(candidates.map(key => [key, 1 / candidates.length])),
    details: { thought: { used: true, tokens: 16, ...(thought ? { text: thought } : {}) } },
  } }, usage: { input_tokens: 20, output_tokens: 5 } }), { headers: { 'content-type': 'application/json' } });
};

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function request(path: string, body?: unknown, account = owner) {
  return mf.dispatchFetch(`https://arena.test${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Arena-Owner': account, 'X-Arena-Internal': internal, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function snapshot(id: string, seat?: number): Promise<MatchSnapshot> {
  const response = await request(`/matches/${id}${seat === undefined ? '' : `?seat=${seat}`}`);
  expect(response.status).toBe(200);
  return response.json() as Promise<MatchSnapshot>;
}
async function command(id: string, value: Record<string, unknown>, seat?: number) {
  return request(`/matches/${id}/commands${seat === undefined ? '' : `?seat=${seat}`}`, { operationId: crypto.randomUUID(), ...value });
}
async function create(gameId: CreateMatchInput['gameId'], seats: [SeatConfig, SeatConfig] = [{ kind: 'human' }, { kind: 'human' }]): Promise<MatchSnapshot> {
  const response = await request('/matches', { gameId, config: gameId === 'gomoku' ? { size: 9 } : {}, seats, seed: 'private-fixture-layout' });
  expect(response.status).toBe(201);
  return response.json() as Promise<MatchSnapshot>;
}
async function profile(account = owner): Promise<ModelProfile> {
  const id = crypto.randomUUID(), ciphertext = await encryptSecret(providerKey, master, account);
  await db.prepare('INSERT INTO arena_credentials(id,owner_id,name,ciphertext,masked,created_at) VALUES(?,?,?,?,?,?)').bind(id, account, 'fixture', ciphertext, '••••real', Date.now()).run();
  return { id: crypto.randomUUID(), ownerId: account, credentialId: id, provider: 'openrouter', endpoint: 'https://openrouter.ai/api/alpha/decisions', model: 'fixture-model', name: 'Fixture model' };
}
async function bambooProfile(): Promise<ModelProfile> {
  const own: ModelProfile = { ...await profile(), provider: 'bamboonode-systemone', endpoint: ENDPOINTS['bamboonode-systemone'], model: 'startlux-decision-27b-autothink', thinkMode: 'always', thinkBudget: 512 };
  await db.prepare('INSERT OR REPLACE INTO arena_bamboo_connections(owner_id,credential_id,status,expires_at,models_json) VALUES(?,?,?,?,?)')
    .bind(owner, own.credentialId, 'connected', Date.now() + 60_000, JSON.stringify([own.model])).run();
  return own;
}
async function until(predicate: () => Promise<boolean> | boolean, description: string, timeout = 10000) {
  const stop = Date.now() + timeout;
  while (Date.now() < stop) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${description}`);
}

// Boundary fixtures are edited only while workerd is stopped. No production test hooks.
async function patchPersistedRecords(patches: Map<string, (record: any, sqlite: DatabaseSync) => void>) {
  await mf.dispose();
  const paths = [resolve(persistence, 'do')];
  let patched = 0;
  while (paths.length) {
    const directory = paths.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) { paths.push(path); continue; }
      if (!entry.name.endsWith('.sqlite')) continue;
      const sqlite = new DatabaseSync(path);
      try {
        if (!sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get()) continue;
        const row = sqlite.prepare('SELECT value FROM meta WHERE id=1').get() as { value: string } | undefined;
        if (!row) continue;
        const record = JSON.parse(row.value), patch = patches.get(record.id);
        if (!patch) continue;
        patch(record, sqlite);
        sqlite.prepare('UPDATE meta SET value=? WHERE id=1').run(JSON.stringify(record));
        patched++;
      } finally { sqlite.close(); }
    }
  }
  expect(patched).toBe(patches.size);
  mf = new Miniflare(options);
  await mf.ready;
  db = await mf.getD1Database('DB');
}

beforeAll(async () => {
  options = {
    name: 'arena-integration', modules: true, scriptPath: resolve('apps/runner/dist/index.js'),
    compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
    host: '127.0.0.1', port: 0, cf: false, log: new Log(LogLevel.ERROR),
    bindings: { ARENA_ENCRYPTION_KEY: master, ARENA_INTERNAL_SECRET: internal, LOCAL_DEV: 'true' },
    durableObjects: { MATCHES: { className: 'MatchObject', useSQLite: true }, USER_QUOTAS: { className: 'UserQuota', useSQLite: true } },
    d1Databases: ['DB'], r2Buckets: ['REPLAYS'],
    durableObjectsPersist: resolve(persistence, 'do'), d1Persist: resolve(persistence, 'd1'), r2Persist: resolve(persistence, 'r2'),
    // All outbound model traffic terminates here. Unrecognised URLs fail closed.
    outboundService: async req => {
      const target = new URL(req.url);
      if (target.origin === 'https://cloudflare-dns.com' && target.pathname === '/dns-query') {
        return new MockResponse(JSON.stringify({ Status: 0, Answer: dnsAddresses
          .filter(address => (target.searchParams.get('type') === 'AAAA') === address.includes(':'))
          .map(address => ({ type: address.includes(':') ? 28 : 1, data: address })) }), { headers: { 'content-type': 'application/json' } });
      }
      if (![ENDPOINTS.openrouter, ENDPOINTS['bamboonode-systemone'], ENDPOINTS['bamboonode-decisions']].some(endpoint => endpoint === req.url)) throw new Error(`Unexpected outbound request: ${req.url}`);
      const body = await req.json();
      calls.push({ body, authorization: req.headers.get('authorization') });
      return reply(body);
    },
  };
  mf = new Miniflare(options);
  await mf.ready;
  db = await mf.getD1Database('DB');
  const migration = readFileSync(resolve('apps/web/drizzle/0000_powerful_solo.sql'), 'utf8');
  const statements = migration.split('--> statement-breakpoint').map(sql => sql.trim());
  for (const name of ['user', 'arena_credentials', 'arena_matches']) {
    const sql = statements.find(sql => sql.startsWith(`CREATE TABLE \`${name}\``));
    if (!sql) throw new Error(`Missing migration table ${name}`);
    await db.prepare(sql).run();
  }
  for (const id of [owner, stranger]) await db.prepare('INSERT INTO user(id,name,email) VALUES(?,?,?)').bind(id, id, `${id}@example.test`).run();
  await db.prepare('CREATE TABLE arena_bamboo_connections(owner_id TEXT PRIMARY KEY, credential_id TEXT NOT NULL, status TEXT NOT NULL, expires_at INTEGER NOT NULL, models_json TEXT NOT NULL)').run();
});
beforeEach(() => { calls = []; dnsAddresses = ['8.8.8.8']; reply = async body => success(body); });
afterAll(async () => { await mf?.dispose(); rmSync(persistence, { recursive: true, force: true }); });

describe('actual workerd runner integration (fixture providers only)', () => {
  it('requires a current owner-bound BambooNode connection and model catalog when creating matches', async () => {
    for (const condition of ['missing', 'expired', 'disconnected', 'foreign-owner', 'different-key', 'model-removed', 'invalid-catalog']) {
      const own = await bambooProfile();
      if (condition === 'missing') await db.prepare('DELETE FROM arena_bamboo_connections').run();
      if (condition === 'expired') await db.prepare('UPDATE arena_bamboo_connections SET expires_at=? WHERE owner_id=?').bind(Date.now() - 1, owner).run();
      if (condition === 'disconnected') await db.prepare("UPDATE arena_bamboo_connections SET status='disconnected' WHERE owner_id=?").bind(owner).run();
      if (condition === 'foreign-owner') { await db.prepare('DELETE FROM arena_bamboo_connections WHERE owner_id=?').bind(stranger).run(); await db.prepare('UPDATE arena_bamboo_connections SET owner_id=? WHERE owner_id=?').bind(stranger, owner).run(); }
      if (condition === 'different-key') await db.prepare('UPDATE arena_bamboo_connections SET credential_id=? WHERE owner_id=?').bind(crypto.randomUUID(), owner).run();
      if (condition === 'model-removed' || condition === 'invalid-catalog') await db.prepare('UPDATE arena_bamboo_connections SET models_json=? WHERE owner_id=?').bind(condition === 'model-removed' ? '[]' : 'not-json', owner).run();
      const response = await request('/matches', { gameId: 'gomoku', config: {}, seats: [{ kind: 'ai', profile: own }, { kind: 'human' }] });
      expect(response.status, condition).toBe(400); expect(calls).toHaveLength(0);
    }
  });

  it('keeps board-game thinking enabled for a valid BambooNode model', async () => {
    const own = await bambooProfile(), match = await create('gomoku', [{ kind: 'ai', profile: own }, { kind: 'human' }]);
    await command(match.id, { type: 'step' });
    await until(async () => (await snapshot(match.id)).view.ply === 1, 'BambooNode board decision');
    expect(calls).toHaveLength(1); expect(calls[0].body).toMatchObject({ model: own.model, think_mode: 'always', think_budget: 512, return_thought: true });
    expect(calls[0].authorization).toBe(`Bearer ${providerKey}`);
    await command(match.id, { type: 'end' });
  });

  it.each(['before-dispatch', 'during-inference'])('prevents a BambooNode move when disconnected %s without resending', async phase => {
    const own = await bambooProfile(), match = await create('gomoku', [{ kind: 'ai', profile: own }, { kind: 'human' }]);
    const gate = deferred(); reply = async body => { await gate.promise; return success(body); };
    try {
      if (phase === 'before-dispatch') await db.prepare("UPDATE arena_bamboo_connections SET status='disconnected' WHERE owner_id=?").bind(owner).run();
      await command(match.id, { type: 'step' });
      if (phase === 'during-inference') {
        await until(() => calls.length === 1, 'BambooNode inference starts');
        // Leave the credential row present to exercise connection revocation itself.
        await db.prepare("UPDATE arena_bamboo_connections SET status='disconnected' WHERE owner_id=?").bind(owner).run();
      }
      gate.release();
      await until(async () => (await snapshot(match.id)).status === 'error', 'BambooNode revocation pauses the match');
      const state = await snapshot(match.id); expect(state.view.ply).toBe(0); expect(state.error).toContain('BambooNode');
      expect(state.events.filter(event => event.type === 'action')).toHaveLength(0);
      expect(calls).toHaveLength(phase === 'before-dispatch' ? 0 : 1);
      await command(match.id, { type: 'end' });
    } finally { gate.release(); }
  });

  it.each([false, true])('binds a BambooNode board result to the sent key across reconnect/sync (new key=%s)', async changedKey => {
    const own = await bambooProfile(), match = await create('gomoku', [{ kind: 'ai', profile: own }, { kind: 'human' }]);
    const gate = deferred(); reply = async body => { await gate.promise; return success(body); };
    try {
      await command(match.id, { type: 'step' });
      await until(() => calls.length === 1, 'BambooNode board inference starts before key update');
      const previous = await db.prepare('SELECT ciphertext FROM arena_credentials WHERE id=?').bind(own.credentialId).first<{ ciphertext: string }>();
      if (changedKey) {
        await db.prepare("UPDATE arena_bamboo_connections SET status='disconnected' WHERE owner_id=?").bind(owner).run();
        await db.prepare("UPDATE arena_credentials SET ciphertext='',deleted_at=? WHERE id=?").bind(Date.now(), own.credentialId).run();
      }
      const ciphertext = await encryptSecret(changedKey ? 'fixture-reconnected-key' : providerKey, master, owner);
      expect(ciphertext).not.toBe(previous!.ciphertext);
      await db.prepare('UPDATE arena_credentials SET ciphertext=?,deleted_at=NULL WHERE id=?').bind(ciphertext, own.credentialId).run();
      await db.prepare("UPDATE arena_bamboo_connections SET status='connected' WHERE owner_id=?").bind(owner).run();
      gate.release();
      await until(async () => { const state = await snapshot(match.id); return changedKey ? state.status === 'error' : state.view.ply === 1; }, 'BambooNode board response validates the actual key');
      const state = await snapshot(match.id);
      expect(state.view.ply).toBe(changedKey ? 0 : 1);
      expect(state.events.filter(event => event.type === 'action')).toHaveLength(changedKey ? 0 : 1);
      if (changedKey) expect(state.error).toContain('BambooNode authorization changed');
      expect(calls).toHaveLength(1); expect(calls[0].authorization).toBe(`Bearer ${providerKey}`);
    } finally { gate.release(); await command(match.id, { type: 'end' }); }
  });

  it('rejects a stale BambooNode connection-test key before any outbound request', async () => {
    const own = await bambooProfile();
    const response = await request('/provider-test', { profile: own, key: 'fixture-stale-key', request: { state: {}, actions: [{ id: 'ready', label: 'Ready' }], instructions: 'Choose ready' } });
    expect(response.status).toBe(400); expect(await response.text()).toContain('BambooNode authorization changed');
    expect(calls).toHaveLength(0);
  });

  it.each([false, true])('validates the BambooNode connection-test key after a delayed response (new key=%s)', async changedKey => {
    const own = await bambooProfile(), gate = deferred();
    const payload = { profile: own, key: providerKey, request: { state: {}, actions: [{ id: 'ready', label: 'Ready' }], instructions: 'Choose ready' } };
    reply = async body => { await gate.promise; return success(body); };
    const pending = request('/provider-test', payload);
    try {
      await until(() => calls.length === 1, 'BambooNode connection test is in flight');
      const currentKey = changedKey ? 'fixture-reconnected-probe-key' : providerKey;
      if (changedKey) {
        await db.prepare("UPDATE arena_bamboo_connections SET status='disconnected' WHERE owner_id=?").bind(owner).run();
        await db.prepare("UPDATE arena_credentials SET ciphertext='',deleted_at=? WHERE id=?").bind(Date.now(), own.credentialId).run();
      }
      const ciphertext = await encryptSecret(currentKey, master, owner);
      await db.prepare('UPDATE arena_credentials SET ciphertext=?,deleted_at=NULL WHERE id=?').bind(ciphertext, own.credentialId).run();
      await db.prepare("UPDATE arena_bamboo_connections SET status='connected' WHERE owner_id=?").bind(owner).run();
      gate.release();
      const response = await pending;
      expect(response.status).toBe(changedKey ? 400 : 200);
      const result = await response.json() as { error?: string; actionId?: string };
      if (changedKey) expect(result.error).toContain('BambooNode authorization changed');
      else expect(result.actionId).toBe('ready');
      expect(calls).toHaveLength(1);
      // An explicit test with the current key works and proves the old lease released.
      expect((await request('/provider-test', { ...payload, key: currentKey })).status).toBe(200);
      expect(calls).toHaveLength(2); expect(calls[1].authorization).toBe(`Bearer ${currentKey}`);
    } finally { gate.release(); await pending; }
  });

  it('requires the private bridge secret, isolates owners and rejects cross-owner credentials', async () => {
    const denied = await mf.dispatchFetch('https://arena.test/matches', { method: 'POST', headers: { 'X-Arena-Owner': owner }, body: '{}' });
    expect(denied.status).toBe(401);
    const match = await create('gomoku');
    expect((await request(`/matches/${match.id}`, undefined, stranger)).status).toBe(404);
    expect((await request(`/matches/${match.id}/replay`, undefined, stranger)).status).toBe(404);
    expect((await request(`/matches/${match.id}/commands`, { operationId: crypto.randomUUID(), type: 'end' }, stranger)).status).toBe(404);
    const foreign = await profile(stranger);
    const response = await request('/matches', { gameId: 'gomoku', config: {}, seats: [{ kind: 'ai', profile: foreign }, { kind: 'human' }] });
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('rejects unauthorized AI response views before a command can schedule a paid call', async () => {
    const ai = await profile();
    const match = await create('gomoku', [{kind:'ai',profile:ai},{kind:'ai',profile:ai}]);
    const response = await command(match.id,{type:'step',version:match.version},0);
    expect(response.status).toBe(400);
    const unchanged = await snapshot(match.id);
    expect(unchanged.version).toBe(match.version);
    expect(unchanged.status).toBe('ready');
    expect(unchanged.view.ply).toBe(0);
    expect(calls).toHaveLength(0);
    await command(match.id,{type:'end'});
  });

  it('persists human actions once, rejects stale/concurrent commands, and restores after the runtime restarts', async () => {
    const match = await create('gomoku');
    let current = await snapshot(match.id, 0);
    const operationId = crypto.randomUUID();
    const action = { type: 'action', seat: 0, actionId: 'place:0', version: current.version, operationId };
    expect((await command(match.id, action, 0)).status).toBe(200);
    expect((await command(match.id, action, 0)).status).toBe(200);
    current = await snapshot(match.id, 1);
    expect(current.view.ply).toBe(1);
    expect(current.events.filter(e => e.type === 'action')).toHaveLength(1);
    const competing = await Promise.all([1, 2].map(index => command(match.id, { type: 'action', seat: 1, actionId: `place:${index}`, version: current.version }, 1)));
    expect(competing.map(r => r.status).sort()).toEqual([200, 400]);
    current = await snapshot(match.id, 0);
    expect(current.view.ply).toBe(2);
    await mf.dispose();
    mf = new Miniflare(options);
    await mf.ready;
    db = await mf.getD1Database('DB');
    const restored = await snapshot(match.id, 0);
    expect(restored.view).toEqual(current.view);
    expect(restored.events).toEqual(current.events);
  });

  it('executes Xiangqi through the bundled BSD engine inside workerd', async () => {
    const match = await create('xiangqi');
    const current = await snapshot(match.id, 0);
    expect(current.view.legalActions).toHaveLength(44);
    const response = await command(match.id, { type: 'action', seat: 0, actionId: 'h2h9', version: current.version }, 0);
    expect(response.status).toBe(200);
    const after = await snapshot(match.id, 1);
    expect(after.view.ply).toBe(1);
    expect(after.view.cells.filter(Boolean)).toHaveLength(31);
    expect(after.view.cells[7]?.seat).toBe(0);
  });

  it('hides army opponent identities, private seed and live replay, then publishes complete terminal frames', async () => {
    const ai = await profile();
    ai.thinkMode = 'always';
    reply = async body => {
      // Quiet moves keep this privacy assertion independent of randomly deployed
      // commanders: commander capture legitimately reveals the flag to everyone.
      const occupied = new Set(body.state.position.pieces.map((p: any) => p.coordinate));
      const quiet = Object.entries(body.questions.primary_move.criteria).find(([, label]) => !occupied.has(String(label).split('→')[1]));
      expect(quiet).toBeDefined();
      return success(body, quiet![0], privateReasoning);
    };
    const match = await create('army', [{ kind: 'human' }, { kind: 'ai', profile: ai }]);
    const player = await snapshot(match.id, 0), publicView = await snapshot(match.id);
    const socketResponse = await mf.dispatchFetch(`https://arena.test/matches/${match.id}/socket`, {
      headers: { 'X-Arena-Owner': owner, 'X-Arena-Internal': internal, Upgrade: 'websocket' },
    });
    expect(socketResponse.status).toBe(101);
    const socket = socketResponse.webSocket!;
    const pushes: MatchSnapshot[] = [];
    socket.addEventListener('message', event => pushes.push(JSON.parse(String(event.data)).snapshot));
    socket.accept();
    await until(() => pushes.length > 0, 'initial spectator WebSocket frame');
    expect(pushes[0].view.cells.filter(Boolean).every(p => p?.hidden)).toBe(true);
    expect(player.view.phase).toBe('setup'); expect(player.view.ready).toEqual([false, true]);
    expect(player.view.cells.filter(p => p?.seat === 1).every(p => p?.hidden)).toBe(true);
    expect(publicView.view.cells.filter(Boolean).every(p => p?.hidden)).toBe(true);
    expect((await request(`/matches/${match.id}?seat=1`)).status).toBe(400);
    const fullQuery = await request(`/matches/${match.id}?seat=full`);
    const queryBody = await fullQuery.json() as MatchSnapshot;
    expect(queryBody.view.cells.filter(Boolean).every(p => p?.hidden)).toBe(true);
    expect(JSON.stringify(player)).not.toContain('private-fixture-layout');
    expect((await request(`/matches/${match.id}/replay`)).status).toBe(400);
    expect((await command(match.id, { type: 'action', seat: 0, actionId: 'ready', version: player.version }, 0)).status).toBe(200);
    let state = await snapshot(match.id, 0);
    expect(state.view.phase).toBe('playing');
    const humanAction = state.view.legalActions.find(action => action.to !== undefined && !state.view.cells[action.to])!.id;
    expect((await command(match.id, { type: 'action', seat: 0, actionId: humanAction, version: state.version }, 0)).status).toBe(200);
    expect((await command(match.id, { type: 'step' }, 0)).status).toBe(200);
    await until(async () => { const s = await snapshot(match.id, 0); if (s.error) throw new Error(s.error); return s.view.ply === 2; }, 'army AI move');
    state = await snapshot(match.id, 0);
    const decision = state.events.find(e => e.type === 'action' && e.seat === 1);
    expect(decision?.metrics?.probabilities).toBeUndefined();
    expect(decision?.metrics?.thoughtUsed).toBe(true);
    expect(decision?.reasoning).toBeUndefined();
    expect(JSON.stringify(await snapshot(match.id))).not.toContain(privateReasoning);
    expect((await request(`/matches/${match.id}/socket?seat=1`)).status).toBe(426);
    const forbiddenAiSocket = await mf.dispatchFetch(`https://arena.test/matches/${match.id}/socket?seat=1`, {
      headers: { 'X-Arena-Owner': owner, 'X-Arena-Internal': internal, Upgrade: 'websocket' },
    });
    expect(forbiddenAiSocket.status).toBe(400);
    await until(() => pushes.some(p => p.view.ply === 2), 'spectator receives model action');
    expect(pushes.every(p => !JSON.stringify(p).includes(providerKey))).toBe(true);
    expect(pushes.every(p => !JSON.stringify(p).includes(privateReasoning))).toBe(true);
    expect(pushes.every(p => p.view.cells.filter(Boolean).every(piece => piece?.hidden))).toBe(true);
    expect(calls).toHaveLength(1);
    const sent = calls[0].body.state.position;
    expect(sent.pieces.filter((p: any) => p.seat === 0).every((p: any) => p.kind === 'unknown')).toBe(true);
    expect(calls[0].authorization).toBe(`Bearer ${providerKey}`);
    expect((await command(match.id, { type: 'end' }, 0)).status).toBe(200);
    const replayResponse = await request(`/matches/${match.id}/replay`);
    expect(replayResponse.status).toBe(200);
    const replay = await replayResponse.json() as ReplayManifest;
    expect(replay.frames[0].cells.filter(Boolean).every(p => !p?.hidden)).toBe(true);
    expect(replay.result.reason).toBe('ended_by_user');
    expect(replay.seed).not.toBe('private-fixture-layout');
    expect(replay.rulesVersion).toBeTruthy();
    expect(replay.events.find(e => e.type === 'action' && e.seat === 1)?.reasoning).toEqual({ text: privateReasoning, truncated: false });
    await until(() => pushes.some(p => p.status === 'finished'), 'terminal spectator WebSocket frame');
    expect(pushes.find(p => p.status === 'finished')?.events.find(e => e.seat === 1)?.reasoning?.text).toBe(privateReasoning);
    socket.close();
    const exported = JSON.stringify(replay);
    for (const privateValue of [providerKey, ai.credentialId, owner, internal, master]) expect(exported).not.toContain(privateValue);
    const bucket = await mf.getR2Bucket('REPLAYS');
    const privateArtifact = await bucket.get(`replays/${match.id}.json`);
    expect(privateArtifact).not.toBeNull();
    expect(await privateArtifact!.text()).toContain(privateReasoning);
    const summary = await db.prepare('SELECT summary_json FROM arena_matches WHERE id=?').bind(match.id).first<{ summary_json: string }>();
    expect(summary?.summary_json).not.toContain(privateReasoning);
  });

  it('projects restored Army reasoning only to its allowed human seat until the match ends', async () => {
    const match = await create('army');
    let current = await snapshot(match.id, 0);
    await command(match.id, { type: 'action', seat: 0, actionId: 'ready', version: current.version }, 0);
    current = await snapshot(match.id, 1);
    await command(match.id, { type: 'action', seat: 1, actionId: 'ready', version: current.version }, 1);
    // This boundary fixture also represents a future human-assistance event.
    // It is edited only while workerd is stopped, never through a product API.
    await patchPersistedRecords(new Map([[match.id, (_record, sqlite) => {
      const rows = sqlite.prepare('SELECT seq,value FROM events ORDER BY seq').all() as { seq: number; value: string }[];
      const row = rows.find(row => JSON.parse(row.value).seat === 0)!;
      const event = JSON.parse(row.value);
      event.reasoning = { text: privateReasoning, truncated: true };
      event.metrics = { elapsedMs: 1, confidence: 0.75, probabilities: { 'private-candidate': 1 } };
      sqlite.prepare('UPDATE events SET value=? WHERE seq=?').run(JSON.stringify(event), row.seq);
    }]]));
    const allowed = await snapshot(match.id, 0);
    expect(allowed.events.find(e => e.seat === 0)?.reasoning).toEqual({ text: privateReasoning, truncated: true });
    expect(allowed.events.find(e => e.seat === 1)?.reasoning).toBeUndefined(); // Old events remain compatible.
    for (const seat of [undefined, 1]) {
      const projected = await snapshot(match.id, seat);
      expect(JSON.stringify(projected)).not.toContain(privateReasoning);
      expect(projected.events.find(e => e.seat === 0)?.metrics?.probabilities).toBeUndefined();
    }
    const sockets: Awaited<ReturnType<Miniflare['dispatchFetch']>>['webSocket'][] = [];
    try {
      for (const seat of [0, 1, undefined]) {
        const response = await mf.dispatchFetch(`https://arena.test/matches/${match.id}/socket${seat === undefined ? '' : `?seat=${seat}`}`, {
          headers: { 'X-Arena-Owner': owner, 'X-Arena-Internal': internal, Upgrade: 'websocket' },
        });
        expect(response.status).toBe(101);
        const socket = response.webSocket!;
        sockets.push(socket);
        let first: MatchSnapshot | undefined;
        socket.addEventListener('message', event => { first ??= JSON.parse(String(event.data)).snapshot; });
        socket.accept();
        await until(() => !!first, 'restored Army WebSocket projection');
        expect(JSON.stringify(first).includes(privateReasoning)).toBe(seat === 0);
      }
      // Reading an opponent projection must never mutate the persisted private event.
      expect((await snapshot(match.id, 0)).events.find(e => e.seat === 0)?.reasoning?.text).toBe(privateReasoning);
      await command(match.id, { type: 'end' });
      expect((await snapshot(match.id)).events.find(e => e.seat === 0)?.reasoning?.text).toBe(privateReasoning);
    } finally { for (const socket of sockets) socket?.close(); }
  });

  it('persists confirmed reasoning through restart without placing it in metrics, D1 summaries or the next model prompt', async () => {
    const ai = await profile();
    ai.thinkMode = 'always';
    reply = async body => success(body, undefined, privateReasoning);
    const match = await create('gomoku', [{ kind: 'ai', profile: ai }, { kind: 'ai', profile: ai }]);
    await command(match.id, { type: 'step' });
    await until(async () => (await snapshot(match.id)).view.ply === 1, 'first thought-bearing action');
    const before = await snapshot(match.id);
    const action = before.events.find(e => e.type === 'action');
    expect(action?.reasoning).toEqual({ text: privateReasoning, truncated: false });
    expect(JSON.stringify(action?.metrics)).not.toContain(privateReasoning);
    await mf.dispose();
    mf = new Miniflare(options);
    await mf.ready;
    db = await mf.getD1Database('DB');
    expect((await snapshot(match.id)).events).toEqual(before.events);
    await command(match.id, { type: 'step' });
    await until(async () => (await snapshot(match.id)).view.ply === 2, 'second model action');
    expect(calls).toHaveLength(2);
    expect(calls[1].body.state.recentMoves).toHaveLength(1);
    expect(JSON.stringify(calls[1].body)).not.toContain(privateReasoning);
    expect(calls[1].body.state.recentMoves[0]).not.toHaveProperty('reasoning');
    const summary = await db.prepare('SELECT summary_json FROM arena_matches WHERE id=?').bind(match.id).first<{ summary_json: string }>();
    expect(summary?.summary_json).not.toContain(privateReasoning);
    await command(match.id, { type: 'end' });
    const replay = await (await request(`/matches/${match.id}/replay`)).json() as ReplayManifest;
    expect(replay.events.filter(e => e.reasoning).length).toBe(2);
    expect((await request(`/matches/${match.id}/replay`, undefined, stranger)).status).toBe(404);
    const foreignSocket = await mf.dispatchFetch(`https://arena.test/matches/${match.id}/socket`, {
      headers: { 'X-Arena-Owner': stranger, 'X-Arena-Internal': internal, Upgrade: 'websocket' },
    });
    expect(foreignSocket.status).toBe(404);
    expect(foreignSocket.webSocket).toBeNull();
  });

  it('pauses after draining one in-flight model move and does not repeat a submitted step command', async () => {
    const gate = deferred(); reply = async body => { await gate.promise; return success(body); };
    const match = await create('gomoku', [{ kind: 'ai', profile: await profile() }, { kind: 'human' }]);
    const operationId = crypto.randomUUID();
    try {
      expect((await command(match.id, { type: 'step', operationId })).status).toBe(200);
      await until(() => calls.length === 1, 'provider receives first request');
      expect((await command(match.id, { type: 'pause' })).status).toBe(200);
      expect((await snapshot(match.id)).status).toBe('paused');
      gate.release();
      await until(async () => (await snapshot(match.id)).view.ply === 1, 'pending move commits once');
      expect((await command(match.id, { type: 'step', operationId })).status).toBe(200);
      const state = await snapshot(match.id);
      expect(state.status).toBe('paused'); expect(state.view.ply).toBe(1); expect(calls).toHaveLength(1);
    } finally { gate.release(); }
  });

  it('discards a late model response after the user ends the match', async () => {
    const gate = deferred(); reply = async body => { await gate.promise; return success(body, undefined, privateReasoning); };
    const match = await create('gomoku', [{ kind: 'ai', profile: await profile() }, { kind: 'human' }]);
    try {
      await command(match.id, { type: 'step' });
      await until(() => calls.length === 1, 'provider request');
      expect((await command(match.id, { type: 'end' })).status).toBe(200);
      gate.release();
      await new Promise(resolve => setTimeout(resolve, 250));
      const state = await snapshot(match.id);
      expect(state.status).toBe('finished'); expect(state.view.ply).toBe(0);
      expect(state.view.result?.reason).toBe('ended_by_user');
      expect(state.events.filter(e => e.type === 'action')).toEqual([]);
      expect(JSON.stringify(state)).not.toContain(privateReasoning);
    } finally { gate.release(); }
  });

  it('stops without a phantom move when a credential is removed during inference', async () => {
    const gate = deferred(); reply = async body => { await gate.promise; return success(body); };
    const model = await profile();
    const match = await create('gomoku', [{ kind: 'ai', profile: model }, { kind: 'human' }]);
    try {
      await command(match.id, { type: 'step' });
      await until(() => calls.length === 1, 'inference begins');
      await db.prepare('UPDATE arena_credentials SET deleted_at=? WHERE id=?').bind(Date.now(), model.credentialId).run();
      gate.release();
      await until(async () => (await snapshot(match.id)).status === 'error', 'revocation is observed');
      const state = await snapshot(match.id);
      expect(state.view.ply).toBe(0); expect(state.error).toContain('removed');
      expect(JSON.stringify(state)).not.toContain(providerKey);
    } finally { gate.release(); }
  });

  it('validates custom endpoints inside workerd and rejects any private DNS answer', async () => {
    const input = { endpoint: 'https://decision.example.org/v1', provider: 'custom-systemone' };
    const valid = await request('/validate-endpoint', input);
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ endpoint: input.endpoint });
    dnsAddresses = ['8.8.8.8', '127.0.0.1'];
    expect((await request('/validate-endpoint', input)).status).toBe(400);
    expect((await request('/validate-endpoint', { ...input, endpoint: 'http://127.0.0.1/' })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('shares account quota between connection tests and games, releasing failed probes safely', async () => {
    const model = await profile(), gate = deferred();
    const payload = { profile: model, key: providerKey, request: { state: {}, actions: [{ id: 'ready', label: 'Ready' }], instructions: 'Choose ready' } };
    reply = async body => { await gate.promise; return success(body); };
    const pending = request('/provider-test', payload);
    try {
      await until(() => calls.length === 1, 'first connection test holds quota');
      expect((await request('/provider-test', payload)).status).toBe(429);
      const match = await create('gomoku', [{ kind: 'ai', profile: model }, { kind: 'human' }]);
      await command(match.id, { type: 'step' });
      await until(async () => (await snapshot(match.id)).status === 'paused', 'match respects connection-test quota');
      expect(calls).toHaveLength(1);
      gate.release();
      expect((await pending).status).toBe(200);
      reply = async () => new MockResponse('{}', { status: 503 });
      expect((await request('/provider-test', payload)).status).toBe(400);
      reply = async body => success(body);
      expect((await request('/provider-test', payload)).status).toBe(200);
      expect(calls).toHaveLength(3);
    } finally { gate.release(); await pending; }
  });

  it('enforces human move limits and bounds setup/control history while allowing termination', async () => {
    const moves = await create('gomoku'), time = await create('gomoku'), setup = await create('army');
    // Exercise an actual reconnect backlog beyond the old 200-event truncation.
    for (let i = 0; i < 210; i++) expect((await command(setup.id, { type: 'pause' })).status).toBe(200);
    const history = await snapshot(setup.id);
    expect(history.events).toHaveLength(211);
    expect(history.events.map(event => event.seq)).toEqual(Array.from({ length: 211 }, (_, i) => i + 1));
    const resumed = await (await request(`/matches/${setup.id}?since=5`)).json() as MatchSnapshot;
    expect(resumed.events.map(event => event.seq)).toEqual(Array.from({ length: 206 }, (_, i) => i + 6));
    await patchPersistedRecords(new Map([
      [moves.id, record => { record.state.ply = 300; }],
      [time.id, record => { record.activeMs = 3_600_000; }],
      [setup.id, record => { record.eventSeq = 999; }],
    ]));
    for (const match of [moves, time]) {
      const state = await snapshot(match.id, 0);
      const denied = await command(match.id, { type: 'action', seat: 0, actionId: 'place:0', version: state.version }, 0);
      expect(denied.status).toBe(400);
      expect((await denied.json() as { error: string }).error).toContain('Match limit reached');
      expect((await snapshot(match.id, 0)).view.cells).toEqual(state.view.cells);
      expect((await command(match.id, { type: 'end' })).status).toBe(200);
    }
    expect((await command(setup.id, { type: 'pause' })).status).toBe(200);
    const capped = await snapshot(setup.id, 0);
    expect((await command(setup.id, { type: 'pause' })).status).toBe(400);
    expect((await command(setup.id, { type: 'action', seat: 0, actionId: 'ready', version: capped.version }, 0)).status).toBe(400);
    expect((await command(setup.id, { type: 'end' })).status).toBe(200);
    expect((await snapshot(setup.id)).status).toBe('finished');
  }, 60_000);

  it('rejects provider redirects without forwarding a credential or changing the board', async () => {
    reply = async () => new MockResponse(null, { status: 302, headers: { Location: 'https://redirect-target.invalid/' } });
    const match = await create('gomoku', [{ kind: 'ai', profile: await profile() }, { kind: 'human' }]);
    expect((await command(match.id, { type: 'step' })).status).toBe(200);
    await until(async () => (await snapshot(match.id)).status === 'error', 'provider redirect is refused');
    const state = await snapshot(match.id);
    expect(state.error).toContain('HTTP 302');
    expect(state.view.ply).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('limits each account to one active inference and reports invalid decisions without changing the board', async () => {
    const gate = deferred(); reply = async body => { await gate.promise; return success(body); };
    const model = await profile();
    const first = await create('gomoku', [{ kind: 'ai', profile: model }, { kind: 'human' }]);
    const second = await create('gomoku', [{ kind: 'ai', profile: model }, { kind: 'human' }]);
    try {
      await command(first.id, { type: 'step' });
      await until(() => calls.length === 1, 'first inference holds quota');
      await command(second.id, { type: 'step' });
      await until(async () => (await snapshot(second.id)).status === 'paused', 'second match is paused by quota');
      expect((await snapshot(second.id)).error).toContain('Another AI match');
      expect(calls).toHaveLength(1);
      gate.release();
      await until(async () => (await snapshot(first.id)).view.ply === 1, 'first inference finishes');
      reply = async () => new MockResponse(JSON.stringify({ answers: { primary_move: { choice: 'not-a-candidate' } } }), { headers: { 'content-type': 'application/json' } });
      await command(second.id, { type: 'step' });
      await until(async () => (await snapshot(second.id)).status === 'error', 'invalid choice pauses match');
      expect((await snapshot(second.id)).view.ply).toBe(0);
      expect(calls).toHaveLength(2);
    } finally { gate.release(); }
  });
});
