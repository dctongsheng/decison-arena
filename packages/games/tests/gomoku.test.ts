import { describe, expect, it } from 'vitest';
import { gomoku, gomokuWinningLine, type GomokuState } from '../src/gomoku';

function play(moves: number[], size: 9 | 15 = 9): GomokuState {
  let state = gomoku.create({ size }, 'test') as GomokuState;
  for (const move of moves) state = gomoku.apply(state, state.turn, `place:${move}`) as GomokuState;
  return state;
}

describe('independent freestyle gomoku', () => {
  it('offers every empty point and rejects wrong seat, occupied and malformed moves without mutation', () => {
    const initial = gomoku.create({}, 'same');
    expect(gomoku.legalActions(initial, 0)).toHaveLength(225);
    expect(gomoku.legalActions(initial, 1)).toEqual([]);
    const saved = JSON.stringify(initial);
    for (const [seat, action] of [[1, 'place:0'], [0, 'place:225'], [0, 'place:-1'], [0, 'place:01']] as const) expect(() => gomoku.apply(initial, seat, action)).toThrow();
    expect(JSON.stringify(initial)).toBe(saved);
    const next = gomoku.apply(initial, 0, 'place:0');
    expect(() => gomoku.apply(next, 1, 'place:0')).toThrow();
    expect(gomoku.legalActions(next, 1)).toHaveLength(224);
  });

  it.each([
    [0, 1, 2, 3, 4], [0, 9, 18, 27, 36], [0, 10, 20, 30, 40], [8, 16, 24, 32, 40],
  ])('finds five-in-row in all four directions: %j', (...black) => {
    const moves = black.flatMap((value, i) => i === 4 ? [value] : [value, 72 + i * 2]);
    const state = play(moves);
    expect(state.result).toEqual({ winner: 0, reason: 'FIVE_IN_ROW' });
    expect(state.phase).toBe('finished');
    expect(new Set(gomokuWinningLine(state))).toEqual(new Set(black));
    expect(gomoku.legalActions(state, 1)).toEqual([]);
    expect(() => gomoku.apply(state, 1, 'place:5')).toThrow();
  });

  it('allows overlines: filling a gap can produce six', () => {
    const state = play([0, 80, 1, 78, 2, 76, 4, 74, 5, 72, 3]);
    expect(state.result?.winner).toBe(0);
    expect(gomokuWinningLine(state)).toHaveLength(6);
  });

  it('does not connect a row end to the next row start', () => {
    const state = play([7, 40, 8, 42, 9, 44, 10, 46, 11]);
    expect(state.result).toBeUndefined();
  });

  it('declares a full board with no five a draw', () => {
    const black: number[] = [], white: number[] = [];
    for (let i = 0; i < 81; i++) ((Math.floor(i / 9) * 2 + i % 9) % 4 < 2 ? black : white).push(i);
    const moves = black.flatMap((value, i) => white[i] === undefined ? [value] : [value, white[i]]);
    const state = play(moves);
    expect(state.result).toEqual({ winner: null, reason: 'BOARD_FULL' });
    expect(state.ply).toBe(81);
  });

  it('restores from verified history and rejects tampered state', () => {
    const state = play([40, 41, 30, 50]);
    expect(gomoku.restore(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(() => gomoku.restore({ ...state, board: [] })).toThrow();
    expect(() => gomoku.restore({ ...state, history: [40, 40] })).toThrow();
    expect(gomoku.view(state, 'spectator').legalActions).toEqual([]);
    expect(gomoku.view(state, 0).cells).toHaveLength(81);
    expect(() => gomoku.create({ size: 19 }, '')).toThrow();
  });
});
