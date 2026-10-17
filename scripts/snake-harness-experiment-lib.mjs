import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const CRITICAL_SOURCES = ['packages/games/src/index.ts', 'packages/games/src/arcade/index.ts', 'packages/core/src/arcade.ts', 'packages/core/src/index.ts', 'packages/games/src/arcade/common.ts', 'packages/games/src/arcade/snake.ts', 'packages/games/src/arcade/decision.ts', 'packages/games/src/arcade/snake-harness.ts', 'packages/providers/src/index.ts', 'apps/runner/src/arcade.ts', 'apps/runner/src/arcade-scheduling.ts', 'apps/runner/src/index.ts', 'apps/web/src/core/arena/validation.ts', 'apps/web/src/modules/arena/service.ts', 'scripts/snake-harness-experiment.mjs', 'scripts/snake-harness-experiment-lib.mjs', 'scripts/lib/snake-experiment-report.mjs'];
export async function sourceManifest() {
  const files = await Promise.all(CRITICAL_SOURCES.map(async file => ({ path: file, sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex') })));
  return { files, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}
export async function verifySources(plan) { check((await sourceManifest()).sha256 === plan.sourceManifest.sha256, 'SOURCE_CHANGED'); }
export const HARNESS = Object.freeze({ A: 'snake-harness-a-v1', B: 'snake-harness-b-v1', C: 'snake-harness-c-v1' });
const PROVIDERS = ['openrouter', 'systemone', 'custom-openrouter', 'custom-systemone', 'bamboonode-systemone', 'bamboonode-decisions'];
const PHASES = ['pending', 'creating', 'ready', 'starting', 'running', 'settling', 'complete', 'stopped', 'unknown'];
const TOKEN = /^[a-zA-Z0-9_-]{1,128}$/;
export class ExperimentError extends Error {
  constructor(code) { super(code); this.name = 'ExperimentError'; this.code = code; }
}
const check = (condition, code) => { if (!condition) throw new ExperimentError(code); };
export function localOrigin(value) {
  let url; try { url = new URL(value); } catch { throw new ExperimentError('INVALID_LOCAL_ORIGIN'); }
  check(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'INVALID_LOCAL_ORIGIN');
  return url.origin;
}
export function safeModels(items) {
  check(Array.isArray(items), 'INVALID_MODELS_RESPONSE');
  return items.map(p => {
    check(TOKEN.test(p.id) && PROVIDERS.includes(p.provider) && typeof p.model === 'string' && p.model.length <= 256, 'INVALID_MODEL_METADATA');
    const thinkMode = ['never', 'auto', 'always'].includes(p.thinkMode) ? p.thinkMode : null;
    const thinkBudget = Number.isInteger(p.thinkBudget) ? p.thinkBudget : null;
    const configDigest = createHash('sha256').update(JSON.stringify({ provider: p.provider, model: p.model, endpoint: p.endpoint ?? null, thinkMode, thinkBudget })).digest('hex');
    return { profileId: p.id, provider: p.provider, model: p.model, thinkMode, thinkBudget, configDigest, source: p.source === 'bamboonode' ? 'bamboonode' : 'manual', available: p.available === true };
  });
}
export function makePlan({ origin, models, profileIds, developmentSeeds = [], acceptanceSeeds = [], repeatSeeds = [], globalMaxRequests, sourceManifest, experimentId = randomUUID() }) {
  const profiles = profileIds.map(id => { const profile = models.find(p => p.profileId === id); check(profile?.available, 'PROFILE_UNAVAILABLE'); return { ...profile }; });
  const schedule = [];
  for (const [partition, seeds] of Object.entries({ development: developmentSeeds, acceptance: acceptanceSeeds, repeat: repeatSeeds })) {
    for (const [seedIndex, seed] of seeds.entries()) {
      // Rotate variant order between seeds; interleave providers within each variant.
      for (let variantOffset = 0; variantOffset < 3; variantOffset++) {
        const variant = ['A', 'B', 'C'][(seedIndex + variantOffset) % 3];
        for (let modelOffset = 0; modelOffset < profiles.length; modelOffset++) {
          const profile = profiles[(seedIndex + variantOffset + modelOffset) % profiles.length];
          schedule.push({ id: `run-${String(schedule.length + 1).padStart(4, '0')}`, partition, cohort: partition === 'acceptance' ? 'independent' : 'repeat', ...(partition === 'repeat' ? { repetition: 1 } : {}), seed, variant, profileId: profile.profileId, config: { snakeHarnessVersion: HARNESS[variant] } });
        }
      }
    }
  }
  return validatePlan({ schemaVersion: 1, experimentId, origin: localOrigin(origin), gameId: 'snake', mode: 'ai-solo', rulesVersion: 'snake-realtime-v2', thinkMode: 'never', profiles, sourceManifest,
    seedGroups: { development: developmentSeeds, acceptance: acceptanceSeeds, repeat: repeatSeeds }, variants: HARNESS,
    limits: { globalMaxRequests, maxCallsPerRun: 300, durationSeconds: 120, maxTicks: 7200, minRequestIntervalMs: 500 },
    schedule, pilotEntryIds: schedule.filter(e => e.partition === 'development' && e.seed === developmentSeeds[0]).map(e => e.id) });
}
export function validatePlan(p) {
  check(p?.schemaVersion === 1 && TOKEN.test(p.experimentId), 'INVALID_PLAN');
  check(p.sourceManifest && /^[a-f0-9]{64}$/.test(p.sourceManifest.sha256) && Array.isArray(p.sourceManifest.files) && p.sourceManifest.files.length > 0, 'INVALID_SOURCE_MANIFEST');
  check(p.origin === localOrigin(p.origin), 'INVALID_PLAN_ORIGIN');
  check(p.gameId === 'snake' && p.mode === 'ai-solo' && p.rulesVersion === 'snake-realtime-v2' && p.thinkMode === 'never', 'INVALID_PLAN_GAME');
  check(JSON.stringify(p.variants) === JSON.stringify(HARNESS), 'INVALID_PLAN_VARIANTS');
  check(p.limits?.maxCallsPerRun === 300 && p.limits.durationSeconds === 120 && p.limits.maxTicks === 7200 && p.limits.minRequestIntervalMs === 500 && Number.isSafeInteger(p.limits.globalMaxRequests) && p.limits.globalMaxRequests >= 300, 'INVALID_PLAN_BUDGET');
  check(Array.isArray(p.profiles) && p.profiles.length > 0 && p.profiles.length <= 8 && new Set(p.profiles.map(x => x.profileId)).size === p.profiles.length, 'INVALID_PLAN_PROFILES');
  for (const profile of p.profiles) check(TOKEN.test(profile.profileId) && PROVIDERS.includes(profile.provider) && typeof profile.model === 'string' && profile.model.length <= 256 && profile.available === true && /^[a-f0-9]{64}$/.test(profile.configDigest) && (profile.thinkBudget === null || Number.isInteger(profile.thinkBudget)), 'INVALID_PLAN_PROFILE');
  for (const partition of ['development', 'acceptance', 'repeat']) check(Array.isArray(p.seedGroups?.[partition]) && p.seedGroups[partition].length <= 100 && p.seedGroups[partition].every(seed => typeof seed === 'string' && TOKEN.test(seed)), 'INVALID_PLAN_SEEDS');
  const allSeeds = [...p.seedGroups.development, ...p.seedGroups.acceptance];
  check(allSeeds.length > 0 && new Set(allSeeds).size === allSeeds.length, 'SEEDS_OVERLAP_OR_REPEAT');
  check(new Set(p.seedGroups.repeat).size === p.seedGroups.repeat.length && p.seedGroups.repeat.every(seed => p.seedGroups.acceptance.includes(seed)), 'INVALID_REPEAT_SEEDS');
  check(Array.isArray(p.schedule) && p.schedule.length === (allSeeds.length + p.seedGroups.repeat.length) * p.profiles.length * 3, 'INCOMPLETE_SCHEDULE');
  const seen = new Set(), ids = new Set();
  for (const entry of p.schedule) {
    check(TOKEN.test(entry.id) && !ids.has(entry.id), 'DUPLICATE_SCHEDULE_ID'); ids.add(entry.id);
    check(p.seedGroups[entry.partition]?.includes(entry.seed) && entry.cohort === (entry.partition === 'acceptance' ? 'independent' : 'repeat') && (entry.partition !== 'repeat' || entry.repetition === 1) && p.profiles.some(x => x.profileId === entry.profileId) && HARNESS[entry.variant] === entry.config?.snakeHarnessVersion, 'INVALID_SCHEDULE_ENTRY');
    const key = JSON.stringify([entry.partition, entry.seed, entry.profileId, entry.variant]);
    check(!seen.has(key), 'DUPLICATE_SCHEDULE_ENTRY'); seen.add(key);
  }
  const expectedPilot = p.schedule.filter(e => e.partition === 'development' && e.seed === p.seedGroups.development[0]).map(e => e.id);
  check(JSON.stringify(p.pilotEntryIds) === JSON.stringify(expectedPilot), 'INVALID_PILOT');
  return p;
}
export const planHash = plan => createHash('sha256').update(JSON.stringify(validatePlan(plan))).digest('hex');
export function createProgress(plan) {
  return { schemaVersion: 1, experimentId: plan.experimentId, planHash: planHash(plan), halted: false, entries: Object.fromEntries(plan.schedule.map(e => [e.id, { phase: 'pending', calls: 0, decisions: [], cursor: 0, reservedRequests: 0 }])) };
}
export function validateProgress(plan, progress) {
  check(progress.schemaVersion === 1 && progress.experimentId === plan.experimentId && progress.planHash === planHash(plan), 'PLAN_CHANGED');
  check(Object.keys(progress.entries ?? {}).length === plan.schedule.length, 'INVALID_PROGRESS');
  for (const entry of plan.schedule) {
    const row = progress.entries[entry.id];
    check(row && PHASES.includes(row.phase) && Number.isInteger(row.calls) && row.calls >= 0 && row.calls <= 300 && [0, 300].includes(row.reservedRequests) && Array.isArray(row.decisions), 'INVALID_PROGRESS');
  }
  return progress;
}
export async function atomicJson(filename, value, { exclusive = false } = {}) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const target = exclusive ? filename : `${filename}.${randomUUID()}.tmp`;
  const handle = await fs.open(target, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
  if (!exclusive) await fs.rename(target, filename);
  const dir = await fs.open(path.dirname(filename), 'r'); try { await dir.sync(); } finally { await dir.close(); }
}
export async function authenticatedApi(origin, authFile, fetcher = fetch) {
  origin = localOrigin(origin);
  let fixture; try { fixture = JSON.parse(await fs.readFile(authFile, 'utf8')); } catch { throw new ExperimentError('AUTH_FILE_UNAVAILABLE'); }
  check(typeof fixture.cookie === 'string' && fixture.cookie.length > 0 && fixture.cookie.length < 32768 && !/[\r\n]/.test(fixture.cookie), 'INVALID_AUTH_FILE');
  // The existing application's session is used unchanged. No DB reads, account creation,
  // signed-cookie fabrication, model-key extraction, or internal owner headers.
  return async (route, body) => {
    check(/^\/(?:models|arcade-sessions)(?:[/?][a-zA-Z0-9_/?=&-]*)?$/.test(route), 'INVALID_API_ROUTE');
    let response;
    try { response = await fetcher(origin + '/api/arena' + route, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Cookie: fixture.cookie, Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch { throw new ExperimentError('API_NETWORK_UNKNOWN'); }
    let envelope; try { envelope = await response.json(); } catch { throw new ExperimentError('API_INVALID_RESPONSE'); }
    check(response.ok && envelope.code !== -1, `API_HTTP_${response.status}`);
    return envelope.data ?? envelope;
  };
}
export function verifyProfiles(plan, models) {
  for (const expected of plan.profiles) {
    const live = models.find(x => x.profileId === expected.profileId);
    check(live?.available && live.provider === expected.provider && live.model === expected.model && live.source === expected.source && live.configDigest === expected.configDigest && live.thinkBudget === expected.thinkBudget && live.thinkMode === expected.thinkMode, 'PROFILE_CHANGED_OR_UNAVAILABLE');
  }
}
export function verifySnapshot(plan, entry, snapshot) {
  const expected = plan.profiles.find(p => p.profileId === entry.profileId), run = snapshot?.runs?.[0];
  check(snapshot?.gameId === 'snake' && snapshot.mode === 'ai-solo' && snapshot.seed === entry.seed && snapshot.rulesVersion === plan.rulesVersion && snapshot.config?.snakeHarnessVersion === entry.config.snakeHarnessVersion && snapshot.runs.length === 1 && run.controller.kind === 'ai', 'SESSION_CONFIG_MISMATCH');
  check(run.controller.profile?.provider === expected.provider && run.controller.profile?.model === expected.model && run.controller.profile?.thinkMode === 'never' && (run.controller.profile?.thinkBudget ?? null) === expected.thinkBudget, 'SESSION_MODEL_MISMATCH');
  check(snapshot.limits?.maxTicks === 7200 && snapshot.limits.maxCallsPerRun === 300 && snapshot.limits.minRequestIntervalMs === 500, 'SESSION_LIMIT_MISMATCH');
  check(Number.isInteger(run.calls) && run.calls >= 0 && run.calls <= 300, 'CALL_LIMIT_VIOLATED');
}
const number = x => typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : undefined;
const score = x => ({ points: number(x?.points), food: number(x?.food), survivedTicks: number(x?.survivedTicks) });
export function collectSnapshot(row, snapshot) {
  const run = snapshot.runs[0];
  row.sessionId = snapshot.id;
  row.calls = run.calls;
  row.tick = snapshot.tick;
  row.status = snapshot.status;
  row.inflight = Boolean(run.inflight);
  row.score = score(run.view?.score);
  row.reason = ['WALL_COLLISION', 'SELF_COLLISION', 'BOARD_FILLED', 'TIME_LIMIT'].includes(run.view?.reason) ? run.view.reason : undefined;
  row.result = snapshot.result ? { aborted: snapshot.result.aborted === true, reason: ['time_limit', 'runs_finished', 'ended_by_user'].includes(snapshot.result.reason) ? snapshot.result.reason : 'other' } : undefined;
  for (const event of snapshot.events ?? []) {
    if (!Number.isInteger(event.seq) || event.seq <= row.cursor) continue;
    row.cursor = event.seq;
    if (event.type !== 'decision') continue;
    row.decisions.push({ seq: event.seq, observedTick: number(event.observedTick), appliedTick: number(event.appliedTick), settledTick: number(event.tick),
      outcome: ['applied', 'dropped', 'failed', 'unknown'].includes(event.outcome) ? event.outcome : 'unknown',
      actionId: /^(up|down|left|right):100$/.test(event.actionId) ? event.actionId : undefined,
      promptVersion: /^[a-zA-Z0-9_-]{1,100}$/.test(event.promptVersion) ? event.promptVersion : undefined,
      snakeHarnessVersion: Object.values(HARNESS).includes(event.snakeHarnessVersion) ? event.snakeHarnessVersion : undefined,
      elapsedMs: number(event.metrics?.elapsedMs), actualModel: typeof event.metrics?.actualModel === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,159}$/.test(event.metrics.actualModel) && !/^(?:sk[-_]|bag_|bearer)/i.test(event.metrics.actualModel) ? event.metrics.actualModel : undefined,
      thoughtUsed: typeof event.metrics?.thoughtUsed === 'boolean' ? event.metrics.thoughtUsed : null });
  }
}
export function chargedOrReserved(progress) {
  return Object.values(progress.entries).reduce((sum, row) => sum + (row.reservedRequests || row.calls), 0);
}
// Every mutating intent is durably recorded BEFORE sending. Unknown outcomes are never replayed.
// A second process cannot use the CLI's ledger while its exclusive lock exists.
export async function runBatch({ plan, progress, api, save, pilot = false, partition, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), signal, verifySource = async () => {}, summarizeReplay, emit = () => {} }) {
  validateProgress(plan, progress);
  check(!progress.halted, 'BATCH_HALTED_REQUIRES_REVIEW');
  const ambiguous = Object.values(progress.entries).some(row => !['pending', 'complete'].includes(row.phase));
  if (ambiguous) { progress.halted = true; progress.haltReason = 'INTERRUPTED_RUN_REQUIRES_REVIEW'; await save(); throw new ExperimentError(progress.haltReason); }
  check(pilot || ['development', 'acceptance', 'repeat'].includes(partition), 'SELECT_PARTITION_OR_PILOT');
  await verifySource();
  verifyProfiles(plan, safeModels((await api('/models')).items));
  const selected = plan.schedule.filter(entry => pilot ? plan.pilotEntryIds.includes(entry.id) : entry.partition === partition);
  check(selected.length > 0, 'EMPTY_SELECTION');
  for (const entry of selected) {
    const row = progress.entries[entry.id];
    if (row.phase === 'complete') continue;
    check(!signal?.aborted, 'INTERRUPTED_BEFORE_START');
    if (chargedOrReserved(progress) + 300 > plan.limits.globalMaxRequests) { emit({ type: 'budget-stop', nextEntryId: entry.id, chargedOrReserved: chargedOrReserved(progress), limit: plan.limits.globalMaxRequests }); return; }
    await verifySource();
    // Check before EACH session because a profile may be revoked/changed during a batch.
    verifyProfiles(plan, safeModels((await api('/models')).items));
    let snapshot;
    try {
      row.phase = 'creating'; await save();
      snapshot = await api('/arcade-sessions', { gameId: 'snake', mode: 'ai-solo', seed: entry.seed, config: entry.config, controllers: [{ kind: 'ai', profileId: entry.profileId }] });
      check(TOKEN.test(snapshot?.id), 'INVALID_SESSION_ID'); row.sessionId = snapshot.id;
      verifySnapshot(plan, entry, snapshot);
      check(snapshot.status === 'ready' && snapshot.runs[0].calls === 0, 'SESSION_NOT_READY');
      collectSnapshot(row, snapshot); row.phase = 'ready'; await save();
      check(!signal?.aborted, 'INTERRUPTED_BEFORE_START');
      row.phase = 'starting'; row.startOperationId = randomUUID(); row.reservedRequests = 300; row.startedAt = now(); await save();
      snapshot = await api(`/arcade-sessions/${row.sessionId}/commands`, { type: 'start', operationId: row.startOperationId });
      const deadline = now() + 120000 + 135000;
      while (true) {
        verifySnapshot(plan, entry, snapshot); collectSnapshot(row, snapshot);
        check(!signal?.aborted, 'INTERRUPTED_AFTER_START');
        check(!['paused', 'error'].includes(snapshot.status) && !snapshot.needsRetry, 'SESSION_PAUSED_OR_ERROR');
        check(!row.result?.aborted, 'SESSION_ABORTED');
        check(!row.decisions.some(d => d.outcome === 'failed' || d.outcome === 'unknown'), 'MODEL_CALL_FAILED_OR_UNKNOWN');
        check(!row.decisions.some(d => d.thoughtUsed), 'THINKING_UNEXPECTED');
        check(row.decisions.every(d => d.snakeHarnessVersion === entry.config.snakeHarnessVersion && d.promptVersion), 'DECISION_VERSION_MISMATCH');
        check(['running', 'finished'].includes(snapshot.status), 'UNEXPECTED_SESSION_STATUS');
        row.phase = snapshot.status === 'finished' ? 'settling' : 'running'; await save();
        const pageFull = (snapshot.events?.length ?? 0) >= 100;
        if (snapshot.status === 'finished' && !row.inflight && !pageFull) {
          check(row.decisions.length === row.calls, 'INCOMPLETE_DECISION_METRICS');
          if (summarizeReplay) {
            row.replaySummary = await summarizeReplay(await api(`/arcade-sessions/${row.sessionId}/replay`));
            check(row.replaySummary.harnessVersion === entry.config.snakeHarnessVersion && row.replaySummary.harnessVersionSource === 'recorded' && row.replaySummary.runs.length === 1 && row.replaySummary.runs.every(run => run.checks?.frameAgreement === true && run.checks?.scoreAgreement === true && run.checks?.inputActionAgreement === true), 'REPLAY_VERIFICATION_FAILED');
          }
          await verifySource();
          row.phase = 'complete'; row.reservedRequests = 0; row.completedAt = now(); await save();
          emit({ type: 'complete', entryId: entry.id, sessionId: row.sessionId, calls: row.calls, score: row.score }); break;
        }
        check(now() < deadline, 'SESSION_OBSERVATION_TIMEOUT');
        if (!pageFull) await sleep(500);
        snapshot = await api(`/arcade-sessions/${row.sessionId}?since=${row.cursor}`);
      }
    } catch (error) {
      const previousPhase = row.phase;
      row.phase = ['creating', 'starting'].includes(previousPhase) || !(error instanceof ExperimentError) || error.code?.startsWith('API_') ? 'unknown' : 'stopped';
      row.failure = error instanceof ExperimentError ? error.code : 'UNEXPECTED_DRIVER_ERROR';
      progress.halted = true; progress.haltReason = row.failure;
      await save();
      // Fail-safe PAUSE is a single control command, never a retry/start/resume. Persist its
      // operation ID first. If it cannot be confirmed, the 300-call reservation remains held.
      if (row.sessionId && (previousPhase === 'starting' || !['ready', 'finished', 'paused', 'error'].includes(row.status))) {
        row.pauseOperationId = randomUUID(); row.pauseAttempted = true; await save();
        try {
          const paused = await api(`/arcade-sessions/${row.sessionId}/commands`, { type: 'pause', operationId: row.pauseOperationId });
          verifySnapshot(plan, entry, paused); collectSnapshot(row, paused);
          row.pauseConfirmed = ['paused', 'finished', 'error'].includes(paused.status);
        } catch { row.pauseConfirmed = false; }
        await save();
      }
      emit({ type: 'halted', entryId: entry.id, sessionId: row.sessionId, code: row.failure, pauseConfirmed: row.pauseConfirmed ?? false });
      throw new ExperimentError(row.failure);
    }
  }
}
function distribution(values) {
  const sorted = values.filter(x => typeof x === 'number').sort((a, b) => a - b);
  return { n: sorted.length, mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null, p50: sorted.length ? sorted[Math.ceil(sorted.length * 0.5) - 1] : null, p95: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null };
}
export function report(plan, progress) {
  validateProgress(plan, progress);
  const entries = plan.schedule.map(entry => {
    const row = progress.entries[entry.id], usable = row.phase === 'complete';
    return { entryId: entry.id, partition: entry.partition, cohort: entry.cohort, repetition: entry.repetition, seed: entry.seed, variant: entry.variant, snakeHarnessVersion: entry.config.snakeHarnessVersion, profileId: entry.profileId,
      sessionId: row.sessionId, phase: row.phase, eligibleForScore: usable, failure: row.failure, calls: row.calls, reservedRequests: row.reservedRequests,
      score: usable ? row.score : null, replaySummary: row.replaySummary, thoughtUsed: { true: row.decisions.filter(d => d.thoughtUsed === true).length, false: row.decisions.filter(d => d.thoughtUsed === false).length, unreported: row.decisions.filter(d => d.thoughtUsed === null).length }, reason: row.reason, result: row.result,
      latencyMs: distribution(row.decisions.map(d => d.elapsedMs)), observedToSettledTicks: distribution(row.decisions.map(d => d.settledTick - d.observedTick)),
      outcomes: Object.fromEntries(['applied', 'dropped', 'failed', 'unknown'].map(outcome => [outcome, row.decisions.filter(d => d.outcome === outcome).length])),
      actions: Object.fromEntries(['up:100', 'down:100', 'left:100', 'right:100'].map(action => [action, row.decisions.filter(d => d.actionId === action).length])),
      promptVersions: [...new Set(row.decisions.map(d => d.promptVersion).filter(Boolean))], actualModels: [...new Set(row.decisions.map(d => d.actualModel).filter(Boolean))] };
  });
  const paired = [];
  for (const partition of ['development', 'acceptance', 'repeat']) for (const profile of plan.profiles) for (const seed of plan.seedGroups[partition]) {
    const matches = entries.filter(e => e.partition === partition && e.profileId === profile.profileId && e.seed === seed), baseline = matches.find(e => e.variant === 'A');
    for (const variant of ['B', 'C']) {
      const candidate = matches.find(e => e.variant === variant), valid = baseline?.eligibleForScore && candidate?.eligibleForScore;
      paired.push({ partition, profileId: profile.profileId, seed, comparison: `${variant}-A`, eligible: Boolean(valid), foodDelta: valid ? candidate.score.food - baseline.score.food : null, survivedTicksDelta: valid ? candidate.score.survivedTicks - baseline.score.survivedTicks : null });
    }
  }
  return { schemaVersion: 1, experimentId: plan.experimentId, planHash: progress.planHash, halted: progress.halted, haltReason: progress.haltReason, globalMaxRequests: plan.limits.globalMaxRequests,
    knownCalls: Object.values(progress.entries).reduce((n, r) => n + r.calls, 0), chargedOrReserved: chargedOrReserved(progress), completed: entries.filter(e => e.eligibleForScore).length,
    profiles: plan.profiles, sourceManifest: plan.sourceManifest, entries, paired, evidenceLimit: 'Real-time runs only; paused, failed, interrupted, and unknown runs are excluded, never scored as zero. Development and acceptance results are separate; no significance claim.' };
}
