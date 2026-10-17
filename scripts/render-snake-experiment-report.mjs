/**
 * Offline only. Usage:
 * node scripts/render-snake-experiment-report.mjs --report FINAL.report.json \
 *   --pilot PILOT.report.json --out docs/snake-experiment-results \
 *   --blocked-provider systemone --blocked-http-status 401
 * Writes new .json, .md and .events.json files; never overwrites existing files.
 * Frozen experiment sources and running ledgers are neither read nor changed.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { quantile, reportPairwise, SNAKE_EXPERIMENT_VERSIONS } from './lib/snake-experiment-report.mjs';

const VARIANTS = ['A', 'B', 'C'];
const PROVIDERS = ['openrouter', 'systemone', 'custom-openrouter', 'custom-systemone', 'bamboonode-systemone', 'bamboonode-decisions'];
const PHASES = ['pending', 'creating', 'ready', 'starting', 'running', 'settling', 'complete', 'stopped', 'unknown'];
const OUTCOMES = ['applied', 'dropped', 'failed', 'unknown'];
const REASONS = ['WALL_COLLISION', 'SELF_COLLISION', 'BOARD_FILLED', 'TIME_LIMIT', 'ended_by_user', 'time_limit', 'runs_finished'];
const USAGE_KEYS = ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens', 'cached_tokens', 'reasoning_tokens'];
const HASH = /^[a-f0-9]{64}$/;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const count = (value, max = Number.MAX_SAFE_INTEGER) => Number.isInteger(value) && value >= 0 && value <= max ? value : null;
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const sum = values => values.reduce((total, value) => total + value, 0);
const unique = values => [...new Set(values.filter(value => value !== null))].sort();
function ensure(value) { if (!value) throw new Error('INVALID_REPORT'); }
function model(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,159}$/.test(value) && !/^(?:sk[-_]|bag_|bearer)/i.test(value) ? value : null;
}
function version(value) { return typeof value === 'string' && /^decision-arena-arcade-v\d+$/.test(value) ? value : null; }
function distribution(values) {
  const finite = values.filter(value => value !== null);
  return { count: finite.length, mean: mean(finite), median: quantile(finite, 0.5), p95: quantile(finite, 0.95),
    min: finite.length ? Math.min(...finite) : null, max: finite.length ? Math.max(...finite) : null };
}
function sameScore(a, b) {
  return a && b && ['food', 'points', 'survivedTicks'].every(key => a[key] === b[key]);
}
function safeDecision(event) {
  return {
    seq: count(event?.seq), outcome: OUTCOMES.includes(event?.outcome) ? event.outcome : 'unknown',
    elapsedMs: number(event?.elapsedMs), actualModel: model(event?.actualModel),
    thoughtUsed: typeof event?.thoughtUsed === 'boolean' ? event.thoughtUsed : null,
    ticksObservedToSettled: count(event?.ticksObservedToSettled, 7200),
    ticksObservedToApplied: count(event?.ticksObservedToApplied, 7200),
    movesObservedToSettled: count(event?.movesObservedToSettled, 360),
    movesObservedToApplied: count(event?.movesObservedToApplied, 360),
  };
}
function auditDecision(event) {
  const usage = {};
  for (const key of USAGE_KEYS) if (number(event?.usage?.[key]) !== null) usage[key] = event.usage[key];
  return { ...safeDecision(event),
    actionId: typeof event?.actionId === 'string' && /^(?:up|right|down|left):100$/.test(event.actionId) ? event.actionId : null,
    observedTick: count(event?.observedTick, 7200), settledTick: count(event?.settledTick, 7200),
    appliedTick: count(event?.appliedTick, 7200), nextSnakeMovementTick: count(event?.nextSnakeMovementTick, 7200),
    appliedWithinReplay: typeof event?.appliedWithinReplay === 'boolean' ? event.appliedWithinReplay : null,
    inputActionConsistent: typeof event?.inputActionConsistent === 'boolean' ? event.inputActionConsistent : null,
    usage: Object.keys(usage).length ? usage : null,
  };
}
function projectEntry(entry) {
  ensure(entry && ['development', 'acceptance', 'repeat'].includes(entry.partition) && VARIANTS.includes(entry.variant));
  ensure(typeof entry.seed === 'string' && typeof entry.profileId === 'string');
  const harness = SNAKE_EXPERIMENT_VERSIONS[VARIANTS.indexOf(entry.variant)];
  const summary = entry.replaySummary, run = summary?.runs?.length === 1 ? summary.runs[0] : undefined;
  const decisions = Array.isArray(run?.decisions) ? run.decisions.map(safeDecision) : [];
  const calls = count(entry.calls, 300), food = count(entry.score?.food, 397), survivedTicks = count(entry.score?.survivedTicks, 7200);
  const complete = entry.phase === 'complete' && entry.eligibleForScore === true;
  const replayValid = summary?.schemaVersion === 1 && summary.gameId === 'snake' && summary.rulesVersion === 'snake-realtime-v2' &&
    summary.harnessVersion === harness && summary.harnessVersionSource === 'recorded' && entry.snakeHarnessVersion === harness &&
    run?.checks?.frameAgreement === true && run.checks.scoreAgreement === true && run.checks.inputActionAgreement === true &&
    sameScore(entry.score, run.score) && sameScore(run.score, run.originalScore) && summary.originalResult?.aborted === false;
  const decisionsComplete = calls !== null && calls === decisions.length && new Set(decisions.map(event => event.seq)).size === decisions.length && decisions.every(event => event.seq !== null);
  const errors = decisions.filter(event => ['failed', 'unknown'].includes(event.outcome)).length;
  const valid = complete && replayValid && decisionsComplete && food !== null && survivedTicks !== null &&
    !entry.failure && entry.result?.aborted === false && errors === 0;
  return {
    // Identifiers remain only in this internal object for joins, never public output.
    seed: entry.seed, profileId: entry.profileId, partition: entry.partition, variant: entry.variant,
    repetition: count(entry.repetition, 10000), harness, decisions,
    value: {
      phase: PHASES.includes(entry.phase) ? entry.phase : 'unknown', eligible: valid,
      food: valid ? food : null, survivedTicks: valid ? survivedTicks : null,
      endReason: REASONS.includes(run?.endReason) ? run.endReason : REASONS.includes(entry.reason) ? entry.reason : null,
      requests: calls, replayValid: Boolean(replayValid), decisionsComplete,
      error: Boolean(entry.failure) || errors > 0 || ['stopped', 'unknown'].includes(entry.phase),
      successfulMoves: count(run?.successfulMoves, 360), longestNoScoreMoves: count(run?.longestNoScoreMoves, 360),
      repeatedFullStateVisits: count(run?.repeatedFullStateVisits, 360), completedStateCycles: count(run?.completedStateCycles, 360),
      longestCycleMoves: count(run?.longestCycleMoves, 360),
      rulesVersion: summary?.rulesVersion === 'snake-realtime-v2' ? summary.rulesVersion : null,
      promptVersions: unique((Array.isArray(entry.promptVersions) ? entry.promptVersions : []).map(version)),
    },
  };
}
function metrics(entries) {
  const decisions = entries.flatMap(entry => entry.decisions), calls = entries.map(entry => entry.value.requests);
  return {
    sessions: entries.length, eligibleSessions: entries.filter(entry => entry.value.eligible).length,
    requests: sum(calls.filter(value => value !== null)), requestCountComplete: calls.every(value => value !== null),
    returnedDecisions: decisions.length, missingDecisionRecords: sum(entries.map(entry => Math.max(0, (entry.value.requests ?? 0) - entry.decisions.length))),
    errorSessions: entries.filter(entry => entry.value.error).length,
    invalidReplays: entries.filter(entry => !entry.value.replayValid).length,
    outcomes: Object.fromEntries(OUTCOMES.map(outcome => [outcome, decisions.filter(event => event.outcome === outcome).length])),
    latencyMs: distribution(decisions.map(event => event.elapsedMs)),
    observedToSettledTicks: distribution(decisions.map(event => event.ticksObservedToSettled)),
    observedToAppliedTicks: distribution(decisions.map(event => event.ticksObservedToApplied)),
    observedToSettledMoves: distribution(decisions.map(event => event.movesObservedToSettled)),
    observedToAppliedMoves: distribution(decisions.map(event => event.movesObservedToApplied)),
    longestNoScoreMoves: distribution(entries.map(entry => entry.value.longestNoScoreMoves)),
    completedStateCycles: distribution(entries.map(entry => entry.value.completedStateCycles)),
    repeatedFullStateVisits: distribution(entries.map(entry => entry.value.repeatedFullStateVisits)),
    thoughtUsed: { true: decisions.filter(event => event.thoughtUsed === true).length,
      false: decisions.filter(event => event.thoughtUsed === false).length, unreported: decisions.filter(event => event.thoughtUsed === null).length },
    actualModels: unique(decisions.map(event => event.actualModel)),
  };
}
function validateReport(report) {
  ensure(report?.schemaVersion === 1 && Array.isArray(report.entries) && report.entries.length <= 3000 &&
    Array.isArray(report.profiles) && report.profiles.length >= 1 && report.profiles.length <= 8);
  const ids = new Set();
  for (const profile of report.profiles) {
    ensure(typeof profile.profileId === 'string' && !ids.has(profile.profileId) && PROVIDERS.includes(profile.provider));
    ids.add(profile.profileId);
  }
  const entries = report.entries.map(projectEntry), keys = new Set();
  for (const entry of entries) {
    ensure(ids.has(entry.profileId));
    const key = JSON.stringify([entry.profileId, entry.partition, entry.seed, entry.variant, entry.repetition]);
    ensure(!keys.has(key)); keys.add(key);
  }
  return entries;
}
function indexedSeeds(entries, partition) {
  // Driver report entries preserve the pre-registered schedule order. Neither
  // performance nor completion order influences the public seed numbering.
  return [...new Set(entries.filter(entry => entry.partition === partition).map(entry => entry.seed))];
}
function group(entries, seeds, seedIndices) {
  return { metrics: metrics(entries), variants: VARIANTS.map(variant => ({ variant,
    meanFood: mean(entries.filter(entry => entry.variant === variant && entry.value.eligible).map(entry => entry.value.food)),
    meanSurvivedTicks: mean(entries.filter(entry => entry.variant === variant && entry.value.eligible).map(entry => entry.value.survivedTicks)),
    metrics: metrics(entries.filter(entry => entry.variant === variant)) })),
    seeds: seeds.map(seed => ({ seedIndex: seedIndices.get(seed),
      versions: Object.fromEntries(VARIANTS.map(variant => [variant, entries.find(entry => entry.seed === seed && entry.variant === variant)?.value ?? null])) })) };
}
function compare(statistics, seedIndices, clean, independentComplete, repeatsComplete) {
  return statistics.comparisons.map(comparison => {
    const variant = VARIANTS[SNAKE_EXPERIMENT_VERSIONS.indexOf(comparison.candidate)];
    const repeated = statistics.repeated.comparisons.find(item => item.candidate === comparison.candidate);
    const outcomes = comparison.originalRuleOutcomes;
    const netWins = outcomes.candidateWins - outcomes.controlWins;
    const interval = comparison.candidateMinusAConfidenceInterval;
    const repeatedMean = repeated.candidateMinusA.mean;
    const criteria = {
      twentyCompleteIndependentSeeds: independentComplete,
      fiveCompleteRepeatedSeeds: repeatsComplete,
      allFormalReplaysValidWithoutErrors: clean,
      meanFoodImprovementAtLeastHalf: comparison.candidateMinusA !== null && comparison.candidateMinusA >= 0.5,
      confidenceLowerBoundAboveZero: interval?.[0] !== undefined && interval[0] > 0,
      originalRuleNetWinsNonnegative: outcomes.unresolved === 0 && netWins >= 0,
      repeatedMeanFoodDifferenceNonnegative: repeated.pairedObservations === 5 && repeatedMean !== null && repeatedMean >= 0,
    };
    return { variant, contrast: `${variant} minus A`, meanFoodDifference: comparison.candidateMinusA,
      confidenceLevel: 0.975, confidenceInterval: interval, confidenceLowerBound: interval?.[0] ?? null,
      pairedIndependentSeeds: comparison.pairedSeedCount,
      originalRule: { ...outcomes, netWins },
      pairs: comparison.pairs.map(pair => ({ seedIndex: seedIndices.get(pair.seed), foodDifference: pair.candidateMinusA,
        survivedTicksDifference: pair.survivedTicksDifference, originalRuleWinner: pair.originalRuleWinner })),
      repeated: { pairedSeeds: repeated.pairedObservations, meanFoodDifference: repeatedMean,
        foodDifference: repeated.candidateMinusA, differenceFromOriginal: repeated.differenceFromOriginal,
        originalRule: { ...repeated.originalRuleOutcomes, netWins: repeated.originalRuleOutcomes.candidateWins - repeated.originalRuleOutcomes.controlWins },
        pairs: repeated.pairs.map(pair => ({ seedIndex: seedIndices.get(pair.seed), repetition: pair.repetition,
          foodDifference: pair.candidateMinusA, survivedTicksDifference: pair.survivedTicksDifference,
          differenceFromOriginal: pair.differenceFromOriginal, originalRuleWinner: pair.originalRuleWinner })) },
      gate: { passed: Object.values(criteria).every(Boolean), criteria, defaultChanged: false },
    };
  });
}

/** Pure projection: raw reports, credentials, seeds and session IDs never escape. */
export function createPublicSnakeReport(formalReport, pilotReport, { blockedProvider, blockedHttpStatus } = {}) {
  ensure(blockedProvider === undefined && blockedHttpStatus === undefined ||
    PROVIDERS.includes(blockedProvider) && Number.isInteger(blockedHttpStatus) && blockedHttpStatus >= 400 && blockedHttpStatus <= 599);
  const formal = validateReport(formalReport), pilot = validateReport(pilotReport).filter(entry => entry.partition === 'development');
  const acceptanceSeeds = indexedSeeds(formal, 'acceptance'), repeatSeeds = indexedSeeds(formal, 'repeat');
  const developmentSeeds = indexedSeeds(pilot, 'development');
  const seedIndices = new Map(acceptanceSeeds.map((seed, index) => [seed, index + 1]));
  const developmentIndices = new Map(developmentSeeds.map((seed, index) => [seed, index + 1]));
  ensure(repeatSeeds.every(seed => seedIndices.has(seed)) && developmentSeeds.every(seed => !seedIndices.has(seed)));
  const allProfiles = [...formalReport.profiles];
  for (const profile of pilotReport.profiles) {
    const existing = allProfiles.find(item => item.profileId === profile.profileId);
    if (existing) ensure(existing.provider === profile.provider && existing.model === profile.model);
    else allProfiles.push(profile);
  }
  const models = allProfiles.map((profile, index) => {
    const rows = formal.filter(entry => entry.profileId === profile.profileId && entry.partition !== 'development');
    const independent = rows.filter(entry => entry.partition === 'acceptance'), repeated = rows.filter(entry => entry.partition === 'repeat');
    const development = pilot.filter(entry => entry.profileId === profile.profileId);
    const samples = rows.filter(entry => entry.value.eligible).map(entry => ({ seed: entry.seed, harnessVersion: entry.harness,
      food: entry.value.food, survivedTicks: entry.value.survivedTicks, cohort: entry.partition === 'acceptance' ? 'independent' : 'repeat',
      ...(entry.partition === 'repeat' && entry.repetition !== null ? { repetition: entry.repetition } : {}) }));
    const statistics = reportPairwise(samples);
    const clean = !formalReport.halted && rows.every(entry => entry.value.eligible) && rows.length > 0;
    const independentComplete = acceptanceSeeds.length === 20 && independent.length === 60 && statistics.independentDesignComplete;
    const repeatsComplete = repeatSeeds.length === 5 && repeated.length === 15 && repeated.every(entry => entry.value.eligible && entry.repetition === 1);
    return { modelIndex: index + 1, provider: profile.provider, requestedModel: model(profile.model),
      requestedModelIsServiceDefault: profile.model === '', thinkMode: 'never',
      actualModels: metrics([...rows, ...development]).actualModels,
      development: group(development, developmentSeeds, developmentIndices),
      independent: group(independent, acceptanceSeeds, seedIndices), repeated: group(repeated, repeatSeeds, seedIndices),
      repeatMinusOriginal: statistics.repeated.rows.map(row => ({ seedIndex: seedIndices.get(row.seed),
        variant: VARIANTS[SNAKE_EXPERIMENT_VERSIONS.indexOf(row.harnessVersion)], repetition: row.repetition,
        foodDelta: row.foodDelta, survivedTicksDelta: row.survivedTicksDelta, referenceAvailable: row.referenceAvailable,
        originalRuleWinner: row.originalRuleWinner })),
      comparisons: compare(statistics, seedIndices, clean, independentComplete, repeatsComplete),
    };
  });
  return { schemaVersion: 1, gameId: 'snake', defaultHarness: SNAKE_EXPERIMENT_VERSIONS[0], defaultChanged: false,
    seedsReference: 'seeds.json', seedIndexBase: 1,
    rulesVersions: unique([...formal, ...pilot].map(entry => entry.value.rulesVersion)),
    harnessVersions: [...SNAKE_EXPERIMENT_VERSIONS], promptVersions: unique([...formal, ...pilot].flatMap(entry => entry.value.promptVersions)),
    sourceHash: HASH.test(formalReport.sourceManifest?.sha256) ? formalReport.sourceManifest.sha256 : null,
    planHash: HASH.test(formalReport.planHash) ? formalReport.planHash : null,
    developmentSourceHash: HASH.test(pilotReport.sourceManifest?.sha256) ? pilotReport.sourceManifest.sha256 : null,
    halted: formalReport.halted === true, globalMaxRequests: count(formalReport.globalMaxRequests),
    externalBlocked: blockedProvider === undefined ? [] : [{ provider: blockedProvider, httpStatus: blockedHttpStatus, includedInScores: false }],
    method: 'Paired percentile bootstrap; 10000 resamples; fixed seeds 20261017/20261018; two 97.5% two-sided intervals; nominal Bonferroni familywise target 0.05; bootstrap approximation.',
    quantileMethod: 'R-7 linear interpolation',
    originalRule: 'food first, then survivedTicks; missing survival on equal food is unresolved',
    timingMeaning: 'appliedTick is input acceptance before a physics tick, not a completed snake turn; later inputs can replace a queued turn',
    evidenceLimit: 'Development is separate. Repeated seeds are descriptive and excluded from confidence intervals. Failed, incomplete or invalid-replay runs are not scored as zero. Passing gates is evidence only for the tested model, not all models, and does not change the default.',
    totals: { development: metrics(pilot), formal: metrics(formal.filter(entry => entry.partition !== 'development')) }, models };
}

