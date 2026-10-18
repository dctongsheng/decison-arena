#!/usr/bin/env node
// Post-completion, read-only evidence analysis. Never dispatches model calls or
// writes a replay, request, image, thought, credential, endpoint, or auth cookie.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { atomicJson, authenticatedApi, localOrigin, ExperimentError } from './snake-harness-experiment-lib.mjs';
import { distribution, schedule, safeDecision, verifyReplay, VERSIONS } from './tetris-v8-experiment.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = (ok, code) => { if (!ok) throw new ExperimentError(code); };
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const integer = (n, lo = 0, hi = 7200) => Number.isSafeInteger(n) && n >= lo && n <= hi;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) && !/^(sk[-_]|bag_|bearer)/i.test(value);
const score = value => ({ lines: value.lines, points: value.points, survivedTicks: value.survivedTicks });
const delta = (a, b) => ({ lines: b.lines - a.lines, points: b.points - a.points, survivedTicks: b.survivedTicks - a.survivedTicks });
const reason = value => ['TOP_OUT', 'SPAWN_BLOCKED', 'TIME_LIMIT'].includes(value) ? value : null;
const counts = (rows, field, values) => Object.fromEntries(values.map(v => [v, rows.filter(r => r[field] === v).length]));
const poseChanged = (a, b) => !same([a.pieceId, a.active], [b.pieceId, b.active]);

function stateFacts(state, adapter) {
  const o = adapter.observe(state);
  const active = o.active ? { type: o.active.type, rotation: o.active.rotation, x: o.active.x, y: o.active.y,
    leftmostColumn: Math.min(...o.active.cells.map(p => p.x)), cells: o.active.cells.map(p => ({ x: p.x, y: p.y })) } : null;
  return { tick: o.tick, status: o.status, reason: reason(state.reason), pieceId: o.pieceId, active,
    score: score(o.score), grounded: o.grounded, fallTicks: o.fallTicks, lockTicks: o.lockTicks,
    horizontalDirection: o.horizontalDirection, horizontalHeldTicks: o.horizontalHeldTicks,
    // Internal fingerprint only. It is removed before a state reaches output.
    boardKey: o.board.rows.map(r => r.cells).join('') };
}
function publicFacts(facts) { if (!facts) return null; const { boardKey: _boardKey, ...safe } = facts; return safe; }
function readGoal(value) {
  if (value == null) return null;
  check(integer(value.pieceId, 1, 20000) && integer(value.leftmostColumn, 0, 9) && integer(value.rotation, 0, 3), 'INVALID_RECORDED_GOAL');
  return { pieceId: value.pieceId, leftmostColumn: value.leftmostColumn, rotation: value.rotation };
}

