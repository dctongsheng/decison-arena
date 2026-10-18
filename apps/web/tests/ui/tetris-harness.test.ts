import { createElement } from 'react';
import type {
  ArcadeEvent,
  ArcadeReplayV2,
  ArcadeView,
} from '@decision-arena/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { arcadeReplayMarkers } from '@/blocks/arcade/replay-markers';
import { arcadeCreateControllers } from '@/blocks/arcade/create-preferences';
import {
  arcadeFormConfig,
  currentTetrisGoal,
  displayedTetrisVersion,
  replayTetrisDecision,
  replayTetrisGoal,
  TETRIS_BASELINE,
  TETRIS_V8,
  tetrisCreationVersion,
  tetrisModelAllowed,
} from '@/blocks/arcade/tetris-harness';
import {
  TetrisHarnessNotice,
  TetrisPlanningPanel,
} from '@/blocks/arcade/tetris-planning';

vi.mock('@/paraglide/messages.js', () => ({
  m: new Proxy({}, { get: (_, key) => () => String(key) }),
}));
const view: ArcadeView = {
  gameId: 'tetris',
  tick: 30,
  status: 'playing',
  score: { points: 0, survivedTicks: 30 },
  width: 10,
  height: 20,
  currentButtons: [],
  pieceId: 4,
  active: {
    type: 'I',
    rotation: 0,
    cells: [
      { x: 3, y: 2 },
      { x: 4, y: 2 },
      { x: 5, y: 2 },
      { x: 6, y: 2 },
    ],
  },
};
const goal = { pieceId: 4, leftmostColumn: 7, rotation: 1 as const };
function event(values: Partial<ArcadeEvent> = {}): ArcadeEvent {
  return {
    seq: 1,
    type: 'decision',
    tick: 10,
    settledTick: 10,
    at: 100,
    runId: 'run-0',
    observedTick: 0,
    decisionStage: 'target',
    outcome: 'applied',
    tetrisGoal: goal,
    ...values,
  };
}

