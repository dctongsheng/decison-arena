import { describe, expect, it } from 'vitest';
import { arcadeGames, getArcadeGame, games, getGame } from '../src';

describe('arcade adapters and turn-based compatibility', () => {
  it('registers three arcade games independently of the three existing turn-based games', () => {
    expect(arcadeGames.map(g => g.id)).toEqual(['snake', 'tetris', 'platformer']);
    expect(games.map(g => g.id)).toEqual(['army', 'xiangqi', 'gomoku']);
    expect(getGame('gomoku').id).toBe('gomoku');
    expect(() => getGame('snake')).toThrow();
    expect(() => getArcadeGame('unknown')).toThrow();
  });

  it.each(arcadeGames)('$id replays timestamped controls identically across JSON restore and tick batching', game => {
    const initial = game.create({}, 'replay-seed'), saved = JSON.stringify(initial);
    const first = game.candidates(initial).find(a => a.input.buttons.includes('right'))!;
    const controlled = game.input(initial, first.input);
    const continuous = game.step(controlled, 90);
    let checkpoint = game.step(controlled, 15);
    checkpoint = game.restore(JSON.parse(JSON.stringify(checkpoint)));
    checkpoint = game.step(checkpoint, 75);
    expect(checkpoint).toEqual(continuous);
    expect(JSON.stringify(initial)).toBe(saved);
    expect(game.compare(continuous.score, checkpoint.score)).toBe(0);
    expect(() => game.step(initial, -1)).toThrow();
    expect(() => game.step(initial, 0.5)).toThrow();
    expect(() => game.step(initial, 7201)).toThrow();
    expect(game.step(initial, 0)).toEqual(initial);
  });

  it.each(arcadeGames)('$id candidates are bounded, stable and contain actual primitive inputs', game => {
    const state = game.create({}, 'candidate-seed'), candidates = game.candidates(state);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(24);
    expect(new Set(candidates.map(a => a.id)).size).toBe(candidates.length);
    for (const candidate of candidates) expect(() => game.input(state, candidate.input)).not.toThrow();
    expect(game.candidates(state)).toEqual(candidates);
    expect(() => game.restore({ ...state, tick: NaN })).toThrow();
    expect(() => game.restore({ ...state, releaseTick: Infinity })).toThrow();
  });
});