/** Native replay reconstruction is verified first. Extra analysis never chooses inputs. */
export function auditReplay(replay, adapter) {
  check(replay?.version === 2 && replay.mode === 'ai-solo' && replay.result?.aborted === false, 'UNFINISHED_OR_ABORTED_REPLAY');
  check(Array.isArray(replay.frames) && replay.frames.length > 0 && replay.frames.length <= 2000 &&
    Array.isArray(replay.events) && replay.events.length <= 2000, 'INVALID_REPLAY_BOUNDS');
  const lastTick = replay.frames.at(-1).tick;
  check(integer(lastTick) && replay.frames.every(f => integer(f.tick, 0, lastTick)), 'INVALID_REPLAY_TICK');
  const verified = verifyReplay(replay, adapter);
  const decisions = replay.events.filter(e => e.type === 'decision').sort((a, b) => a.seq - b.seq);
  check(decisions.length <= 300, 'INVALID_DECISION_COUNT');
  const inputs = replay.events.filter(e => e.type === 'input').sort((a, b) => a.seq - b.seq);
  const byTick = new Map();
  for (const event of inputs) byTick.set(event.appliedTick, [...(byTick.get(event.appliedTick) ?? []), event]);
  let state = adapter.create(replay.config, replay.seed);
  const timeline = [stateFacts(state, adapter)], transitions = [], inputFacts = new Map();
  for (let tick = 1; tick <= lastTick; tick++) {
    for (const event of byTick.get(tick) ?? []) if (state.status === 'playing') {
      const beforeHeld = [...state.held], beforeEdges = [...state.pendingEdges];
      state = event.release ? adapter.release(state) : adapter.input(state, event.input);
      inputFacts.set(event.seq, { buttons: [...event.input.buttons], durationMs: event.input.durationMs ?? null,
        previouslyHeld: beforeHeld, newlyQueuedEdges: state.pendingEdges.filter(b => !beforeEdges.includes(b)), release: event.release === true });
    }
    if (state.status === 'playing') state = adapter.step(state, 1);
    const before = timeline.at(-1), after = stateFacts(state, adapter);
    timeline.push(after);
    if (before.boardKey !== after.boardKey || before.pieceId !== after.pieceId || before.status !== after.status) {
      transitions.push({ tick, before, after, scoreDelta: delta(before.score, after.score),
        lockedBoardChanged: before.boardKey !== after.boardKey, pieceChanged: before.pieceId !== after.pieceId });
    }
  }
  check(timeline.at(-1).status === 'finished', 'NATIVE_GAME_NOT_FINISHED');
  const goals = decisions.filter(e => e.decisionStage === 'target' && e.outcome === 'applied').map(event => {
    check(Object.hasOwn(event, 'tetrisGoal'), 'MISSING_RECORDED_GOAL');
    const tick = event.settledTick ?? event.tick;
    check(integer(tick, 0, lastTick), 'INVALID_GOAL_TICK');
    return { seq: event.seq, tick, goal: readGoal(event.tetrisGoal), scope: timeline[tick] };
  });
  const goalAt = (tick, seqLimit) => {
    const entry = goals.filter(g => g.tick <= tick && g.seq < seqLimit).at(-1), s = timeline[tick];
    return entry && entry.scope.pieceId === s.pieceId && entry.scope.active?.type === s.active?.type &&
      entry.scope.boardKey === s.boardKey ? entry.goal : null;
  };
  const details = decisions.map(event => {
    const d = safeDecision(event);
    check(integer(d.observedTick, 0, lastTick) && integer(d.returnedTick, d.observedTick, lastTick) &&
      (d.appliedTick === null || integer(d.appliedTick, 1, lastTick)), 'INVALID_DECISION_TIMING');
    const observed = timeline[d.observedTick], returned = timeline[d.returnedTick];
    const linked = inputs.find(i => !i.release && i.requestId === event.requestId);
    const applied = d.appliedTick === null ? null : timeline[d.appliedTick];
    const beforeApplied = d.appliedTick === null ? null : timeline[d.appliedTick - 1];
    let firstChange = null;
    if (d.appliedTick !== null) for (let tick = d.appliedTick; tick <= lastTick; tick++) {
      if (poseChanged(timeline[tick - 1], timeline[tick])) { firstChange = { tick, before: publicFacts(timeline[tick - 1]), after: publicFacts(timeline[tick]) }; break; }
    }
    const staleness = [];
    if (returned.status === 'finished') staleness.push('native_game_finished_by_settlement');
    if (observed.pieceId !== returned.pieceId) staleness.push('piece_id_changed_during_observation_window');
    if (observed.active?.type !== returned.active?.type) staleness.push('active_type_changed_during_observation_window');
    if (observed.boardKey !== returned.boardKey) staleness.push('locked_board_changed_during_observation_window');
    if (d.outcome !== 'applied' && !staleness.length) staleness.push('not_identifiable_from_public_replay');
    return { seq: d.seq, stage: d.stage, actionId: d.actionId, outcome: d.outcome, observedTick: d.observedTick,
      returnedTick: d.returnedTick, returnedTickSource: event.settledTick === undefined ? 'event.tick' : 'event.settledTick', appliedTick: d.appliedTick,
      elapsedMs: d.elapsedMs, thoughtUsed: d.thoughtUsed, observed: publicFacts(observed), settled: publicFacts(returned),
      targetAtObservation: goalAt(d.observedTick, event.seq), targetAfterSettlement: goalAt(d.returnedTick, event.seq + 1),
      observationWindowScoreDelta: delta(observed.score, returned.score),
      observationWindowPieceChanges: transitions.filter(t => t.tick > d.observedTick && t.tick <= d.returnedTick && t.pieceChanged).length,
      input: linked ? inputFacts.get(linked.seq) ?? null : null,
      applicationFrame: applied ? { before: publicFacts(beforeApplied), after: publicFacts(applied), scoreDelta: delta(beforeApplied.score, applied.score) } : null,
      firstActualPoseChangeAtOrAfterApplication: firstChange,
      nonAppliedFacts: d.outcome === 'applied' ? [] : staleness };
  });
  const window = (kind, rows, trigger = null) => ({ kind, ...(trigger ? { trigger } : {}), decisions: rows });
  const windows = [window('last_six_decisions_in_sequence', details.slice(-6))];
  const clears = transitions.filter(t => t.scoreDelta.lines > 0);
  for (const clear of clears.slice(0, 2)) {
    // Previous two settlements and the next one, chosen by chronology, not score.
    const index = details.findIndex(d => d.returnedTick >= clear.tick);
    const end = index === -1 ? details.length : index + 1;
    windows.push(window('first_two_line_clear_windows', details.slice(Math.max(0, end - 3), end), {
      tick: clear.tick, scoreDelta: clear.scoreDelta, before: publicFacts(clear.before), after: publicFacts(clear.after),
      inputAppliedAtThisTick: details.filter(d => d.appliedTick === clear.tick).map(d => d.seq),
    }));
  }
  for (const event of details.filter(d => d.outcome !== 'applied').slice(0, 2)) {
    const index = details.indexOf(event);
    windows.push(window('first_two_non_applied_windows', details.slice(Math.max(0, index - 1), index + 1)));
  }
  return { verification: verified, score: score(timeline.at(-1).score), reason: timeline.at(-1).reason, lastTick,
    metrics: { decisions: details.length, stageCalls: counts(details, 'stage', ['target', 'key']),
      outcomes: counts(details, 'outcome', ['applied', 'dropped', 'failed', 'unknown']),
      latencyMs: distribution(details.map(d => d.elapsedMs)), observedToSettledTicks: distribution(details.map(d => d.returnedTick - d.observedTick)),
      thoughtUsedTrue: details.filter(d => d.thoughtUsed === true).length, lineClearFrames: clears.length,
      lockedBoardChangeFrames: transitions.filter(t => t.lockedBoardChanged).length,
      nonAppliedFactCounts: Object.fromEntries([...new Set(details.flatMap(d => d.nonAppliedFacts))].map(f => [f, details.filter(d => d.nonAppliedFacts.includes(f)).length])) },
    windows };
}

