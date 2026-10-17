import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { snake, type SnakeState } from '../packages/games/src/arcade/snake';

// stdin contains only the Python reader's game-field whitelist. Never log it.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const eq = isDeepStrictEqual;
const vector: Record<string, [number, number]> = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] };
const allowedActions = new Set(Object.keys(vector).map(direction => `${direction}:100`));
const allowedOutcomes = new Set(['applied', 'dropped', 'failed', 'unknown']);
const point = (state: SnakeState) => ({ ...state.body[0] });
const position = (p: { x: number; y: number } | null) => p ? `(${p.x},${p.y})` : '—';
const movementInterval = 20;

function nextCellCollision(state: SnakeState, action: string | null) {
  const direction = action?.split(':')[0], v = direction && vector[direction];
  if (!v) return null;
  const head = { x: state.body[0].x + v[0], y: state.body[0].y + v[1] };
  if (head.x < 0 || head.x > 19 || head.y < 0 || head.y > 19) return 'wall';
  const eating = state.food && eq(state.food, head);
  return state.body.slice(0, eating ? undefined : -1).some(p => eq(p, head)) ? 'self' : null;
}

function gameState(state: any) {
  // Compare all engine fields without accepting extra arbitrary saved properties.
  return { gameId: state.gameId, tick: state.tick, status: state.status, score: state.score, held: state.held,
    releaseTick: state.releaseTick, body: state.body, direction: state.direction, queued: state.queued,
    food: state.food, rng: state.rng, reason: state.reason ?? null };
}

