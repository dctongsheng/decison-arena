import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicJson, authenticatedApi, createProgress, makePlan, report, runBatch, safeModels, validatePlan, validateProgress } from './snake-harness-experiment-lib.mjs';

const models = safeModels(modelResponse().items);
const sourceManifest = { sha256: 'a'.repeat(64), files: [{ path: 'fixture', sha256: 'a'.repeat(64) }] };
function plan(budget = 1800) { return makePlan({ experimentId: 'test-experiment', origin: 'http://127.0.0.1:5091', models, profileIds: ['profile-one'], developmentSeeds: ['dev-1'], acceptanceSeeds: ['accept-1', 'accept-2'], globalMaxRequests: budget, sourceManifest }); }
const clone = value => JSON.parse(JSON.stringify(value));
function snapshot(p, entry, status = 'ready', calls = 0, overrides = {}) {
  return { id: 'session-one', gameId: 'snake', mode: 'ai-solo', seed: entry.seed, rulesVersion: p.rulesVersion, config: entry.config, status, tick: status === 'finished' ? 100 : 0,
    runs: [{ id: 'run-0', controller: { kind: 'ai', profile: { provider: 'systemone', model: '', thinkMode: 'never' } }, calls, view: { score: { food: 2, points: 2, survivedTicks: 100 }, reason: 'WALL_COLLISION' } }],
    limits: { maxTicks: 7200, maxCallsPerRun: 300, minRequestIntervalMs: 500 }, events: [], ...(status === 'finished' ? { result: { aborted: false, reason: 'runs_finished' } } : {}), ...overrides };
}
function decision(seq = 2, version = 'snake-harness-a-v1') { return { seq, type: 'decision', tick: 100, actionId: 'up:100', observedTick: 1, appliedTick: 10, outcome: 'applied', promptVersion: 'decision-arena-arcade-v5', snakeHarnessVersion: version,
  metrics: { elapsedMs: 100, actualModel: 'service-default', thoughtUsed: false, private: 'DO_NOT_PERSIST' }, reasoning: { text: 'DO_NOT_PERSIST' }, message: 'DO_NOT_PERSIST', request: 'DO_NOT_PERSIST' }; }
function modelResponse() { return { items: [{ id: 'profile-one', provider: 'systemone', model: '', source: 'manual', available: true, apiKey: 'fake_DO_NOT_PERSIST', credentialId: 'DO_NOT_PERSIST', endpoint: 'DO_NOT_PERSIST' }] }; }

test('plan keeps complete version IDs, disjoint seed groups and rotated interleaving', () => {
  const p = plan(); assert.equal(p.schedule.length, 9); assert.deepEqual(p.schedule.slice(6).map(e => e.variant), ['B', 'C', 'A']); assert.equal(p.pilotEntryIds.length, 3);
  assert.equal(p.schedule[0].config.snakeHarnessVersion, 'snake-harness-a-v1');
  const bad = clone(p); bad.seedGroups.acceptance[0] = 'dev-1'; assert.throws(() => validatePlan(bad), /SEEDS_OVERLAP/);
  const edited = clone(p); edited.schedule[0].config.snakeHarnessVersion = 'B'; assert.throws(() => validatePlan(edited), /INVALID_SCHEDULE_ENTRY/);
  const progress = createProgress(p); const changed = clone(p); changed.limits.globalMaxRequests++;
  assert.throws(() => validateProgress(changed, progress), /PLAN_CHANGED/);
});

test('metadata projection omits keys, endpoints, credential IDs and arbitrary fields', () => {
  const projected = safeModels(modelResponse().items); assert.deepEqual(projected, models); assert.ok(!JSON.stringify(projected).includes('DO_NOT_PERSIST'));
});

test('finished runs reserve 300 first, release unused budget and never persist raw snapshot content', async () => {
  const p = plan(301), progress = createProgress(p), saves = [], sent = []; let entry;
  const api = async (route, body) => {
    sent.push({ route, body });
    if (route === '/models') return modelResponse();
    if (route === '/arcade-sessions') { entry = p.schedule.find(e => e.config.snakeHarnessVersion === body.config.snakeHarnessVersion); assert.equal(progress.entries[entry.id].phase, 'creating'); return snapshot(p, entry); }
    if (body?.type === 'start') {
      const row = progress.entries[entry.id]; assert.equal(row.phase, 'starting'); assert.equal(row.reservedRequests, 300); assert.ok(row.startOperationId);
      return snapshot(p, entry, 'finished', 1, { events: [decision(2, entry.config.snakeHarnessVersion)] });
    }
    throw Error('unexpected');
  };
  await runBatch({ plan: p, progress, api, save: async () => saves.push(clone(progress)), pilot: true });
  assert.equal(sent.filter(x => x.body?.type === 'start').length, 2); // 1+300 fits, 2+300 does not.
  assert.equal(progress.entries['run-0001'].reservedRequests, 0); assert.equal(progress.entries['run-0003'].phase, 'pending');
  assert.ok(saves.some(x => x.entries['run-0001'].phase === 'starting')); assert.ok(!JSON.stringify(progress).includes('DO_NOT_PERSIST'));
  const result = report(p, progress); assert.equal(result.completed, 2); assert.equal(result.paired[0].foodDelta, 0); assert.equal(result.paired[1].foodDelta, null);
});