export function validateCompletedInputs(plan, report) {
  check(plan?.schema === 'arena-tetris-v8-plan-v1' && report?.schema === 'arena-tetris-v8-evidence-v1', 'INVALID_INPUT_SCHEMA');
  check(same(plan.schedule, schedule(plan.phase)) && report.phase === plan.phase && report.planHash === hash(plan), 'PLAN_REPORT_MISMATCH');
  check(report.halted === false && Array.isArray(report.entries) && report.entries.length === plan.schedule.length, 'EXPERIMENT_NOT_COMPLETE');
  const seen = new Set();
  return plan.schedule.map(entry => {
    const matches = report.entries.filter(row => row.id === entry.id);
    check(matches.length === 1, 'DUPLICATE_OR_MISSING_ENTRY');
    const row = matches[0];
    check(row.phase === 'complete' && row.status === 'finished' && row.aborted === false && row.inflight === false &&
      row.seed === entry.seed && row.variant === entry.variant && row.partition === entry.partition && row.version === entry.version &&
      id(row.sessionId) && !seen.has(row.sessionId) && integer(row.calls, 0, 300) && row.calls === row.decisions?.length, 'ENTRY_NOT_COMPLETE');
    seen.add(row.sessionId);
    return { id: entry.id, sessionId: row.sessionId, seed: entry.seed, variant: entry.variant, partition: entry.partition,
      version: entry.version, calls: row.calls, expectedScore: score(row.score) };
  });
}

async function artifactPath(value, existing) {
  check(typeof value === 'string', 'ARTIFACT_PATH_REQUIRED');
  const base = await fs.realpath(path.join(ROOT, 'artifacts')), resolved = path.resolve(ROOT, value);
  check(resolved.startsWith(base + path.sep) && resolved.endsWith('.json'), 'PATH_OUTSIDE_ARTIFACTS');
  const actual = existing ? await fs.realpath(resolved) : path.join(await fs.realpath(path.dirname(resolved)), path.basename(resolved));
  check(actual.startsWith(base + path.sep), 'PATH_OUTSIDE_ARTIFACTS');
  return actual;
}
async function readJson(filename) {
  check((await fs.stat(filename)).size <= 32 * 1024 * 1024, 'INPUT_FILE_TOO_LARGE');
  return JSON.parse(await fs.readFile(filename, 'utf8'));
}
async function verifyNativeSources(plan) {
  const names = ['packages/core/src/index.ts', 'packages/core/src/arcade.ts', 'packages/games/src/arcade/tetris.ts', 'packages/games/src/arcade/common.ts',
    'scripts/tetris-v8-experiment.mjs', 'scripts/snake-harness-experiment-lib.mjs'];
  for (const name of names) {
    const expected = plan.sources?.files?.find(f => f.path === name);
    check(expected && hash(await fs.readFile(path.join(ROOT, name))) === expected.sha256, 'FROZEN_NATIVE_SOURCE_CHANGED');
  }
}