/** Per-call audit companion. Session UUIDs are allowed; account/profile IDs and
 * raw seeds remain private. This uses only the already-sanitized replaySummary,
 * never raw request/response/replay fields or arbitrary driver error messages. */
export function createSnakeAuditEvents(formalReport, pilotReport) {
  const formal = validateReport(formalReport), pilot = validateReport(pilotReport);
  const seeds = indexedSeeds(formal, 'acceptance'), developmentSeeds = indexedSeeds(pilot, 'development');
  const seedIndices = new Map(seeds.map((seed, index) => [seed, index + 1]));
  const developmentIndices = new Map(developmentSeeds.map((seed, index) => [seed, index + 1]));
  ensure(indexedSeeds(formal, 'repeat').every(seed => seedIndices.has(seed)) && developmentSeeds.every(seed => !seedIndices.has(seed)));
  const profiles = [...formalReport.profiles];
  for (const profile of pilotReport.profiles) {
    const existing = profiles.find(item => item.profileId === profile.profileId);
    if (existing) ensure(existing.provider === profile.provider && existing.model === profile.model);
    else profiles.push(profile);
  }
  const sourceRows = [...pilotReport.entries.filter(entry => entry.partition === 'development'),
    ...formalReport.entries.filter(entry => ['acceptance', 'repeat'].includes(entry.partition))];
  const sessions = sourceRows.map(entry => {
    const projected = projectEntry(entry), profileIndex = profiles.findIndex(profile => profile.profileId === entry.profileId);
    const profile = profiles[profileIndex], rawRun = entry.replaySummary?.runs?.length === 1 ? entry.replaySummary.runs[0] : undefined;
    const decisions = Array.isArray(rawRun?.decisions) ? rawRun.decisions.map(auditDecision) : [];
    const sessionId = typeof entry.sessionId === 'string' && /^(?:arcade-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.sessionId) ? entry.sessionId : null;
    return {
      sessionId, modelIndex: profileIndex + 1,
      seedIndex: (entry.partition === 'development' ? developmentIndices : seedIndices).get(entry.seed),
      cohort: entry.partition === 'acceptance' ? 'independent' : entry.partition,
      repetition: projected.repetition, variant: projected.variant, phase: projected.value.phase,
      eligibleForScore: projected.value.eligible, replayValid: projected.value.replayValid,
      requests: projected.value.requests, decisionsComplete: projected.value.decisionsComplete,
      rulesVersion: projected.value.rulesVersion, harnessVersion: projected.harness,
      promptVersions: projected.value.promptVersions, provider: profile.provider,
      requestedModel: model(profile.model), requestedModelIsServiceDefault: profile.model === '',
      actualModels: unique(decisions.map(event => event.actualModel)), decisions,
    };
  });
  return { schemaVersion: 1, gameId: 'snake', seedsReference: 'seeds.json', seedIndexBase: 1,
    timingMeaning: 'appliedTick accepts an input before a physics tick; nextSnakeMovementTick is a possible movement boundary, not proof that this turn executed; later inputs can replace it',
    sessionAccess: 'Session UUIDs support local audit; reading a private session still requires its owner authentication.',
    sessions };
}

