import type { ArcadeAction, ArcadePoint, SnakeHarnessVersion } from '@decision-arena/core';

/** Immutable experiment versions. Add a new ID instead of editing a released version.
 * A copies the v4 instructions byte-for-byte; B changes instructions only.
 * Rule engine, candidate labels/order, request pacing and transport are shared.
 */
export const SNAKE_HARNESS_VERSIONS = ['snake-harness-a-v1', 'snake-harness-b-v1', 'snake-harness-c-v1'] as const;
export const DEFAULT_SNAKE_HARNESS: SnakeHarnessVersion = 'snake-harness-a-v1';
export const SNAKE_HARNESS_PROTOCOL = 'decision-arena-arcade-v4';
export function snakeHarnessVersion(value: unknown): SnakeHarnessVersion {
  // Legacy absence always means A, even if a later release changes the new-session default.
  if (value === undefined) return 'snake-harness-a-v1';
  if (!(SNAKE_HARNESS_VERSIONS as readonly unknown[]).includes(value)) throw new Error('Unknown snake harness version');
  return value as SnakeHarnessVersion;
}

const frozenCommon = [
  '你正在控制一款连续运行的实时游戏。根据本侧当前局面，从候选中选择一个最有助于取得更好成绩的按键输入。',
  'position 是观察时刻的真实局面；坐标、图例和时间单位以其中的说明为准。recentInputs 是本侧最近已接受的输入，不是必须重复的策略。',
  '游戏以每秒 60 tick 运行，模型请求期间物理继续。返回的按键在收到后的下一 tick 才进入模拟，不会回到观察时刻执行。',
  'runtime.lastResponseMs 是本侧上一次请求的实际响应耗时（毫秒，首次为 null），可作为延迟参考，但不保证本次耗时相同。',
  '候选时长表示按键保持时间，不是游戏暂停或思考时间；每次输入替换上一组按键，时长结束自动松开。只选择一个给定候选，不输出坐标、路线或额外动作。',
].join('\n');
const frozenObjective = [
    '目标：120 秒内尽量吃到更多食物；食物数相同时存活更久的一方获胜。',
    '结合蛇头、从头到尾的身体坐标、食物、当前方向和下一次移动时间，选择通向食物且能继续生存的方向；检查墙壁和身体，不要只按食物所在方向直冲。',
    '方向是绝对方向；不能反向。按键松开不会停止前进，移动速度和下一次移动时间以 position 的 movementEveryTicks、movesPerSecond、nextMoveInTicks 为准。短按会保留到下一次移动，100 毫秒并不代表只走一格；考虑响应期间仍会继续前进。',
    '不吃食物时尾格会腾出，吃到食物时尾巴不移动。候选只保证按键规则合法，不保证不会撞墙或身体；没有自动避障。',
  ].join('\n');
export const SNAKE_BASELINE_INSTRUCTIONS = `${frozenCommon}\n${frozenObjective}`;

// Derived from the observed queued-turn duplication and late wall turn in the trace audit.
const realtimeStrategy = [
  '目标：120 秒内尽量多吃食物，食物数相同时比较存活时间。安全绕行是为了继续吃食物，不要长期重复一圈而不接近食物。',
  '先区分已经行进的 direction 和尚未执行的 queued：queued 非空时，这个转向已经提交，下一移动时刻就会执行，不需要再次提交来确认。结合最近输入判断上一次转向正在等待、已生效还是已经驶过目标；不要把旧观察中未移动的蛇头当作上次按键未成功。',
  '请求期间蛇每隔 movementEveryTicks 继续走一格，先执行已排队方向，随后一直沿该方向行进。参考 nextMoveInTicks 和 runtime.lastResponseMs 估计等待期间会走多少格，并为本次延迟波动和下一次请求留出空间；这些时间只是参考，不是延迟上限。提前在仍有转向余地时选方向，不要等贴墙才请求转弯。',
  '100ms 是按键持续时间，不是只走一格；松键不停止，重复相同方向也不刹车。回答只能在返回后改变方向，不能补做已经错过的转弯。食物若在等待期间已被吃到，旧食物位置不再值得直冲。',
  '对每个候选，结合身体从头到尾的顺序检查沿途的墙和身体，并考虑收到回答时的位置可能已变化。非增长移动的尾格会腾出，吃食物的那一步尾格仍被占用。候选合法不等于安全；所有危险但合法的方向仍由你判断，没有自动避障。',
  '优先选择有后续转向空间的方向，在能持续生存的选择中推进吃食物；必要时暂时远离食物再绕回。用最近动作与实际位置变化检查是否无得分循环。只选一个给定方向，不输出路线或额外动作。',
].join('\n');
export const SNAKE_REALTIME_INSTRUCTIONS = `${frozenCommon}\n${realtimeStrategy}`;

