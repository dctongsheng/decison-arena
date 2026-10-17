import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPublicSnakeReport, createSnakeAuditEvents, renderSnakeMarkdown, main } from './render-snake-experiment-report.mjs';

const variants = ['A', 'B', 'C'];
const versions = variants.map(value => `snake-harness-${value.toLowerCase()}-v1`);
const clone = value => structuredClone(value);
function entry(seed, variant, partition = 'acceptance', profileId = 'private-profile-1') {
  const index = variants.indexOf(variant), score = { food: index, points: index * 100, survivedTicks: 600 + index * 20 };
  const decisions = [100, 200, 400].map((elapsedMs, i) => ({ seq: i + 1, elapsedMs,
    outcome: i === 2 ? 'dropped' : 'applied', actualModel: 'typesafe/jev-1.14', thoughtUsed: i === 2 ? null : false,
    ticksObservedToSettled: 60 + i * 20, ticksObservedToApplied: i === 2 ? null : 61 + i * 20,
    movesObservedToSettled: 3 + i, movesObservedToApplied: i === 2 ? null : 3 + i }));
  return { seed, variant, partition, profileId, cohort: partition === 'acceptance' ? 'independent' : 'repeat',
    ...(partition === 'repeat' ? { repetition: 1 } : {}), phase: 'complete', eligibleForScore: true, calls: 3,
    snakeHarnessVersion: versions[index], score, result: { aborted: false, reason: 'runs_finished' },
    // Deliberately incompatible legacy quantile output must not influence rendering.
    latencyMs: { p50: 999999, p95: 999999 }, promptVersions: ['decision-arena-arcade-v4'],
    replaySummary: { schemaVersion: 1, gameId: 'snake', rulesVersion: 'snake-realtime-v2',
      harnessVersion: versions[index], harnessVersionSource: 'recorded', originalResult: { aborted: false },
      runs: [{ score, originalScore: score, endReason: 'WALL_COLLISION', successfulMoves: 29 + index,
        longestNoScoreMoves: 12 + index, completedStateCycles: index, repeatedFullStateVisits: 2 * index,
        longestCycleMoves: 8, decisions, checks: { frameAgreement: true, scoreAgreement: true, inputActionAgreement: true } }] } };
}
function fixture() {
  // The lexical order intentionally differs from the pre-registered order.
  const seeds = Array.from({ length: 20 }, (_, index) => `private-seed-${20 - index}`);
  const repeats = [seeds[0], seeds[3], seeds[6], seeds[9], seeds[12]];
  const profile = { profileId: 'private-profile-1', provider: 'openrouter', model: 'typesafe/jev-1.14' };
  const formal = { schemaVersion: 1, profiles: [profile], halted: false, globalMaxRequests: 4000,
    sourceManifest: { sha256: 'a'.repeat(64) }, planHash: 'b'.repeat(64),
    entries: [...seeds.flatMap((seed, index) => variants.map((_, offset) => entry(seed, variants[(index + offset) % 3]))),
      ...repeats.flatMap(seed => variants.map(variant => entry(seed, variant, 'repeat')))],
    statistics: [{ ignored: 'NEVER_TRUST_PRECOMPUTED_OR_ARBITRARY_FIELDS', passed: false }] };
  const pilot = { schemaVersion: 1, profiles: [profile], halted: false, sourceManifest: { sha256: 'a'.repeat(64) },
    entries: variants.map(variant => entry('private-development-seed', variant, 'development')) };
  return { formal, pilot };
}

test('renders complete 20-seed comparisons and five repeats using fixed pre-registered indices, without changing default', () => {
  const { formal, pilot } = fixture(), before = JSON.stringify({ formal, pilot });
  const report = createPublicSnakeReport(formal, pilot), model = report.models[0];
  assert.equal(model.independent.seeds.length, 20);
  assert.deepEqual(model.repeated.seeds.map(row => row.seedIndex), [1, 4, 7, 10, 13]);
  assert.equal(model.development.seeds.length, 1);
  assert.equal(model.comparisons[0].meanFoodDifference, 1);
  assert.deepEqual(model.comparisons[0].confidenceInterval, [1, 1]);
  assert.equal(model.comparisons[0].originalRule.netWins, 20);
  assert.equal(model.comparisons[0].repeated.meanFoodDifference, 1);
  assert.equal(model.comparisons[0].gate.passed, true);
  assert.equal(model.comparisons[1].gate.passed, true);
  assert.equal(report.defaultChanged, false);
  assert.equal(report.defaultHarness, versions[0]);
  assert.equal(JSON.stringify({ formal, pilot }), before);
  const markdown = renderSnakeMarkdown(report);
  assert.match(markdown, /20 个独立种子/);
  assert.match(markdown, /5 个重复种子/);
  assert.match(markdown, /\[seeds.json\]\(seeds.json\)/);
  assert.match(markdown, /单一 Jev 模型达到门槛也不足/);
  assert.match(markdown, /nominal Bonferroni/);
  assert.doesNotMatch(markdown, /private-seed/);
});

