import { createElement } from 'react';
import type {
  ArcadeEvent,
  ArcadeReplayV2,
  ArcadeSession,
} from '@decision-arena/core';
import { getArcadeGame } from '@decision-arena/games/arcade';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { arcadeButtons, keyButton } from '@/blocks/arcade/input';
import { createArcadeReplayReader } from '@/blocks/arcade/replay-engine';
import {
  adjacentReplayMarker,
  arcadeReplayMarkers,
} from '@/blocks/arcade/replay-markers';
import { ArcadeReplayPlayer } from '@/blocks/arcade/replay-player';
import {
  arcadeCompletionState,
  arcadeControlState,
  canSendArcadeInput,
  mergeArcadeSnapshot,
} from '@/blocks/arcade/session-state';

vi.mock('@/paraglide/messages.js', () => ({
  m: new Proxy({}, { get: (_, key) => () => String(key) }),
}));

const adapter = getArcadeGame('snake');
const initial = () => adapter.view(adapter.create({}, 'replay-fixture'));
function replay(events: ArcadeEvent[] = [], count = 2): ArcadeReplayV2 {
  return {
    version: 2,
    engineKind: 'arcade',
    matchId: 'fixture',
    gameId: 'snake',
    mode: count === 1 ? 'practice' : 'human-ai',
    rulesVersion: adapter.rulesVersion,
    promptVersion: 'test',
    seed: 'replay-fixture',
    config: {},
    controllers: Array.from({ length: count }, () => ({ kind: 'human' })),
    runIds: ['left-track', 'right-track'].slice(0, count),
    result: {
      winner: null,
      reason: 'test',
      scores: Array.from({ length: count }, () => initial().score),
      aborted: false,
    },
    createdAt: 0,
    finishedAt: 2000,
    maxTicks: 120,
    frames: [
      { tick: 0, views: Array.from({ length: count }, initial) },
      { tick: 120, views: Array.from({ length: count }, initial) },
    ],
    events,
  };
}
function input(
  seq: number,
  appliedTick: number,
  buttons: NonNullable<ArcadeEvent['input']>['buttons'],
  runId = 'left-track'
): ArcadeEvent {
  return {
    seq,
    tick: appliedTick - 1,
    appliedTick,
    type: 'input',
    at: 0,
    input: { buttons },
    runId,
  };
}
function snapshot(): ArcadeSession {
  return {
    id: 'one',
    engineKind: 'arcade',
    schemaVersion: 2,
    gameId: 'snake',
    mode: 'practice',
    config: {},
    seed: 'replay-fixture',
    rulesVersion: adapter.rulesVersion,
    status: 'running',
    version: 3,
    tick: 0,
    runs: [
      {
        id: 'left-track',
        controller: { kind: 'human' },
        view: initial(),
        calls: 0,
      },
    ],
    events: [],
    limits: { maxTicks: 120, maxCallsPerRun: 300, minRequestIntervalMs: 500 },
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('continuous arcade replay', () => {
  it('applies inputs immediately before their authoritative next tick, independently per track', () => {
    const reader = createArcadeReplayReader(replay([input(1, 20, ['up'])]));
    expect(reader.read(19)[0].snake?.[0]).toEqual({ x: 4, y: 10 });
    expect(reader.read(20)[0].snake?.[0]).toEqual({ x: 4, y: 9 });
    expect(reader.read(20)[1].snake?.[0]).toEqual({ x: 5, y: 10 });
  });
  it('orders same-tick inputs by sequence and does not execute decision metadata', () => {
    const events = [
      { ...input(2, 20, []), release: true as const },
      input(1, 20, ['up']),
      {
        ...input(3, 20, ['down']),
        type: 'decision' as const,
        outcome: 'applied' as const,
      },
    ];
    expect(
      createArcadeReplayReader(replay(events)).read(20)[0].snake?.[0]
    ).toEqual({ x: 5, y: 10 });
  });
  it('seeks backward and forward without changing simulation results or returning shared state', () => {
    const record = replay([input(1, 20, ['up']), input(2, 60, ['right'])]);
    const reader = createArcadeReplayReader(record);
    const end = reader.read(120);
    reader.read(25)[0].snake![0].x = 999;
    expect(reader.read(120)).toEqual(end);
    expect(reader.read(60)).toEqual(createArcadeReplayReader(record).read(60));
    expect(reader.read(-5)[0]).toEqual(initial());
  });
  it('cancels a same-tick tap on pause rather than replaying the pending direction after resume', () => {
    const tap = input(1, 20, ['up']);
    const keyUp = input(2, 20, []);
    const pause = { ...input(3, 20, []), release: true as const };
    const reader = createArcadeReplayReader(replay([tap, keyUp, pause]));
    expect(reader.read(20)[0].snake?.[0]).toEqual({ x: 5, y: 10 });
    expect(reader.read(20)[0].currentButtons).toEqual([]);
  });
  it('ends with released controls at the saved tick and never advances the simulation to apply a pending tap', () => {
    const record = replay([
      input(1, 1, ['up']),
      input(2, 20, ['right']),
      { seq: 3, type: 'ended', tick: 19, at: 100 },
    ]);
    record.frames = [
      { tick: 0, views: [initial(), initial()] },
      { tick: 19, views: [initial(), initial()] },
    ];
    const reader = createArcadeReplayReader(record);
    const view = reader.read(999)[0];
    expect(view.tick).toBe(19);
    expect(view.snake?.[0]).toEqual({ x: 4, y: 10 });
    expect(view.currentButtons).toEqual([]);
    expect(reader.read(18)[0].currentButtons).toEqual(['up']);
  });
  it('keeps old 6-cells-per-second snake v1 frames instead of replaying them with the slower engine', () => {
    const record = replay();
    record.rulesVersion = 'snake-realtime-v1';
    const firstMove = {
      ...initial(),
      tick: 10,
      snake: [
        { x: 5, y: 10 },
        { x: 4, y: 10 },
        { x: 3, y: 10 },
      ],
    };
    const secondMove = {
      ...initial(),
      tick: 20,
      snake: [
        { x: 6, y: 10 },
        { x: 5, y: 10 },
        { x: 4, y: 10 },
      ],
    };
    record.frames = [
      { tick: 0, views: [initial(), initial()] },
      { tick: 10, views: [firstMove, firstMove] },
      { tick: 20, views: [secondMove, secondMove] },
    ];
    const reader = createArcadeReplayReader(record);
    expect(reader.compatible).toBe(false);
    expect(reader.read(9)[0].snake?.[0]).toEqual({ x: 4, y: 10 });
    expect(reader.read(10)[0].snake?.[0]).toEqual({ x: 5, y: 10 });
    expect(reader.read(19)[0].snake?.[0]).toEqual({ x: 5, y: 10 });
    expect(reader.read(20)[0].snake?.[0]).toEqual({ x: 6, y: 10 });
  });
  it('renders two tracks and continuous controls without leaking private decision text', () => {
    const record = replay([
      {
        seq: 1,
        type: 'decision',
        tick: 1,
        at: 1,
        reasoning: { text: 'PRIVATE_PROVIDER_THOUGHT', truncated: false },
      },
    ]);
    const html = renderToStaticMarkup(
      createElement(ArcadeReplayPlayer, { replay: record })
    );
    expect(html.match(/<canvas /g)).toHaveLength(2);
    expect(html).toContain('type="range"');
    expect(html).not.toContain('PRIVATE_PROVIDER_THOUGHT');
    expect(html).not.toContain('arena-reasoning');
  });
});

describe('arcade input and reconnect boundaries', () => {
  it('sends input only for an active human track in a running session', () => {
    const value = snapshot();
    expect(canSendArcadeInput(value, 'left-track')).toBe(true);
    for (const status of ['ready', 'paused', 'finished', 'error'] as const)
      expect(canSendArcadeInput({ ...value, status }, 'left-track')).toBe(
        false
      );
    value.runs[0].view.status = 'finished';
    expect(canSendArcadeInput(value, 'left-track')).toBe(false);
    value.runs[0].view.status = 'playing';
    value.runs[0].controller.kind = 'ai';
    expect(canSendArcadeInput(value, 'left-track')).toBe(false);
    expect(canSendArcadeInput(undefined, 'left-track')).toBe(false);
  });
  it('chooses explicit retry after a model failure and blocks resume until requests settle', () => {
    const value = snapshot();
    value.status = 'ready';
    expect(arcadeControlState(value, true, true).command).toBe('start');
    value.status = 'paused';
    expect(arcadeControlState(value, true, true).command).toBe('resume');
    value.needsRetry = true;
    expect(arcadeControlState(value, true, true)).toEqual({
      command: 'retry',
      waiting: false,
      enabled: true,
    });
    value.runs[0].inflight = {
      requestId: 'pending',
      observedTick: 0,
      startedAt: 0,
    };
    expect(arcadeControlState(value, true, true)).toEqual({
      command: 'retry',
      waiting: true,
      enabled: false,
    });
    delete value.runs[0].inflight;
    expect(arcadeControlState(value, false, false).enabled).toBe(false);
    value.runs[0].view.status = 'finished';
    expect(arcadeControlState(value, false, false).enabled).toBe(true);
  });
  it('deduplicates incremental socket events and ignores late older snapshots', () => {
    const previous = {
      ...snapshot(),
      events: [input(1, 1, ['up']), input(2, 2, [])],
    };
    const incoming = {
      ...snapshot(),
      version: 4,
      events: [input(2, 2, []), input(3, 3, ['right'])],
    };
    const merged = mergeArcadeSnapshot(previous, incoming);
    expect(merged.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(mergeArcadeSnapshot(merged, previous)).toBe(merged);
    expect(
      mergeArcadeSnapshot(merged, { ...snapshot(), id: 'other', events: [] })
        .events
    ).toEqual([]);
  });
  it('maps direct Tetris keys, platform jumps, and restricts Snake to the latest direction', () => {
    expect(keyButton('tetris', 'Space')).toBe('hard-drop');
    expect(keyButton('tetris', 'KeyZ')).toBe('rotate-ccw');
    expect(keyButton('tetris', 'KeyC')).toBe('hold');
    expect(keyButton('platformer', 'Space')).toBe('jump');
    expect(keyButton('snake', 'Space')).toBeUndefined();
    expect(arcadeButtons('snake', ['right', 'up'])).toEqual(['up']);
    expect(arcadeButtons('platformer', ['right', 'jump', 'right'])).toEqual([
      'right',
      'jump',
    ]);
  });
});

describe('public arcade replay markers', () => {
  it('locates inputs at appliedTick and model returns at the return tick rather than observation time', () => {
    const record = replay([
      input(1, 10, ['up']),
      {
        seq: 2,
        type: 'decision',
        tick: 18,
        observedTick: 2,
        appliedTick: 19,
        at: 9,
        runId: 'right-track',
        outcome: 'applied',
        metrics: { elapsedMs: 267, actualModel: 'returned-model' },
      },
      { seq: 3, type: 'status', tick: 20, at: 10 },
      { seq: 4, type: 'ended', tick: 120, at: 20 },
    ]);
    const markers = arcadeReplayMarkers(record);
    expect(markers.map((marker) => [marker.kind, marker.tick])).toEqual([
      ['input', 10],
      ['decision', 18],
      ['status', 20],
      ['ended', 120],
    ]);
    expect(markers[0].appliedTick).toBe(10);
    expect(markers[1]).toMatchObject({
      runIndex: 1,
      elapsedMs: 267,
      actualModel: 'returned-model',
      outcome: 'applied',
    });
  });
  it('synthesizes one exact end marker per run from the view tick even when the saved frame is later', () => {
    const record = replay();
    const dead = {
      ...initial(),
      status: 'finished' as const,
      tick: 17,
      reason: 'WALL_COLLISION',
      score: { ...initial().score, survivedTicks: 17 },
    };
    const won = {
      ...initial(),
      status: 'finished' as const,
      tick: 45,
      reason: 'BOARD_FILLED',
      score: { ...initial().score, survivedTicks: 45, completed: true },
    };
    record.frames = [
      { tick: 0, views: [initial(), initial()] },
      { tick: 30, views: [dead, initial()] },
      { tick: 60, views: [dead, won] },
      { tick: 120, views: [dead, won] },
    ];
    const markers = arcadeReplayMarkers(record);
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatchObject({
      runIndex: 0,
      tick: 17,
      kind: 'run-ended',
      reason: 'WALL_COLLISION',
    });
    expect(markers[1]).toMatchObject({
      runIndex: 1,
      tick: 45,
      kind: 'run-won',
    });
  });
  it('uses saved result survival time when only the final reason identifies a completed run', () => {
    const record = replay();
    record.frames[1].views[0].reason = 'WALL_COLLISION';
    record.result.scores[0].survivedTicks = 73;
    expect(arcadeReplayMarkers(record)[0]).toMatchObject({
      tick: 73,
      kind: 'run-ended',
    });
  });
  it('never projects raw messages, reasoning, usage or probabilities into the public timeline', () => {
    const record = replay([
      {
        seq: 1,
        type: 'decision',
        tick: 3,
        at: 10,
        message: 'PRIVATE_MESSAGE',
        reasoning: { text: 'PRIVATE_REASONING', truncated: false },
        metrics: {
          elapsedMs: 20,
          actualModel: 'safe-model',
          usage: { secret: 99 },
          probabilities: { private: 0.8 },
        },
      },
    ]);
    const text = JSON.stringify(arcadeReplayMarkers(record));
    expect(text).toContain('safe-model');
    for (const hidden of [
      'PRIVATE_MESSAGE',
      'PRIVATE_REASONING',
      'usage',
      'probabilities',
      'secret',
    ])
      expect(text).not.toContain(hidden);
  });
  it('walks each same-tick event by sequence and omits inputs never applied before the session ended', () => {
    const record = replay([
      input(3, 10, []),
      input(1, 10, ['up']),
      input(2, 10, ['right']),
      input(4, 121, ['down']),
    ]);
    const markers = arcadeReplayMarkers(record);
    expect(markers.map((marker) => marker.id)).toEqual([
      'event-1',
      'event-2',
      'event-3',
    ]);
    expect(adjacentReplayMarker(markers, 0, null, 1)?.id).toBe('event-1');
    expect(adjacentReplayMarker(markers, 10, 'event-1', 1)?.id).toBe('event-2');
    expect(adjacentReplayMarker(markers, 10, 'event-3', -1)?.id).toBe(
      'event-2'
    );
    expect(adjacentReplayMarker(markers, 10, 'event-3', 1)).toBeUndefined();
  });
});

describe('arcade terminal request settling', () => {
  it('keeps polling and reconnecting with archive actions blocked while a finished session still has a provider request', () => {
    const value = snapshot();
    value.status = 'finished';
    value.runs[0].inflight = {
      requestId: 'settling',
      observedTick: 0,
      startedAt: 0,
    };
    for (const connected of [true, false]) {
      expect(arcadeCompletionState(value, connected)).toEqual({
        settling: true,
        archiveReady: false,
        shouldReconnect: true,
        pollInterval: 1500,
      });
    }
    expect(canSendArcadeInput(value, 'left-track')).toBe(false);
    delete value.runs[0].inflight;
    expect(arcadeCompletionState(value, false)).toEqual({
      settling: false,
      archiveReady: true,
      shouldReconnect: false,
      pollInterval: false,
    });
  });
  it('does not expose archive actions for ongoing sessions and preserves their normal polling cadence', () => {
    const value = snapshot();
    expect(arcadeCompletionState(value, true)).toEqual({
      settling: false,
      archiveReady: false,
      shouldReconnect: true,
      pollInterval: 10000,
    });
    expect(arcadeCompletionState(value, false).pollInterval).toBe(1500);
    expect(arcadeCompletionState(undefined, false).archiveReady).toBe(false);
  });
});
