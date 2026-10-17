import { describe, expect, it } from 'vitest';
import { snake } from '@decision-arena/games/arcade';
import {
  BOOTSTRAP_RESAMPLES,
  SNAKE_EXPERIMENT_VERSIONS,
  quantile,
  reportPairwise,
  summarizeSnakeReplay,
} from '../../../../scripts/lib/snake-experiment-report.mjs';

const [A, B, C] = SNAKE_EXPERIMENT_VERSIONS;
function chooseSeed(allowed: (food: { x: number; y: number }) => boolean) {
  for (let i = 0; i < 1000; i++) {
    const seed = `report-fixture-${i}`;
    if (allowed((snake.create({}, seed) as any).food)) return seed;
  }
  throw new Error('Could not construct a deterministic fixture');
}
function recording(seed: string, terminalTick: number, inputs: any[] = [], decisions: any[] = []): any {
  let state = snake.create({}, seed);
  const frames: any[] = [{ tick: 0, views: [snake.view(state)] }];
  for (let tick = 1; tick <= terminalTick; tick++) {
    for (const event of inputs.filter(input => input.appliedTick === tick))
      state = event.release ? snake.release(state) : snake.input(state, event.input);
    if (state.status === 'playing') state = snake.step(state, 1);
    if (tick % 60 === 0 || tick === terminalTick) frames.push({ tick, views: [snake.view(state)] });
  }
  const events = [...inputs, ...decisions].sort((left, right) => left.tick - right.tick).map((event, index) => ({ seq: index + 1, at: index, ...event }));
  events.push({ seq: events.length + 1, tick: terminalTick, at: terminalTick, type: 'ended' });
  return {
    version: 2, engineKind: 'arcade', gameId: 'snake', mode: 'ai-solo', matchId: 'fixture-session',
    seed, rulesVersion: snake.rulesVersion, promptVersion: 'decision-arena-arcade-v4', config: { snakeHarnessVersion: A },
    runIds: ['run-0'], controllers: [{ kind: 'ai', profile: { model: 'typesafe/jev-1.14' } }],
    result: { winner: null, reason: state.status === 'finished' ? 'runs_finished' : 'ended_by_user', scores: [state.score], aborted: state.status !== 'finished' },
    frames, events, maxTicks: 7200, createdAt: 0, finishedAt: terminalTick,
  };
}
function input(tick: number, direction: string, requestId?: string) {
  return { type: 'input', tick: tick - 1, appliedTick: tick, runId: 'run-0', requestId, input: { buttons: [direction], durationMs: 100 } };
}
const summarize = (replay: any) => summarizeSnakeReplay(replay, { adapter: snake });