describe('frozen Tetris scheme presentation', () => {
  it.each(['ai-solo', 'human-ai', 'ai-ai'] as const)('creates %s with one shared V8 config while preserving separate AI model selections', (mode) => {
    const controllers = arcadeCreateControllers(mode, { profile0: 'left-model', profile1: 'right-model' }, ['left-model', 'right-model']);
    const config = arcadeFormConfig('tetris', '1', tetrisCreationVersion());
    expect(config).toEqual({ tetrisHarnessVersion: TETRIS_V8 });
    expect(controllers).toEqual(mode === 'ai-solo'
      ? [{ kind: 'ai', profileId: 'left-model' }]
      : mode === 'human-ai'
        ? [{ kind: 'human' }, { kind: 'ai', profileId: 'right-model' }]
        : [{ kind: 'ai', profileId: 'left-model' }, { kind: 'ai', profileId: 'right-model' }]);
  });
  it('keeps legacy and explicit clone versions independent of the new-session default', () => {
    const legacy = {};
    expect(tetrisCreationVersion()).toBe(TETRIS_V8);
    expect(tetrisCreationVersion(legacy)).toBe(TETRIS_BASELINE);
    expect(displayedTetrisVersion(legacy)).toBe(TETRIS_BASELINE);
    expect(legacy).toEqual({});
    for (const version of [TETRIS_BASELINE, TETRIS_V8]) {
      const source = { tetrisHarnessVersion: version };
      expect(tetrisCreationVersion(source)).toBe(version);
      expect(displayedTetrisVersion(source)).toBe(version);
      expect(source).toEqual({ tetrisHarnessVersion: version });
    }
  });
  it('keeps legacy baseline interpretation read-only and does not leak a Tetris choice to other games', () => {
    const config = {};
    expect(displayedTetrisVersion(config)).toBe(TETRIS_BASELINE);
    expect(config).toEqual({});
    expect(arcadeFormConfig('tetris', '1', TETRIS_V8)).toEqual({
      tetrisHarnessVersion: TETRIS_V8,
    });
    expect(arcadeFormConfig('snake', '1', TETRIS_V8)).toEqual({});
    expect(arcadeFormConfig('platformer', '2', TETRIS_V8)).toEqual({
      level: 2,
    });
  });
  it('keeps baseline providers while V8 accepts System One and the two verified Jev image models', () => {
    for (const provider of [
      'openrouter',
      'custom-openrouter',
      'bamboonode-decisions',
    ]) {
      for (const model of ['typesafe/jev-1.13', 'typesafe/jev-1.14'])
        expect(tetrisModelAllowed('tetris', TETRIS_V8, provider, model)).toBe(true);
      for (const model of ['', 'unknown/model', 'typesafe/jev-1.12', 'typesafe/jev-1.14-preview'])
        expect(tetrisModelAllowed('tetris', TETRIS_V8, provider, model)).toBe(false);
      expect(tetrisModelAllowed('tetris', TETRIS_BASELINE, provider, 'unknown/model')).toBe(
        true
      );
      expect(tetrisModelAllowed('snake', TETRIS_V8, provider, 'unknown/model')).toBe(true);
    }
    for (const provider of [
      'systemone',
      'custom-systemone',
      'bamboonode-systemone',
    ])
      expect(tetrisModelAllowed('tetris', TETRIS_V8, provider, '')).toBe(true);
    expect(tetrisModelAllowed('tetris', TETRIS_V8, 'unknown-provider', 'typesafe/jev-1.14')).toBe(false);
  });
  it('shows only a current valid piece target and projects no private extras', () => {
    expect(
      currentTetrisGoal(view, {
        ...goal,
        rawRequest: 'private-marker',
      } as typeof goal)
    ).toEqual(goal);
    expect(currentTetrisGoal({ ...view, pieceId: 5 }, goal)).toBeNull();
    expect(currentTetrisGoal({ ...view, status: 'finished' }, goal)).toBeNull();
    expect(currentTetrisGoal(view, { ...goal, leftmostColumn: 10 })).toBeNull();
  });
  it('replays applied targets at settlement, supports clear and ignores dropped/future/cross-run choices', () => {
    const events = [
      event(),
      event({
        seq: 2,
        tick: 12,
        settledTick: 12,
        outcome: 'dropped',
        tetrisGoal: null,
      }),
      event({
        seq: 3,
        tick: 13,
        settledTick: 13,
        runId: 'run-1',
        tetrisGoal: null,
      }),
      event({
        seq: 4,
        tick: 20,
        settledTick: 20,
        actionId: 'clear',
        tetrisGoal: null,
      }),
    ];
    expect(replayTetrisGoal(events, 'run-0', 9, view)).toBeNull();
    expect(replayTetrisGoal(events, 'run-0', 10, view)).toEqual(goal);
    expect(replayTetrisGoal(events, 'run-0', 19, view)).toEqual(goal);
    expect(replayTetrisGoal(events, 'run-0', 20, view)).toBeNull();
    expect(
      replayTetrisGoal(events, 'run-0', 19, { ...view, pieceId: 5 })
    ).toBeNull();
    expect(replayTetrisDecision(events, 'run-0', 19)?.outcome).toBe('dropped');
  });
  it('renders current columns/rotation and target-vs-key status without request, image or reasoning text', () => {
    const privateText = 'private-marker-never-render';
    const html = renderToStaticMarkup(
      createElement(TetrisPlanningPanel, {
        view,
        goal,
        inflight: {
          requestId: 'fixture',
          observedTick: 30,
          startedAt: 1,
          decisionStage: 'key',
        },
        lastDecision: event({
          reasoning: { text: privateText, truncated: false },
          message: privateText,
        }),
      })
    );
    expect(html).toContain('arcade.tetris.column 3');
    expect(html).toContain('arcade.tetris.column 7');
    expect(html).toContain('arcade.tetris.rotation 1');
    expect(html).toContain('arcade.tetris.stage.key');
    expect(html).toContain('arcade.tetris.conditional');
    expect(html).not.toContain(privateText);
    const baseline = renderToStaticMarkup(
      createElement(TetrisHarnessNotice, { config: {} })
    );
    expect(baseline).toContain(TETRIS_BASELINE);
    expect(baseline).not.toContain(TETRIS_V8);
    expect(baseline).not.toContain('arcade.tetris.shared_scheme');
    const v8 = renderToStaticMarkup(createElement(TetrisHarnessNotice, {
      config: arcadeFormConfig('tetris', '1', tetrisCreationVersion()),
    }));
    expect(v8).toContain(TETRIS_V8);
    expect(v8).toContain('arcade.tetris.shared_scheme');
  });
  it('adds safe target/key timeline labels without interpreting target as a physical input', () => {
    const replay = {
      gameId: 'tetris',
      events: [
        event(),
        event({
          seq: 2,
          tick: 20,
          settledTick: 20,
          decisionStage: 'key',
          actionId: 'hard-drop:100',
        }),
      ],
      runIds: ['run-0'],
      frames: [{ tick: 30, views: [view] }],
      result: { scores: [view.score], aborted: false },
      maxTicks: 7200,
    } as ArcadeReplayV2;
    const markers = arcadeReplayMarkers(replay);
    expect(markers.map((marker) => marker.decisionStage)).toEqual([
      'target',
      'key',
    ]);
    expect(markers[0]).not.toHaveProperty('buttons');
    expect(markers[0]).not.toHaveProperty('appliedTick');
  });
});