const fmt = value => value === null || value === undefined ? '未返回' : typeof value === 'number' ? String(Number(value.toFixed(3))) : String(value);
const status = value => value ? '通过' : '未通过';
const cell = run => !run ? '缺失' : !run.eligible ? `无效（${run.phase}）` : `${run.food} / ${run.survivedTicks}（${fmt(run.survivedTicks / 60)}s；${run.endReason ?? '原因未返回'}）`;
function metricLines(value) {
  return [
    `请求 ${value.requests}；可核对 decision ${value.returnedDecisions}；缺失 ${value.missingDecisionRecords}；错误局 ${value.errorSessions}；无效回放 ${value.invalidReplays}。`,
    `applied / dropped / failed / unknown：${OUTCOMES.map(key => value.outcomes[key]).join(' / ')}。延迟 R7 中位数 / P95：${fmt(value.latencyMs.median)} / ${fmt(value.latencyMs.p95)} ms（n=${value.latencyMs.count}）。`,
    `观察→settled tick 中位数 / P95：${fmt(value.observedToSettledTicks.median)} / ${fmt(value.observedToSettledTicks.p95)}；移动格数：${fmt(value.observedToSettledMoves.median)} / ${fmt(value.observedToSettledMoves.p95)}。`,
    `观察→applied tick 中位数 / P95：${fmt(value.observedToAppliedTicks.median)} / ${fmt(value.observedToAppliedTicks.p95)}；移动格数：${fmt(value.observedToAppliedMoves.median)} / ${fmt(value.observedToAppliedMoves.p95)}。`,
    `最长无得分移动：${fmt(value.longestNoScoreMoves.max)} 格；完整状态循环总数：${fmt(value.completedStateCycles.mean === null ? null : value.completedStateCycles.mean * value.completedStateCycles.count)}；重复状态访问总数：${fmt(value.repeatedFullStateVisits.mean === null ? null : value.repeatedFullStateVisits.mean * value.repeatedFullStateVisits.count)}。`,
    `thoughtUsed true / false / 未返回：${value.thoughtUsed.true} / ${value.thoughtUsed.false} / ${value.thoughtUsed.unreported}。`,
  ].join('\n\n');
}
function seedTable(group, comparisons = []) {
  const lines = ['| 种子序号 | A：食物 / 生存 tick | B：食物 / 生存 tick | C：食物 / 生存 tick | B−A 原规则 | C−A 原规则 |', '|---|---|---|---|---|---|'];
  const winner = (variant, seedIndex) => {
    const pair = comparisons.find(item => item.variant === variant)?.pairs.find(item => item.seedIndex === seedIndex);
    return !pair ? '未判定' : ({ candidate: '+1', control: '−1', tie: '0' })[pair.originalRuleWinner] ?? '未判定';
  };
  for (const row of group.seeds) lines.push(`| ${String(row.seedIndex).padStart(2, '0')} | ${cell(row.versions.A)} | ${cell(row.versions.B)} | ${cell(row.versions.C)} | ${winner('B', row.seedIndex)} | ${winner('C', row.seedIndex)} |`);
  return lines.join('\n');
}
export function renderSnakeMarkdown(report) {
  const lines = ['# 贪吃蛇 Harness A/B/C 实验报告', '',
    '开发预实验、独立验收与重复实验分别列出。种子序号按预先登记的 schedule 顺序，原始种子见 [seeds.json](seeds.json)；不按得分或完成时间重排。', '',
    `规则：${report.rulesVersions.join(', ') || '未返回'}；提示协议：${report.promptVersions.join(', ') || '未返回'}。`, '',
    ...report.harnessVersions.map((harness, index) => `- ${VARIANTS[index]}：${harness}`), '',
    `默认仍为 A；本报告不会自动改变默认。单一 Jev 模型达到门槛也不足以推断其他模型应切换。正式批次暂停/失败：${report.halted ? '是' : '否'}。`, '',
    `源代码 SHA-256：${report.sourceHash ?? '未返回'}；计划 SHA-256：${report.planHash ?? '未返回'}。`, '',
    '统计采用固定随机种子、10000 次配对重采样，分别报告 B−A、C−A 的 97.5% 双侧区间；这是 nominal Bonferroni familywise target 0.05 的 bootstrap 近似，并非有限样本覆盖保证。延迟和时序指标使用 R7 分位数。', '',
    '原规则先比较食物，再比较生存 tick（60 tick/s）。无效、缺失、异常局不按 0 分处理。重复实验不作为独立样本进入置信区间。applied tick 表示输入已进入下一物理步，不等于蛇已完成转向；后续输入可覆盖排队转向。', '',
    '## 全部请求与证据完整性', '', '### 开发预实验', '', metricLines(report.totals.development), '', '### 正式独立与重复实验', '', metricLines(report.totals.formal), ''];
  if (report.externalBlocked.length) {
    lines.push('## 未纳入评分的外部阻塞', '');
    for (const item of report.externalBlocked) lines.push(`${item.provider === 'systemone' ? 'StartLux / System One' : item.provider}：HTTP ${item.httpStatus}。未纳入评分或置信区间，也不按 0 分、失败局或模型能力结论处理。此记录由发布命令显式提供；渲染器未读取凭证或发起验证请求。`, '');
  }
  for (const item of report.models) {
    lines.push(`## 模型 ${item.modelIndex}：${item.requestedModel ?? (item.requestedModelIsServiceDefault ? '服务默认模型' : '未返回')}`, '',
      `提供商：${item.provider}；实际返回模型：${item.actualModels.join(', ') || '未返回'}；请求思考配置：never。`, '',
      '### 开发预实验（不参与验收）', '', seedTable(item.development), '', metricLines(item.development.metrics), '',
      '### 20 个独立种子', '', seedTable(item.independent, item.comparisons), '', metricLines(item.independent.metrics), '',
      '| 版本 | 平均食物 | 平均生存 tick | 请求 | drop | 延迟中位数 / P95 ms |', '|---|---|---|---|---|---|');
    for (const variant of item.independent.variants) lines.push(`| ${variant.variant} | ${fmt(variant.meanFood)} | ${fmt(variant.meanSurvivedTicks)} | ${variant.metrics.requests} | ${variant.metrics.outcomes.dropped} | ${fmt(variant.metrics.latencyMs.median)} / ${fmt(variant.metrics.latencyMs.p95)} |`);
    lines.push('', '### 5 个重复种子（仅描述波动）', '',
      seedTable(item.repeated, item.comparisons.map(comparison => ({ variant: comparison.variant, pairs: comparison.repeated.pairs }))), '', metricLines(item.repeated.metrics), '',
      '| 种子序号 | 版本 | 重复−原始食物 | 重复−原始生存 tick |', '|---|---|---|---|');
    for (const row of item.repeatMinusOriginal) lines.push(`| ${String(row.seedIndex).padStart(2, '0')} | ${row.variant} | ${fmt(row.foodDelta)} | ${fmt(row.survivedTicksDelta)} |`);
    lines.push('', '### 预先指定的联合门槛', '',
      '| 比较 | 食物均差 | 97.5% CI | CI 下界 | 原规则净胜 | 重复均差 | 重复差值 min / max | 联合门槛 |', '|---|---|---|---|---|---|---|---|');
    for (const comparison of item.comparisons) {
      lines.push(`| ${comparison.contrast} | ${fmt(comparison.meanFoodDifference)} | ${comparison.confidenceInterval ? comparison.confidenceInterval.map(fmt).join(' ～ ') : '未返回'} | ${fmt(comparison.confidenceLowerBound)} | ${comparison.originalRule.netWins} | ${fmt(comparison.repeated.meanFoodDifference)} | ${fmt(comparison.repeated.foodDifference.min)} / ${fmt(comparison.repeated.foodDifference.max)} | ${status(comparison.gate.passed)} |`);
    }
    lines.push('', '只有全部满足才通过：20 个独立种子完整、5 个重复种子完整、正式局无错误且回放校验通过、食物均差 ≥0.5、CI 下界 >0、原规则净胜 ≥0、重复配对食物均差 ≥0。', '');
    for (const comparison of item.comparisons) lines.push(`${comparison.contrast} 未通过项：${Object.entries(comparison.gate.criteria).filter(([, passed]) => !passed).map(([key]) => key).join(', ') || '无'}。`, '');
  }
  lines.push('汇总报告仅含白名单指标，不包含私有接口地址、凭证、用户/会话 ID、原始请求、思考正文或完整回放。独立 .events.json 保留格式校验后的 session ID 和逐调用时序用于本地核对；私有对局仍需所有者登录才能读取。');
  return lines.join('\n') + '\n';
}