test('unknown START persists reservation, pauses once, and rerun never sends a paid command', async () => {
  const p = plan(), progress = createProgress(p), entry = p.schedule[0], commands = [];
  const api = async (route, body) => {
    if (route === '/models') return modelResponse();
    if (route === '/arcade-sessions') return snapshot(p, entry);
    commands.push(body.type);
    if (body.type === 'start') throw Error('sensitive provider error DO_NOT_PERSIST');
    return snapshot(p, entry, 'paused', 1);
  };
  await assert.rejects(runBatch({ plan: p, progress, api, save: async () => {}, pilot: true }), /UNEXPECTED_DRIVER_ERROR/);
  const row = progress.entries[entry.id]; assert.equal(row.phase, 'unknown'); assert.equal(row.reservedRequests, 300); assert.equal(row.pauseConfirmed, true); assert.deepEqual(commands, ['start', 'pause']);
  await assert.rejects(runBatch({ plan: p, progress, api: () => { throw Error('must not call'); }, save: async () => {}, pilot: true }), /BATCH_HALTED/);
  assert.ok(!JSON.stringify(progress).includes('DO_NOT_PERSIST')); assert.equal(report(p, progress).entries[0].score, null);
});

test('unknown CREATE is not retried and does not send start or fabricate a session ID', async () => {
  const p = plan(), progress = createProgress(p); let posts = 0;
  await assert.rejects(runBatch({ plan: p, progress, pilot: true, save: async () => {}, api: async (route) => { if (route === '/models') return modelResponse(); posts++; throw Error('unknown'); } }));
  assert.equal(posts, 1); assert.equal(progress.entries['run-0001'].phase, 'unknown'); assert.equal(progress.entries['run-0001'].sessionId, undefined); assert.equal(progress.entries['run-0001'].reservedRequests, 0);
});

test('restarting an interrupted ledger fails closed before any network or mutation', async () => {
  const p = plan(), progress = createProgress(p); progress.entries['run-0001'].phase = 'starting'; progress.entries['run-0001'].reservedRequests = 300;
  await assert.rejects(runBatch({ plan: p, progress, pilot: true, save: async () => {}, api: () => { throw Error('network prohibited'); } }), /INTERRUPTED_RUN/);
  assert.equal(progress.halted, true);
});

test('paused or model-error results halt the entire schedule and are never zero scores', async () => {
  for (const status of ['paused', 'error']) {
    const p = plan(), progress = createProgress(p), entry = p.schedule[0]; let creates = 0;
    await assert.rejects(runBatch({ plan: p, progress, pilot: true, save: async () => {}, api: async (route, body) => {
      if (route === '/models') return modelResponse();
      if (route === '/arcade-sessions') { creates++; return snapshot(p, entry); }
      return snapshot(p, entry, status, 1, { error: 'DO_NOT_PERSIST', needsRetry: true });
    } }), /SESSION_PAUSED_OR_ERROR/);
    assert.equal(creates, 1); assert.equal(progress.halted, true); assert.equal(report(p, progress).entries[0].score, null); assert.ok(!JSON.stringify(progress).includes('DO_NOT_PERSIST'));
  }
});

test('old server that strips harness config cannot start inference', async () => {
  const p = plan(), progress = createProgress(p); const commands = [];
  await assert.rejects(runBatch({ plan: p, progress, pilot: true, save: async () => {}, api: async (route, body) => {
    if (route === '/models') return modelResponse();
    if (route === '/arcade-sessions') return snapshot(p, p.schedule[0], 'ready', 0, { config: {} });
    commands.push(body.type); return snapshot(p, p.schedule[0], 'paused');
  } }), /SESSION_CONFIG_MISMATCH/);
  assert.ok(!commands.includes('start'));
});

test('settles outstanding calls and drains paginated events before counting a run complete', async () => {
  const p = plan(300), progress = createProgress(p); const entry = p.schedule[0]; let reads = 0;
  const events = Array.from({ length: 100 }, (_, i) => ({ seq: i + 1, type: 'input' }));
  await runBatch({ plan: p, progress, pilot: true, save: async () => {}, sleep: async () => {}, api: async (route, body) => {
    if (route === '/models') return modelResponse();
    if (route === '/arcade-sessions') return snapshot(p, entry);
    if (body?.type === 'start') { const s = snapshot(p, entry, 'finished', 1, { events }); s.runs[0].inflight = { requestId: 'private-request' }; return s; }
    reads++; return snapshot(p, entry, 'finished', 1, { events: [decision(101)] });
  } });
  assert.equal(reads, 1); assert.equal(progress.entries[entry.id].phase, 'complete'); assert.equal(progress.entries[entry.id].decisions.length, 1); assert.equal(progress.entries[entry.id].cursor, 101);
});

