import { describe, expect, it } from 'vitest';
import { arcadeGames } from '../src/arcade';
import { snake, type SnakeState } from '../src/arcade/snake';
import { tetris, type TetrisState } from '../src/arcade/tetris';
import { platformer, type PlatformerState } from '../src/arcade/platformer';

type RowBoard = { columns: number[]; rows: { y: number; cells: string }[]; legend: Record<string, string> };
type Controls = { held: string[]; releaseTick: number | null; releaseInTicks: number | null; pendingEdges: string[]; queuedDirection?: string | null };
type Observation = { board: RowBoard; controls: Controls; tick: number; tickRate: number; ticksRemaining: number; secondsRemaining: number; [key: string]: unknown };

describe('model-readable arcade observations', () => {
  it('distinguishes snake head, tail, food, current direction and a turn waiting after key release', () => {
    const initial = snake.create({}, 'observation') as SnakeState;
    initial.food = { x: 10, y: 12 };
    const state = snake.step(snake.input(initial, { buttons: ['up'], durationMs: 100 }), 6) as SnakeState;
    const observation = snake.observe(state) as Observation;
    expect(observation).toMatchObject({ tick: 6, tickRate: 60, ticksRemaining: 7194, secondsRemaining: 119.9,
      head: { x: 4, y: 10 }, tail: { x: 2, y: 10 }, direction: 'right', directionVector: { x: 1, y: 0 },
      queued: 'up', movementEveryTicks: 20, movesPerSecond: 3, nextMoveInTicks: 14,
      controls: { held: [], releaseTick: null, releaseInTicks: null, queuedDirection: 'up' } });
    expect(observation.board.columns).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(observation.board.rows).toHaveLength(20);
    expect(observation.board.rows[10]).toEqual({ y: 10, cells: '..TBH...............' });
    expect(observation.board.rows[12].cells[10]).toBe('F');
    expect(observation.board.rows.every(row => row.cells.length === 20)).toBe(true);
    expect(snake.step(state, 14).body).toEqual([{ x: 4, y: 9 }, { x: 4, y: 10 }, { x: 3, y: 10 }]);
  });

  it('labels all 22 Tetris rows with locked cells and keeps the active piece separate', () => {
    const state = tetris.create({}, 'observation') as TetrisState;
    state.board[0] = 1; state.board[19] = 7; state.board[25] = 2; state.board[219] = 3;
    state.active = { type: 'T', rotation: 1, x: 3, y: 5 };
    const observation = tetris.observe(state) as Observation;
    expect(observation.board.columns).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(observation.board.rows.map(row => row.y)).toEqual(Array.from({ length: 22 }, (_, index) => index - 2));
    expect(observation.board.rows[0]).toEqual({ y: -2, cells: 'I.........' });
    expect(observation.board.rows[1]).toEqual({ y: -1, cells: '.........L' });
    expect(observation.board.rows[2]).toEqual({ y: 0, cells: '.....O....' });
    expect(observation.board.rows[21]).toEqual({ y: 19, cells: '.........T' });
    expect(observation.board.rows.every(row => row.cells.length === 10)).toBe(true);
    expect(observation.active).toMatchObject({ type: 'T', rotation: 1, x: 3, y: 5,
      cells: [{ x: 5, y: 6 }, { x: 4, y: 5 }, { x: 4, y: 6 }, { x: 4, y: 7 }] });
    expect(observation.board.rows[7].cells).toBe('..........');
    expect(observation.next).toHaveLength(5);
    expect(observation).not.toHaveProperty('rng');
  });

  it('reports pending Tetris edges without applying them or resetting the macro clock', () => {
    const initial = tetris.create({}, 'observation') as TetrisState;
    initial.active = { type: 'T', rotation: 0, x: 3, y: 4 };
    const state = tetris.input(initial, { buttons: ['rotate-cw'], durationMs: 300 });
    const before = JSON.stringify(state), observation = tetris.observe(state) as Observation;
    expect(observation.controls).toMatchObject({ held: ['rotate-cw'], pendingEdges: ['rotate-cw'], releaseTick: 18, releaseInTicks: 18 });
    expect(observation.active).toMatchObject({ rotation: 0 });
    expect(JSON.stringify(state)).toBe(before);
    const next = tetris.step(state, 1) as TetrisState;
    expect(next.active?.rotation).toBe(1);
    expect((tetris.observe(next) as Observation).controls).toMatchObject({ pendingEdges: [], releaseTick: 18, releaseInTicks: 17 });
  });

  it('uses pixels consistently for the platform player, collision rectangles and enemy motion', () => {
    const state = platformer.step(platformer.input(platformer.create({ level: 3 }, 'observation'), { buttons: ['right', 'jump'], durationMs: 300 }), 12) as PlatformerState;
    const observation = platformer.observe(state) as Observation;
    expect(observation).toMatchObject({ width: 1536, height: 384, tick: 12, ticksRemaining: 7188, secondsRemaining: 119.8,
      units: { position: 'px', velocity: 'px/tick', acceleration: 'px/tick²', tilePixels: 32 },
      physics: { acceleration: 0.5, maxSpeed: 3, friction: 0.75, gravity: 0.5, jumpVelocity: -10.5, terminalFallSpeed: 16 },
      controls: { held: ['right', 'jump'], pendingEdges: [], releaseTick: 18, releaseInTicks: 6 } });
    expect(observation.player).toMatchObject({ x: state.player.x / 8, y: state.player.y / 8, width: 24, height: 28,
      vx: state.player.vx / 8, vy: state.player.vy / 8, onGround: false });
    expect(observation.platforms).toEqual([{ x: 0, y: 320, width: 1536, height: 64 }]);
    expect(observation.exit).toEqual({ x: 1440, y: 256, width: 32, height: 64 });
    expect(observation.enemies).toEqual(expect.arrayContaining([expect.objectContaining({ x: 332, y: 296, width: 24, height: 24,
      vx: 1, vy: 0, patrolMinX: 320, patrolMaxX: 480 })]));
    const atEnd = platformer.step(platformer.create({ level: 3 }, 'observation'), 160);
    const enemy = (platformer.observe(atEnd) as { enemies: { x: number; vx: number }[] }).enemies[0];
    expect(enemy).toMatchObject({ x: 480, vx: -1 });
    expect(platformer.view(platformer.step(atEnd, 1)).enemies![0].x).toBe(enemy.x + enemy.vx);
  });

  it.each(arcadeGames)('$id observation/candidate reads do not alter simulation or its restore format', game => {
    const state = game.create({ level: 1 }, 'read-only-observation');
    const saved = JSON.stringify(state), baseline = game.step(state, 60);
    const observation = game.observe(state) as Observation;
    game.candidates(state);
    observation.controls.held.push('left');
    observation.controls.pendingEdges.push('right');
    if (observation.board) observation.board.rows[0].cells = 'mutated';
    expect(JSON.stringify(state)).toBe(saved);
    expect(game.step(game.restore(JSON.parse(saved)), 60)).toEqual(baseline);
    expect(game.rulesVersion).toBe(`${game.id}-realtime-v${game.id === 'snake' ? 2 : 1}`);
  });
});
