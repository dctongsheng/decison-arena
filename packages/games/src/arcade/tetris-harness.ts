import type { Action, ArcadePoint, TetrisGoalTarget, TetrisHarnessVersion } from '@decision-arena/core';
import { TETROMINOES, tetrisCells, tetrisPoseFits, tetrisConditionalHardDrop, type FallingPiece, type Tetromino } from './tetris';

/** Independent MIT implementation of the V8 design, adapted to continuous Arena time.
 * Read-only reference: game-harness-lab/docs/experiments/tetris-landing-v8/research-harness.json
 * Reference id: landing-planning-2fd8b603374a82bb (paused 80-action experiment, NOT Arena results).
 * SHA-256 file: 73e437b7aacb4e5ac8afdfd8a178e5bf4dd00f6a3a21bb1a5f65875f328eaa24
 * Original action prompt: 38b7d6e45e00a5c5b12a40783673a7b4263a31c3bd978d42111797049c8ef1da
 * Original goal prompt: 4a3d30b81be0fd58983549888699e6c377ab8d950a6818ff2bfc7e324dae23b8
 * No reference runtime, assets, state, credentials or experiment data is imported.
 */
export const TETRIS_HARNESS_VERSIONS = ['tetris-harness-baseline-v1', 'tetris-harness-v8-realtime-v1'] as const;
export const TETRIS_HARNESS_PROTOCOL = 'tetris-harness-v8-realtime-v1';
export const DEFAULT_TETRIS_HARNESS: TetrisHarnessVersion = 'tetris-harness-baseline-v1';
export function tetrisHarnessVersion(value: unknown): TetrisHarnessVersion {
  if (value === undefined) return 'tetris-harness-baseline-v1';
  if (!(TETRIS_HARNESS_VERSIONS as readonly unknown[]).includes(value)) throw new Error('Unknown Tetris harness version');
  return value as TetrisHarnessVersion;
}
/** Exact pre-V8 v4 text. Kept independent so future common prompts cannot alter old sessions. */
export const TETRIS_BASELINE_INSTRUCTIONS = [
  '你正在控制一款连续运行的实时游戏。根据本侧当前局面，从候选中选择一个最有助于取得更好成绩的按键输入。',
  'position 是观察时刻的真实局面；坐标、图例和时间单位以其中的说明为准。recentInputs 是本侧最近已接受的输入，不是必须重复的策略。',
  '游戏以每秒 60 tick 运行，模型请求期间物理继续。返回的按键在收到后的下一 tick 才进入模拟，不会回到观察时刻执行。',
  'runtime.lastResponseMs 是本侧上一次请求的实际响应耗时（毫秒，首次为 null），可作为延迟参考，但不保证本次耗时相同。',
  '候选时长表示按键保持时间，不是游戏暂停或思考时间；每次输入替换上一组按键，时长结束自动松开。只选择一个给定候选，不输出坐标、路线或额外动作。',
  '目标：120 秒内最大化消行数，其次是消行得分，再其次是存活时间。硬降或软降本身不加分。',
  '先读已锁定棋盘的各行、活动方块的四个格子和朝向，再结合预览与 hold 判断如何填满整行、避免空洞及中间堆高。为当前方块确定合适的目标列与朝向，选择能推进这个放置计划的一个按键：先用左右移动、旋转或暂存调整，位置合适时及时硬降锁定。',
  '硬降会立即把活动块移到当前横向位置和朝向所能到达的最低处，并立刻锁定；它不会自动横移、旋转或寻找最佳落点。不要把硬降当作默认的前进一步。',
  '自然重力会持续下落，释放所有按键也会继续下落；但被动等待本身不产生消行。不要因为方块还在高处就默认不操作，应利用下落时间调整位置。只有确实需要松键或等待短暂时机时才选释放所有按键。',
  '旋转、硬降和 hold 是单次按下；左右与软降的时长决定持续操作多久。返回时若已经换块，答案会丢弃。候选不是落点规划，危险但合法的按键也会照常执行。',
].join('\n');
const REALTIME_CONTRACT = [
  '这是连续实时俄罗斯方块。所有调用关闭思考；60Hz物理在目标请求和按键请求期间都继续，120秒及共享调用预算不因规划暂停。目标是先最大化消行数，再比较原生消行积分，最后存活tick；软硬降本身无分。',
  'position与PNG都来自同一次当前公开观察。x为0..9，y向下，-2/-1是已公开的生成行。active.x是局部框原点；目标leftmost_column是实际四格最左列。rotation=0/1/2/3为生成朝向起顺时针四种朝向。',
  '目标只是Decision选择的记忆，不是可执行指令。keep/clear/40个target只出现在目标调用；实际每一个原生按键必须由另一次Decision选择，程序不寻路、不代按、不自动硬降、不过滤危险合法候选。',
  '新块（包括hold）、块类型或锁定棋盘改变使目标失效；同一作用域每4次已接受按键再次规划。clear后不立即再问目标，等下一固定规划点。规划和按键都消耗调用预算。',
  'tetris_landing_projections完整按列0..9、朝向0..3描述40项：假设当前块立刻处于该朝向和最左列，保持观察中的active.y，再垂直硬降。pose_valid只表示假设初始姿态不越界不重叠；native_reachability始终not_proven。没有横移、SRS路径、按键耗时、重力、锁定倒计时或hold可达性模拟。',
  '后果是消行后的锁定棋盘事实。holes_delta是空洞净变化；空洞为同列上方已有锁块的空格，列高包括两行生成区。top_out只检查消行后生成区锁块，不预测下一块生成；false不是下一块可生成保证。invalid项的后果为null，不是零风险。',
  'runtime.lastResponseMs只是上次实际耗时，不保证本次。规划成功也不会回到观察时刻；按键在收到后下一物理帧接受，目标可能已过时。结合gravityEveryTicks、fallTicks、lockTicks、held与近期真实变化判断剩余时间。不要把请求等待期间移动归为某个按键的全部效果。',
].join('\n');
/** Exact frozen reference text. Adaptations are appended explicitly, never edited into these strings. */
// SHA-256: 4a3d30b81be0fd58983549888699e6c377ab8d950a6818ff2bfc7e324dae23b8
export const TETRIS_V8_SOURCE_GOAL_INSTRUCTIONS = "这是目标选择调用，只从42项目录输出一个ID，不产生任何按键。流程：(1)先复核已有目标：若decision_goal_memory中目标仍属当前块、pose_valid且后果不比其他候选差，输出keep；若目标对应的块已锁定、棋盘已变、目标姿态无效或明显劣于当前最优候选，输出clear或直接换新target，不要盲目保留，也不要无理由每轮追逐不同列。(2)选新目标时，逐个比较tetris_landing_projections中候选的完整后果：lines_cleared与points_delta（原生消行分，一行缺4格配横I只消1行，四消需四行齐备）、holes_delta（净变化，不是新增空洞数；负值可因消行填洞）、max_height、total_height、bumpiness、top_out。invalid或后果为null的候选不可当作零空洞零消行的好结果，直接不选。pose_valid只是几何假设成立，native_reachability始终为not_proven，不要把投影有效说成按键可达；但不因可达性未证明就放弃，可达性由动作层逐步校正。(3)取舍自己判断：优先消行得分；其次避免净增空洞与盖洞（被覆盖的洞无法靠竖直下落填）；控制max_height接近生成区、保持bumpiness低、为后续块（next预览）留平整可放空间；top_out=true的候选绝不选。(4)紧急时优先消最低可行行、压低最高列。不得用位置偏好代替后果比较，不得对已成功的局面承诺改进，不得生成评分公式、权重、路径、宏或fallback。输出恰好一个ID：keep、clear或target:c:r。";
// SHA-256: 38b7d6e45e00a5c5b12a40783673a7b4263a31c3bd978d42111797049c8ef1da
export const TETRIS_V8_SOURCE_ACTION_INSTRUCTIONS = "所有调用think_mode=never，每次只做一个判断：当前最左占用列与朝向是否等于目标，否则选最接近目标的单个原生按键。(1)目标规划：仅在目标更新点（新作用域或每4次游戏动作）调用keep/clear/target；游戏按键调用绝不输出keep/clear/target，也没有即时换目标接口。decision_goal_memory中target仍有效（同块、棋盘未变）且可达时选keep；目标被锁块挡住或形状不合时clear（clear后等下一固定更新点）或直接选新target。选目标时：有tetris_features用columns[].height与hole_ys，无则读board.rows估各列高度；优先铺平底面、不悬空、不盖洞。注意：某行缺4格配横I只消1行，消4行需4行同时完整；被覆盖的洞不能靠竖直下落填。(2)单步执行：用active.cells最小x作当前最左列（不是active.x）。若tetris_control_facts存在，用current.leftmost_column、horizontal_held_ticks、target_relation.column_error判断。旋转：active.rotation≠目标朝向时选rotate-cw:100一次（差3用rotate-ccw:100），下步重读朝向确认。平移：横移计时器跨动作保留——300ms新方向最多约4次移动尝试，同方向成熟加速期续按约6次尝试；1000ms新方向最多约18次尝试；墙与锁块会限制实际位移，长按不保证越过也不保证位移，实际以cells为准。默认用100或300短按键沿目标方向移动，每步后按实际cells校正：仍在目标一侧继续同方向；到达目标列立即停横移。误差1格且held_ticks低（<6）可用100ms，但同向连续短按会在计时器达9/12/15时每按多移1-2格，越过后按新列误差重新决策——越过或反转只是事实，若新误差仍可安全校正且预算允许可再短按一次反方向，不必也不许因越过就无条件锁块或无限往返；若反复校正仍不收敛（如已≥2次反向仍未对齐），选当前可用的最平整落点hard-drop或让其自然锁定，勿耗尽步数。若同向held_ticks很高导致短按连发，Decision可在锁定窗口充足、且当前纵向离地尚远时主动用一次noop:100重置横移计时器，代价是推进6tick重力/锁定并消耗一个动作预算；noop不是固定程序，接地或锁定临近时禁用。(3)锁定：仅当最左占用列等于target.leftmost_column、rotation等于目标朝向、且读棋盘确认落点不悬空造洞时hard-drop:100。grounded且位置正确时立即硬降，勿拖延（30tick锁定、横移重置上限15次）。hold每块限一次，仅当当前块无任何不恶化落点时用。绝不向更高列硬降假装目标达成；上方接近生成区时优先消最低可行行。";
// SHA-256: 82d91f9dc478adf2051a2ec69d1930d861441525bb00a7fa636e9df91c86f25d
export const TETRIS_V8_SOURCE_STRATEGY_NOTES = "核心修正旧错误映射：300ms=18tick、新方向最多约4次移动尝试，同方向成熟加速期（每3tick一次）续按约6次尝试；1000ms约18次尝试；100ms不保证1格，同向计时器达9/12/15时短按会触发重复移动。所有时长只是尝试次数，墙与锁块限制实际位移（历史I贴墙长按恰达目标列），必须每步读cells校正。历史0分局根因是S/L在目标列两侧用300ms无限往复；对策是接受越过、按新列误差校正，禁止无限往返，也不把越过本身当作锁块理由。目标规划与执行分离：目标只在固定更新点选，keep/clear/target不进游戏按键；一行缺4格配横I只消1行，四消需四行齐备。noop仅在离地远、锁定窗口充足时由Decision主动用于重置横移计时器，并计入重力与动作代价。推演保持一两步：朝向是否相等、列误差正负、该按哪个单键。";
export const TETRIS_V8_ARENA_ADDENDUM = [
  'Arena实时适配补充：以下接口与时间约束在和上方研究原文冲突时优先。原研究是模型等待期间暂停、80动作、points评分的条件；本局不是该实验，不承诺或复用其成绩。',
  '本局按消行数、原生积分、存活tick顺序比较，120秒上限。目标与按键均由外部Decision选择并消耗同一请求预算；不是每个方块固定6-8步预算，没有完成目标的自动按键。',
  '模型等待期间物理持续；100/300/1000ms只是原生按键最多保持6/18/60tick的时长，不是每次调用只推进这些tick，也不保证等待后仍是原姿态。新返回输入可提前替换仍在持续的旧按键。',
  '同向held计时器继续；旋转、硬降和hold只在新按下边沿触发，若同键仍held，重复选择不会重新触发。若需再次按同键须由Decision自己选择释放再按，程序不自动松键重按。',
  'tetris_features、decision_goal_memory、tetris_control_facts、tetris_landing_projections 均位于position。近期动作的after字段只在真实后续观察确认后出现；运动包含等待期间影响，不等于某个按键单独造成的效果。',
  REALTIME_CONTRACT,
].join('\n');
export const TETRIS_V8_GOAL_INSTRUCTIONS = TETRIS_V8_SOURCE_GOAL_INSTRUCTIONS + '\n' + TETRIS_V8_ARENA_ADDENDUM;
export const TETRIS_V8_ACTION_INSTRUCTIONS = TETRIS_V8_SOURCE_ACTION_INSTRUCTIONS + '\n策略参考：\n' + TETRIS_V8_SOURCE_STRATEGY_NOTES + '\n' + TETRIS_V8_ARENA_ADDENDUM;
export function tetrisHarnessInstructions(version: TetrisHarnessVersion, purpose: 'goal' | 'action'): string {
  return tetrisHarnessVersion(version) === 'tetris-harness-baseline-v1' ? TETRIS_BASELINE_INSTRUCTIONS
    : purpose === 'goal' ? TETRIS_V8_GOAL_INSTRUCTIONS : TETRIS_V8_ACTION_INSTRUCTIONS;
}
export interface TetrisGoalActionEvidence {
  actionId: string; observedTick: number; appliedTick?: number;
  beforeLeftmostColumn: number; beforeRotation: number;
  afterLeftmostColumn?: number; afterRotation?: number; afterObservedTick?: number; outcome?: string;
  targetAtAction?: TetrisGoalTarget | null;
}
export interface TetrisGoalMemory { target: TetrisGoalTarget | null; ageActions: number | null; recentActions: TetrisGoalActionEvidence[] }
const int = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const piece = (v: unknown): v is Tetromino => typeof v === 'string' && (TETROMINOES as readonly string[]).includes(v);
function requireValue(ok: unknown): asserts ok { if (!ok) throw new Error('Invalid public Tetris observation'); }
function number(v: unknown, lo: number, hi: number): number { requireValue(int(v, lo, hi)); return v; }
const cellsKey = (cells: ArcadePoint[]) => cells.map(p => `${p.x},${p.y}`).sort().join(';');
/** Strict public input whitelist shared by context and PNG. Missing data never becomes an empty board. */
export function readTetrisObservation(value: unknown) {
  const o = value as Record<string, any>;
  requireValue(o && o.gameId === 'tetris' && o.width === 10 && o.height === 20 && o.hiddenRows === 2 && ['playing', 'finished'].includes(o.status));
  requireValue(Array.isArray(o.board?.rows) && o.board.rows.length === 22);
  const byY = new Map<number, string>();
  for (const row of o.board.rows) {
    requireValue(row && int(row.y, -2, 19) && !byY.has(row.y) && typeof row.cells === 'string' && /^[.IOTSZJL]{10}$/.test(row.cells));
    byY.set(row.y, row.cells);
  }
  const rows = Array.from({ length: 22 }, (_, i) => ({ y: i - 2, cells: byY.get(i - 2)! }));
  const board = rows.flatMap(r => [...r.cells].map(c => c === '.' ? 0 : TETROMINOES.indexOf(c as Tetromino) + 1));
  let active: (FallingPiece & { cells: ArcadePoint[] }) | null = null;
  if (o.active !== null) {
    const a = o.active;
    requireValue(a && piece(a.type) && int(a.rotation, 0, 3) && int(a.x, -3, 9) && int(a.y, -2, 19));
    requireValue(Array.isArray(a.cells) && a.cells.length === 4 && a.cells.every((p: ArcadePoint) => p && int(p.x, 0, 9) && int(p.y, -2, 19)));
    const native = tetrisCells(a);
    requireValue(cellsKey(native) === cellsKey(a.cells));
    if (o.status === 'playing') requireValue(tetrisPoseFits(board, a));
    active = { type: a.type, rotation: a.rotation, x: a.x, y: a.y, cells: native };
  } else requireValue(o.status === 'finished');
  requireValue(Array.isArray(o.next) && o.next.length >= 5 && o.next.slice(0, 5).every(piece));
  requireValue((o.hold === null || piece(o.hold)) && typeof o.holdAvailable === 'boolean' && typeof o.grounded === 'boolean');
  const isButtons = (value: unknown): value is string[] => Array.isArray(value) && value.every((b: unknown) => typeof b === 'string' && ['left','right','rotate-cw','rotate-ccw','soft-drop','hard-drop','hold'].includes(b));
  requireValue(o.score && o.controls && isButtons(o.controls.held) && isButtons(o.controls.pendingEdges));
  const tick = number(o.tick, 0, 7200);
  const observation = { gameId: 'tetris' as const, status: o.status as 'playing' | 'finished', width: 10, height: 20, hiddenRows: 2,
    tick, tickRate: 60, ticksRemaining: 7200 - tick, secondsRemaining: (7200 - tick) / 60,
    coordinates: 'x=0..9 right; y=-2..19 down; -2,-1 are exposed spawn rows', board: { columns: [0,1,2,3,4,5,6,7,8,9], rows },
    active, next: [...o.next.slice(0, 5)] as Tetromino[], hold: o.hold as Tetromino | null, holdAvailable: o.holdAvailable as boolean,
    pieceId: number(o.pieceId, 1, 20000), grounded: o.grounded as boolean,
    gravityEveryTicks: number(o.gravityEveryTicks, 6, 48), effectiveFallEveryTicks: number(o.effectiveFallEveryTicks, 3, 48), fallTicks: number(o.fallTicks, 0, 47),
    lockTicks: number(o.lockTicks, 0, 30), lockLimitTicks: 30, lockResets: number(o.lockResets, 0, 15), maxLockResets: 15,
    horizontalDirection: number(o.horizontalDirection, -1, 1), horizontalHeldTicks: number(o.horizontalHeldTicks, 0, 7200),
    controls: { held: [...o.controls.held] as string[], pendingEdges: [...o.controls.pendingEdges] as string[], releaseTick: o.controls.releaseTick === null ? null : number(o.controls.releaseTick, 0, 7260),
      releaseInTicks: o.controls.releaseInTicks === null ? null : number(o.controls.releaseInTicks, 0, 60) },
    score: { points: number(o.score.points, 0, 16594560000), lines: number(o.score.lines, 0, 28800), survivedTicks: number(o.score.survivedTicks, 0, 7200) } };
  return { observation, board };
}
function boardFacts(board: readonly number[]) {
  const columns = Array.from({ length: 10 }, (_, x) => {
    const ys = Array.from({ length: 22 }, (_, i) => i - 2).filter(y => board[(y + 2) * 10 + x] !== 0);
    const top = ys[0] ?? null, holes = top === null ? [] : Array.from({ length: 19 - top }, (_, i) => top + 1 + i).filter(y => board[(y + 2) * 10 + x] === 0);
    return { x, top_occupied_y: top, height: top === null ? 0 : 20 - top, occupied_count: ys.length, hole_ys: holes, hole_count: holes.length };
  });
  const heights = columns.map(c => c.height);
  return { columns, rows: Array.from({ length: 22 }, (_, row) => ({ y: row - 2, occupied_count: board.slice(row * 10, row * 10 + 10).filter(Boolean).length,
    missing_columns: Array.from({ length: 10 }, (_, x) => x).filter(x => board[row * 10 + x] === 0) })),
    total_locked_cells: columns.reduce((n, c) => n + c.occupied_count, 0), total_holes: columns.reduce((n, c) => n + c.hole_count, 0),
    max_height: Math.max(...heights), total_height: heights.reduce((a,b) => a+b,0), bumpiness: heights.slice(1).reduce((n,h,i) => n + Math.abs(h-heights[i]),0) };
}
export function tetrisLandingProjections(position: unknown) {
  const { observation: o, board } = readTetrisObservation(position);
  requireValue(o.status === 'playing' && o.active);
  const active = o.active, before = boardFacts(board);
  const candidates = Array.from({ length: 40 }, (_, index) => {
    const column = Math.floor(index / 4), rotation = index % 4 as 0 | 1 | 2 | 3;
    const offsets = tetrisCells({ type: active.type, rotation, x: 0, y: 0 });
    const pose = { type: active.type, rotation, x: column - Math.min(...offsets.map(p => p.x)), y: active.y };
    const cells = tetrisCells(pose);
    const reason = cells.some(p => p.x < 0 || p.x >= 10) ? 'outside_horizontal_bounds'
      : cells.some(p => p.y < -2 || p.y >= 20) ? 'outside_vertical_bounds' : !tetrisPoseFits(board, pose) ? 'start_pose_collision' : null;
    const projected = reason === null ? tetrisConditionalHardDrop(board, pose, o.score.lines) : null;
    const after = projected ? boardFacts(projected.board) : null;
    return { id: `target:${column}:${rotation}`, leftmost_column: column, rotation, pose_valid: reason === null, invalid_reason: reason,
      native_reachability: 'not_proven' as const, landing_origin: projected ? { x: projected.piece.x, y: projected.piece.y } : null,
      landing_cells: projected ? projected.cells.sort((a,b) => a.y-b.y || a.x-b.x) : null,
      lines_cleared: projected?.linesCleared ?? null, points_delta: projected?.pointsDelta ?? null,
      holes_before: before.total_holes, holes_after: after?.total_holes ?? null, holes_delta: after ? after.total_holes-before.total_holes : null,
      max_height: after?.max_height ?? null, total_height: after?.total_height ?? null, bumpiness: after?.bumpiness ?? null, top_out: projected?.topOut ?? null };
  });
  return { schema: 'arena-tetris-conditional-landings-v1', assumptions: { method: 'conditional_vertical_hard_drop_from_assumed_pose',
    active_origin_y: active.y, level_before: 1 + Math.floor(o.score.lines / 10), native_reachability: 'not_proven',
    scope: 'Current public locked board only; no inputs, SRS path, gravity/time, hold, RNG or next-piece spawn simulation.',
    top_out: 'Remaining locked cells in spawn rows after line clear; false does not guarantee the next piece can spawn.',
    ordering: 'All 40 targets, column 0..9 then rotation 0..3, no ranking or filtering' }, before, candidates };
}
export function tetrisGoalCandidates(position: unknown): Action[] {
  return [{ id: 'keep', label: '保持当前目标；无目标则仍无目标，不执行按键' }, { id: 'clear', label: '清空目标，等下一固定规划点；不执行按键' },
    ...tetrisLandingProjections(position).candidates.map(p => ({ id: p.id, label: `目标最左占用列=${p.leftmost_column}，朝向=${p.rotation}；` +
      (p.pose_valid ? `条件直落：消${p.lines_cleared}行，积分+${p.points_delta}，空洞${p.holes_before}→${p.holes_after}（净${p.holes_delta}），最大列高${p.max_height}，总列高${p.total_height}，高度差绝对值之和${p.bumpiness}，隐藏行锁块=${p.top_out}`
        : `假设起始姿态无效：${p.invalid_reason}，后果未知`) + '；按键路径未验证，不执行按键' }))];
}
export function tetrisGoalScope(position: unknown) {
  const { observation: o } = readTetrisObservation(position); requireValue(o.active);
  return { pieceId: o.pieceId, pieceType: o.active.type, boardKey: o.board.rows.map(r => r.cells).join('') };
}
function targetCopy(target: TetrisGoalTarget | null): TetrisGoalTarget | null {
  if (target === null) return null;
  requireValue(target && int(target.leftmostColumn, 0, 9) && int(target.rotation, 0, 3));
  return { leftmostColumn: target.leftmostColumn, rotation: target.rotation };
}
export function applyTetrisGoalChoice(currentTarget: TetrisGoalTarget | null, choiceId: string): TetrisGoalTarget | null {
  if (choiceId === 'clear') return null;
  if (choiceId === 'keep') return targetCopy(currentTarget);
  const match = /^target:([0-9]):([0-3])$/.exec(choiceId);
  if (!match) throw new Error('Invalid Tetris goal choice');
  return { leftmostColumn: Number(match[1]), rotation: Number(match[2]) as 0 | 1 | 2 | 3 };
}
export function tetrisHarnessPosition(version: TetrisHarnessVersion, position: unknown, memory?: TetrisGoalMemory): unknown {
  if (tetrisHarnessVersion(version) === 'tetris-harness-baseline-v1') return position;
  const { observation: o, board } = readTetrisObservation(position); requireValue(o.active && o.status === 'playing');
  const target = targetCopy(memory?.target ?? null), left = Math.min(...o.active.cells.map(p => p.x));
  const recent = (memory?.recentActions ?? []).slice(-4).map(a => {
    requireValue(/^(noop|left|right|rotate-cw|rotate-ccw|soft-drop|hard-drop|hold):(100|300|1000)$/.test(a.actionId));
    return { action_id: a.actionId, observed_tick: number(a.observedTick, 0, 7200), applied_tick: a.appliedTick === undefined ? null : number(a.appliedTick, 0, 7200),
      before_leftmost_column: number(a.beforeLeftmostColumn, 0, 9), before_rotation: number(a.beforeRotation, 0, 3),
      after_leftmost_column: a.afterLeftmostColumn === undefined ? null : number(a.afterLeftmostColumn, 0, 9),
      after_rotation: a.afterRotation === undefined ? null : number(a.afterRotation, 0, 3),
      after_observed_tick: a.afterObservedTick === undefined ? null : number(a.afterObservedTick, 0, 7200),
      target_at_action: a.targetAtAction === undefined ? undefined : targetCopy(a.targetAtAction),
      outcome: ['applied','dropped','failed','unknown'].includes(a.outcome ?? '') ? a.outcome : null };
  });
  const horizontal = recent.filter(a => /^(left|right):/.test(a.action_id));
  const last = recent.at(-1);
  const confirmed = last && last.outcome === 'applied' && last.after_leftmost_column !== null && last.after_rotation !== null && last.after_observed_tick !== null;
  const sameTarget = !!last && last.target_at_action !== undefined && (last.target_at_action === null ? target === null : !!target && last.target_at_action.leftmostColumn === target.leftmostColumn && last.target_at_action.rotation === target.rotation);
  const crossingApplicable = !!(confirmed && target && sameTarget && last.before_rotation === last.after_rotation && /^(left|right):/.test(last.action_id));
  return { ...o, tetris_features: { schema: 'arena-tetris-visible-facts-v1', definitions: 'Locked cells only; heights include spawn rows. Holes are empty cells below a locked cell in the same column.', ...boardFacts(board) },
    decision_goal_memory: { target: target ? { leftmost_column: target.leftmostColumn, rotation: target.rotation } : null,
      age_actions: memory?.ageActions == null ? null : number(memory.ageActions, 0, 300), recent_actions: recent },
    tetris_control_facts: { schema: 'arena-tetris-realtime-control-facts-v1', current: { leftmost_column: left, rotation: o.active.rotation,
      horizontal_direction: o.horizontalDirection, horizontal_held_ticks: o.horizontalHeldTicks },
      target_relation: { column_error: target ? target.leftmostColumn-left : null, rotation_equal: target ? target.rotation === o.active.rotation : null,
        at_target: target ? target.leftmostColumn === left && target.rotation === o.active.rotation : null },
      last_transition: confirmed ? { ...last, physical_ticks: last.after_observed_tick! - last.observed_tick,
        actual_column_delta: last.after_leftmost_column! - last.before_leftmost_column,
        target_unchanged: last.target_at_action === undefined ? null : sameTarget,
        crossing_comparison_applicable: crossingApplicable,
        strictly_crossed_target_column: crossingApplicable && (target!.leftmostColumn-last.before_leftmost_column) * (target!.leftmostColumn-last.after_leftmost_column!) < 0 } : null,
      recent_window: { max_actions: 4, recorded_actions: recent.length, horizontal_command_reversals: horizontal.slice(1).filter((a,i) => a.action_id.split(':')[0] !== horizontal[i].action_id.split(':')[0]).length },
      meaning: 'Only real observation and accepted-input evidence. Missing after fields are unconfirmed. Waiting time and other inputs also affect position; duration is not actual displacement.' },
    tetris_landing_projections: tetrisLandingProjections(o) };
}
