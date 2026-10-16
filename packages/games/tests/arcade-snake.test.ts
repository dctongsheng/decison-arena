import { describe, expect, it } from 'vitest';
import { snake, type SnakeState } from '../src/arcade/snake';

const create = () => snake.create({}, 'snake-fixture') as SnakeState;
const step = (state: SnakeState, ticks = 1) => snake.step(state, ticks) as SnakeState;

describe('independent realtime snake', () => {
  it('uses a 20x20 board, length 3 and exactly three moves per second', () => {
    const s = create(), saved = JSON.stringify(s);
    expect(snake.view(s)).toMatchObject({ width: 20, height: 20 });
    expect(s.body).toEqual([{ x: 4, y: 10 }, { x: 3, y: 10 }, { x: 2, y: 10 }]);
    expect(step(s, 19).body).toEqual(s.body);
    expect(step(s, 20).body[0]).toEqual({ x: 5, y: 10 });
    expect(step(s, 60).body[0]).toEqual({ x: 7, y: 10 });
    expect(JSON.stringify(s)).toBe(saved);
  });

  it('keeps running while a controller has no answer, with no automatic avoidance', () => {
    const s = step(create(), 7200);
    expect(s).toMatchObject({ tick: 320, status: 'finished', reason: 'WALL_COLLISION', held: [], releaseTick: null });
    expect(s.score.survivedTicks).toBe(320);
    expect(step(s, 7200)).toEqual(s);
    expect(snake.candidates(s)).toEqual([]);
    expect(() => snake.input(s, { buttons: ['up'] })).toThrow();
  });

  it('rejects reversing, multiple directions and invalid durations without changing state', () => {
    const s = create(), saved = JSON.stringify(s);
    expect(snake.candidates(s)).toHaveLength(3);
    expect(snake.candidates(s).map(action => action.id)).toEqual(['up:100', 'right:100', 'down:100']);
    expect(snake.candidates(s).every(a => !a.input.buttons.includes('left'))).toBe(true);
    for (const input of [{ buttons: ['left'] }, { buttons: ['up', 'right'] }, { buttons: ['jump'] }, { buttons: ['up'], durationMs: 500 }]) {
      expect(() => snake.input(s, input as never)).toThrow();
    }
    expect(JSON.stringify(s)).toBe(saved);
  });

  it('latches a short direction until the next movement and keeps moving after release', () => {
    const input = snake.input(create(), { buttons: ['up'], durationMs: 100 }) as SnakeState;
    expect(input.tick).toBe(0);
    let s = step(input, 6);
    expect(s.held).toEqual([]);
    expect(s.releaseTick).toBeNull();
    expect(s.body[0]).toEqual({ x: 4, y: 10 });
    s = step(s, 34);
    expect(s.body[0]).toEqual({ x: 4, y: 8 });
    expect(s.direction).toBe('up');
  });

  it('does not use two queued turns to reverse before the snake has moved', () => {
    const up = snake.input(create(), { buttons: ['up'] });
    expect(() => snake.input(up, { buttons: ['left'] })).toThrow();
    const moved = snake.step(up, 20);
    expect(() => snake.input(moved, { buttons: ['left'] })).not.toThrow();
  });

  it('cancels an unapplied turn on internal release while retaining the already active direction', () => {
    const queued = step(snake.input(create(), { buttons: ['up'] }) as SnakeState, 5);
    const released = snake.release(queued) as SnakeState;
    expect(released.queued).toBeNull();
    expect(step(released, 15).body[0]).toEqual({ x: 5, y: 10 });
    const turned = step(snake.input(create(), { buttons: ['up'] }) as SnakeState, 20);
    const releasedTurn = snake.release(turned) as SnakeState;
    expect(step(releasedTurn, 20).body[0]).toEqual({ x: 4, y: 8 });
  });

  it('retains a human direction tap whose key-up arrives before the next simulation tick', () => {
    const pressed = snake.input(create(), { buttons: ['up'] });
    const keyUp = snake.input(pressed, { buttons: [] }) as SnakeState;
    expect(keyUp.held).toEqual([]);
    expect(step(keyUp, 20).body[0]).toEqual({ x: 4, y: 9 });
  });

  it('grows once, scores food and places the next food outside the body reproducibly', () => {
    const s = create(); s.food = { x: 5, y: 10 };
    const next = step(s, 20);
    expect(next.body).toHaveLength(4);
    expect(next.score).toMatchObject({ food: 1, points: 100 });
    expect(next.body).not.toContainEqual(next.food);
    expect(step(s, 20)).toEqual(next);
    expect(snake.restore(JSON.parse(JSON.stringify(next)))).toEqual(next);
  });

  it('allows entering the departing tail but rejects entering another occupied segment', () => {
    const s = create();
    s.body = [{ x: 2, y: 2 }, { x: 2, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 2 }];
    s.direction = 'up'; s.score.food = 1; s.score.points = 100; s.food = { x: 15, y: 15 };
    const tail = step(snake.input(s, { buttons: ['right'] }) as SnakeState, 20);
    expect(tail.status).toBe('playing');
    expect(tail.body[0]).toEqual({ x: 3, y: 2 });
    s.body = [{ x: 2, y: 2 }, { x: 2, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 2 }, { x: 4, y: 2 }];
    const body = step(snake.input(s, { buttons: ['right'] }) as SnakeState, 20);
    expect(body.reason).toBe('SELF_COLLISION');
  });

  it('ends successfully when the final food fills the board', () => {
    const s = create();
    // A Hamiltonian path covering every cell except (0,0), with its head adjacent to that final food.
    const path = Array.from({ length: 20 }, (_, y) => Array.from({ length: 20 }, (_, n) => ({ x: y % 2 === 0 ? n : 19 - n, y }))).flat();
    s.body = path.slice(1); s.direction = 'left'; s.food = { x: 0, y: 0 }; s.score.food = 396; s.score.points = 39600;
    const full = step(s, 20);
    expect(full).toMatchObject({ status: 'finished', reason: 'BOARD_FILLED', food: null });
    expect(full.body).toHaveLength(400);
    expect(full.score).toMatchObject({ completed: true, food: 397, points: 39700 });
    expect(snake.restore(full)).toEqual(full);
  });

  it('terminates at 120 seconds on a safe repeated circuit and compares food before survival', () => {
    let s = create(); s.food = { x: 15, y: 15 };
    for (let tick = 0; tick < 7200 && s.status === 'playing'; tick += 20) {
      const direction = ['up', 'right', 'down', 'left'][Math.floor(tick / 60) % 4] as 'up';
      s = step(snake.input(s, { buttons: [direction] }) as SnakeState, 20);
    }
    expect(s).toMatchObject({ tick: 7200, reason: 'TIME_LIMIT' });
    expect(snake.compare({ points: 100, food: 1, survivedTicks: 10 }, { points: 0, food: 0, survivedTicks: 7200 })).toBeGreaterThan(0);
  });

  it('rejects malformed saves and returns isolated projections', () => {
    const s = create();
    expect(() => snake.restore({ ...s, body: [{ x: -1, y: 0 }] })).toThrow();
    expect(() => snake.restore({ ...s, food: s.body[0] })).toThrow();
    expect(() => snake.restore({ ...s, rng: NaN })).toThrow();
    expect(() => snake.restore({ ...s, score: { ...s.score, food: 1 } })).toThrow();
    const view = snake.view(s); view.snake![0].x = 99;
    expect(s.body[0].x).toBe(4);
  });
});
