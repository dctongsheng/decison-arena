/**
 * In-memory analysis only. This module has no file, network, or logging access.
 * Pass the current snake adapter from the driver; private replay objects never
 * become part of the return value. All report fields are projected explicitly.
 */
export const SNAKE_EXPERIMENT_VERSIONS = Object.freeze([
  'snake-harness-a-v1', 'snake-harness-b-v1', 'snake-harness-c-v1',
]);
export const BOOTSTRAP_RESAMPLES = 10_000;
export const BOOTSTRAP_SEED = 20261017;
const MAX_TICKS = 7200;
const MAX_EVENTS = 20000;
const DIRECTIONS = ['up', 'right', 'down', 'left'];
const OUTCOMES = ['applied', 'dropped', 'failed', 'unknown'];
const REASONS = new Set(['WALL_COLLISION', 'SELF_COLLISION', 'BOARD_FILLED', 'TIME_LIMIT', 'ended_by_user', 'time_limit', 'runs_finished']);
const USAGE_KEYS = ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens', 'cached_tokens', 'reasoning_tokens'];

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
function integer(value, max = MAX_TICKS) {
  return Number.isInteger(value) && value >= 0 && value <= max;
}
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function safeReason(value) {
  return REASONS.has(value) ? value : value == null ? null : 'UNRECOGNIZED';
}
function safeModel(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,159}$/.test(value) &&
    !/^(?:sk[-_]|bag_|bearer)/i.test(value) ? value : null;
}
function safeUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const key of USAGE_KEYS) if (finiteNumber(value[key]) !== null) result[key] = value[key];
  return Object.keys(result).length ? result : null;
}
function safeScore(value) {
  requireValue(value && integer(value.food, 397) && integer(value.points, 39700) && integer(value.survivedTicks), 'Invalid snake score');
  return { food: value.food, points: value.points, survivedTicks: value.survivedTicks };
}
function safeInput(value) {
  requireValue(value && Array.isArray(value.buttons) && value.buttons.length <= 1 && value.buttons.every(button => DIRECTIONS.includes(button)), 'Invalid snake input');
  requireValue(value.durationMs === undefined || [100, 300, 1000].includes(value.durationMs), 'Invalid snake input duration');
  return { buttons: [...value.buttons], ...(value.durationMs === undefined ? {} : { durationMs: value.durationMs }) };
}
function sameInput(a, b) {
  return a && b && a.durationMs === b.durationMs && a.buttons.length === b.buttons.length && a.buttons.every((button, index) => button === b.buttons[index]);
}
function positionKey(state) {
  // Ordered body, current direction, and food; neither just the head nor ticks.
  return JSON.stringify([state.body.map(point => [point.x, point.y]), state.direction,
    state.food ? [state.food.x, state.food.y] : null]);
}
function samePoints(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((point, index) => point.x === b[index].x && point.y === b[index].y);
}
function samePoint(a, b) {
  return a === null && b === null || a && b && a.x === b.x && a.y === b.y;
}

/** R-7 / linear interpolation quantiles, also used for latency median and P95. */
export function quantile(values, probability) {
  requireValue(probability >= 0 && probability <= 1 && Number.isFinite(probability), 'Invalid quantile');
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * probability, lower = Math.floor(index), weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[Math.ceil(index)] * weight;
}

/**
 * Replays accepted input events before their appliedTick, then performs one
 * physics tick. Direction taps and explicit system release retain their exact
 * semantics. A movement means a successful one-cell head movement; the fatal
 * collision attempt is not counted as a moved cell.
 */
