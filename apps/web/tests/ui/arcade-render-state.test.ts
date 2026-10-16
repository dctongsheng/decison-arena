import type { ArcadeState } from '@decision-arena/core';
import { getArcadeGame } from '@decision-arena/games/arcade';
import { describe, expect, it } from 'vitest';

import {
  ArcadeRenderState,
  interpolateArcadeView,
} from '@/blocks/arcade/render-state';

const platformer = getArcadeGame('platformer');
const tetris = getArcadeGame('tetris');
const snake = getArcadeGame('snake');
const start = () => platformer.create({ level: 1 }, 'presentation-test');

describe('bounded human render prediction', () => {
  it('previews a locally pressed key before the next server snapshot, without changing authority', () => {
    const state = start(),
      view = platformer.view(state),
      copy = structuredClone(state);
    const render = new ArcadeRenderState(view, state, true, 0);
    render.input({ seq: 1, at: 0, input: { buttons: ['right'] } });
    const predicted = render.frame(17);
    expect(predicted.player!.x).toBeGreaterThan(view.player!.x);
    expect(predicted.score).toEqual(view.score);
    expect(predicted.status).toBe(view.status);
    expect(state).toEqual(copy);
  });
  it('never simulates more than six ticks and releases held controls on a stale snapshot', () => {
    const state = start(),
      view = platformer.view(state);
    const render = new ArcadeRenderState(view, state, true, 0);
    render.input({ seq: 1, at: 0, input: { buttons: ['right'] } });
    const limit = render.frame(100),
      stale = render.frame(5000);
    expect(stale.tick).toBe(view.tick + 6);
    expect(stale.player).toEqual(limit.player);
    expect(stale.currentButtons).toEqual([]);
    render.input({ seq: 2, at: 5001, input: { buttons: ['jump'] } });
    expect(render.frame(6000).player).toEqual(limit.player);
  });
  it('retains keydown + keyup edges within one render frame and does not repeat the same input', () => {
    const state = tetris.create({}, 'tap-seed'),
      view = tetris.view(state);
    const render = new ArcadeRenderState(view, state, true, 0);
    const press = { seq: 1, at: 1, input: { buttons: ['hard-drop'] as const } };
    render.input({ ...press, input: { buttons: [...press.input.buttons] } });
    render.input({ seq: 2, at: 2, input: { buttons: [] } });
    expect(render.frame(17).pieceId).toBe(view.pieceId! + 1);
    render.input({ ...press, input: { buttons: [...press.input.buttons] } });
    expect(render.frame(34).pieceId).toBe(view.pieceId! + 1);
  });
  it('corrects to the newly received authoritative tick and discards older local inputs', () => {
    const state = start(),
      render = new ArcadeRenderState(platformer.view(state), state, true, 0);
    render.input({ seq: 1, at: 0, input: { buttons: ['right'] } });
    render.frame(100);
    const serverState = platformer.step(state, 3),
      serverView = platformer.view(serverState);
    render.receive(serverView, serverState, true, 150);
    expect(render.frame(150).player).toEqual(serverView.player);
    render.input({ seq: 2, at: 90, input: { buttons: ['right'] } });
    expect(render.frame(167).player!.x).toBe(serverView.player!.x);
    expect(render.frame(500).tick).toBe(serverView.tick + 6);
  });
  it('does not extend the 100ms horizon for same-tick snapshot updates', () => {
    const state = start(),
      view = platformer.view(state);
    const render = new ArcadeRenderState(view, state, true, 0);
    render.receive(structuredClone(view), structuredClone(state), true, 90);
    expect(render.frame(150).tick).toBe(6);
    expect(render.frame(150).currentButtons).toEqual([]);
  });
  it('freezes immediately on pause or finish and ignores later queued controls', () => {
    const state = start(),
      view = platformer.view(state),
      render = new ArcadeRenderState(view, state, true, 0);
    render.input({ seq: 1, at: 0, input: { buttons: ['right'] } });
    render.frame(34);
    render.receive(view, state, false, 35);
    render.input({ seq: 2, at: 36, input: { buttons: ['jump'] } });
    expect(render.frame(200)).toBe(view);
    const terminal = {
      ...view,
      status: 'finished' as const,
      reason: 'TIME_LIMIT',
    };
    render.receive(terminal, state, true, 250);
    expect(render.frame(999)).toBe(terminal);
  });
  it('never predicts a score or a terminal result even when the replica eats or collides', () => {
    let state = snake.create({}, 'score-test');
    state = {
      ...state,
      tick: 19,
      score: { ...state.score, survivedTicks: 19 },
      food: { x: 5, y: 10 },
    } as ArcadeState;
    const view = snake.view(state),
      render = new ArcadeRenderState(view, state, true, 0);
    expect(render.frame(17).score.points).toBe(0);
    expect(render.frame(17).score.food).toBe(0);
    expect(render.frame(17).snake?.[0]).toEqual({ x: 5, y: 10 });
    const edge = {
      ...snake.create({}, 'edge-test'),
      tick: 19,
      body: [
        { x: 19, y: 10 },
        { x: 18, y: 10 },
        { x: 17, y: 10 },
      ],
      food: { x: 1, y: 1 },
      score: { ...state.score, survivedTicks: 19 },
    } as ArcadeState;
    const edgeView = snake.view(edge),
      collision = new ArcadeRenderState(edgeView, edge, true, 0);
    expect(collision.frame(100).status).toBe('playing');
    expect(collision.frame(100).reason).toBeUndefined();
  });
});

describe('AI snapshot coordinate interpolation', () => {
  it('smooths platform motion between adjacent snapshots without extrapolation or changing score', () => {
    const from = platformer.view(start()),
      to = structuredClone(from);
    to.tick = 6;
    to.player!.x += 60;
    to.score.points = 500;
    const render = new ArcadeRenderState(from, undefined, true, 0);
    render.receive(to, undefined, true, 100);
    expect(render.frame(150).player!.x).toBe(from.player!.x + 30);
    expect(render.frame(150).score.points).toBe(500);
    expect(render.frame(1000).player!.x).toBe(to.player!.x);
  });
  it('interpolates snake segments and active Tetris cells but never morphs between pieces', () => {
    const from = snake.view(snake.create({}, 'interpolate')),
      to = structuredClone(from);
    to.snake!.forEach((segment) => segment.x++);
    expect(interpolateArcadeView(from, to, 0.5).snake![0].x).toBe(
      from.snake![0].x + 0.5
    );
    const before = tetris.view(tetris.create({}, 'interpolate')),
      after = structuredClone(before);
    after.active!.cells.forEach((cell) => cell.x++);
    expect(interpolateArcadeView(before, after, 0.5).active!.cells[0].x).toBe(
      before.active!.cells[0].x + 0.5
    );
    after.pieceId!++;
    expect(interpolateArcadeView(before, after, 0.5).active).toEqual(
      after.active
    );
  });
  it('immediately renders authoritative terminal snapshots', () => {
    const from = platformer.view(start()),
      to = { ...from, status: 'finished' as const };
    expect(interpolateArcadeView(from, to, 0.1)).toBe(to);
  });
});