test('recomputes all latency and timing R7 quantiles from safe replay decisions, not driver nearest-rank statistics', () => {
  const { formal, pilot } = fixture();
  const report = createPublicSnakeReport(formal, pilot), dev = report.totals.development;
  assert.equal(report.totals.formal.requests, 225);
  assert.equal(report.totals.formal.returnedDecisions, 225);
  assert.equal(report.totals.formal.outcomes.dropped, 75);
  assert.equal(report.totals.formal.outcomes.failed, 0);
  assert.equal(dev.requests, 9);
  // One variant has [100,200,400]: R7 P95=380, nearest rank would be 400.
  const one = report.models[0].development.variants[0].metrics;
  assert.equal(one.latencyMs.median, 200);
  assert.ok(Math.abs(one.latencyMs.p95 - 380) < 1e-9);
  assert.equal(one.observedToAppliedTicks.count, 2);
  assert.equal(one.observedToAppliedTicks.median, 71);
  assert.equal(one.observedToAppliedMoves.median, 3.5);
  assert.equal(one.longestNoScoreMoves.max, 12);
  assert.deepEqual(one.thoughtUsed, { true: 0, false: 2, unreported: 1 });
  assert.doesNotMatch(JSON.stringify(report), /:999999[,}]/);
});

test('independent, repeat and development evidence cannot contaminate each other or silently treat invalid runs as zero', () => {
  const { formal, pilot } = fixture();
  const bad = formal.entries.find(row => row.partition === 'acceptance' && row.variant === 'B');
  bad.replaySummary.runs[0].checks.inputActionAgreement = false;
  pilot.entries.forEach(row => { row.score.food = 300; row.replaySummary.runs[0].score.food = 300; });
  const report = createPublicSnakeReport(formal, pilot), model = report.models[0];
  assert.equal(model.independent.seeds[0].versions.B.food, null);
  assert.equal(model.comparisons[0].pairedIndependentSeeds, 19);
  assert.equal(model.comparisons[0].gate.passed, false);
  assert.equal(model.comparisons[1].gate.passed, false); // whole formal batch must be clean
  assert.equal(report.totals.formal.invalidReplays, 1);
  assert.equal(model.comparisons[0].meanFoodDifference, 1);
  assert.match(renderSnakeMarkdown(report), /无效（complete）/);
});

test('repeat regression blocks the repeat gate while retaining positive independent evidence', () => {
  const { formal, pilot } = fixture();
  for (const row of formal.entries.filter(row => row.partition === 'repeat')) {
    const food = row.variant === 'A' ? 2 : 0;
    row.score.food = food; row.score.points = food * 100;
  }
  const report = createPublicSnakeReport(formal, pilot), candidate = report.models[0].comparisons[0];
  assert.equal(candidate.meanFoodDifference, 1);
  assert.equal(candidate.confidenceLowerBound, 1);
  assert.equal(candidate.repeated.meanFoodDifference, -2);
  assert.equal(candidate.gate.criteria.repeatedMeanFoodDifferenceNonnegative, false);
  assert.equal(candidate.gate.passed, false);
  assert.equal(report.models[0].repeatMinusOriginal.find(row => row.variant === 'B').foodDelta, -1);
});

test('missing, failed and halted evidence fails closed and does not hide known billed calls', () => {
  const { formal, pilot } = fixture();
  formal.entries[0].failure = 'PRIVATE_UPSTREAM_ERROR';
  formal.entries[0].replaySummary.runs[0].decisions[0].outcome = 'failed';
  formal.entries[1].replaySummary = undefined;
  formal.halted = true;
  const report = createPublicSnakeReport(formal, pilot);
  assert.equal(report.totals.formal.requests, 225);
  assert.equal(report.totals.formal.missingDecisionRecords, 3);
  assert.equal(report.totals.formal.outcomes.failed, 1);
  assert.equal(report.totals.formal.errorSessions, 1);
  assert.equal(report.models[0].comparisons[0].gate.passed, false);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_UPSTREAM_ERROR/);
  const missing = fixture();
  missing.formal.entries = missing.formal.entries.filter(row => row.partition !== 'repeat' || row.seed !== 'private-seed-20');
  assert.equal(createPublicSnakeReport(missing.formal, missing.pilot).models[0].comparisons[0].gate.criteria.fiveCompleteRepeatedSeeds, false);
});

