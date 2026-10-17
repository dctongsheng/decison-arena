import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { snake, type SnakeState } from '../src/arcade/snake';
import { arcadeDecisionInstructions } from '../src/arcade/decision';
import { SNAKE_HARNESS_VERSIONS, SNAKE_BASELINE_INSTRUCTIONS, SNAKE_REALTIME_INSTRUCTIONS, snakeHarnessInstructions, snakeHarnessPosition, snakeHarnessVersion, compactSnakeObservation, rememberSnakeObservation, type SnakeVisibleObservation } from '../src/arcade/snake-harness';

const observe = (state: SnakeState) => snake.observe(state) as SnakeVisibleObservation;
describe('frozen real-time snake harnesses', () => {
  it('A is exactly the pre-experiment v4 strategy and B changes instructions only', () => {
    expect(SNAKE_BASELINE_INSTRUCTIONS).toBe(arcadeDecisionInstructions('snake'));
    expect(createHash('sha256').update(SNAKE_BASELINE_INSTRUCTIONS).digest('hex')).toBe('7d783ea7e4ad7e9204d28a7257e92dbc2572f7762bfd9b94e5030db89060695c');
    const state = snake.create({}, 'contract') as SnakeState, position = observe(state), actions = snake.candidates(state);
    expect(createHash('sha256').update(JSON.stringify({ position, actions })).digest('hex')).toBe('be1f7886025035f041f1a2bdedfc068cabc4c8069f91eb974c5ab4f00d81c934');
    expect(snakeHarnessPosition('snake-harness-a-v1', position, actions)).toBe(position);
    expect(snakeHarnessPosition('snake-harness-b-v1', position, actions)).toBe(position);
    expect(snakeHarnessInstructions('snake-harness-b-v1')).not.toBe(SNAKE_BASELINE_INSTRUCTIONS);
    expect(snakeHarnessInstructions('snake-harness-c-v1')).toBe(SNAKE_REALTIME_INSTRUCTIONS);
    expect(snakeHarnessVersion(undefined)).toBe('snake-harness-a-v1');
    for (const value of [null, 'A', '', 'snake-harness-c-v2', 'constructor']) expect(() => snakeHarnessVersion(value)).toThrow();
  });

  it('C exposes current visible facts only, for every candidate including a lethal legal wall move', () => {
    const s = snake.create({}, 'geometry') as SnakeState;
    s.body = [{ x: 19, y: 0 }, { x: 18, y: 0 }, { x: 17, y: 0 }]; s.food = { x: 12, y: 4 };
    const actions = snake.candidates(s), o = observe(s);
    const c = compactSnakeObservation({ ...o, rng: 123, secret: 'not-visible' } as SnakeVisibleObservation, actions);
    expect(c.geometry.map(g => g.actionId)).toEqual(actions.map(a => a.id));
    expect(c.geometry).toEqual([
      { actionId: 'up:100', direction: 'up', adjacent: { x: 19, y: -1 }, outside: true, bodyIndex: -1, isTailCell: false, isFoodCell: false, wallDistance: 0 },
      { actionId: 'right:100', direction: 'right', adjacent: { x: 20, y: 0 }, outside: true, bodyIndex: -1, isTailCell: false, isFoodCell: false, wallDistance: 0 },
      { actionId: 'down:100', direction: 'down', adjacent: { x: 19, y: 1 }, outside: false, bodyIndex: -1, isTailCell: false, isFoodCell: false, wallDistance: 19 },
    ]);
    expect(c.foodOffset).toEqual({ dx: -7, dy: 4 });
    expect(c).not.toHaveProperty('rng'); expect(c).not.toHaveProperty('secret'); expect(c).not.toHaveProperty('board');
    expect(snake.step(snake.input(s, actions[1].input), 20).reason).toBe('WALL_COLLISION');
  });

  it('C distinguishes committed queued controls and observed effects, including growth, without future food', () => {
    const s = snake.create({}, 'effects') as SnakeState; s.food = { x: 4, y: 9 };
    const previous = { ...rememberSnakeObservation(observe(s)), actionId: 'up:100', appliedTick: 1, outcome: 'applied' };
    const queued = snake.step(snake.input(s, { buttons: ['up'], durationMs: 100 }), 6) as SnakeState;
    const c = compactSnakeObservation(observe(queued), snake.candidates(queued), previous);
    expect(c).toMatchObject({ direction: 'right', queued: 'up', nextScheduledDirection: 'up', nextMoveInTicks: 14,
      controls: { held: [] }, sincePreviousObservation: { elapsedTicks: 6, movementTicksElapsed: 0, headDisplacement: { dx: 0, dy: 0 }, foodEaten: 0 } });
    const grown = snake.step(queued, 14) as SnakeState;
    expect(compactSnakeObservation(observe(grown), snake.candidates(grown), previous)).toMatchObject({
      direction: 'up', queued: null, sincePreviousObservation: { movementTicksElapsed: 1, headDisplacement: { dx: 0, dy: -1 }, foodEaten: 1, foodPositionChanged: true } });
    const before = JSON.stringify(grown); compactSnakeObservation(observe(grown), snake.candidates(grown), previous);
    expect(JSON.stringify(grown)).toBe(before);
  });

  it('keeps departing-tail occupancy visible and leaves its legality to the existing rule engine', () => {
    const s = snake.create({}, 'tail') as SnakeState;
    s.body = [{ x: 4, y: 4 }, { x: 3, y: 4 }, { x: 3, y: 5 }, { x: 4, y: 5 }]; s.food = { x: 12, y: 8 }; s.score.food = 1; s.score.points = 100;
    const c = compactSnakeObservation(observe(s), snake.candidates(s));
    expect(c.geometry.find(g => g.direction === 'down')).toMatchObject({ bodyIndex: 3, isTailCell: true, isFoodCell: false });
    expect(snake.step(snake.input(s, { buttons: ['down'], durationMs: 100 }), 20).status).toBe('playing');
  });

  it('all variants preserve rules, candidates, input timing and deterministic replay', () => {
    const finals = SNAKE_HARNESS_VERSIONS.map(version => {
      let state = snake.create({}, 'same-rules') as SnakeState;
      for (const d of ['right', 'down', 'left', 'up'] as const) {
        const actions = snake.candidates(state), saved = JSON.stringify(state);
        snakeHarnessPosition(version, observe(state), actions); snakeHarnessInstructions(version);
        expect(JSON.stringify(state)).toBe(saved);
        const selected = actions.find(a => a.input.buttons[0] === d)!;
        state = snake.step(snake.input(state, selected.input), 60) as SnakeState;
      }
      return state;
    });
    expect(finals[1]).toEqual(finals[0]); expect(finals[2]).toEqual(finals[0]);
    expect(snake.rulesVersion).toBe('snake-realtime-v2');
  });
});
