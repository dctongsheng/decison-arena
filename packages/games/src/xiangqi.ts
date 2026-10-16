import type { Action, GameAdapter, GameResult, GameState, GameView, Seat, Viewer } from '@decision-arena/core';
import { Xiangqi, type XiangqiMove } from './vendor/xiangqi.cjs';
import { other, record, requireTurn, same } from './common';

export interface XiangqiState extends GameState { gameId: 'xiangqi'; fen: string; history: string[] }
const labels: Record<string, string> = { r: '车', n: '马', b: '象', a: '士', k: '将', c: '炮', p: '卒', R: '车', N: '马', B: '相', A: '仕', K: '帅', C: '炮', P: '兵' };
const rules = '中国象棋体验规则：红先黑后，马腿、象眼、九宫、炮架、过河兵、将帅照面及必须应将均适用。将死或困毙对方获胜。相同局面及行棋方出现三次、连续120个半回合无吃子，或双方仅剩将帅士象则和棋；暂不实施赛事长将长捉责任裁定。坐标a-i从红方左至右，0为红方底线，9为黑方底线。';
const toIndex = (square: string) => (9 - Number(square[1])) * 9 + square.charCodeAt(0) - 97;
const seatOf = (color: 'r' | 'b'): Seat => color === 'r' ? 0 : 1;

function engine(state?: XiangqiState): Xiangqi {
  const board = new Xiangqi();
  if (state) for (const action of state.history) {
    if (!board.move(action)) throw new Error('象棋棋谱包含非法走法');
  }
  return board;
}

function outcome(board: Xiangqi): GameResult | undefined {
  if (board.in_checkmate()) return { winner: other(seatOf(board.turn())), reason: 'CHECKMATE' };
  if (board.in_stalemate()) return { winner: other(seatOf(board.turn())), reason: 'STALEMATE' };
  if (board.in_threefold_repetition()) return { winner: null, reason: 'THREEFOLD_REPETITION' };
  if (Number(board.fen().split(' ')[4]) >= 120) return { winner: null, reason: 'SIXTY_MOVES' };
  if (board.insufficient_material()) return { winner: null, reason: 'INSUFFICIENT_MATERIAL' };
  return undefined;
}

function create(): XiangqiState {
  return { gameId: 'xiangqi', turn: 0, phase: 'playing', ply: 0, fen: new Xiangqi().fen(), history: [] };
}

function legalActions(input: GameState, seat: Seat): Action[] {
  const state = input as XiangqiState;
  if (state.phase !== 'playing' || state.result || state.turn !== seat) return [];
  // A current position suffices for candidate generation; repetition uses the full history in apply.
  return (new Xiangqi(state.fen).moves({ verbose: true }) as XiangqiMove[]).map(move => ({
    id: move.iccs, from: toIndex(move.from), to: toIndex(move.to),
    label: `${labels[move.color === 'r' ? move.piece.toUpperCase() : move.piece.toLowerCase()]} ${move.from}→${move.to}${move.captured ? '（吃子）' : ''}`,
  })).sort((a, b) => a.id.localeCompare(b.id));
}

function apply(input: GameState, seat: Seat, actionId: string): XiangqiState {
  const state = input as XiangqiState;
  requireTurn(state, seat);
  if (!/^[a-i][0-9][a-i][0-9]$/.test(actionId)) throw new Error('象棋走法坐标无效');
  const board = engine(state);
  if (!board.move(actionId)) throw new Error('象棋走法不合法');
  const result = outcome(board);
  return { gameId: 'xiangqi', turn: seatOf(board.turn()), phase: result ? 'finished' : 'playing', ply: state.ply + 1, fen: board.fen(), history: [...state.history, actionId], ...(result ? { result } : {}) };
}

function view(input: GameState, viewer: Viewer): GameView {
  const state = input as XiangqiState;
  const board = new Xiangqi(state.fen);
  return {
    gameId: 'xiangqi', rows: 10, cols: 9, turn: state.turn, phase: state.phase, ply: state.ply,
    cells: board.board().flat().map((p, index) => {
      if (!p) return null;
      const kind = p.color === 'r' ? p.type.toUpperCase() : p.type;
      return { id: `piece-${index}`, seat: seatOf(p.color), kind: p.type, label: labels[kind] };
    }),
    legalActions: typeof viewer === 'number' ? legalActions(state, viewer) : [],
    ...(state.result ? { result: { ...state.result } } : {}),
  };
}

function restore(input: unknown): XiangqiState {
  const data = record(input);
  if (data.gameId !== 'xiangqi' || !Array.isArray(data.history) || data.history.length > 2000) throw new Error('象棋存档格式无效');
  // Replay through public moves: FEN alone does not preserve repetition history.
  const board = new Xiangqi();
  let result: GameResult | undefined;
  for (const move of data.history) {
    if (typeof move !== 'string' || !/^[a-i][0-9][a-i][0-9]$/.test(move) || result || !board.move(move)) throw new Error('象棋棋谱包含非法走法');
    result = outcome(board);
  }
  const state: XiangqiState = { gameId: 'xiangqi', turn: seatOf(board.turn()), phase: result ? 'finished' : 'playing', ply: data.history.length, fen: board.fen(), history: data.history.slice() as string[], ...(result ? { result } : {}) };
  if (state.fen !== data.fen || state.ply !== data.ply || state.turn !== data.turn || state.phase !== data.phase || !same(state.result, data.result)) throw new Error('象棋存档与棋谱不一致');
  return state;
}

export const xiangqi: GameAdapter = {
  id: 'xiangqi', name: '中国象棋', rulesVersion: 'xiangqi-casual-1-f9019ac', rules,
  create, legalActions, apply, view, restore,
  observe(input, seat) {
    const state = input as XiangqiState, board = new Xiangqi(state.fen);
    return { game: '中国象棋', rules, yourSeat: seat, yourColor: seat === 0 ? '红' : '黑', fen: state.fen, board: board.ascii(), inCheck: board.in_check() };
  },
};
