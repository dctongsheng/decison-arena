import test from 'node:test';
import assert from 'node:assert/strict';
import { schedule, safeDecision, distribution, verifyReplay, VERSIONS } from './tetris-v8-experiment.mjs';
import { tsImport } from 'tsx/esm/api';
const { tetris } = await tsImport('../packages/games/src/arcade/tetris.ts', import.meta.url);

test('predeclared paired seeds alternate order and separate the explicit repeat', () => {
  const rows = schedule('acceptance');
  assert.equal(rows.length, 14);
  assert.equal(new Set(rows.filter(e => e.partition === 'acceptance').map(e => e.seed)).size, 6);
  for (let i = 0; i < 12; i += 2) {
    assert.equal(rows[i].seed, rows[i + 1].seed);
    assert.notEqual(rows[i].version, rows[i + 1].version);
    assert.equal(rows[i].variant, i % 4 === 0 ? 'A' : 'V8');
  }
  assert.deepEqual(rows.slice(12).map(e => [e.partition, e.variant]), [['repeat', 'V8'], ['repeat', 'A']]);
  assert.ok(!rows.some(e => schedule('pilot').some(p => p.seed === e.seed)));
});

test('evidence is a whitelist, not a dump of provider telemetry', () => {
  const record = safeDecision({ seq: 2, decisionStage: 'target', outcome: 'applied', actionId: 'target:4:0', tick: 10, observedTick: 1,
    tetrisHarnessVersion: VERSIONS.V8, reasoning: { text: 'PRIVATE' }, apiKey: 'PRIVATE', request: { images: ['PRIVATE'] },
    metrics: { elapsedMs: 42, actualModel: 'sk-PRIVATE', probabilities: { PRIVATE: 1 }, thoughtUsed: false, usage: { input_tokens: 99, PRIVATE: 'PRIVATE' } } });
  assert.equal(record.stage, 'target'); assert.equal(record.actualModel, null);
  assert.ok(!JSON.stringify(record).includes('PRIVATE'));
  assert.equal(record.appliedTick, null);
  assert.deepEqual(distribution([1, 2, 3, 4, null]), { n: 4, median: 2.5, p95: 3.8499999999999996 });
});

function fixture() {
  const config = { tetrisHarnessVersion: VERSIONS.V8 }, seed = 'replay-fixture';
  let state = tetris.create(config, seed);
  const frames = [{ tick: 0, views: [tetris.view(state)] }];
  const input = { buttons: ['hard-drop'], durationMs: 100 };
  state = tetris.input(state, input); state = tetris.step(state, 120);
  frames.push({ tick: 120, views: [tetris.view(state)] });
  return { version: 2, gameId: 'tetris', rulesVersion: tetris.rulesVersion, config, seed, runIds: ['run1'], frames,
    events: [
      { seq: 1, type: 'decision', runId: 'run1', decisionStage: 'target', requestId: 'target1', actionId: 'target:3:0', outcome: 'applied', tick: 0, observedTick: 0 },
      { seq: 2, type: 'decision', runId: 'run1', decisionStage: 'key', requestId: 'key1', actionId: 'hard-drop:100', outcome: 'applied', tick: 0, observedTick: 0, appliedTick: 1 },
      { seq: 3, type: 'input', runId: 'run1', requestId: 'key1', tick: 0, appliedTick: 1, input },
    ], result: { scores: [state.score] } };
}
test('native reconstruction checks frames and keeps target decisions out of physics', () => {
  assert.equal(verifyReplay(fixture(), tetris).targetNeverExecutesInput, true);
  const altered = fixture(); altered.events[2].requestId = 'target1';
  assert.throws(() => verifyReplay(altered, tetris), /ORPHAN_INPUT/);
});
test('orphan controls, foreign tracks, duplicate receipts and altered previews are rejected', () => {
  const orphan = fixture(); orphan.events[2].requestId = 'no-model-receipt';
  assert.throws(() => verifyReplay(orphan, tetris), /ORPHAN_INPUT/);
  const foreign = fixture(); foreign.events[2].runId = 'other-run';
  assert.throws(() => verifyReplay(foreign, tetris), /FOREIGN_RUN/);
  const duplicate = fixture(); duplicate.events.push({ ...duplicate.events[1], seq: 4 });
  assert.throws(() => verifyReplay(duplicate, tetris), /DUPLICATE_OR_MISSING_REQUEST/);
  const preview = fixture(); preview.frames[0].views[0].next[0] = preview.frames[0].views[0].next[0] === 'I' ? 'O' : 'I';
  assert.throws(() => verifyReplay(preview, tetris), /REPLAY_FRAME_MISMATCH/);
});
test('a changed key or saved score cannot pass replay verification', () => {
  const changed = fixture(); changed.events[1].actionId = 'left:100';
  assert.throws(() => verifyReplay(changed, tetris), /ACTION_CHANGED/);
  const score = fixture(); score.result.scores[0].points += 100;
  assert.throws(() => verifyReplay(score, tetris), /REPLAY_SCORE_MISMATCH/);
});