test('HTTP wrapper uses existing session plus same Origin, refuses redirects and strips upstream errors', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snake-driver-test-')); const auth = path.join(dir, 'auth.json');
  try {
    await atomicJson(auth, { cookie: 'test-cookie-DO_NOT_PERSIST' }, { exclusive: true });
    const api = await authenticatedApi('http://127.0.0.1:5091', auth, async (url, options) => {
      assert.equal(options.headers.Cookie, 'test-cookie-DO_NOT_PERSIST'); assert.equal(options.headers.Origin, 'http://127.0.0.1:5091'); assert.equal(options.redirect, 'error'); assert.equal(options.headers['X-Arena-Owner'], undefined);
      return { ok: false, status: 401, json: async () => ({ code: -1, message: 'secret DO_NOT_PERSIST' }) };
    });
    await assert.rejects(api('/models'), error => error.message === 'API_HTTP_401');
    await assert.rejects(authenticatedApi('https://example.com', auth), /INVALID_LOCAL_ORIGIN/);
    await assert.rejects(api('/models/../../other'), /INVALID_API_ROUTE/);
    assert.equal((await fs.stat(auth)).mode & 0o777, 0o600);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('formal plan omits development and keeps prespecified repeats outside independent samples', () => {
  const p = makePlan({ origin: 'http://127.0.0.1:5091', models, profileIds: ['profile-one'], acceptanceSeeds: ['a-1', 'a-2'], repeatSeeds: ['a-1'], globalMaxRequests: 1800, sourceManifest });
  assert.equal(p.pilotEntryIds.length, 0); assert.deepEqual(p.schedule.map(e => e.partition), ['acceptance', 'acceptance', 'acceptance', 'acceptance', 'acceptance', 'acceptance', 'repeat', 'repeat', 'repeat']);
  assert.ok(p.schedule.slice(0, 6).every(e => e.cohort === 'independent')); assert.ok(p.schedule.slice(6).every(e => e.cohort === 'repeat'));
  assert.throws(() => makePlan({ origin: p.origin, models, profileIds: ['profile-one'], acceptanceSeeds: ['a-1'], repeatSeeds: ['not-prespecified'], globalMaxRequests: 1800, sourceManifest }), /INVALID_REPEAT/);
});

test('unreported thinking stays null and config/budget changes stop before creating a match', async () => {
  const p = plan(300), progress = createProgress(p), entry = p.schedule[0];
  await runBatch({ plan: p, progress, pilot: true, save: async () => {}, api: async (route) => {
    if (route === '/models') return modelResponse(); if (route === '/arcade-sessions') return snapshot(p, entry);
    const e = decision(); delete e.metrics.thoughtUsed; return snapshot(p, entry, 'finished', 1, { events: [e] });
  } });
  assert.equal(progress.entries[entry.id].decisions[0].thoughtUsed, null); assert.equal(report(p, progress).entries[0].thoughtUsed.unreported, 1);
  const altered = modelResponse(); altered.items[0].thinkBudget = 4096;
  await assert.rejects(runBatch({ plan: p, progress: createProgress(p), pilot: true, save: async () => {}, api: async route => { assert.equal(route, '/models'); return altered; } }), /PROFILE_CHANGED/);
});

test('source drift stops before creating or starting any session', async () => {
  const p = plan(), progress = createProgress(p); let fetched = false;
  await assert.rejects(runBatch({ plan: p, progress, pilot: true, save: async () => {}, verifySource: async () => { throw Error('changed'); }, api: async () => { fetched = true; } }));
  assert.equal(fetched, false); assert.equal(progress.entries['run-0001'].phase, 'pending');
});

test('replay mismatch is excluded and prevents the next paid run', async () => {
  const p = plan(), progress = createProgress(p), entry = p.schedule[0]; let starts = 0;
  await assert.rejects(runBatch({ plan: p, progress, pilot: true, save: async () => {}, summarizeReplay: async replay => { assert.equal(replay.rawPrivate, 'IN_MEMORY_ONLY'); return { harnessVersion: entry.config.snakeHarnessVersion, harnessVersionSource: 'recorded', runs: [{ checks: { frameAgreement: false, scoreAgreement: true, inputActionAgreement: true } }] }; }, api: async (route, body) => {
    if (route === '/models') return modelResponse(); if (route === '/arcade-sessions') return snapshot(p, entry);
    if (route.endsWith('/replay')) return { rawPrivate: 'IN_MEMORY_ONLY' };
    starts++; return snapshot(p, entry, 'finished', 1, { events: [decision()] });
  } }), /REPLAY_VERIFICATION_FAILED/);
  assert.equal(starts, 1); assert.equal(report(p, progress).entries[0].score, null); assert.ok(!JSON.stringify(progress).includes('IN_MEMORY_ONLY'));
});
