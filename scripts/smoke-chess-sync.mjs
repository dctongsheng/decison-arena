import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Use an existing ignored local test session. Never print its Cookie, load model
// credentials, alter a user's existing game, or publish these disposable matches.
const origin = process.env.ARENA_SMOKE_ORIGIN || 'http://127.0.0.1:5091';
const base = new URL(origin);
assert.equal(base.protocol, 'http:');
assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname));
assert.ok(!base.username && !base.password && base.pathname === '/' && !base.search && !base.hash);
const fixture = JSON.parse(readFileSync(process.env.ARENA_CHESS_FIXTURE || 'artifacts/local-fixture.json', 'utf8'));
assert.equal(typeof fixture.cookie, 'string');
const require = createRequire(import.meta.url);
const WebSocket = createRequire(require.resolve('miniflare'))('ws');
async function api(path, body) {
  const response = await fetch(new URL(path, base), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Cookie: fixture.cookie, Origin: base.origin, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200, `HTTP ${response.status} for local chess smoke`);
  const json = await response.json();
  assert.equal(json.code, 0, 'Local chess API rejected request');
  return json.data;
}
function socketUrl(id, seat = 'spectator') {
  const url = new URL(`/api/arena/matches/${id}/socket?seat=${seat}`, base);
  url.protocol = 'ws:';
  return url.toString(); // Deliberately same-origin 5091, not a bypass to 5094.
}
async function until(test, label) {
  const end = performance.now() + 10000;
  while (!test()) {
    assert.ok(performance.now() < end, `Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function connect(id, seat) {
  const messages = [];
  const ws = new WebSocket(socketUrl(id, seat), { headers: { Cookie: fixture.cookie, Origin: base.origin }, handshakeTimeout: 10000 });
  let error, pong = false;
  ws.on('error', e => { error = e; });
  ws.on('message', raw => {
    if (raw.toString() === 'pong') { pong = true; return; }
    const message = JSON.parse(raw.toString());
    if (message.type === 'snapshot') messages.push({ snapshot: message.snapshot, at: performance.now() });
  });
  await until(() => { if (error) throw error; return messages.length > 0; }, 'initial snapshot');
  ws.send('ping');
  await until(() => pong, 'heartbeat pong');
  return { ws, messages };
}
async function rejected(id, cookie, requestOrigin, status) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(socketUrl(id), { headers: { Cookie: cookie, Origin: requestOrigin }, handshakeTimeout: 10000 });
    ws.on('open', () => { ws.close(); reject(new Error('Unauthorized upgrade accepted')); });
    ws.on('unexpected-response', (_request, response) => {
      response.resume(); ws.terminate();
      try { assert.equal(response.statusCode, status); resolve(); } catch (e) { reject(e); }
    });
    ws.on('error', e => { if (!e.message.includes('closed before')) reject(e); });
  });
}
const results = [];
for (const gameId of ['gomoku', 'xiangqi', 'army']) {
  const created = await api('/api/arena/matches', {
    gameId, seats: [{ kind: 'human' }, { kind: 'human' }], seed: 'chess-sync-smoke',
  });
  const path = `/api/arena/matches/${created.id}`;
  const streams = [];
  const command = (data, seat = 'spectator') => api(`${path}/commands?seat=${seat}`, { ...data, operationId: randomUUID() });
  try {
    if (gameId === 'gomoku') {
      await rejected(created.id, '', base.origin, 401);
      await rejected(created.id, fixture.cookie, 'https://untrusted.example.invalid', 403);
    }
    let stream = await connect(created.id); streams.push(stream);
    if (gameId === 'army') {
      for (const seat of [0, 1]) {
        const view = await api(`${path}?seat=${seat}`);
        await command({ type: 'action', actionId: 'ready', version: view.version, seat }, seat);
      }
      const player = await connect(created.id, 0); streams.push(player);
      const state = player.messages.at(-1).snapshot;
      assert.ok(state.view.cells.some(piece => piece?.seat === 0 && !piece.hidden));
      assert.ok(state.view.cells.filter(piece => piece?.seat === 1).every(piece => piece.hidden));
      const spectator = (await api(path)).view;
      assert.ok(spectator.cells.filter(Boolean).every(piece => piece.hidden));
    }
    const latencies = [];
    for (let move = 0; move < 6; move++) {
      const current = await api(path);
      const seat = current.view.turn;
      const view = await api(`${path}?seat=${seat}`);
      const action = view.view.legalActions[0];
      assert.ok(action, 'Test position has a legal human action');
      const started = performance.now();
      const result = await command({ type: 'action', actionId: action.id, version: view.version, seat }, seat);
      await until(() => stream.messages.some(m => m.snapshot.version === result.version), 'move broadcast');
      const pushed = stream.messages.find(m => m.snapshot.version === result.version);
      assert.equal(pushed.snapshot.view.ply, result.view.ply);
      latencies.push(Math.round(pushed.at - started));
      if (move === 2) {
        stream.ws.terminate();
        stream = await connect(created.id); streams.push(stream);
        assert.equal(stream.messages.at(-1).snapshot.version, result.version);
      }
    }
    results.push({ gameId, moveBroadcastMs: latencies, sameOriginWebSocket: true, reconnectSnapshot: true, ...(gameId === 'army' ? { hiddenViews: true } : {}) });
  } finally {
    await command({ type: 'end' });
    for (const stream of streams) stream.ws.close();
  }
}
console.log(JSON.stringify({ origin, modelCalls: 0, anonymousStatus: 401, foreignOriginStatus: 403, results }, null, 2));