export function summarizeSnakeReplay(replay, { adapter } = {}) {
  requireValue(adapter?.id === 'snake' && typeof adapter.create === 'function', 'A snake adapter is required');
  requireValue(replay?.version === 2 && replay.engineKind === 'arcade' && replay.gameId === 'snake', 'A private snake V2 replay is required');
  requireValue(replay.rulesVersion === adapter.rulesVersion, 'Snake rules version does not match the replay');
  requireValue(typeof replay.seed === 'string' && replay.seed.length > 0 && replay.seed.length <= 128, 'Invalid snake seed');
  requireValue(Array.isArray(replay.runIds) && replay.runIds.length >= 1 && replay.runIds.length <= 2 && new Set(replay.runIds).size === replay.runIds.length, 'Invalid snake tracks');
  requireValue(replay.runIds.every(id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id)), 'Invalid snake track identifier');
  requireValue(Array.isArray(replay.controllers) && replay.controllers.length === replay.runIds.length, 'Invalid snake controllers');
  requireValue(Array.isArray(replay.frames) && replay.frames.length > 0 && replay.frames.length <= MAX_EVENTS, 'Invalid snake frames');
  requireValue(Array.isArray(replay.events) && replay.events.length <= MAX_EVENTS, 'Invalid snake events');
  const harnessVersion = replay.config?.snakeHarnessVersion ?? SNAKE_EXPERIMENT_VERSIONS[0];
  requireValue(SNAKE_EXPERIMENT_VERSIONS.includes(harnessVersion), 'Invalid snake harness version');
  requireValue(replay.result && [null, 0, 1].includes(replay.result.winner) && typeof replay.result.aborted === 'boolean' && Array.isArray(replay.result.scores) && replay.result.scores.length === replay.runIds.length, 'Invalid snake result');
  const originalResult = { winner: replay.result.winner, reason: safeReason(replay.result.reason), aborted: replay.result.aborted, scores: replay.result.scores.map(safeScore) };
  const lastTick = replay.frames.at(-1).tick;
  requireValue(integer(lastTick), 'Invalid snake terminal tick');
  let previousFrameTick = -1;
  for (const frame of replay.frames) {
    requireValue(integer(frame.tick) && frame.tick > previousFrameTick && Array.isArray(frame.views) && frame.views.length === replay.runIds.length, 'Invalid snake frame order');
    previousFrameTick = frame.tick;
  }
  const events = [...replay.events].sort((left, right) => left.seq - right.seq);
  let previousSeq = -1;
  for (const event of events) {
    requireValue(integer(event.seq, Number.MAX_SAFE_INTEGER) && event.seq > previousSeq && integer(event.tick) && event.tick <= lastTick, 'Invalid snake event sequence');
    previousSeq = event.seq;
    requireValue(event.runId === undefined || replay.runIds.includes(event.runId), 'Invalid snake event track');
    requireValue(event.snakeHarnessVersion === undefined || event.snakeHarnessVersion === harnessVersion, 'Snake event harness differs from the frozen session');
  }
  const runs = replay.runIds.map((runId, runIndex) => {
    const decisions = events.filter(event => event.type === 'decision' && event.runId === runId);
    const wantedTicks = new Set([0, lastTick, ...replay.frames.map(frame => frame.tick)]);
    for (const event of decisions) {
      requireValue(OUTCOMES.includes(event.outcome) && integer(event.observedTick) && event.observedTick <= event.tick, 'Invalid snake decision timing');
      requireValue(event.appliedTick === undefined || integer(event.appliedTick) && event.appliedTick === event.tick + 1, 'Invalid snake applied tick');
      wantedTicks.add(event.observedTick);
    }
    const inputs = events.filter(event => event.type === 'input' && event.runId === runId);
    const inputsByTick = new Map();
    for (const event of inputs) {
      requireValue(integer(event.appliedTick) && event.appliedTick === event.tick + 1, 'Invalid snake input timing');
      const input = safeInput(event.input);
      requireValue(event.release === undefined || event.release === true && input.buttons.length === 0, 'Invalid snake release');
      inputsByTick.set(event.appliedTick, [...(inputsByTick.get(event.appliedTick) || []), { ...event, input }]);
    }
    // Pass only the public configuration needed by this adapter, not arbitrary
    // fields accidentally retained in a private artifact.
    let state = adapter.create({ snakeHarnessVersion: harnessVersion }, replay.seed);
    const captured = new Map([[0, structuredClone(state)]]);
    const moveCounts = [0];
    const seen = new Set([positionKey(state)]), cycleSeen = new Map([[positionKey(state), 0]]);
    let successfulMoves = 0, noScoreMoves = 0, longestNoScoreMoves = 0;
    let repeatedFullStateVisits = 0, completedStateCycles = 0, longestCycleMoves = 0;
    for (let tick = 1; tick <= lastTick; tick++) {
      for (const event of inputsByTick.get(tick) || []) {
        if (state.status !== 'playing') {
          requireValue(event.release === true, 'Input was applied after the snake finished');
          continue;
        }
        try { state = event.release ? adapter.release(state) : adapter.input(state, event.input); }
        catch { throw new Error('Snake replay contains an illegal input'); }
      }
      const previousHead = state.body[0], previousFood = state.score.food;
      if (state.status === 'playing') state = adapter.step(state, 1);
      if (!samePoint(previousHead, state.body[0])) {
        requireValue(Math.abs(previousHead.x - state.body[0].x) + Math.abs(previousHead.y - state.body[0].y) === 1, 'Invalid snake movement');
        successfulMoves++;
        noScoreMoves = state.score.food > previousFood ? 0 : noScoreMoves + 1;
        longestNoScoreMoves = Math.max(longestNoScoreMoves, noScoreMoves);
        const key = positionKey(state);
        if (seen.has(key)) repeatedFullStateVisits++; else seen.add(key);
        if (cycleSeen.has(key)) {
          completedStateCycles++;
          longestCycleMoves = Math.max(longestCycleMoves, successfulMoves - cycleSeen.get(key));
          // Consume a completed return, so rotations of the same cycle are not
          // counted as several overlapping completed cycles.
          cycleSeen.clear();
        }
        cycleSeen.set(key, successfulMoves);
      }
      moveCounts[tick] = successfulMoves;
      if (wantedTicks.has(tick)) captured.set(tick, structuredClone(state));
    }
    let frameMismatches = 0;
    for (const frame of replay.frames) {
      const actual = captured.get(frame.tick), stored = frame.views[runIndex];
      if (!stored || stored.gameId !== 'snake' || actual.tick !== stored.tick ||
          actual.status !== stored.status || actual.reason !== stored.reason ||
          !samePoints(actual.body, stored.snake) || !samePoint(actual.food, stored.food) ||
          actual.score.food !== stored.score?.food || actual.score.points !== stored.score?.points || actual.score.survivedTicks !== stored.score?.survivedTicks)
        frameMismatches++;
    }
    const score = safeScore(state.score), storedScore = originalResult.scores[runIndex];
    const scoreMatches = score.food === storedScore.food && score.points === storedScore.points && score.survivedTicks === storedScore.survivedTicks;
    const projectedDecisions = decisions.map(event => {
      const observedState = captured.get(event.observedTick);
      const action = observedState && adapter.candidates(observedState).find(candidate => candidate.id === event.actionId);
      const linked = typeof event.requestId === 'string'
        ? inputs.filter(input => input.requestId === event.requestId && input.release !== true)
        : [];
      const applied = event.outcome === 'applied';
      const inputActionConsistent = typeof event.requestId !== 'string' ? null : applied
        ? linked.length === 1 && !!action && linked[0].appliedTick === event.appliedTick && sameInput(linked[0].input, action.input)
        : linked.length === 0;
      const appliedWithinReplay = event.appliedTick !== undefined && event.appliedTick <= lastTick;
      // appliedTick acknowledges a queued input, not a completed turn. The v2
      // snake moves every 20 ticks; later accepted inputs may replace this one.
      const movementTick = event.appliedTick === undefined ? null : Math.ceil(event.appliedTick / 20) * 20;
      return {
        seq: event.seq,
        actionId: typeof event.actionId === 'string' && /^(?:up|down|left|right):100$/.test(event.actionId) ? event.actionId : null,
        outcome: event.outcome,
        observedTick: event.observedTick, settledTick: event.tick, appliedTick: event.appliedTick ?? null,
        nextSnakeMovementTick: movementTick !== null && movementTick <= Math.min(lastTick, state.tick) ? movementTick : null,
        ticksObservedToSettled: event.tick - event.observedTick,
        ticksObservedToApplied: event.appliedTick === undefined ? null : event.appliedTick - event.observedTick,
        movesObservedToSettled: moveCounts[event.tick] - moveCounts[event.observedTick],
        movesObservedToApplied: appliedWithinReplay ? moveCounts[event.appliedTick] - moveCounts[event.observedTick] : null,
        appliedWithinReplay, inputActionConsistent,
        elapsedMs: finiteNumber(event.metrics?.elapsedMs), actualModel: safeModel(event.metrics?.actualModel),
        thoughtUsed: typeof event.metrics?.thoughtUsed === 'boolean' ? event.metrics.thoughtUsed : null,
        usage: safeUsage(event.metrics?.usage),
      };
    });
    const latencies = projectedDecisions.map(event => event.elapsedMs).filter(value => value !== null);
    const lastView = replay.frames.at(-1).views[runIndex];
    return {
      runId, score, originalScore: storedScore,
      endReason: safeReason(lastView?.reason) ?? safeReason(replay.result.reason),
      successfulMoves, longestNoScoreMoves, repeatedFullStateVisits, completedStateCycles, longestCycleMoves,
      decisionCount: projectedDecisions.length,
      dropped: projectedDecisions.filter(event => event.outcome === 'dropped').length,
      failed: projectedDecisions.filter(event => event.outcome === 'failed').length,
      unknown: projectedDecisions.filter(event => event.outcome === 'unknown').length,
      latency: { count: latencies.length, medianMs: quantile(latencies, 0.5), p95Ms: quantile(latencies, 0.95) },
      decisions: projectedDecisions,
      checks: { frameAgreement: frameMismatches === 0, frameMismatches, scoreAgreement: scoreMatches,
        inputActionAgreement: projectedDecisions.every(event => event.inputActionConsistent === true) },
    };
  });
  return {
    schemaVersion: 1, gameId: 'snake', harnessVersion,
    harnessVersionSource: replay.config?.snakeHarnessVersion === undefined ? 'legacy-default' : 'recorded',
    rulesVersion: adapter.rulesVersion, originalResult, lastTick, runs,
  };
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function originalRuleWinner(control, candidate) {
  if (candidate.food !== control.food) return candidate.food > control.food ? 'candidate' : 'control';
  if (candidate.survivedTicks === null || control.survivedTicks === null) return null;
  return candidate.survivedTicks === control.survivedTicks ? 'tie'
    : candidate.survivedTicks > control.survivedTicks ? 'candidate' : 'control';
}
function outcomeCounts(pairs) {
  return {
    controlWins: pairs.filter(pair => pair.originalRuleWinner === 'control').length,
    candidateWins: pairs.filter(pair => pair.originalRuleWinner === 'candidate').length,
    ties: pairs.filter(pair => pair.originalRuleWinner === 'tie').length,
    unresolved: pairs.filter(pair => pair.originalRuleWinner === null).length,
  };
}
function variation(values) {
  const average = mean(values);
  return { count: values.length, mean: average, min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    sampleStandardDeviation: values.length >= 2
      ? Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1)) : null };
}
function pairValues(seed, control, candidate) {
  return { seed, controlFood: control.food, candidateFood: candidate.food,
    candidateMinusA: candidate.food - control.food,
    survivedTicksDifference: control.survivedTicks === null || candidate.survivedTicks === null
      ? null : candidate.survivedTicks - control.survivedTicks,
    originalRuleWinner: originalRuleWinner(control, candidate) };
}
function pairedComparison(bySeed, candidate, seed) {
  const control = SNAKE_EXPERIMENT_VERSIONS[0], pairs = [], incompleteSeeds = [];
  for (const [id, values] of bySeed) {
    if (values.has(control) && values.has(candidate)) pairs.push(pairValues(id, values.get(control), values.get(candidate)));
    else incompleteSeeds.push(id);
  }
  const differences = pairs.map(pair => -pair.candidateMinusA);
  let confidenceInterval = null;
  if (differences.length >= 2) {
    const random = seededRandom(seed), estimates = [];
    for (let iteration = 0; iteration < BOOTSTRAP_RESAMPLES; iteration++) {
      let total = 0;
      for (let draw = 0; draw < differences.length; draw++) total += differences[Math.floor(random() * differences.length)];
      estimates.push(total / differences.length);
    }
    confidenceInterval = [quantile(estimates, 0.0125), quantile(estimates, 0.9875)];
  }
  const difference = mean(differences);
  return { control, candidate, contrast: 'A minus candidate', metric: 'food', pairedSeedCount: differences.length,
    pairedSeeds: pairs.map(pair => pair.seed), incompleteSeeds, pairs,
    originalRuleOutcomes: outcomeCounts(pairs), meanDifference: difference, candidateMinusA: difference === null ? null : -difference,
    confidenceLevel: 0.975, confidenceInterval,
    candidateMinusAConfidenceInterval: confidenceInterval === null ? null : [-confidenceInterval[1], -confidenceInterval[0]],
    bootstrapResamples: BOOTSTRAP_RESAMPLES, bootstrapSeed: seed };
}