describe('in-memory snake experiment projection', () => {
  it('counts successful moves, not stationary physics ticks or the fatal collision attempt', () => {
    const replay = recording(chooseSeed(food => food.y !== 10), 320);
    const original = JSON.stringify(replay);
    const summary = summarize(replay), run = summary.runs[0];
    expect(run.score).toEqual({ food: 0, points: 0, survivedTicks: 320 });
    expect(run.endReason).toBe('WALL_COLLISION');
    expect(run.successfulMoves).toBe(15);
    expect(run.longestNoScoreMoves).toBe(15);
    expect(run.repeatedFullStateVisits).toBe(0);
    expect(run.completedStateCycles).toBe(0);
    expect(run.latency).toEqual({ count: 0, medianMs: null, p95Ms: null });
    expect(run.checks).toEqual({ frameAgreement: true, frameMismatches: 0, scoreAgreement: true, inputActionAgreement: true });
    expect(JSON.stringify(replay)).toBe(original);
  });

  it('counts complete body/direction/food returns and non-overlapping cycles', () => {
    const seed = chooseSeed(food => !(food.x >= 4 && food.x <= 8 && food.y >= 10 && food.y <= 14));
    const turns = Array.from({ length: 15 }, (_, i) => input(81 + i * 80, ['down', 'left', 'up', 'right'][i % 4]));
    const run = summarize(recording(seed, 1280, turns)).runs[0];
    expect(run.successfulMoves).toBe(64);
    expect(run.longestNoScoreMoves).toBe(64);
    expect(run.repeatedFullStateVisits).toBe(47);
    expect(run.completedStateCycles).toBe(3);
    expect(run.longestCycleMoves).toBe(16);
    expect(run.checks.frameAgreement).toBe(true);
  });

  it('matches candidate action to accepted input and measures movement during delayed responses', () => {
    const seed = chooseSeed(food => food.y !== 10 && food.x !== 6);
    const replay = recording(seed, 200, [input(41, 'up', 'request-1'), input(201, 'right', 'request-3')], [
      { type: 'decision', runId: 'run-0', requestId: 'request-1', tick: 40, observedTick: 0, appliedTick: 41, actionId: 'up:100', outcome: 'applied', metrics: { elapsedMs: 750, actualModel: 'typesafe/jev-1.14', thoughtUsed: false, usage: { input_tokens: 10, total_tokens: 12 } } },
      { type: 'decision', runId: 'run-0', requestId: 'request-2', tick: 80, observedTick: 60, actionId: 'right:100', outcome: 'dropped', metrics: { elapsedMs: 1250 } },
      { type: 'decision', runId: 'run-0', requestId: 'request-3', tick: 200, observedTick: 180, appliedTick: 201, actionId: 'right:100', outcome: 'applied' },
    ]);
    const run = summarize(replay).runs[0];
    expect(run.decisions[0]).toMatchObject({ observedTick: 0, settledTick: 40, appliedTick: 41, nextSnakeMovementTick: 60, movesObservedToSettled: 2, movesObservedToApplied: 2, inputActionConsistent: true, thoughtUsed: false, actualModel: 'typesafe/jev-1.14' });
    expect(run.decisions[1]).toMatchObject({ outcome: 'dropped', movesObservedToSettled: 1, appliedTick: null, movesObservedToApplied: null, inputActionConsistent: true, thoughtUsed: null });
    expect(run.decisions[2]).toMatchObject({ appliedWithinReplay: false, movesObservedToApplied: null, nextSnakeMovementTick: null, inputActionConsistent: true });
    expect(run.successfulMoves).toBe(10);
    expect(run.dropped).toBe(1);
    expect(run.latency).toEqual({ count: 2, medianMs: 1000, p95Ms: 1225 });
    expect(run.checks.inputActionAgreement).toBe(true);
    replay.events.find((event: any) => event.type === 'decision').actionId = 'down:100';
    const mismatch = summarize(replay).runs[0];
    expect(mismatch.checks.inputActionAgreement).toBe(false);
    expect(mismatch.checks.frameAgreement).toBe(true);
  });

  it('applies system release before the next tick without running a queued short tap', () => {
    const seed = chooseSeed(food => food.y !== 10);
    const replay = recording(seed, 40, [input(20, 'up'), { type: 'input', runId: 'run-0', tick: 19, appliedTick: 20, release: true, input: { buttons: [] } }]);
    const run = summarize(replay).runs[0];
    expect(run.successfulMoves).toBe(2);
    expect(run.checks.frameAgreement).toBe(true);
  });

  it('projects no credentials, private endpoints, raw thoughts, messages or arbitrary numeric usage fields', () => {
    const marker = 'private-should-never-leave-memory';
    const replay = recording(chooseSeed(food => food.y !== 10), 40, [input(21, 'right', 'request-1')], [{
      type: 'decision', runId: 'run-0', requestId: 'request-1', tick: 20, observedTick: 0, appliedTick: 21,
      actionId: 'right:100', outcome: 'applied', message: marker, reasoning: { text: marker },
      metrics: { elapsedMs: Infinity, actualModel: 'sk-private-secret', raw: marker, usage: { total_tokens: 4, input_tokens: NaN, secretNumeric: 999, raw: marker } },
    }]);
    Object.assign(replay.controllers[0].profile, { endpoint: `https://${marker}.invalid`, apiKey: marker, credentialId: marker });
    replay.result.reason = marker;
    const summary = summarize(replay);
    expect(JSON.stringify(summary)).not.toContain(marker);
    expect(JSON.stringify(summary)).not.toContain('sk-private-secret');
    expect(JSON.stringify(summary)).not.toContain('secretNumeric');
    expect(summary.runs[0].decisions[0]).toMatchObject({ elapsedMs: null, actualModel: null, thoughtUsed: null, usage: { total_tokens: 4 } });
    expect(summary.originalResult.reason).toBe('UNRECOGNIZED');
  });

  it('detects reconstruction disagreement and rejects different physics or changed harness metadata', () => {
    const replay = recording(chooseSeed(food => food.y !== 10), 40);
    replay.frames.at(-1).views[0].snake[0].x++;
    expect(summarize(replay).runs[0].checks.frameAgreement).toBe(false);
    expect(() => summarize({ ...replay, rulesVersion: 'snake-realtime-v1' })).toThrow('rules version');
    expect(() => summarize({ ...replay, events: [{ seq: 1, tick: 0, type: 'created', snakeHarnessVersion: B }] })).toThrow('frozen session');
    delete replay.config.snakeHarnessVersion;
    const legacy = summarize(replay);
    expect(legacy.harnessVersion).toBe(A);
    expect(legacy.harnessVersionSource).toBe('legacy-default');
    expect(replay.config).toEqual({});
  });

  it('compares recorded terminal state and reason as well as position and score', () => {
    const replay = recording(chooseSeed(food => food.y !== 10), 320);
    const changedStatus = structuredClone(replay);
    changedStatus.frames.at(-1).views[0].status = 'playing';
    expect(summarize(changedStatus).runs[0].checks.frameAgreement).toBe(false);
    const changedReason = structuredClone(replay);
    changedReason.frames.at(-1).views[0].reason = 'SELF_COLLISION';
    expect(summarize(changedReason).runs[0].checks.frameAgreement).toBe(false);
    expect(summarize(replay).runs[0].checks.frameAgreement).toBe(true);
  });
});

