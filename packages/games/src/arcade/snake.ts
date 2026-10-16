import { ARCADE_TICK_RATE, type ArcadeAdapter, type ArcadeButton, type ArcadePoint, type ArcadeState } from '@decision-arena/core';
import { actions, advance, baseState, clearInput, finish, integer, observationClock, observationControls, random, seedNumber, setInput, validInput } from './common';

const DIRECTIONS = ['up', 'right', 'down', 'left'] as const;
const MOVEMENT_EVERY_TICKS = 20;
const MOVES_PER_SECOND = ARCADE_TICK_RATE / MOVEMENT_EVERY_TICKS;
type Direction = typeof DIRECTIONS[number];
const VECTOR: Record<Direction, ArcadePoint> = { up: { x: 0, y: -1 }, right: { x: 1, y: 0 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 } };
const LABEL: Record<Direction, string> = { up: '向上', right: '向右', down: '向下', left: '向左' };
export interface SnakeState extends ArcadeState {
  gameId: 'snake'; body: ArcadePoint[]; direction: Direction; queued: Direction | null; food: ArcadePoint | null; rng: number;
}
const equal = (a: ArcadePoint, b: ArcadePoint) => a.x === b.x && a.y === b.y;
const opposite = (a: Direction, b: Direction) => (DIRECTIONS.indexOf(a) + 2) % 4 === DIRECTIONS.indexOf(b);
function newFood(s: SnakeState): void {
  const occupied = new Set(s.body.map(p => p.y * 20 + p.x));
  const free: number[] = [];
  for (let i = 0; i < 400; i++) if (!occupied.has(i)) free.push(i);
  if (!free.length) { s.food = null; s.score.completed = true; finish(s, 'BOARD_FILLED'); return; }
  const cell = free[random(s) % free.length];
  s.food = { x: cell % 20, y: Math.floor(cell / 20) };
}
function frame(s: SnakeState): void {
  // A direction key is latched until the next movement tick. Releasing a key never stops the snake.
  if (s.held.length === 1 && !opposite(s.direction, s.held[0] as Direction)) s.queued = s.held[0] as Direction;
  if (s.tick % MOVEMENT_EVERY_TICKS !== 0) return;
  if (s.queued && !opposite(s.direction, s.queued)) s.direction = s.queued;
  s.queued = null;
  const v = VECTOR[s.direction], head = { x: s.body[0].x + v.x, y: s.body[0].y + v.y };
  if (head.x < 0 || head.x >= 20 || head.y < 0 || head.y >= 20) { finish(s, 'WALL_COLLISION'); return; }
  const eating = !!s.food && equal(head, s.food);
  // Entering the departing tail is legal only on a non-growing move.
  if (s.body.slice(0, eating ? undefined : -1).some(p => equal(p, head))) { finish(s, 'SELF_COLLISION'); return; }
  s.body.unshift(head);
  if (eating) { s.score.food = (s.score.food ?? 0) + 1; s.score.points = s.score.food * 100; newFood(s); }
  else s.body.pop();
}
export const snake: ArcadeAdapter = {
  id: 'snake', name: '贪吃蛇', rulesVersion: 'snake-realtime-v2',
  rules: `20×20，长度3，初始向右；每秒${MOVES_PER_SECOND}格。不能反向，撞墙或自己结束；不增长时可进入即将离开的尾格。食物使长度加1、得100分；最多120秒。先比较食物数，再比较存活tick。方向保持前进，不自动避障。`,
  create(_config, seed): SnakeState {
    const s: SnakeState = { gameId: 'snake', tick: 0, status: 'playing', score: { points: 0, food: 0, survivedTicks: 0, completed: false }, held: [], releaseTick: null,
      body: [{ x: 4, y: 10 }, { x: 3, y: 10 }, { x: 2, y: 10 }], direction: 'right', queued: null, food: null, rng: seedNumber(seed) };
    newFood(s); return s;
  },
  candidates(state) {
    const s = state as SnakeState;
    return s.status === 'finished' ? [] : actions(DIRECTIONS.filter(d => !opposite(s.direction, d)).map(d => ({ buttons: [d], label: `${LABEL[d]}，在下一移动 tick 设置方向，之后继续沿此方向前进`, durations: [100] })));
  },
  input(state, input) {
    const s = state as SnakeState;
    validInput(input, DIRECTIONS);
    if (input.buttons.length > 1 || (input.buttons.length && opposite(s.direction, input.buttons[0] as Direction))) throw new Error('贪吃蛇不能反向或同时按多个方向');
    const copy = setInput(s, input);
    // A short direction tap remains committed until the next movement. Internal release cancels it.
    if (input.buttons.length) copy.queued = input.buttons[0] as Direction;
    return copy;
  },
  release(state) { return clearInput(state as SnakeState); },
  step(state, ticks) { return advance(state as SnakeState, ticks, frame); },
  observe(state) {
    const s = state as SnakeState;
    const cells = Array.from({ length: 20 }, () => Array<string>(20).fill('.'));
    s.body.forEach((point, index) => { cells[point.y][point.x] = index === 0 ? 'H' : index === s.body.length - 1 ? 'T' : 'B'; });
    if (s.food) cells[s.food.y][s.food.x] = 'F';
    return { gameId: 'snake', status: s.status, width: 20, height: 20, ...observationClock(s),
      coordinates: '单位是格；左上角为 (0,0)，x 向右增加，y 向下增加。x、y 均为 0..19；每行第 x 个字符对应该列。',
      board: { columns: Array.from({ length: 20 }, (_, x) => x), rows: cells.map((row, y) => ({ y, cells: row.join('') })),
        legend: { '.': '空格', H: '蛇头', B: '蛇身', T: '蛇尾', F: '食物' } },
      head: { ...s.body[0] }, tail: { ...s.body[s.body.length - 1] }, bodyOrder: 'body 从蛇头到蛇尾排列', body: structuredClone(s.body),
      direction: s.direction, directionVector: { ...VECTOR[s.direction] }, queued: s.queued,
      movementEveryTicks: MOVEMENT_EVERY_TICKS, movesPerSecond: MOVES_PER_SECOND,
      nextMoveInTicks: s.status === 'playing' ? MOVEMENT_EVERY_TICKS - s.tick % MOVEMENT_EVERY_TICKS : null,
      controls: { ...observationControls(s), queuedDirection: s.queued,
        directionSemantics: 'queuedDirection 尚未执行，将在下一移动 tick 替换当前 direction。100ms 方向输入会保留到下一移动 tick；之后松键也继续前进，不能停止或直接反向。' },
      food: s.food && { ...s.food }, score: { ...s.score } };
  },
  view(state) {
    const s = state as SnakeState, cells = Array<number>(400).fill(0);
    for (const p of s.body) cells[p.y * 20 + p.x] = 1;
    if (s.food) cells[s.food.y * 20 + s.food.x] = 2;
    return { gameId: 'snake', tick: s.tick, status: s.status, score: { ...s.score }, width: 20, height: 20, currentButtons: [...s.held], reason: s.reason,
      cells, snake: structuredClone(s.body), food: s.food && { ...s.food } };
  },
  restore(value) {
    const s = baseState(value, 'snake', DIRECTIONS) as SnakeState;
    const point = (p: ArcadePoint) => p && integer(p.x, 0, 19) && integer(p.y, 0, 19);
    if (!Array.isArray(s.body) || s.body.length < 3 || s.body.length > 400 || !s.body.every(point) ||
      new Set(s.body.map(p => p.y * 20 + p.x)).size !== s.body.length ||
      s.body.some((p, i) => i > 0 && Math.abs(p.x - s.body[i - 1].x) + Math.abs(p.y - s.body[i - 1].y) !== 1) ||
      !DIRECTIONS.includes(s.direction) || (s.queued !== null && !DIRECTIONS.includes(s.queued)) ||
      !integer(s.rng, 0, 0xffffffff) || !integer(s.score.food, 0, 397) || s.body.length !== s.score.food! + 3 || s.score.points !== s.score.food! * 100 ||
      (s.food !== null && (!point(s.food) || s.body.some(p => equal(p, s.food!)))) || (s.food === null && s.body.length !== 400)) throw new Error('贪吃蛇存档无效');
    if (s.held.length > 1) throw new Error('贪吃蛇按键存档无效');
    return s;
  },
  compare(a, b) { return (a.food ?? 0) - (b.food ?? 0) || a.survivedTicks - b.survivedTicks; },
};