export async function main(args = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    ensure(['--report', '--pilot', '--out', '--blocked-provider', '--blocked-http-status'].includes(args[i]) && args[i + 1] && !options[args[i]]);
    options[args[i]] = args[i + 1];
  }
  ensure(options['--report'] && options['--pilot'] && options['--out']);
  const read = async filename => {
    ensure((await fs.stat(filename)).size <= 64 * 1024 * 1024);
    return JSON.parse(await fs.readFile(filename, 'utf8'));
  };
  const [formal, pilot] = await Promise.all([read(options['--report']), read(options['--pilot'])]);
  const report = createPublicSnakeReport(formal, pilot, { blockedProvider: options['--blocked-provider'],
    blockedHttpStatus: options['--blocked-http-status'] === undefined ? undefined : Number(options['--blocked-http-status']) }), markdown = renderSnakeMarkdown(report);
  const events = createSnakeAuditEvents(formal, pilot);
  const prefix = path.resolve(options['--out']);
  const paths = [prefix + '.json', prefix + '.md', prefix + '.events.json'];
  for (const filename of paths) ensure(![options['--report'], options['--pilot']].map(value => path.resolve(value)).includes(filename));
  await fs.mkdir(path.dirname(prefix), { recursive: true });
  // Reserve all destinations first so an existing output cannot be overwritten.
  const handles = [];
  try {
    for (const filename of paths) handles.push(await fs.open(filename, 'wx', 0o600));
    await handles[0].writeFile(JSON.stringify(report, null, 2) + '\n');
    await handles[1].writeFile(markdown);
    await handles[2].writeFile(JSON.stringify(events, null, 2) + '\n');
  } catch (error) {
    await Promise.all(handles.map(handle => handle.close()));
    await Promise.all(paths.slice(0, handles.length).map(filename => fs.unlink(filename)));
    handles.length = 0;
    throw error;
  } finally { await Promise.all(handles.map(handle => handle.close())); }
  return { filesWritten: 3, models: report.models.length };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(result => console.log(JSON.stringify({ type: 'report-rendered', ...result }))).catch(() => {
    console.error(JSON.stringify({ type: 'render-failed', code: 'INVALID_INPUT_OR_OUTPUT_UNAVAILABLE', privateErrorsOmitted: true }));
    process.exitCode = 1;
  });
}
