import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

// Opt-in paid smoke. Credentials stay in the existing local vault; never printed or copied.
// Five dispatches per run is a polling-based SOFT stop target, not a server-enforced limit.
// Verify at most ten actual calls per run after stopping. Never retry a model request.
assert.ok(process.argv.includes('--confirm-live'), 'Pass --confirm-live to use the saved model profiles.');
const origin = 'http://127.0.0.1:5091';
const reportPath = process.env.ARENA_SMOKE_REPORT || 'artifacts/arcade-live-results.json';
const fixture = JSON.parse(await fs.readFile('artifacts/local-fixture.json', 'utf8'));
async function api(path, body) {
  const response = await fetch(origin + '/api/arena/' + path, {
    method: body ? 'POST' : 'GET', headers: { Cookie: fixture.cookie, Origin: origin, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
  });
  const value = await response.json();
  if (!response.ok || value.code === -1) throw new Error(`Local API failed (${response.status}): ${path}`);
  return value.data ?? value;
}
const budget = { softStopCallsPerRun: 5, maximumVerifiedCallsPerRun: 10, observationDeadlineMs: 25000, stopTargetIsServerEnforced: false };
console.log(JSON.stringify({ type: 'live-smoke-budget', ...budget }));
const profiles = (await api('models')).items;
const selected = ['openrouter', 'systemone'].map(provider => {
  const profileId = process.env[provider === 'openrouter' ? 'ARENA_SMOKE_OPENROUTER_PROFILE_ID' : 'ARENA_SMOKE_SYSTEMONE_PROFILE_ID'];
  const profile = profiles.find(profile => profileId ? profile.id === profileId && profile.provider === provider : profile.provider === provider);
  assert.ok(profile, profileId ? `The explicitly selected ${provider} profile is unavailable or has a different provider.` : `Save a ${provider} profile first.`);
  return profile;
});
function cleanupFailure(sessionId, ended, settled) {
  console.error(JSON.stringify({ type: 'live-smoke-cleanup-unconfirmed', sessionId, endConfirmed: ended, settlementConfirmed: settled, nextSessionStarted: false }));
  throw new Error(`Could not confirm cleanup for session ${sessionId}; inspect this session before another paid test.`);
}
async function endAndSettle(path, sessionId, current) {
  const operationId = randomUUID();
  // Send END before any fresh GET: a failed status read must never prevent cleanup.
  // Only this idempotent control command is retried; no start/resume/retry model command is sent.
  for (let attempt = 0; attempt < 2 && current.status !== 'finished'; attempt++) {
    try { current = await api(path + '/commands', { type: 'end', operationId }); }
    catch {
      // END may have succeeded while its response was lost. Read back if possible;
      // otherwise retry END once with the SAME operation identifier.
      try { current = await api(path); } catch { /* Continue the bounded END attempt. */ }
    }
  }
  if (current.status !== 'finished') cleanupFailure(sessionId, false, false);
  const settleDeadline = Date.now() + 125000;
  while (current.runs.some(run => run.inflight) && Date.now() < settleDeadline) {
    await new Promise(resolve => setTimeout(resolve, 400));
    try { current = await api(path); }
    catch { cleanupFailure(sessionId, true, false); }
  }
  if (current.runs.some(run => run.inflight)) cleanupFailure(sessionId, true, false);
  return current;
}
const summaries = [];
const gameIds = process.env.ARENA_SMOKE_GAMES?.split(',') ?? ['snake', 'tetris', 'platformer'];
assert.ok(gameIds.length > 0 && gameIds.length <= 3 && new Set(gameIds).size === gameIds.length && gameIds.every(game => ['snake', 'tetris', 'platformer'].includes(game)), 'ARENA_SMOKE_GAMES must contain unique supported game IDs.');
for (const gameId of gameIds) {
  const session = await api('arcade-sessions', {
    gameId, mode: 'ai-ai', seed: 'live-arcade-2026-10-16', config: { level: 1 },
    controllers: selected.map(profile => ({ kind: 'ai', profileId: profile.id })),
  });
  const path = `arcade-sessions/${session.id}`;
  const command = type => api(path + '/commands', { type, operationId: randomUUID() });
  let current = session;
  try {
    await command('start');
    const deadline = Date.now() + budget.observationDeadlineMs;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 120));
      current = await api(path);
      // Stop immediately on the first observed threshold; polling/network delays can overshoot it.
      if (current.status !== 'running' || current.runs.some(run => run.calls >= budget.softStopCallsPerRun)) break;
    }
  } finally {
    current = await endAndSettle(path, session.id, current);
  }
  const replay = await api(path + '/replay');
  const summary = {
    gameId, sessionId: session.id, status: current.status, tick: current.tick, result: current.result,
    promptVersion: replay.promptVersion, budget,
    runs: current.runs.map(run => ({ id: run.id, calls: run.calls, score: run.view.score, reason: run.view.reason,
      provider: run.controller.profile?.provider, requestedModel: run.controller.profile?.model,
      thinkMode: run.controller.profile?.thinkMode, thinkBudget: run.controller.profile?.thinkBudget })),
    decisions: replay.events.filter(event => event.type === 'decision').map(event => ({
      runId: event.runId, actionId: event.actionId, promptVersion: event.promptVersion, observedTick: event.observedTick, appliedTick: event.appliedTick,
      outcome: event.outcome, metrics: event.metrics,
    })),
  };
  assert.ok(summary.runs.every(run => run.calls <= budget.maximumVerifiedCallsPerRun), `Live-call verification bound exceeded for session ${session.id}; no subsequent test started.`);
  summaries.push(summary);
  await fs.writeFile(reportPath, JSON.stringify(summaries, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(summary));
}