function audit(session: any, tail: number) {
  const { meta, events, frames } = session;
  if (meta.rules !== snake.rulesVersion || !Number.isInteger(meta.tick) || meta.tick < 0 || meta.tick > 7200) throw new Error('Unsupported rules or clock');
  const frameMap = new Map<number, any>(frames.map((frame: any) => [frame.tick, frame]));
  const wallClockUsable = events.filter((event: any) => event.type === 'status').length === 1 && events.some((event: any) => event.phase === 'start');
  const result: any[] = [];
  for (let runIndex = 0; runIndex < meta.runs.length; runIndex++) {
    const run = meta.runs[runIndex];
    if (!run.calls) continue;
    const runEvents = events.filter((event: any) => event.runId === run.id);
    const inputs = runEvents.filter((event: any) => event.type === 'input');
    const inputsAt = new Map<number, any[]>();
    for (const input of inputs) inputsAt.set(input.tick, [...(inputsAt.get(input.tick) ?? []), input]);
    const endedAt = new Set<number>(events.filter((event: any) => event.type === 'ended').map((event: any) => event.tick));
    let state = snake.create(session.config, session.seed) as SnakeState;
    const snapshots: SnakeState[] = [], mismatchedFrameTicks: number[] = [];
    let checkedFrames = 0;
    for (let tick = 0; tick <= meta.tick; tick++) {
      if (tick) state = snake.step(state, 1) as SnakeState;
      const frame = frameMap.get(tick)?.views[runIndex];
      if (frame) {
        checkedFrames++;
        if (!eq(state.body, frame.snake) || !eq(state.food, frame.food) || !eq(state.score, frame.score) ||
            state.status !== frame.status || state.tick !== frame.tick || state.reason !== frame.reason) mismatchedFrameTicks.push(tick);
      }
      // Runner applies input at the event tick; its advertised appliedTick is the next physical frame.
      for (const input of inputsAt.get(tick) ?? []) state = (input.release ? snake.release(state) : snake.input(state, input.input)) as SnakeState;
      if (endedAt.has(tick)) state = snake.release(state) as SnakeState;
      snapshots[tick] = structuredClone(state);
    }
    const decisions = runEvents.filter((event: any) => event.type === 'decision');
    const trace = decisions.map((event: any, index: number) => {
      const observed = snapshots[event.observedTick], settled = snapshots[event.tick];
      if (!observed || !settled) throw new Error('Observation outside saved clock');
      const input = inputs.find((candidate: any) => candidate.requestId && candidate.requestId === event.requestId);
      const action = allowedActions.has(event.actionId) ? event.actionId : null;
      const outcome = allowedOutcomes.has(event.outcome) ? event.outcome : 'unknown';
      const firstMovementTick = input ? (Math.floor(input.tick / movementInterval) + 1) * movementInterval : null;
      const movement = firstMovementTick !== null ? snapshots[firstMovementTick] : null;
      const previous = decisions.slice(0, index).reverse().find((candidate: any) => candidate.outcome === 'applied');
      let successfulMoves = 0, movementAttempts = 0;
      for (let tick = event.observedTick + 1; tick <= event.tick; tick++) {
        if (tick % movementInterval === 0 && snapshots[tick - 1].status === 'playing') movementAttempts++;
        if (!eq(snapshots[tick - 1].body[0], snapshots[tick].body[0])) successfulMoves++;
      }
      const mappingOkay = outcome !== 'applied' || !!input &&
        action === `${input.input.buttons.join('+')}:${input.input.durationMs}` && event.appliedTick === input.appliedTick && input.appliedTick === input.tick + 1;
      const supersedingInputs = firstMovementTick === null ? 0 : inputs.filter((candidate: any) => candidate.seq > input.seq && candidate.tick < firstMovementTick).length;
      return { index: index + 1, observedTick: event.observedTick, returnTick: event.tick,
        settleWallTick: wallClockUsable ? session.anchorTick + Math.floor((event.at - session.anchorWall) * 60 / 1000) : null,
        appliedTick: event.appliedTick ?? null, outcome, action,
        elapsedMs: typeof event.elapsedMs === 'number' && Number.isFinite(event.elapsedMs) ? event.elapsedMs : null,
        successfulMoves, movementAttempts, observedHead: point(observed), observedDirection: observed.direction,
        observedQueued: observed.queued, observedFood: observed.food && { ...observed.food },
        returnHead: point(settled), returnDirection: settled.direction, returnStatus: settled.status,
        firstMovementTick, firstMovementDirection: movement?.direction ?? null,
        firstMovementHead: movement ? point(movement) : null, firstMovementStatus: movement?.status ?? null,
        immediateObservedCollision: nextCellCollision(observed, action), immediateReturnCollision: nextCellCollision(settled, action),
        supersedingInputs, gateOkay: !previous || event.observedTick >= previous.appliedTick, mappingOkay };
    });
    const pendingDifferent = trace.filter((event: any) => event.observedQueued && event.observedQueued !== event.observedDirection);
    result.push({ sessionId: meta.sessionId, runId: run.id, provider: run.provider, model: run.model, rulesVersion: meta.rules,
      promptVersion: meta.prompt, calls: run.calls, aborted: session.aborted,
      final: { tick: state.tick, status: state.status, head: point(state), direction: state.direction, reason: state.reason ?? null, food: state.score.food },
      verification: { checkedFrames, mismatchedFrameTicks, finalStateMatches: eq(gameState(state), gameState(session.final[runIndex])),
        acceptedInputs: trace.filter((event: any) => event.outcome === 'applied').length,
        mappingMismatchIndices: trace.filter((event: any) => !event.mappingOkay).map((event: any) => event.index),
        gateViolationIndices: trace.filter((event: any) => !event.gateOkay).map((event: any) => event.index) },
      aggregate: { decisionEvents: trace.length, withAction: trace.filter((event: any) => event.action).length,
        queuedDifferent: pendingDifferent.length, repeatedQueued: pendingDifferent.filter((event: any) => event.action === `${event.observedQueued}:100`).length,
        immediateObservedRiskIndices: trace.filter((event: any) => event.immediateObservedCollision).map((event: any) => event.index),
        immediateReturnRiskIndices: trace.filter((event: any) => event.immediateReturnCollision).map((event: any) => event.index) },
      trace: trace.slice(-tail) });
  }
  return result;
}

