import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

// Disposable, no-provider integration checks; safe against local D1/R2 only.
const origin = process.env.ARENA_SMOKE_ORIGIN || 'http://127.0.0.1:5093';
const address = new URL(origin);
assert.equal(address.protocol, 'http:');
assert.ok(['127.0.0.1', 'localhost'].includes(address.hostname));
assert.ok(!address.username && !address.password && !address.search && !address.hash && address.pathname === '/');
// Vite's authenticated game socket listens separately from its HTTP/HMR server.
// The compiled Cloudflare preview keeps native, same-origin upgrades.
const socketAddress = new URL(process.env.ARENA_SMOKE_WS_ORIGIN || address.origin);
if (!process.env.ARENA_SMOKE_WS_ORIGIN && address.port === '5091') {
  socketAddress.hostname = '127.0.0.1';
  socketAddress.port = '5094';
}
if (socketAddress.protocol === 'http:') socketAddress.protocol = 'ws:';
assert.equal(socketAddress.protocol, 'ws:', 'Smoke WebSockets must target local development');
assert.ok(['127.0.0.1', 'localhost'].includes(socketAddress.hostname));
assert.ok(!socketAddress.username && !socketAddress.password && !socketAddress.search && !socketAddress.hash && socketAddress.pathname === '/');
const socketUrl = id => new URL(`/api/arena/arcade-sessions/${encodeURIComponent(id)}/socket`, socketAddress).toString();
const require = createRequire(import.meta.url);
const WebSocket = createRequire(require.resolve('miniflare'))('ws');
async function request(cookie, path, body, status = 200) {
  const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { Cookie: cookie, Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const json = await response.json();
  assert.equal(response.status, status, `${path}: ${response.status} ${json.message || ''}`);
  return { data: json.data ?? json, cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
}
async function account() {
  return (await request('', '/api/auth/sign-up/email', { name: 'Arcade smoke',
    email: `arcade-smoke-${randomUUID()}@example.invalid`, password: randomBytes(24).toString('base64url') })).cookie;
}
async function until(test, description, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!await test()) {
    if (Date.now() >= end) throw new Error(`Timed out: ${description}`);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}
function connect(cookie, id) {
  const messages = [];
  const socket = new WebSocket(socketUrl(id), { headers: { Cookie: cookie, Origin: address.origin }, handshakeTimeout: 10000 });
  let heartbeat;
  let activeController;
  let failure;
  socket.on('error', error => { failure = error; });
  socket.on('message', data => {
    const message = JSON.parse(data.toString());
    message.receivedAt = performance.now();
    if (message.type === 'controller') activeController = message.controllerSession;
    messages.push(message);
  });
  return {
    socket, messages,
    async ready() { await until(() => { if (failure) throw failure; return socket.readyState === WebSocket.OPEN; }, 'socket open'); },
    send(message) { socket.send(JSON.stringify(message)); },
    keepAlive(controllerSession) { activeController = controllerSession; heartbeat = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'heartbeat', controllerSession: activeController }));
    }, 400); },
    close() { clearInterval(heartbeat); socket.close(); },
  };
}

async function rejectedSocket(cookie, id, requestOrigin, expected) {
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl(id), {
      headers: { Cookie: cookie, ...(requestOrigin === undefined ? {} : { Origin: requestOrigin }) }, handshakeTimeout: 5000,
    });
    socket.on('open', () => { socket.close(); reject(new Error('Unauthorized socket was accepted')); });
    socket.on('unexpected-response', (_request, response) => {
      response.resume(); socket.terminate();
      try { assert.equal(response.statusCode, expected); resolve(); } catch (error) { reject(error); }
    });
    socket.on('error', error => { if (!String(error.message).includes('closed before')) reject(error); });
  });
}