type Direction = 'up' | 'right' | 'down' | 'left';
/** Only the already-visible projection is accepted. No RNG, simulation, or future-food access. */
export interface SnakeVisibleObservation {
  gameId: 'snake'; status: string; width: number; height: number; tick: number; tickRate: number;
  ticksRemaining: number; secondsRemaining: number; head: ArcadePoint; tail: ArcadePoint; body: ArcadePoint[];
  direction: Direction; queued: Direction | null; food: ArcadePoint | null;
  movementEveryTicks: number; movesPerSecond: number; nextMoveInTicks: number | null;
  controls: { held: string[]; releaseTick: number | null; releaseInTicks: number | null };
  score: { food?: number; points: number; survivedTicks: number; completed?: boolean };
}
export interface SnakePreviousObservation {
  tick: number; head: ArcadePoint; direction: Direction; queued: Direction | null;
  food: ArcadePoint | null; foodCount: number;
  actionId?: string; appliedTick?: number; outcome?: string;
}
export function rememberSnakeObservation(o: SnakeVisibleObservation): SnakePreviousObservation {
  return { tick: o.tick, head: { ...o.head }, direction: o.direction, queued: o.queued,
    food: o.food && { ...o.food }, foodCount: o.score.food ?? 0 };
}
const vectors: Record<Direction, ArcadePoint> = { up: { x: 0, y: -1 }, right: { x: 1, y: 0 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 } };
const same = (a: ArcadePoint | null, b: ArcadePoint | null) => a === b || !!a && !!b && a.x === b.x && a.y === b.y;

/** C provides symmetric, one-cell geometry. It does not sort, score, filter or select candidates. */
export function compactSnakeObservation(o: SnakeVisibleObservation, actions: readonly ArcadeAction[], previous?: SnakePreviousObservation) {
  return {
    gameId: o.gameId, status: o.status,
    coordinates: { width: o.width, height: o.height, origin: 'top-left', x: 'right', y: 'down', units: 'cells' },
    clock: { tick: o.tick, tickRate: o.tickRate, ticksRemaining: o.ticksRemaining, secondsRemaining: o.secondsRemaining },
    direction: o.direction, queued: o.queued,
    movementEveryTicks: o.movementEveryTicks, movesPerSecond: o.movesPerSecond, nextMoveInTicks: o.nextMoveInTicks,
    nextScheduledDirection: o.queued ?? o.direction,
    controlMeaning: 'direction 已生效；queued 已接受但尚未移动，非空时不需要重复确认。nextScheduledDirection 是无新输入时下一次移动方向。松键不停止。',
    controls: { held: [...o.controls.held], releaseTick: o.controls.releaseTick, releaseInTicks: o.controls.releaseInTicks },
    head: { ...o.head }, food: o.food && { ...o.food },
    foodOffset: o.food ? { dx: o.food.x - o.head.x, dy: o.food.y - o.head.y } : null,
    bodyOrder: 'body 从蛇头到蛇尾，最后一项是尾格；非增长移动尾格腾出，增长时不腾出',
    body: structuredClone(o.body), score: { ...o.score },
    geometryMeaning: '以下仅为观察时刻的静态几何，不预测返回时局面；bodyIndex=-1 表示当前未占用；wallDistance 是沿该方向到墙前的格数，不代表身体通路安全。所有候选顺序和可选性不变。',
    geometry: actions.map(action => {
      const d = action.input.buttons[0] as Direction, v = vectors[d];
      const adjacent = { x: o.head.x + v.x, y: o.head.y + v.y };
      const bodyIndex = o.body.findIndex(p => same(p, adjacent));
      return { actionId: action.id, direction: d, adjacent,
        outside: adjacent.x < 0 || adjacent.x >= o.width || adjacent.y < 0 || adjacent.y >= o.height,
        bodyIndex, isTailCell: bodyIndex === o.body.length - 1, isFoodCell: same(adjacent, o.food),
        wallDistance: d === 'up' ? o.head.y : d === 'right' ? o.width - 1 - o.head.x : d === 'down' ? o.height - 1 - o.head.y : o.head.x };
    }),
    sincePreviousObservation: previous ? {
      observedTick: previous.tick, elapsedTicks: o.tick - previous.tick,
      movementTicksElapsed: Math.floor(o.tick / o.movementEveryTicks) - Math.floor(previous.tick / o.movementEveryTicks),
      previousHead: { ...previous.head }, headDisplacement: { dx: o.head.x - previous.head.x, dy: o.head.y - previous.head.y },
      previousDirection: previous.direction, previousQueued: previous.queued,
      selectedAction: previous.actionId ?? null, outcome: previous.outcome ?? null, appliedTick: previous.appliedTick ?? null,
      foodEaten: (o.score.food ?? 0) - previous.foodCount, foodPositionChanged: !same(previous.food, o.food),
      meaning: '这些是两次真实观察的差值，包含请求等待期间的持续行进，不等于上次按键单独造成的效果。',
    } : null,
  };
}

export function snakeHarnessInstructions(version: SnakeHarnessVersion): string {
  return snakeHarnessVersion(version) === 'snake-harness-a-v1' ? SNAKE_BASELINE_INSTRUCTIONS : SNAKE_REALTIME_INSTRUCTIONS;
}
export function snakeHarnessPosition(version: SnakeHarnessVersion, position: unknown, actions: readonly ArcadeAction[], previous?: SnakePreviousObservation): unknown {
  return snakeHarnessVersion(version) === 'snake-harness-c-v1' ? compactSnakeObservation(position as SnakeVisibleObservation, actions, previous) : position;
}