function markdown(report: any) {
  const text = [
    '# Historical Snake trace audit (not experiment scores)', '',
    'This is a read-only reconstruction of selected pre-existing local game histories. It makes no provider requests. These unpaired historical samples are ineligible for A/B/C experiment scoring.', '',
    `Verified game frames: ${report.summary.checkedFrames}; tracks: ${report.runs.length}; accepted decision/input pairs: ${report.summary.acceptedInputs}; all checks passed: ${report.summary.passed}.`, '',
    '`returnTick` is the persisted decision settlement tick, not a separately measured HTTP arrival. It freezes after session end. `settleWallTick` converts the recorded event wall time only when the full history has one uninterrupted start; null means unavailable. `appliedTick` is the next physical frame; Snake direction takes effect on the next movement tick. Successful moves exclude a failed wall/body collision attempt.', '',
    'Only whitelisted counters, actions, versions and local positions are output. Seeds, complete states/frames, credentials, owner identities, request bodies, reasoning and authentication data are omitted.', '',
  ];
  for (const run of report.runs) {
    text.push(`## ${run.sessionId} / ${run.runId}`, '',
      `Model: ${run.model ?? 'not identified in public allowlist'}; provider: ${run.provider}; rules: ${run.rulesVersion}; prompt: ${run.promptVersion ?? 'not recorded'}.`, '',
      `Calls ${run.calls}; food ${run.final.food}; final tick ${run.final.tick}; head ${position(run.final.head)}; reason ${run.final.reason ?? 'none'}; aborted ${run.aborted}. Frames checked ${run.verification.checkedFrames}; final game-state match ${run.verification.finalStateMatches}.`, '',
      `Across all ${run.aggregate.decisionEvents} decisions: queued differed from direction ${run.aggregate.queuedDifferent} times, and was repeated ${run.aggregate.repeatedQueued} times. This is a behavioral pattern, not proof of an internal misunderstanding.`, '',
      '| # | observedTick / head / direction / queued | returnTick | wall settlement tick | appliedTick | moves / attempts | choice | next movement tick / head / status | elapsed ms |',
      '|---:|---|---:|---:|---:|---|---|---|---:|');
    for (const event of run.trace) text.push(`| ${event.index} | ${event.observedTick} / ${position(event.observedHead)} / ${event.observedDirection} / ${event.observedQueued ?? 'none'} | ${event.returnTick} | ${event.settleWallTick ?? '—'} | ${event.appliedTick ?? '—'} | ${event.successfulMoves} / ${event.movementAttempts} | ${event.action ?? 'unavailable'} | ${event.firstMovementTick ?? '—'} / ${position(event.firstMovementHead)} / ${event.firstMovementStatus ?? 'not applied'} | ${event.elapsedMs ?? '—'} |`);
    text.push('');
    const last = run.trace.at(-1);
    if (!run.aborted && run.final.reason === 'WALL_COLLISION' && last?.outcome === 'dropped' && last.observedTick < run.final.tick) {
      text.push(`Last observation to actual death: ${run.final.tick - last.observedTick} ticks (${Math.round((run.final.tick - last.observedTick) * 1000 / 60)} ms); recorded response: ${last.elapsedMs ?? 'unavailable'} ms. The last answer was not applied.`, '');
    }
    text.push(`Verification: ${JSON.stringify(run.verification)}.`, '');
  }
  text.push('## Limits', '',
    'Reconstruction is checked against stored game frames and final game state, not raw provider request logs. It cannot identify the model\'s private interpretation or separate network arrival from parsing and credential checks. A one-cell risk check is not proof that a multi-move policy was safe. Aborted, failed, unknown and no-action histories must not be scored as model losses. Old v1 histories are rejected rather than replayed using v2 speed.', '',
    'The source hashes and exact selected game IDs are in the adjacent audit.json. No result is appended to the harness experiment ledger.', '');
  return text.join('\n');
}

try {
  const args = process.argv.slice(2), outputIndex = args.indexOf('--output-dir'), tailIndex = args.indexOf('--tail');
  const output = outputIndex >= 0 ? path.resolve(args[outputIndex + 1]) : path.join(root, 'artifacts/snake-history-audit');
  const tail = tailIndex >= 0 ? Number(args[tailIndex + 1]) : 6;
  if (!Number.isInteger(tail) || tail < 1 || tail > 20) throw new Error('Invalid tail');
  const sessions = JSON.parse(fs.readFileSync(0, 'utf8'));
  const runs = sessions.flatMap((session: any) => audit(session, tail));
  const report = { kind: 'historical-snake-trace-audit', schemaVersion: 1, eligibleForExperimentScoring: false, readOnly: true,
    source: 'selected-project-local-durable-object-history', generatedAt: new Date().toISOString(),
    selectedSessionIds: sessions.map((session: any) => session.meta.sessionId), tail,
    engine: Object.fromEntries(['packages/games/src/arcade/snake.ts', 'packages/games/src/arcade/common.ts'].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])),
    summary: { checkedFrames: runs.reduce((sum: number, run: any) => sum + run.verification.checkedFrames, 0),
      acceptedInputs: runs.reduce((sum: number, run: any) => sum + run.verification.acceptedInputs, 0),
      passed: runs.length > 0 && runs.every((run: any) => run.verification.finalStateMatches && run.verification.checkedFrames > 0 &&
        !run.verification.mismatchedFrameTicks.length && !run.verification.mappingMismatchIndices.length && !run.verification.gateViolationIndices.length) }, runs };
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'audit.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'audit.md'), markdown(report));
  console.log(JSON.stringify({ kind: report.kind, eligibleForExperimentScoring: false, ...report.summary,
    tracks: runs.length, json: path.join(output, 'audit.json'), markdown: path.join(output, 'audit.md') }));
  if (!report.summary.passed) process.exitCode = 1;
} catch {
  // Never dump raw stdin, game state, frames, provider text or exception payloads.
  console.error('Historical Snake audit failed. Check the selected rules version and local game-event consistency; no raw data was logged.');
  process.exitCode = 2;
}