test('profiles remain separate and unreported thought/model fields are not synthesized', () => {
  const { formal, pilot } = fixture();
  formal.profiles.push({ profileId: 'private-profile-2', provider: 'systemone', model: '' });
  const second = formal.entries.map(row => ({ ...clone(row), profileId: 'private-profile-2' }));
  for (const row of second) for (const decision of row.replaySummary.runs[0].decisions) {
    delete decision.actualModel; delete decision.thoughtUsed;
  }
  formal.entries.push(...second);
  const report = createPublicSnakeReport(formal, pilot);
  assert.equal(report.models.length, 2);
  assert.equal(report.models[1].independent.metrics.requests, 180);
  assert.equal(report.models[1].requestedModel, null);
  assert.equal(report.models[1].requestedModelIsServiceDefault, true);
  assert.deepEqual(report.models[1].actualModels, []);
  assert.deepEqual(report.models[1].independent.metrics.thoughtUsed, { true: 0, false: 0, unreported: 180 });
});

test('white-list projection excludes private identifiers, endpoints, secrets, text and raw replay regardless of nesting', () => {
  const { formal, pilot } = fixture(), marker = 'PRIVATE_PAYLOAD_DO_NOT_EXPORT';
  Object.assign(formal, { cookie: marker, token: marker, endpoint: `https://${marker}.invalid`, privateReplay: { frames: marker } });
  formal.sourceManifest.files = [{ path: marker, sha256: marker }];
  for (const profile of formal.profiles) Object.assign(profile, { apiKey: marker, credentialId: marker, endpoint: marker });
  for (const row of formal.entries) {
    Object.assign(row, { sessionId: marker, message: marker, request: marker, actualModels: [marker] });
    row.replaySummary.reasoning = { text: marker };
    for (const decision of row.replaySummary.runs[0].decisions) Object.assign(decision, { reasoning: marker, raw: marker, usage: { secret: marker } });
  }
  formal.entries[0].replaySummary.runs[0].decisions[0].actualModel = '<script>alert(1)</script>';
  formal.entries[0].replaySummary.runs[0].endReason = marker;
  formal.entries[0].promptVersions.push(marker);
  const report = createPublicSnakeReport(formal, pilot), output = JSON.stringify(report) + renderSnakeMarkdown(report) + JSON.stringify(createSnakeAuditEvents(formal, pilot));
  for (const forbidden of [marker, 'private-profile', 'private-seed', 'private-development', '<script>', 'credentialId', 'apiKey', 'https://']) assert.ok(!output.includes(forbidden), forbidden);
});

test('audit companion preserves each safe call timestamp, action mapping and numeric usage with original seed indices', () => {
  const { formal, pilot } = fixture();
  const id = 'arcade-12345678-1234-1234-1234-123456789abc';
  formal.entries[0].sessionId = id;
  Object.assign(formal.entries[0].replaySummary.runs[0].decisions[0], {
    actionId: 'up:100', observedTick: 40, settledTick: 101, appliedTick: 102, nextSnakeMovementTick: 120,
    appliedWithinReplay: true, inputActionConsistent: true,
    usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15, reasoning_tokens: 0,
      privateNumeric: 987, cached_tokens: NaN, prompt_tokens: Infinity, completion_tokens: -1 },
  });
  const audit = createSnakeAuditEvents(formal, pilot);
  assert.equal(audit.sessions.length, 78);
  assert.equal(audit.sessions[0].cohort, 'development');
  const session = audit.sessions.find(row => row.sessionId === id);
  assert.equal(session.seedIndex, 1);
  assert.equal(session.cohort, 'independent');
  assert.equal(session.rulesVersion, 'snake-realtime-v2');
  assert.equal(session.harnessVersion, versions[0]);
  assert.equal(session.requestedModel, 'typesafe/jev-1.14');
  assert.deepEqual(session.actualModels, ['typesafe/jev-1.14']);
  assert.deepEqual(session.decisions[0], {
    seq: 1, outcome: 'applied', elapsedMs: 100, actualModel: 'typesafe/jev-1.14', thoughtUsed: false,
    ticksObservedToSettled: 60, ticksObservedToApplied: 61, movesObservedToSettled: 3, movesObservedToApplied: 3,
    actionId: 'up:100', observedTick: 40, settledTick: 101, appliedTick: 102, nextSnakeMovementTick: 120,
    appliedWithinReplay: true, inputActionConsistent: true,
    usage: { total_tokens: 15, input_tokens: 11, output_tokens: 4, reasoning_tokens: 0 },
  });
  assert.equal(session.decisions[2].appliedTick, null);
  assert.equal(session.decisions[2].nextSnakeMovementTick, null);
  assert.equal(session.decisions[2].thoughtUsed, null);
  assert.equal(session.decisions[2].usage, null);
  assert.deepEqual([...new Set(audit.sessions.filter(row => row.cohort === 'repeat').map(row => row.seedIndex))], [1, 4, 7, 10, 13]);
  assert.doesNotMatch(JSON.stringify(audit), /privateNumeric|private-profile|private-seed/);
});