export async function selfTest() {
  const assert = (await import('node:assert/strict')).default;
  const { tsImport } = await import('tsx/esm/api');
  const { tetris } = await tsImport('../packages/games/src/arcade/tetris.ts', import.meta.url);
  const seed = 'audit-synthetic-only', config = { tetrisHarnessVersion: VERSIONS.V8 };
  const fixture = adapter => {
  let state = adapter.create(config, seed), seq = 0;
  const frames = [{ tick: 0, views: [adapter.view(state)] }], events = [];
  events.push({ seq: ++seq, type: 'decision', runId: 'run0', requestId: 'goal', decisionStage: 'target',
    actionId: 'target:3:0', tetrisGoal: { pieceId: state.pieceId, leftmostColumn: 3, rotation: 0 },
    outcome: 'applied', observedTick: 0, tick: 0, settledTick: 0, reasoning: { text: 'PRIVATE_SENTINEL' } });
  // Short deterministic hard-drop stack. Enough to finish without a network or long simulation.
  while (state.status === 'playing') {
    const tick = state.tick, input = { buttons: ['hard-drop'], durationMs: 100 }, requestId = `key${tick}`;
    events.push({ seq: ++seq, type: 'decision', runId: 'run0', requestId, decisionStage: 'key',
      actionId: 'hard-drop:100', outcome: 'applied', observedTick: tick, tick, settledTick: tick, appliedTick: tick + 1 });
    events.push({ seq: ++seq, type: 'input', runId: 'run0', requestId, tick, appliedTick: tick + 1, input });
    state = adapter.step(adapter.input(state, input), 7);
    frames.push({ tick: state.tick, views: [adapter.view(state)] });
    assert.ok(state.tick < 200);
  }
  events.push({ seq: ++seq, type: 'decision', runId: 'run0', requestId: 'late', decisionStage: 'key',
    actionId: 'left:100', outcome: 'dropped', observedTick: 0, tick: state.tick, settledTick: state.tick });
  return { version: 2, mode: 'ai-solo', gameId: 'tetris', config, seed, rulesVersion: adapter.rulesVersion,
    runIds: ['run0'], frames, events, result: { aborted: false, scores: [state.score] }, rawRequest: 'PRIVATE_SENTINEL', credentials: 'PRIVATE_SENTINEL' };
  };
  const replay = fixture(tetris);
  const audit = auditReplay(replay, tetris);
  assert.equal(audit.verification.targetNeverExecutesInput, true);
  assert.equal(audit.metrics.stageCalls.target, 1);
  assert.equal(audit.metrics.outcomes.dropped, 1);
  assert.ok(audit.metrics.nonAppliedFactCounts.native_game_finished_by_settlement);
  assert.equal(audit.score.lines, 0);
  assert.ok(!JSON.stringify(audit).includes('PRIVATE_SENTINEL'));
  assert.ok(!JSON.stringify(audit).includes('boardKey'));
  assert.ok(audit.windows.flatMap(w => w.decisions).some(d => d.applicationFrame?.after.pieceId !== d.applicationFrame?.before.pieceId));
  const tampered = structuredClone(replay); tampered.result.scores[0].points++;
  assert.throws(() => auditReplay(tampered, tetris), /REPLAY_SCORE_MISMATCH/);
  // Separate synthetic board, never used by production or the live audit path.
  const clearingFixture = { ...tetris, create(c, s) {
    const state = tetris.create(c, s); state.active = { type: 'I', rotation: 0, x: 0, y: -2 };
    for (let x = 4; x < 10; x++) state.board[21 * 10 + x] = 2;
    return state;
  } };
  const clearAudit = auditReplay(fixture(clearingFixture), clearingFixture);
  assert.ok(clearAudit.metrics.lineClearFrames >= 1);
  const clearWindow = clearAudit.windows.find(w => w.kind === 'first_two_line_clear_windows');
  assert.equal(clearWindow.trigger.scoreDelta.lines, 1);
  assert.equal(clearWindow.trigger.scoreDelta.points, 100);
  assert.equal(clearWindow.trigger.tick, 1);
  assert.deepEqual(clearWindow.trigger.inputAppliedAtThisTick, [2]);
  const plan = { schema: 'arena-tetris-v8-plan-v1', phase: 'pilot', schedule: schedule('pilot') };
  const report = { schema: 'arena-tetris-v8-evidence-v1', phase: 'pilot', planHash: hash(plan), halted: false,
    entries: plan.schedule.map((e, i) => ({ ...e, phase: 'complete', status: 'finished', aborted: false, inflight: false,
      sessionId: `synthetic${i}`, calls: 0, decisions: [], score: { lines: 0, points: 0, survivedTicks: 1 } })) };
  assert.equal(validateCompletedInputs(plan, report).length, 2);
  report.entries[0].phase = 'running';
  assert.throws(() => validateCompletedInputs(plan, report), /ENTRY_NOT_COMPLETE/);
  return { type: 'synthetic-self-test-passed', realRequests: 0, nativeTicks: audit.lastTick + clearAudit.lastTick };
}

