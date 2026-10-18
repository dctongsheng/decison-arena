#!/usr/bin/env node
// Runs the authenticated production execution path. No credential extraction,
// replacement controller, paused simulator, automatic retries, or raw payload logs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { atomicJson, authenticatedApi, safeModels, verifyProfiles, localOrigin, ExperimentError } from './snake-harness-experiment-lib.mjs';

export const VERSIONS = { A: 'tetris-harness-baseline-v1', V8: 'tetris-harness-v8-realtime-v1' };
export const SEEDS = ['101', '203', '307', '409', '503', '607'].map(s => `arena-v8-final-20261018-${s}`);
const check = (value, code) => { if (!value) throw new ExperimentError(code); };
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const emit = value => console.log(JSON.stringify(value));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeModel = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,159}$/.test(value) && !/^(sk[-_]|bag_|bearer)/i.test(value) ? value : null;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const sourceFiles = ['packages/core/src/arcade.ts', 'packages/core/src/index.ts', 'packages/games/src/arcade/tetris.ts', 'packages/games/src/arcade/common.ts', 'packages/games/src/arcade/decision.ts', 'packages/providers/src/index.ts', 'apps/runner/src/arcade.ts', 'apps/runner/src/arcade-scheduling.ts', 'apps/runner/src/tetris-planning.ts', 'apps/runner/src/local-provider-policy.ts', 'apps/runner/src/index.ts', 'apps/web/src/modules/arena/service.ts', 'apps/web/src/core/arena/validation.ts', 'scripts/snake-harness-experiment-lib.mjs', 'scripts/tetris-v8-experiment.mjs'];
async function sources() {
  const extras = (await fs.readdir('packages/games/src/arcade')).filter(x => x.startsWith('tetris-') && x.endsWith('.ts')).map(x => `packages/games/src/arcade/${x}`);
  const files = await Promise.all([...sourceFiles, ...extras].sort().map(async file => ({ path: file, sha256: digest(await fs.readFile(file, 'utf8')) })));
  return { files, sha256: digest(files) };
}
export function schedule(phase) {
  check(['pilot', 'acceptance'].includes(phase), 'INVALID_PHASE');
  const seeds = phase === 'pilot' ? ['arena-v8-pilot-20261018-01'] : [...SEEDS, SEEDS[0]];
  return seeds.flatMap((seed, i) => (i % 2 === 0 && i !== 6 ? ['A', 'V8'] : ['V8', 'A']).map(variant => ({
    id: `${phase}-${i + 1}-${variant}`, seed, variant, partition: phase === 'pilot' ? 'development' : i === 6 ? 'repeat' : 'acceptance', version: VERSIONS[variant],
  })));
}
export function safeDecision(event) {
  const stage = event.decisionStage ?? 'key';
  check(['target', 'key'].includes(stage), 'INVALID_STAGE');
  check(['applied', 'dropped', 'failed', 'unknown'].includes(event.outcome), 'INVALID_OUTCOME');
  const actionId = typeof event.actionId === 'string' && /^(keep|clear|target:[0-9]:[0-3]|(?:noop|left|right|rotate-cw|rotate-ccw|soft-drop|hard-drop|hold):(?:100|300|1000))$/.test(event.actionId) ? event.actionId : null;
  const usage = {};
  for (const field of ['input_tokens', 'output_tokens', 'prompt_tokens', 'completion_tokens', 'reasoning_tokens', 'total_tokens'])
    if (number(event.metrics?.usage?.[field]) !== null) usage[field] = event.metrics.usage[field];
  return { seq: event.seq, stage, actionId, outcome: event.outcome, pieceId: number(event.pieceId),
    observedTick: number(event.observedTick), returnedTick: number(event.settledTick ?? event.tick), appliedTick: number(event.appliedTick),
    elapsedMs: number(event.metrics?.elapsedMs), actualModel: safeModel(event.metrics?.actualModel),
    thoughtUsed: typeof event.metrics?.thoughtUsed === 'boolean' ? event.metrics.thoughtUsed : null,
    usage, harnessVersion: Object.values(VERSIONS).includes(event.tetrisHarnessVersion) ? event.tetrisHarnessVersion : null,
    image: event.observationImage && /^[a-f0-9]{64}$/.test(event.observationImage.sha256) ? { sha256: event.observationImage.sha256, count: event.observationImage.count, width: event.observationImage.width, height: event.observationImage.height } : null };
}
export function distribution(values) {
  const a = values.filter(x => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  const q = p => { if (!a.length) return null; const i = (a.length - 1) * p; return a[Math.floor(i)] * (1 - i % 1) + a[Math.ceil(i)] * (i % 1); };
  return { n: a.length, median: q(.5), p95: q(.95) };
}
function collect(row, snapshot) {
  const run = snapshot.runs[0]; row.status = snapshot.status; row.tick = snapshot.tick; row.calls = run.calls;
  row.score = { lines: run.view.score.lines, points: run.view.score.points, survivedTicks: run.view.score.survivedTicks };
  row.reason = ['TOP_OUT', 'SPAWN_BLOCKED', 'TIME_LIMIT'].includes(run.view.reason) ? run.view.reason : null;
  row.aborted = snapshot.result?.aborted ?? null; row.inflight = Boolean(run.inflight);
  for (const event of snapshot.events ?? []) {
    if (event.seq <= row.cursor) continue;
    row.cursor = event.seq;
    if (event.type === 'decision') row.decisions.push(safeDecision(event));
  }
}
function verify(plan, entry, snapshot) {
  const run = snapshot?.runs?.[0], p = plan.profiles[0];
  check(snapshot.gameId === 'tetris' && snapshot.mode === 'ai-solo' && snapshot.seed === entry.seed && snapshot.rulesVersion === 'tetris-realtime-v1' && snapshot.config?.tetrisHarnessVersion === entry.version && snapshot.runs.length === 1, 'SESSION_CONFIG_CHANGED');
  check(run.controller.profile?.provider === p.provider && run.controller.profile.model === p.model && run.controller.profile.thinkMode === 'never' && (run.controller.profile.thinkBudget ?? null) === p.thinkBudget, 'MODEL_CHANGED');
  check(snapshot.limits?.maxCallsPerRun === 300 && snapshot.limits.maxTicks === 7200 && snapshot.limits.minRequestIntervalMs === 500 && run.calls <= 300, 'LIMIT_CHANGED');
}
/** Replay only recorded key inputs. A goal choice can never move a tetromino. */
export function verifyReplay(replay, adapter) {
  check(replay.gameId === 'tetris' && replay.runIds.length === 1 && replay.rulesVersion === adapter.rulesVersion, 'INVALID_REPLAY');
  let state = adapter.create(replay.config, replay.seed);
  const runId = replay.runIds[0], sequenceIds = new Set(), requestIds = new Set();
  for (const event of replay.events) {
    check(Number.isSafeInteger(event.seq) && !sequenceIds.has(event.seq), 'DUPLICATE_EVENT'); sequenceIds.add(event.seq);
    check(event.runId === undefined || event.runId === runId, 'FOREIGN_RUN');
    if (event.type === 'input' || event.type === 'decision') check(event.runId === runId, 'MISSING_RUN');
    if (event.type === 'decision') {
      check(typeof event.requestId === 'string' && !requestIds.has(event.requestId), 'DUPLICATE_OR_MISSING_REQUEST'); requestIds.add(event.requestId);
    }
  }
  const inputs = replay.events.filter(e => e.type === 'input').sort((a, b) => a.seq - b.seq);
  const decisions = replay.events.filter(e => e.type === 'decision');
  const frames = new Map(replay.frames.map(f => [f.tick, f.views[0]]));
  const lastTick = replay.frames.at(-1).tick;
  const byTick = new Map();
  for (const input of inputs) {
    check(input.appliedTick === input.tick + 1, 'INPUT_TIMING_MISMATCH');
    if (input.release) check(input.input.buttons.length === 0 && input.requestId === undefined, 'INVALID_RELEASE');
    else {
      const origins = decisions.filter(e => e.requestId === input.requestId && e.outcome === 'applied' && e.decisionStage !== 'target');
      check(origins.length === 1 && input.appliedTick <= lastTick, 'ORPHAN_INPUT');
    }
    byTick.set(input.appliedTick, [...(byTick.get(input.appliedTick) ?? []), input]);
  }
  let checkedFrames = 0;
  const signature = view => JSON.stringify([view.tick, view.status, view.cells, view.active?.type, view.active?.rotation, view.active?.cells, view.next, view.hold, view.pieceId, view.score, view.reason ?? null]);
  for (let tick = 0; tick <= lastTick; tick++) {
    if (tick > 0) {
      for (const event of byTick.get(tick) ?? []) if (state.status === 'playing') state = event.release ? adapter.release(state) : adapter.input(state, event.input);
      if (state.status === 'playing') state = adapter.step(state, 1);
    }
    if (frames.has(tick)) { check(signature(adapter.view(state)) === signature(frames.get(tick)), 'REPLAY_FRAME_MISMATCH'); checkedFrames++; }
  }
  check(JSON.stringify(state.score) === JSON.stringify(replay.result.scores[0]), 'REPLAY_SCORE_MISMATCH');
  for (const event of decisions) {
    const linked = inputs.filter(e => e.requestId === event.requestId && !e.release);
    if (event.decisionStage === 'target' || event.outcome !== 'applied') check(linked.length === 0, 'TARGET_OR_DROPPED_EXECUTED');
    else {
      check(linked.length === 1 && linked[0].appliedTick === event.appliedTick, 'ACTION_INPUT_MISMATCH');
      const id = `${linked[0].input.buttons.join('+') || 'noop'}:${linked[0].input.durationMs}`;
      check(id === event.actionId, 'ACTION_CHANGED');
    }
  }
  return { checkedFrames, scoreAgreement: true, inputActionAgreement: true, targetNeverExecutesInput: true };
}
export function report(plan, ledger) {
  const entries = plan.schedule.map(e => {
    const row = ledger.entries[e.id];
    return { ...e, ...row, latencyMs: distribution(row.decisions.map(d => d.elapsedMs)), observedToReturnedTicks: distribution(row.decisions.map(d => d.returnedTick - d.observedTick)),
      stageCalls: Object.fromEntries(['target', 'key'].map(s => [s, row.decisions.filter(d => d.stage === s).length])),
      outcomes: Object.fromEntries(['applied', 'dropped', 'failed', 'unknown'].map(s => [s, row.decisions.filter(d => d.outcome === s).length])),
      actualModels: [...new Set(row.decisions.map(d => d.actualModel).filter(Boolean))] };
  });
  const pairs = entries.filter(e => e.variant === 'A').map(a => {
    const v = entries.find(e => e.seed === a.seed && e.partition === a.partition && e.variant === 'V8');
    const valid = a.phase === 'complete' && v?.phase === 'complete';
    return { seed: a.seed, partition: a.partition, valid, linesDelta: valid ? v.score.lines - a.score.lines : null, pointsDelta: valid ? v.score.points - a.score.points : null,
      nativeComparison: valid ? Math.sign(v.score.lines - a.score.lines || v.score.points - a.score.points || v.score.survivedTicks - a.score.survivedTicks) : null };
  });
  return { schema: 'arena-tetris-v8-evidence-v1', planHash: ledger.planHash, phase: plan.phase, profiles: plan.profiles, sources: plan.sources,
    halted: ledger.halted, budgetCeiling: plan.globalMaxRequests, dispatched: entries.reduce((n, e) => n + e.calls, 0), entries, pairs };
}
export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv, options = {};
  for (let i = 0; i < rest.length; i++) { check(rest[i].startsWith('--'), 'INVALID_ARGUMENT'); const key = rest[i].slice(2); options[key] = key === 'confirm-live' ? true : rest[++i]; }
  const origin = localOrigin(options.origin ?? 'http://127.0.0.1:5091');
  if (command === 'inspect') { emit(safeModels((await (await authenticatedApi(origin, options['auth-file'] ?? 'artifacts/local-fixture.json'))('/models')).items)); return; }
  check(options.plan, 'PLAN_PATH_REQUIRED');
  if (command === 'plan') {
    const api = await authenticatedApi(origin, options['auth-file'] ?? 'artifacts/local-fixture.json');
    const profile = safeModels((await api('/models')).items).find(p => p.profileId === options.profile);
    check(profile?.available && ['systemone', 'custom-systemone', 'bamboonode-systemone'].includes(profile.provider), 'EXPLICIT_SYSTEMONE_PROFILE_REQUIRED');
    const entries = schedule(options.phase);
    const plan = { schema: 'arena-tetris-v8-plan-v1', id: randomUUID(), origin, phase: options.phase, profiles: [profile], sources: await sources(), schedule: entries, globalMaxRequests: entries.length * 300, createdAt: new Date().toISOString() };
    await atomicJson(options.plan, plan, { exclusive: true }); emit({ type: 'frozen-plan', id: plan.id, phase: plan.phase, runs: entries.length, maxCalls: plan.globalMaxRequests, sources: plan.sources.sha256 }); return;
  }
  const plan = await read(options.plan), ledgerFile = options.plan.replace(/\.json$/, '') + '.ledger.json', reportFile = options.plan.replace(/\.json$/, '') + '.report.json';
  check(plan.schema === 'arena-tetris-v8-plan-v1' && JSON.stringify(plan.schedule) === JSON.stringify(schedule(plan.phase)) && plan.globalMaxRequests === plan.schedule.length * 300, 'INVALID_PLAN');
  if (command === 'report') { const result = report(plan, await read(ledgerFile)); await atomicJson(reportFile, result); emit({ type: 'report', path: reportFile, pairs: result.pairs }); return; }
  check(command === 'run' && options['confirm-live'], 'CONFIRM_LIVE_REQUIRED');
  const lock = ledgerFile + '.lock'; await atomicJson(lock, { pid: process.pid }, { exclusive: true });
  const abort = new AbortController(); const stop = () => abort.abort(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let ledger;
  try {
    try { ledger = await read(ledgerFile); } catch (e) { if (e.code !== 'ENOENT') throw e; ledger = { planHash: digest(plan), halted: false, entries: Object.fromEntries(plan.schedule.map(e => [e.id, { phase: 'pending', calls: 0, reserved: 0, cursor: 0, decisions: [] }])) }; await atomicJson(ledgerFile, ledger, { exclusive: true }); }
    check(ledger.planHash === digest(plan) && !ledger.halted && Object.values(ledger.entries).every(r => ['pending', 'complete'].includes(r.phase)), 'LEDGER_REQUIRES_MANUAL_REVIEW');
    const api = await authenticatedApi(plan.origin, options['auth-file'] ?? 'artifacts/local-fixture.json');
    const { tsImport } = await import('tsx/esm/api'); const { tetris } = await tsImport('../packages/games/src/arcade/tetris.ts', import.meta.url);
    const save = () => atomicJson(ledgerFile, ledger);
    for (const entry of plan.schedule) {
      const row = ledger.entries[entry.id]; if (row.phase === 'complete') continue;
      check(!abort.signal.aborted, 'INTERRUPTED');
      check((await sources()).sha256 === plan.sources.sha256, 'SOURCE_CHANGED');
      verifyProfiles(plan, safeModels((await api('/models')).items));
      check(Object.values(ledger.entries).reduce((n, r) => n + (r.reserved || r.calls), 0) + 300 <= plan.globalMaxRequests, 'BUDGET_EXHAUSTED');
      try {
        row.phase = 'creating'; await save();
        let snapshot = await api('/arcade-sessions', { gameId: 'tetris', mode: 'ai-solo', seed: entry.seed, config: { tetrisHarnessVersion: entry.version }, controllers: [{ kind: 'ai', profileId: plan.profiles[0].profileId }] });
        row.sessionId = snapshot.id; verify(plan, entry, snapshot); check(snapshot.status === 'ready', 'NOT_READY');
        row.phase = 'starting'; row.startOperationId = randomUUID(); row.reserved = 300; row.startedAt = new Date().toISOString(); await save();
        snapshot = await api(`/arcade-sessions/${row.sessionId}/commands`, { type: 'start', operationId: row.startOperationId });
        const deadline = Date.now() + 260000;
        while (true) {
          verify(plan, entry, snapshot); collect(row, snapshot); row.phase = 'running'; await save();
          check(!abort.signal.aborted, 'INTERRUPTED');
          check(!['paused', 'error'].includes(snapshot.status) && !snapshot.needsRetry && !row.aborted, 'SESSION_INTERRUPTED');
          check(!row.decisions.some(d => ['failed', 'unknown'].includes(d.outcome)), 'CALL_FAILED_OR_UNKNOWN');
          check(!row.decisions.some(d => d.thoughtUsed === true), 'THINKING_ENABLED');
          for (const decision of row.decisions) if (decision.actualModel) {
            if (ledger.actualModel) check(ledger.actualModel === decision.actualModel, 'ACTUAL_MODEL_CHANGED');
            else ledger.actualModel = decision.actualModel;
          }
          const more = (snapshot.events?.length ?? 0) >= 100;
          if (snapshot.status === 'finished' && !row.inflight && !more) {
            check(row.calls === row.decisions.length, 'MISSING_RECEIPTS');
            row.replayCheck = verifyReplay(await api(`/arcade-sessions/${row.sessionId}/replay`), tetris);
            check((await sources()).sha256 === plan.sources.sha256, 'SOURCE_CHANGED');
            row.phase = 'complete'; row.reserved = 0; await save(); emit({ type: 'complete', entry: entry.id, session: row.sessionId, calls: row.calls, score: row.score, reason: row.reason }); break;
          }
          check(Date.now() < deadline, 'OBSERVATION_TIMEOUT'); if (!more) await sleep(500);
          snapshot = await api(`/arcade-sessions/${row.sessionId}?since=${row.cursor}`);
        }
      } catch (error) {
        row.phase = 'halted'; row.failure = error instanceof ExperimentError ? error.code : 'UNKNOWN_LOCAL_FAILURE'; ledger.halted = true; await save();
        // Stop scheduling, never retry inference. An unknown start retains its reservation.
        if (row.sessionId && !['finished', 'paused', 'error'].includes(row.status)) {
          row.pauseOperationId = randomUUID(); await save();
          try { const snapshot = await api(`/arcade-sessions/${row.sessionId}/commands`, { type: 'pause', operationId: row.pauseOperationId }); collect(row, snapshot); row.pauseConfirmed = snapshot.status !== 'running'; } catch { row.pauseConfirmed = false; }
          await save();
        }
        throw error;
      }
    }
    const result = report(plan, ledger); await atomicJson(reportFile, result); emit({ type: 'batch-complete', report: reportFile, pairs: result.pairs, calls: result.dispatched });
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); await fs.unlink(lock); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch(error => { emit({ type: 'experiment-stopped', code: error instanceof ExperimentError ? error.code : 'LOCAL_DRIVER_ERROR', secretsOmitted: true }); process.exitCode = 1; });
