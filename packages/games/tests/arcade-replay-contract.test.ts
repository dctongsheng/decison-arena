import { describe, expect, it } from 'vitest';
import type { ArcadeEvent, ArcadeInput, ArcadeReplayV2, ArcadeState } from '@decision-arena/core';
import { arcadeGames } from '../src/arcade';
import { createArcadeReplayReader } from '../../../apps/web/src/blocks/arcade/replay-engine';

describe('fixed-tick pause and replay contract', () => {
  it.each(arcadeGames)('$id still executes old replay duration variants removed from model candidates', game => {
    const seed = 'legacy-duration-replay', initial = game.create({}, seed);
    const input: ArcadeInput = { buttons: game.id === 'snake' ? ['up'] : game.id === 'tetris' ? ['hard-drop'] : ['jump'], durationMs: 1000 };
    const actionId = `${input.buttons.join('+')}:1000`;
    expect(game.candidates(initial).some(action => action.id === actionId)).toBe(false);
    const live = game.step(game.restore(JSON.parse(JSON.stringify(game.step(game.input(initial, input), 30)))), 30);
    const replay: ArcadeReplayV2 = { version: 2, engineKind: 'arcade', matchId: 'legacy-duration-fixture', gameId: game.id, mode: 'practice',
      seed, config: {}, rulesVersion: game.rulesVersion, promptVersion: 'decision-arena-arcade-v1', controllers: [{ kind: 'human' }], runIds: ['run-0'],
      createdAt: 0, finishedAt: 1000, maxTicks: 7200, result: { winner: null, aborted: true, reason: 'ended_by_user', scores: [live.score] },
      frames: [{ tick: 0, views: [game.view(initial)] }, { tick: 60, views: [game.view(live)] }],
      events: [{ seq: 1, type: 'input', runId: 'run-0', at: 0, tick: 0, appliedTick: 1, input, actionId }] };
    expect(createArcadeReplayReader(replay).read(60)).toEqual([game.view(live)]);
    expect(live.held).toEqual([]);
    if (game.id === 'snake') expect(game.view(live).snake![0]).toEqual({ x: 4, y: 7 });
    if (game.id === 'tetris') expect(game.view(live).pieceId).toBe(2);
    if (game.id === 'platformer') expect(game.view(live).player).toMatchObject({ x: 68, y: 292, vx: 0, vy: 0, onGround: true });
  });

  it.each(arcadeGames)('$id preserves input ordering across pause, offline time and resume', game => {
    const seed = 'pause-replay-fixture', initial = game.create({}, seed);
    let live = initial;
    const events: ArcadeEvent[] = [];
    const accept = (input: ArcadeInput, at: number, release = false) => {
      events.push({ seq: events.length + 1, type: 'input', runId: 'run-0', at, tick: live.tick, appliedTick: live.tick + 1, input, ...(release ? { release: true as const } : {}) });
      live = release ? game.release(live) : game.input(live, input);
    };
    accept({ buttons: game.id === 'snake' ? ['up'] : game.id === 'tetris' ? ['right'] : ['right', 'jump'] }, 0);
    live = game.step(live, 5);
    accept({ buttons: [] }, 84, true); // Pause invalidates held/queued controls without advancing simulation time.
    const savedWhilePaused = JSON.stringify(live);
    live = game.restore(JSON.parse(savedWhilePaused));
    expect(live.tick).toBe(5);
    expect(live.held).toEqual([]);
    // A whole minute offline contributes no frames or survival score in an explicitly paused session.
    expect(JSON.stringify(live)).toBe(savedWhilePaused);
    live = game.step(live, 25);
    accept({ buttons: game.id === 'tetris' ? ['rotate-cw'] : ['right'] }, 60_501);
    live = game.step(live, 30);

    const replay: ArcadeReplayV2 = {
      version: 2, engineKind: 'arcade', matchId: 'pause-fixture', gameId: game.id, mode: 'practice',
      seed, config: {}, rulesVersion: game.rulesVersion, promptVersion: 'fixture', controllers: [{ kind: 'human' }], runIds: ['run-0'],
      createdAt: 0, finishedAt: 61_000, maxTicks: 7200,
      result: { winner: null, aborted: true, reason: 'ended_by_user', scores: [live.score] },
      frames: [{ tick: 0, views: [game.view(initial)] }, { tick: live.tick, views: [game.view(live)] }],
      events: [...events].reverse(), // Readers must honor sequence, not transport array order.
    };
    const reader = createArcadeReplayReader(replay);
    expect(reader.read(60)).toEqual([game.view(live)]);
    expect(reader.read(0)).toEqual([game.view(initial)]);
    expect(reader.read(60)[0].score).toEqual(replay.result.scores[0]);
    expect(live.score.survivedTicks).toBe(60);
    if (game.id === 'snake') expect(game.view(live).snake![0]).toEqual({ x: 7, y: 10 });
    if (game.id === 'tetris') {
      expect(live.active).toMatchObject({ x: 4, y: -1, rotation: 1 });
      expect(game.view(live).cells!.every(cell => cell === 0)).toBe(true);
    }
    if (game.id === 'platformer') expect(live.player).toMatchObject({ x: 1288, y: 2336, vx: 24, vy: 0, onGround: true });
  });

  it.each(arcadeGames)('$id internal release cancels unconsumed input without advancing simulation time', game => {
    const initial = game.create({}, 'same-tick');
    const first = game.candidates(initial).find(action => action.input.buttons.includes('right'))!.input;
    const accepted = game.release(game.input(initial, first));
    const actual = game.step(accepted, 1);
    const expected = game.step(initial, 1);
    expect(game.view(actual)).toEqual(game.view(expected));
    expect(actual.tick).toBe(1);
    expect(actual.score.survivedTicks).toBe(1);
    expect(() => game.release(game.step(initial, 7200))).not.toThrow();
  });

  it('keeps an ended lane stationary while the other lane continues independently', () => {
    const game = arcadeGames.find(g => g.id === 'snake')!;
    let left = game.create({}, 'independent-lanes'), right = game.create({}, 'independent-lanes');
    left = game.step(left, 320);
    expect(left.reason).toBe('WALL_COLLISION');
    right = game.step(game.input(right, { buttons: ['up'] }), 100);
    right = game.step(game.input(right, { buttons: ['right'] }), 100);
    right = game.step(game.input(right, { buttons: ['down'] }), 120);
    expect(right.status).toBe('playing');
    const ended = structuredClone(left);
    left = game.step(left, 20); right = game.step(right, 20);
    expect(left).toEqual(ended);
    expect(right.tick).toBe(340);
    expect((right as ArcadeState).score.survivedTicks).toBe(340);
  });
});