export async function main(argv = process.argv.slice(2)) {
  if (same(argv, ['--self-test'])) { console.log(JSON.stringify(await selfTest())); return; }
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    check(['--plan', '--report', '--auth-file', '--output'].includes(argv[i]) && typeof argv[i + 1] === 'string' && !Object.hasOwn(options, argv[i]), 'INVALID_ARGUMENT');
    options[argv[i]] = argv[i + 1];
  }
  check(options['--auth-file'], 'EXPLICIT_AUTH_FILE_REQUIRED');
  const planFile = await artifactPath(options['--plan'], true), reportFile = await artifactPath(options['--report'], true);
  const outputFile = await artifactPath(options['--output'], false);
  check(outputFile !== planFile && outputFile !== reportFile && outputFile !== path.resolve(ROOT, options['--auth-file']), 'OUTPUT_OVERWRITES_INPUT');
  const plan = await readJson(planFile), report = await readJson(reportFile);
  const entries = validateCompletedInputs(plan, report);
  await verifyNativeSources(plan);
  const origin = localOrigin(plan.origin);
  // Only after every entry is complete do we open the explicitly supplied auth file.
  const api = await authenticatedApi(origin, path.resolve(ROOT, options['--auth-file']));
  const { tsImport } = await import('tsx/esm/api');
  const { tetris } = await tsImport('../packages/games/src/arcade/tetris.ts', import.meta.url);
  const results = [];
  for (const entry of entries) {
    const replay = await api(`/arcade-sessions/${entry.sessionId}/replay`); // GET only; no retry.
    check(replay.matchId === entry.sessionId && replay.seed === entry.seed && replay.config?.tetrisHarnessVersion === entry.version, 'REPLAY_ENTRY_MISMATCH');
    const result = auditReplay(replay, tetris);
    check(result.metrics.decisions === entry.calls && same(result.score, entry.expectedScore), 'REPORT_REPLAY_MISMATCH');
    const { expectedScore: _expected, ...safe } = entry;
    results.push({ ...safe, ...result });
  }
  await verifyNativeSources(plan);
  const output = { schema: 'arena-tetris-v8-readonly-audit-v1', auditSourceSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))),
    planHash: hash(plan), reportSha256: hash(await fs.readFile(reportFile)), phase: plan.phase,
    methodology: { source: 'Own completed authenticated replay; native recorded-input reconstruction checked against stored frames and final score.',
      returnedTick: 'Runner settlement tick (settledTick, falling back to event.tick), NOT an independently measured HTTP arrival tick.',
      applicationFrame: 'State before/after one native physics tick with all inputs accepted for that tick; not isolated causal attribution.',
      firstActualPoseChange: 'First actual pose/piece change at or after application, possibly gravity or another later input; no claim the chosen key caused it.',
      target: 'Recorded successful target decisions, retained only while piece/type/locked-board scope matches. Null includes baseline or cleared/expired target.',
      nonAppliedFacts: 'Observable differences by settlement only. Multiple facts may co-occur; unknown generation, permissions or transport details are not guessed.',
      windows: 'Per game: last six decisions; first two line-clear frames with three chronological nearby decisions; first two non-applied decisions plus preceding one.',
      limitations: 'No stored requests/images/thoughts are read into the analysis. Runtime records lack a separate HTTP-arrival timestamp and counterfactual action outcomes. Post-hoc explanation only; no changes to formal scores or sample partitions.' }, entries: results };
  await atomicJson(outputFile, output, { exclusive: true });
  console.log(JSON.stringify({ type: 'readonly-audit-complete', sessions: results.length, requests: results.length, modelRequests: 0, output: path.relative(ROOT, outputFile) }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch(error => { console.error(JSON.stringify({ type: 'audit-stopped', code: error instanceof ExperimentError ? error.code : 'LOCAL_AUDIT_ERROR', secretsOmitted: true })); process.exitCode = 1; });
