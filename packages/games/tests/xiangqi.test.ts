import { describe, expect, it } from 'vitest';
import { xiangqi } from '../src/xiangqi';
import { Xiangqi } from '../src/vendor/xiangqi.cjs';

describe('pinned BSD xiangqi adapter', () => {
  it('starts with all 44 legal moves and correctly orients red at the bottom', () => {
    const state = xiangqi.create({}, '');
    expect(xiangqi.legalActions(state, 0)).toHaveLength(44);
    expect(xiangqi.legalActions(state, 1)).toEqual([]);
    const view = xiangqi.view(state, 0);
    expect(view.cells.filter(Boolean)).toHaveLength(32);
    expect(view.cells[4]?.label).toBe('将');
    expect(view.cells[85]?.label).toBe('帅');
    expect(view.cells[85]?.seat).toBe(0);
  });

  it('validates cannon screens, horse legs, elephant eyes and the river', () => {
    const initial = new Xiangqi();
    expect(initial.moves()).toContain('h2h9');
    expect(initial.moves()).not.toContain('h2h8');
    const horse = new Xiangqi('4k4/9/9/9/4p4/9/9/9/1R7/1N2K4 r - - 0 1');
    expect(horse.moves()).not.toContain('b0a2');
    expect(horse.moves()).not.toContain('b0c2');
    expect(horse.moves()).toContain('b0d1');
    const eye = new Xiangqi('4k4/9/9/9/4p4/9/9/9/3R5/2B1K4 r - - 0 1');
    expect(eye.moves()).not.toContain('c0e2');
    expect(eye.moves()).toContain('c0a2');
    const river = new Xiangqi('4k4/9/9/9/4p4/2B6/9/9/9/4K4 r - - 0 1');
    expect(river.moves()).not.toContain('c4a6');
    expect(river.moves()).not.toContain('c4e6');
    expect(river.moves()).toContain('c4a2');
  });

  it('prevents facing kings and detects stalemate as a loss condition, not draw', () => {
    const shield = new Xiangqi('4k4/9/9/9/4R4/9/9/9/9/4K4 r - - 0 1');
    expect(shield.moves()).not.toContain('e5d5');
    const trapped = new Xiangqi('3k5/R8/9/9/9/9/9/9/9/4K4 b - - 0 1');
    expect(trapped.in_check()).toBe(false);
    expect(trapped.in_stalemate()).toBe(true);
    expect(trapped.moves()).toEqual([]);
  });

  it('keeps public move-generation perft at 44 / 1920 / 79666 (does not use broken upstream perft)', () => {
    const game = new Xiangqi(), start = game.fen();
    function nodes(depth: number): number {
      if (!depth) return 1;
      let total = 0;
      for (const move of game.moves() as string[]) {
        expect(game.move(move)).not.toBeNull();
        total += nodes(depth - 1); game.undo();
      }
      return total;
    }
    expect([1, 2, 3].map(nodes)).toEqual([44, 1920, 79666]);
    expect(game.fen()).toBe(start);
  }, 20000);

  it('plays a real mating line, persists the outcome and rejects later moves', () => {
    let state = xiangqi.create({}, '');
    for (const action of ['h2h4', 'd9e8', 'h4g4', 'g6g5', 'g4g9']) state = xiangqi.apply(state, state.turn, action);
    expect(state.result).toEqual({ winner: 0, reason: 'CHECKMATE' });
    expect(xiangqi.restore(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(() => xiangqi.apply(state, 1, 'e9d9')).toThrow();
  });

  it('restores repetition knowledge, keeps candidates pure, and rejects tampered history', () => {
    let state = xiangqi.create({}, '');
    for (const action of ['h0g2', 'h9g7', 'g2h0', 'g7h9']) state = xiangqi.apply(state, state.turn, action);
    const before = JSON.stringify(state);
    xiangqi.legalActions(state, 0); xiangqi.observe(state, 0); xiangqi.view(state, 'spectator');
    expect(JSON.stringify(state)).toBe(before);
    state = xiangqi.restore(JSON.parse(before));
    for (const action of ['h0g2', 'h9g7', 'g2h0', 'g7h9']) state = xiangqi.apply(state, state.turn, action);
    expect(state.result).toEqual({ winner: null, reason: 'THREEFOLD_REPETITION' });
    expect(() => xiangqi.restore({ ...state, fen: 'bad' })).toThrow();
    const start = xiangqi.create({}, '');
    expect(() => xiangqi.apply(start, 1, 'h9g7')).toThrow();
    expect(() => xiangqi.apply(start, 0, 'e0e9')).toThrow();
  });
});