test('audit event identifiers and values cannot be used to smuggle tokens, endpoints or raw text', () => {
  const { formal, pilot } = fixture(), marker = 'PRIVATE_PAYLOAD_MUST_NOT_LEAVE';
  formal.entries[0].sessionId = `https://${marker}.invalid`;
  Object.assign(formal.entries[0].replaySummary.runs[0].decisions[0], {
    actionId: marker, seq: marker, elapsedMs: marker, observedTick: marker,
    settledTick: Infinity, appliedTick: -1, nextSnakeMovementTick: 9000,
    inputActionConsistent: marker, actualModel: `sk-${marker}`, thoughtUsed: marker,
    reasoning: marker, rawbody: marker, endpoint: marker, apiKey: marker, profileId: marker, userId: marker,
    usage: { total_tokens: marker, input_tokens: { private: marker }, privateNumeric: 1234 },
  });
  const audit = createSnakeAuditEvents(formal, pilot), session = audit.sessions.find(row => row.cohort === 'independent');
  assert.equal(session.sessionId, null);
  const event = session.decisions[0];
  for (const key of ['actionId', 'seq', 'elapsedMs', 'observedTick', 'settledTick', 'appliedTick', 'nextSnakeMovementTick', 'inputActionConsistent', 'actualModel', 'thoughtUsed', 'usage']) assert.equal(event[key], null, key);
  const output = JSON.stringify(audit);
  for (const forbidden of [marker, 'rawbody', 'endpoint', 'apiKey', 'profileId', 'userId', 'privateNumeric']) assert.ok(!output.includes(forbidden), forbidden);
});

test('rejects duplicate sessions, overlapping development seeds and unmatched repeat seeds instead of relabeling evidence', () => {
  const a = fixture(); a.formal.entries.push(clone(a.formal.entries[0]));
  assert.throws(() => createPublicSnakeReport(a.formal, a.pilot), /INVALID_REPORT/);
  const b = fixture(); b.pilot.entries.forEach(row => { row.seed = b.formal.entries[0].seed; });
  assert.throws(() => createPublicSnakeReport(b.formal, b.pilot), /INVALID_REPORT/);
  const c = fixture(); c.formal.entries.find(row => row.partition === 'repeat').seed = 'unknown-seed';
  assert.throws(() => createPublicSnakeReport(c.formal, c.pilot), /INVALID_REPORT/);
});

test('explicit blocked-provider evidence remains outside all scoring and cannot carry arbitrary upstream text', () => {
  const { formal, pilot } = fixture();
  const report = createPublicSnakeReport(formal, pilot, { blockedProvider: 'systemone', blockedHttpStatus: 401 });
  assert.deepEqual(report.externalBlocked, [{ provider: 'systemone', httpStatus: 401, includedInScores: false }]);
  assert.equal(report.totals.formal.requests, 225);
  assert.equal(report.models[0].comparisons[0].gate.passed, true);
  assert.match(renderSnakeMarkdown(report), /StartLux \/ System One：HTTP 401/);
  assert.throws(() => createPublicSnakeReport(formal, pilot, { blockedProvider: 'PRIVATE_PAYLOAD', blockedHttpStatus: 401 }), /INVALID_REPORT/);
  assert.throws(() => createPublicSnakeReport(formal, pilot, { blockedProvider: 'systemone' }), /INVALID_REPORT/);
});

test('CLI uses synthetic local files only and does not overwrite an existing output', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snake-renderer-fixture-'));
  try {
    const { formal, pilot } = fixture(), reportFile = path.join(dir, 'formal.report.json'), pilotFile = path.join(dir, 'pilot.report.json'), out = path.join(dir, 'public');
    await fs.writeFile(reportFile, JSON.stringify(formal)); await fs.writeFile(pilotFile, JSON.stringify(pilot));
    assert.deepEqual(await main(['--report', reportFile, '--pilot', pilotFile, '--out', out]), { filesWritten: 3, models: 1 });
    const publicJson = await fs.readFile(out + '.json', 'utf8'), publicMd = await fs.readFile(out + '.md', 'utf8');
    assert.doesNotMatch(publicJson, /private-seed/);
    assert.match(publicMd, /贪吃蛇 Harness/);
    const events = JSON.parse(await fs.readFile(out + '.events.json', 'utf8'));
    assert.equal(events.sessions.length, 78);
    assert.doesNotMatch(JSON.stringify(events), /private-seed|private-profile/);
    await assert.rejects(main(['--report', reportFile, '--pilot', pilotFile, '--out', out]));
    assert.equal(await fs.readFile(out + '.json', 'utf8'), publicJson);
    assert.equal(await fs.readFile(reportFile, 'utf8'), JSON.stringify(formal));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