const owner = await account(), stranger = await account();
const measurements = [];
const rejectedUpgrades = {};
for (const gameId of ['snake', 'tetris', 'platformer']) {
  const created = (await request(owner, '/api/arena/arcade-sessions', {
    gameId, mode: 'practice', config: { level: 1 }, seed: 'arcade-integration-seed', controllers: [{ kind: 'human' }],
  })).data;
  await request(stranger, `/api/arena/arcade-sessions/${created.id}`, undefined, 404);
  await request('', `/api/arena/arcade-sessions/${created.id}`, undefined, 401);
  if (gameId === 'snake') {
    await rejectedSocket('', created.id, address.origin, 401);
    rejectedUpgrades.anonymous = 401;
    await rejectedSocket(stranger, created.id, address.origin, 404);
    rejectedUpgrades.foreignOwner = 404;
    await rejectedSocket(owner, created.id, 'https://untrusted.example.invalid', 403);
    rejectedUpgrades.crossOrigin = 403;
    await rejectedSocket(owner, created.id, undefined, 403);
    rejectedUpgrades.missingOrigin = 403;
  }
  const stream = connect(owner, created.id);
  const command = type => request(owner, `/api/arena/arcade-sessions/${created.id}/commands`, { type, operationId: randomUUID() });
  try {
    await stream.ready();
    stream.send({ type: 'claim', runId: created.runs[0].id });
    await until(() => stream.messages.some(message => message.type === 'controller'), 'human claim');
    const controller = stream.messages.find(message => message.type === 'controller');
    stream.keepAlive(controller.controllerSession);
    await command('start');
    const start = performance.now();
    stream.send({ type: 'input', runId: created.runs[0].id, controllerSession: controller.controllerSession,
      clientSeq: 1, input: { buttons: gameId === 'snake' ? ['up'] : ['right'], durationMs: 100 } });
    await until(() => stream.messages.some(message => message.type === 'ack' && message.clientSeq === 1), 'input acknowledgement');
    const ack = stream.messages.find(message => message.type === 'ack' && message.clientSeq === 1);
    const ackMs = ack.receivedAt - start;
    await until(() => stream.messages.some(message => message.type === 'snapshot' && message.snapshot.tick >= ack.appliedTick), 'input broadcast');
    const visible = stream.messages.find(message => message.type === 'snapshot' && message.snapshot.tick >= ack.appliedTick);
    await until(() => stream.messages.some(message => message.type === 'snapshot' && message.snapshot.tick >= 15), 'continuous simulation');
    const paused = (await command('pause')).data;
    await new Promise(resolve => setTimeout(resolve, 300));
    const held = (await request(owner, `/api/arena/arcade-sessions/${created.id}`)).data;
    assert.equal(held.tick, paused.tick, 'Pause freezes authoritative time');
    await command('resume');
    await until(async () => (await request(owner, `/api/arena/arcade-sessions/${created.id}`)).data.tick > held.tick, 'resume');
    const ended = (await command('end')).data;
    assert.equal(ended.status, 'finished'); assert.equal(ended.result.aborted, true);
    const replay = (await request(owner, `/api/arena/arcade-sessions/${created.id}/replay`)).data;
    assert.equal(replay.version, 2); assert.equal(replay.frames[0].tick, 0); assert.equal(replay.runIds.length, 1);
    const post = (await request(owner, '/api/arena/community', { matchId: created.id, title: `Arcade fixture ${gameId}` })).data;
    const anonymous = (await request('', `/api/arena/community/${post.id}`)).data;
    assert.equal(anonymous.replay.version, 2);
    assert.equal(anonymous.replay.gameId, gameId);
    const cloned = (await request(stranger, '/api/arena/arcade-sessions', { cloneId: post.id, gameId, mode: 'practice', controllers: [{ kind: 'human' }] })).data;
    assert.equal(cloned.seed, created.seed);
    await request(stranger, `/api/arena/arcade-sessions/${cloned.id}/commands`, { type: 'end', operationId: randomUUID() });
    await request(stranger, `/api/arena/community/${post.id}`, { action: 'like', liked: true });
    await request(stranger, `/api/arena/community/${post.id}`, { action: 'comment', body: 'Arcade integration replay.' });
    await request(stranger, `/api/arena/community/${post.id}`, { action: 'report', reason: 'Fixture report' });
    await request(owner, `/api/arena/community/${post.id}`, { action: 'unpublish' });
    await request('', `/api/arena/community/${post.id}`, undefined, 404);
    const snapshots = stream.messages.filter(message => message.type === 'snapshot');
    measurements.push({ gameId, inputAckMs: Math.round(ackMs), inputBroadcastMs: Math.round(visible.receivedAt - start), snapshots: snapshots.length, tick: ended.tick, events: replay.events.length, frames: replay.frames.length });
  } finally { stream.close(); }
}
// Exercise the single-AI HTTP/publication path without ever starting a model request.
// Actual automatic single-run execution is covered by the workerd fixture-provider tests.
const ownModel = (await request(owner, '/api/arena/models', { name: 'Solo fixture', provider: 'openrouter', model: 'fixture/no-network', apiKey: 'fixture-solo-never-send' })).data;
const otherModel = (await request(stranger, '/api/arena/models', { name: 'Own solo fixture', provider: 'openrouter', model: 'fixture/no-network', apiKey: 'fixture-solo-never-send-other' })).data;
const singleAi = [];
for (const gameId of ['snake', 'tetris', 'platformer']) {
  const body = { gameId, mode: 'ai-solo', config: { level: 1 }, seed: 'solo-fixture', controllers: [{ kind: 'ai', profileId: ownModel.id }] };
  await request(stranger, '/api/arena/arcade-sessions', body, 404);
  const created = (await request(owner, '/api/arena/arcade-sessions', body)).data;
  assert.equal(created.runs.length, 1); assert.equal(created.runs[0].controller.kind, 'ai');
  assert.equal(created.runs[0].calls, 0);
  const ended = (await request(owner, `/api/arena/arcade-sessions/${created.id}/commands`, { type: 'end', operationId: randomUUID() })).data;
  assert.equal(ended.result.winner, null); assert.equal(ended.result.scores.length, 1);
  assert.equal(ended.runs[0].calls, 0, 'Never send fixture credentials to an external provider');
  const post = (await request(owner, '/api/arena/community', { matchId: created.id, title: `Single AI fixture ${gameId}` })).data;
  const published = (await request('', `/api/arena/community/${post.id}`)).data.replay;
  assert.equal(published.mode, 'ai-solo'); assert.equal(published.runIds.length, 1);
  assert.ok(published.frames.every(frame => frame.views.length === 1));
  assert.ok(!JSON.stringify(published).includes('fixture-solo-never-send'));
  const cloned = (await request(stranger, '/api/arena/arcade-sessions', { ...body, cloneId: post.id, controllers: [{ kind: 'ai', profileId: otherModel.id }] })).data;
  assert.equal(cloned.mode, 'ai-solo'); assert.equal(cloned.runs.length, 1); assert.equal(cloned.seed, created.seed);
  await request(stranger, `/api/arena/arcade-sessions/${cloned.id}/commands`, { type: 'end', operationId: randomUUID() });
  await request(owner, `/api/arena/community/${post.id}`, { action: 'unpublish' });
  await request('', `/api/arena/community/${post.id}`, undefined, 404);
  singleAi.push({ gameId, runs: ended.runs.length, calls: 0, winner: ended.result.winner });
}
console.log(JSON.stringify({ ok: true, websocket: { httpOrigin: address.origin, socketOrigin: socketAddress.origin, rejectedUpgrades }, arcade: measurements, singleAi, checks: ['authenticated-websocket', 'anonymous-websocket-rejected', 'foreign-owner-websocket-rejected', 'cross-origin-websocket-rejected', 'missing-origin-websocket-rejected', 'real-input', 'continuous-ticks', 'pause-resume', 'tenant-isolation', 'v2-replay', 'anonymous-replay', 'clone-seed', 'likes-comments-reports', 'withdrawal', 'single-ai-create-end-publication-clone', 'single-ai-foreign-profile-rejected'] }));