describe('paired independent-seed statistics', () => {
  it('uses 20 seed pairs, fixed 10000 resamples, and 97.5% intervals without repeated-run pseudoreplication', () => {
    const rows = Array.from({ length: 20 }, (_, i) => [
      { seed: `seed-${i}`, harnessVersion: A, food: i % 5, cohort: 'independent' },
      { seed: `seed-${i}`, harnessVersion: B, food: i % 5 + 1, cohort: 'independent' },
      { seed: `seed-${i}`, harnessVersion: C, food: i % 5 + 2, cohort: 'independent' },
    ]).flat();
    const original = reportPairwise(rows);
    const report = reportPairwise([...rows, ...Array.from({ length: 40 }, () => ({ seed: 'seed-0', harnessVersion: B, food: 100, cohort: 'repeat' }))]);
    expect(report.independentDesignComplete).toBe(true);
    expect(report.independentSeedCount).toBe(20);
    expect(BOOTSTRAP_RESAMPLES).toBe(10000);
    expect(report.comparisons[0]).toMatchObject({ pairedSeedCount: 20, meanDifference: -1, candidateMinusA: 1, confidenceLevel: 0.975, confidenceInterval: [-1, -1], candidateMinusAConfidenceInterval: [1, 1] });
    expect(report.comparisons[1]).toMatchObject({ meanDifference: -2, confidenceInterval: [-2, -2] });
    expect(report.comparisons).toEqual(original.comparisons);
    expect(report.repeated.observations).toBe(40);
    expect(report.repeated.includedInConfidenceIntervals).toBe(false);
    expect(report.defaultVersionUnchanged).toBe(A);
  });

  it('is deterministic under input reordering and identifies incomplete pairs', () => {
    const rows = Array.from({ length: 20 }, (_, i) => [
      { seed: `seed-${i}`, harnessVersion: A, food: i % 6, cohort: 'independent' },
      { seed: `seed-${i}`, harnessVersion: B, food: (i + 2) % 7, cohort: 'independent' },
      ...(i ? [{ seed: `seed-${i}`, harnessVersion: C, food: i % 5, cohort: 'independent' }] : []),
    ]).flat();
    const report = reportPairwise(rows);
    expect(reportPairwise([...rows].reverse())).toEqual(report);
    expect(report.independentDesignComplete).toBe(false);
    expect(report.comparisons[1].pairedSeedCount).toBe(19);
    expect(report.comparisons[1].incompleteSeeds).toEqual(['seed-0']);
    expect(report.comparisons[0].confidenceInterval![0]).toBeLessThan(report.comparisons[0].confidenceInterval![1]!);
  });

  it('rejects duplicate independent seeds, unlabeled cohorts and invalid outcomes instead of silently altering sample size', () => {
    const row = { seed: 'same', harnessVersion: A, food: 0, cohort: 'independent' };
    expect(() => reportPairwise([row, row])).toThrow('Duplicate independent');
    expect(() => reportPairwise([{ ...row, cohort: undefined }])).toThrow('Invalid experiment observation');
    expect(() => reportPairwise([{ ...row, food: NaN }])).toThrow('Invalid experiment observation');
    expect(reportPairwise([row]).comparisons[0].confidenceInterval).toBeNull();
  });

  it('keeps repeat-minus-original and matched repeated candidate-minus-A variation separate from independent confidence intervals', () => {
    const rows = [
      { seed: 's1', harnessVersion: A, food: 1, survivedTicks: 200, cohort: 'independent' },
      { seed: 's1', harnessVersion: B, food: 2, survivedTicks: 100, cohort: 'independent' },
      { seed: 's1', harnessVersion: A, food: 2, survivedTicks: 300, cohort: 'repeat', repetition: 1 },
      { seed: 's1', harnessVersion: B, food: 4, survivedTicks: 200, cohort: 'repeat', repetition: 1 },
      { seed: 's1', harnessVersion: A, food: 2, survivedTicks: 400, cohort: 'repeat', repetition: 2 },
      { seed: 's1', harnessVersion: B, food: 2, survivedTicks: 500, cohort: 'repeat', repetition: 2 },
      { seed: 's2', harnessVersion: C, food: 3, survivedTicks: 100, cohort: 'repeat', repetition: 1 },
      { seed: 's1', harnessVersion: B, food: 99, cohort: 'repeat' },
    ];
    const report = reportPairwise(rows);
    expect(report.comparisons[0]).toMatchObject({ pairedSeedCount: 1, candidateMinusA: 1, confidenceInterval: null, originalRuleOutcomes: { candidateWins: 1, controlWins: 0, ties: 0, unresolved: 0 } });
    expect(report.repeated.rows.find((row: any) => row.harnessVersion === B && row.repetition === 1)).toMatchObject({ originalFood: 2, foodDelta: 2, survivedTicksDelta: 100, originalRuleWinner: 'repeat' });
    expect(report.repeated.rows.find((row: any) => row.seed === 's2')).toMatchObject({ originalFood: null, foodDelta: null, referenceAvailable: false });
    expect(report.repeated.comparisons[0]).toMatchObject({ pairedObservations: 2, candidateMinusA: { count: 2, mean: 1, min: 0, max: 2 }, differenceFromOriginal: { count: 2, mean: 0, min: -1, max: 1 }, originalRuleOutcomes: { candidateWins: 2, controlWins: 0, ties: 0, unresolved: 0 } });
    expect(report.repeated.comparisons[0].pairs[1]).toMatchObject({ repetition: 2, candidateMinusA: 0, survivedTicksDifference: 100, originalRuleWinner: 'candidate', differenceFromOriginal: -1 });
    expect(reportPairwise([...rows].reverse())).toEqual(report);
    expect(() => reportPairwise([...rows, rows[2]])).toThrow('Duplicate repeated');
  });

  it('uses food before survival for original rule outcomes and never invents a draw from missing survival', () => {
    const rows = [
      { seed: 'food-first', harnessVersion: A, food: 2, survivedTicks: 100, cohort: 'independent' },
      { seed: 'food-first', harnessVersion: B, food: 1, survivedTicks: 7000, cohort: 'independent' },
      { seed: 'survival', harnessVersion: A, food: 1, survivedTicks: 100, cohort: 'independent' },
      { seed: 'survival', harnessVersion: B, food: 1, survivedTicks: 200, cohort: 'independent' },
      { seed: 'tie', harnessVersion: A, food: 1, survivedTicks: 200, cohort: 'independent' },
      { seed: 'tie', harnessVersion: B, food: 1, survivedTicks: 200, cohort: 'independent' },
      { seed: 'unknown', harnessVersion: A, food: 0, cohort: 'independent' },
      { seed: 'unknown', harnessVersion: B, food: 0, cohort: 'independent' },
    ];
    expect(reportPairwise(rows).comparisons[0].originalRuleOutcomes).toEqual({ candidateWins: 1, controlWins: 1, ties: 1, unresolved: 1 });
    expect(() => reportPairwise([{ ...rows[0], survivedTicks: NaN }])).toThrow('Invalid experiment survival');
    expect(() => reportPairwise([{ ...rows[0], cohort: 'repeat', repetition: -1 }])).toThrow('Invalid experiment repetition');
  });

  it('uses the stated quantile convention and leaves missing latency unknown', () => {
    expect(quantile([400, 100, 300, 200], 0.5)).toBe(250);
    expect(quantile([400, 100, 300, 200], 0.95)).toBe(385);
    expect(quantile([], 0.5)).toBeNull();
    expect(() => quantile([1], 2)).toThrow();
  });
});