/**
 * Rows: { seed, harnessVersion, food, survivedTicks?, cohort, repetition? }.
 * Only one independent observation per seed/version is allowed. Repeated runs
 * remain descriptive and never inflate the paired bootstrap sample size.
 * A repeated A/candidate pair requires the same explicit repetition identifier;
 * missing identifiers are never inferred from input ordering.
 */
export function reportPairwise(samples) {
  requireValue(Array.isArray(samples), 'Experiment rows must be an array');
  const independent = new Map(), repeats = [], repeatedGroups = new Map();
  const independentValues = new Map(SNAKE_EXPERIMENT_VERSIONS.map(version => [version, []]));
  for (const row of samples) {
    requireValue(row && typeof row.seed === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(row.seed), 'Invalid experiment seed identifier');
    requireValue(SNAKE_EXPERIMENT_VERSIONS.includes(row.harnessVersion) && integer(row.food, 397) && ['independent', 'repeat'].includes(row.cohort), 'Invalid experiment observation');
    requireValue(row.survivedTicks === undefined || integer(row.survivedTicks), 'Invalid experiment survival');
    requireValue(row.repetition === undefined || integer(row.repetition, 10000), 'Invalid experiment repetition');
    const value = { food: row.food, survivedTicks: row.survivedTicks ?? null };
    if (row.cohort === 'repeat') {
      repeats.push({ seed: row.seed, harnessVersion: row.harnessVersion, ...value, repetition: row.repetition ?? null });
      if (row.repetition !== undefined) {
        const key = JSON.stringify([row.seed, row.repetition]);
        const group = repeatedGroups.get(key) || { seed: row.seed, repetition: row.repetition, values: new Map() };
        requireValue(!group.values.has(row.harnessVersion), 'Duplicate repeated seed, repetition and harness');
        group.values.set(row.harnessVersion, value); repeatedGroups.set(key, group);
      }
      continue;
    }
    const values = independent.get(row.seed) || new Map();
    requireValue(!values.has(row.harnessVersion), 'Duplicate independent seed and harness; mark repeated runs separately');
    values.set(row.harnessVersion, value); independent.set(row.seed, values);
    independentValues.get(row.harnessVersion).push(row.food);
  }
  // Sorting makes the random bootstrap reproducible regardless of run order.
  const bySeed = new Map([...independent].sort(([left], [right]) => left.localeCompare(right, 'en')));
  const comparisons = [
    pairedComparison(bySeed, SNAKE_EXPERIMENT_VERSIONS[1], BOOTSTRAP_SEED),
    pairedComparison(bySeed, SNAKE_EXPERIMENT_VERSIONS[2], BOOTSTRAP_SEED + 1),
  ];
  const repeatedRows = repeats.sort((a, b) => a.seed.localeCompare(b.seed, 'en') || a.harnessVersion.localeCompare(b.harnessVersion, 'en') ||
    (a.repetition ?? -1) - (b.repetition ?? -1) || a.food - b.food || (a.survivedTicks ?? -1) - (b.survivedTicks ?? -1)).map(row => {
      const original = bySeed.get(row.seed)?.get(row.harnessVersion);
      const winner = original ? originalRuleWinner(original, row) : null;
      return { ...row, originalFood: original?.food ?? null,
        foodDelta: original ? row.food - original.food : null,
        survivedTicksDelta: original && original.survivedTicks !== null && row.survivedTicks !== null ? row.survivedTicks - original.survivedTicks : null,
        originalRuleWinner: winner === 'candidate' ? 'repeat' : winner === 'control' ? 'original' : winner,
        referenceAvailable: !!original };
    });
  const repeatComparisons = SNAKE_EXPERIMENT_VERSIONS.slice(1).map(candidate => {
    const control = SNAKE_EXPERIMENT_VERSIONS[0], pairs = [];
    for (const group of [...repeatedGroups.values()].sort((a, b) => a.seed.localeCompare(b.seed, 'en') || a.repetition - b.repetition)) {
      if (!group.values.has(control) || !group.values.has(candidate)) continue;
      const pair = pairValues(group.seed, group.values.get(control), group.values.get(candidate));
      const originals = bySeed.get(group.seed);
      const originalDelta = originals?.has(control) && originals.has(candidate)
        ? originals.get(candidate).food - originals.get(control).food : null;
      pairs.push({ ...pair, repetition: group.repetition, originalCandidateMinusA: originalDelta,
        differenceFromOriginal: originalDelta === null ? null : pair.candidateMinusA - originalDelta });
    }
    return { control, candidate, pairs, pairedObservations: pairs.length,
      candidateMinusA: variation(pairs.map(pair => pair.candidateMinusA)),
      differenceFromOriginal: variation(pairs.map(pair => pair.differenceFromOriginal).filter(value => value !== null)),
      originalRuleOutcomes: outcomeCounts(pairs) };
  });
  return {
    schemaVersion: 1, metric: 'food', expectedIndependentSeeds: 20,
    independentSeedCount: bySeed.size,
    independentDesignComplete: bySeed.size === 20 && [...bySeed.values()].every(values => values.size === 3),
    defaultVersionUnchanged: SNAKE_EXPERIMENT_VERSIONS[0],
    method: 'Paired percentile bootstrap; 10000 resamples; two 97.5% two-sided intervals; nominal Bonferroni familywise target 0.05; bootstrap approximation.',
    quantileMethod: 'R-7 linear interpolation',
    independent: SNAKE_EXPERIMENT_VERSIONS.map(harnessVersion => ({ harnessVersion,
      observations: independentValues.get(harnessVersion).length, meanFood: mean(independentValues.get(harnessVersion)) })),
    comparisons,
    repeated: { includedInConfidenceIntervals: false, observations: repeats.length, rows: repeatedRows, comparisons: repeatComparisons,
      byVersion: SNAKE_EXPERIMENT_VERSIONS.map(harnessVersion => {
        const rows = repeatedRows.filter(row => row.harnessVersion === harnessVersion);
        return { harnessVersion, observations: rows.length, distinctSeeds: new Set(rows.map(row => row.seed)).size,
          meanFood: mean(rows.map(row => row.food)), repeatMinusOriginal: variation(rows.map(row => row.foodDelta).filter(value => value !== null)) };
      }) },
  };
}
