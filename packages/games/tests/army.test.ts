import { describe, expect, it } from 'vitest';
import type { Seat } from '@decision-arena/core';
import { army, armyTerrain, armyWatchView, type ArmyState } from '../src/army';

type Kind = NonNullable<ArmyState['board'][number]>['kind'];
function sparse(pieces: [number, Seat, Kind][], turn: Seat = 0): ArmyState {
  const state = army.create({}, 'scenario') as ArmyState;
  state.phase = 'playing'; state.ready = [true, true]; state.turn = turn;
  state.board = Array(60).fill(null);
  for (const [index, seat, kind] of [[1, 0, 'flag'], [58, 1, 'flag'], ...pieces] as [number, Seat, Kind][]) state.board[index] = { id: `piece-${seat}-${index}`, seat, kind, moved: false };
  state.positions = [`${turn}|${state.board.map(p => p ? `${p.seat}:${p.kind}` : '.').join(',')}`];
  return state;
}
const move = (state: ArmyState, from: number, to: number) => army.apply(state, state.turn, `move:${from}:${to}`) as ArmyState;
const ids = (state: ArmyState, seat: Seat = state.turn) => army.legalActions(state, seat).map(a => a.id);

describe('independent hidden-information army rules', () => {
  it('keeps explicit watch perspectives after natural completion without changing model observations or full replays', () => {
    const state = sparse([[53, 0, 'bomb'], [50, 1, 'platoon']]);
    const before = army.observe(state, 0);
    const full = armyWatchView(state, 'full');
    expect(full.cells.filter(Boolean).every(p => !p?.hidden)).toBe(true);
    expect(full.legalActions).toEqual([]);
    expect(army.observe(state, 0)).toEqual(before);
    const finished = move(state, 53, 58);
    for (const seat of [0, 1] as const) {
      const side = armyWatchView(finished, seat);
      expect(side.phase).toBe('finished');
      expect(side.cells.filter(p => p?.seat === seat).every(p => !p?.hidden)).toBe(true);
      expect(side.cells.filter(p => p?.seat !== seat && p).some(p => p?.hidden)).toBe(true);
      expect(side.legalActions).toEqual([]);
    }
    expect(army.view(finished, 'spectator').cells.filter(Boolean).every(p => !p?.hidden)).toBe(true);
    expect(armyWatchView(finished, 'full').cells).toEqual(army.view(finished, 'full').cells);
  });
  it('reproducibly creates 25 legal pieces per side with both seats unready', () => {
    for (let seed = 0; seed < 30; seed++) {
      const state = army.create({}, String(seed)) as ArmyState;
      expect(state).toEqual(army.create({}, String(seed)));
      expect(state.ready).toEqual([false, false]);
      expect(state.phase).toBe('setup');
      expect(state.board.filter(p => p?.seat === 0)).toHaveLength(25);
      expect(state.board.filter(p => p?.seat === 1)).toHaveLength(25);
      for (const index of armyTerrain.camps) expect(state.board[index]).toBeNull();
      state.board.forEach((piece, index) => {
        if (!piece) return;
        const localRow = piece.seat === 0 ? Math.floor(index / 5) : 11 - Math.floor(index / 5);
        if (piece.kind === 'mine') expect(localRow).toBeLessThan(2);
        if (piece.kind === 'bomb') expect(localRow).not.toBe(5);
        if (piece.kind === 'flag') { expect(localRow).toBe(0); expect(armyTerrain.headquarters).toContain(index); }
        expect(piece.id).not.toContain(piece.kind);
      });
    }
    expect(army.create({}, 'one')).not.toEqual(army.create({}, 'two'));
  });

  it('validates swaps independently, locks ready seats and starts only when both ready', () => {
    const start = army.create({}, 'setup') as ArmyState;
    const candidate = army.legalActions(start, 0).find(a => a.id.startsWith('swap:'))!;
    const swapped = army.apply(start, 0, candidate.id) as ArmyState;
    expect(swapped.ply).toBe(0);
    expect(swapped.board.slice(30)).toEqual(start.board.slice(30));
    expect(swapped.board[candidate.to!]).toEqual(start.board[candidate.from!]);
    expect(army.restore(JSON.parse(JSON.stringify(swapped)))).toEqual(swapped);
    const mine = start.board.findIndex(p => p?.seat === 0 && p.kind === 'mine');
    expect(() => army.apply(start, 0, `swap:${mine}:25`)).toThrow();
    expect(() => army.apply(start, 0, 'swap:0:59')).toThrow();
    const ready = army.apply(swapped, 0, 'ready');
    expect(ready.phase).toBe('setup');
    expect(army.legalActions(ready, 0)).toEqual([]);
    expect(() => army.apply(ready, 0, candidate.id)).toThrow();
    const playing = army.apply(ready, 1, 'ready');
    expect(playing.phase).toBe('playing'); expect(playing.turn).toBe(0);
    expect(army.legalActions(playing, 1)).toEqual([]);
    expect(army.restore(JSON.parse(JSON.stringify(playing)))).toEqual(playing);
  });

  it('allows engineers to turn on rail but forbids rail jumps, crossings in mountain gaps, and rail travel into the back row', () => {
    const engineer = sparse([[5, 0, 'engineer'], [50, 1, 'platoon']]);
    expect(ids(engineer)).toContain('move:5:19');
    expect(ids(engineer)).not.toContain('move:5:55');
    const general = sparse([[5, 0, 'general'], [50, 1, 'platoon']]);
    expect(ids(general)).toContain('move:5:9');
    expect(ids(general)).not.toContain('move:5:19');
    const block = sparse([[5, 0, 'general'], [15, 1, 'platoon'], [50, 1, 'platoon']]);
    expect(ids(block)).toContain('move:5:15'); expect(ids(block)).not.toContain('move:5:20');
    const mountain = sparse([[26, 0, 'company'], [27, 0, 'company'], [50, 1, 'platoon']]);
    expect(ids(mountain)).not.toContain('move:26:31'); expect(ids(mountain)).toContain('move:27:32');
  });

  it('respects diagonal camp links, camp protection, immovable mines/flags and HQ imprisonment', () => {
    const camps = sparse([[11, 0, 'company'], [12, 0, 'engineer'], [13, 1, 'commander'], [50, 1, 'platoon']]);
    expect(ids(camps)).toContain('move:11:17');
    expect(ids(camps)).not.toContain('move:12:13');
    const locked = sparse([[3, 0, 'general'], [5, 0, 'mine'], [50, 1, 'platoon']]);
    expect(ids(locked)).toEqual([]);
    const enter = sparse([[2, 0, 'general'], [50, 1, 'platoon']]);
    const next = move(enter, 2, 3);
    expect(next.board[3]?.kind).toBe('general');
    next.turn = 0;
    expect(ids(next)).toEqual([]);
  });

  it.each([
    ['engineer', 'mine', 'engineer'], ['general', 'mine', 'mine'], ['bomb', 'mine', null],
    ['company', 'company', null], ['general', 'company', 'general'], ['company', 'general', 'general'], ['general', 'bomb', null],
  ] as const)('resolves %s attacking %s as %s', (attacker, defender, survivor) => {
    const state = sparse([[47, 0, attacker], [52, 1, defender], [5, 0, 'engineer'], [50, 1, 'platoon']]);
    const before = JSON.stringify(state), next = move(state, 47, 52);
    expect(next.board[47]).toBeNull();
    expect(next.board[52]?.kind ?? null).toBe(survivor);
    expect(next.ply).toBe(1); expect(next.turn).toBe(1);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('prioritizes capturing the flag, reveals flags when commanders die and declares no-moves loss', () => {
    const captured = move(sparse([[53, 0, 'bomb'], [50, 1, 'platoon']]), 53, 58);
    expect(captured.result).toEqual({ winner: 0, reason: 'FLAG_CAPTURED' });
    expect(captured.phase).toBe('finished');
    const deadCommander = move(sparse([[47, 0, 'commander'], [52, 1, 'mine'], [5, 0, 'engineer'], [50, 1, 'platoon']]), 47, 52);
    expect(army.view(deadCommander, 1).cells[1]?.kind).toBe('flag');
    const trapped = move(sparse([[47, 0, 'engineer'], [52, 1, 'mine']]), 47, 52);
    expect(trapped.result).toEqual({ winner: 0, reason: 'NO_LEGAL_MOVES' });
    expect(() => army.apply(trapped, 1, 'move:58:53')).toThrow();
  });

  it('uses three occurrences with the same side to move for a repetition draw', () => {
    let state = sparse([[5, 0, 'company'], [50, 1, 'company']]);
    for (const [from, to] of [[5, 6], [50, 51], [6, 5], [51, 50]]) state = move(state, from, to);
    expect(state.result).toBeUndefined();
    for (const [from, to] of [[5, 6], [50, 51], [6, 5], [51, 50]]) state = move(state, from, to);
    expect(state.result).toEqual({ winner: null, reason: 'THREEFOLD_REPETITION' });
  });

  it('does not expose hidden types or the setup seed in player observations or public views', () => {
    const mine = sparse([[47, 0, 'platoon'], [52, 1, 'mine'], [5, 0, 'engineer'], [50, 1, 'platoon']]);
    const division = sparse([[47, 0, 'platoon'], [52, 1, 'division'], [5, 0, 'engineer'], [50, 1, 'platoon']]);
    expect(army.observe(mine, 0)).toEqual(army.observe(division, 0));
    expect(army.view(mine, 0)).toEqual(army.view(division, 0));
    expect(army.view(mine, 'spectator')).toEqual(army.view(division, 'spectator'));
    expect(army.view(mine, 'full').cells[52]?.kind).toBe('mine');
    const initial = army.create({}, 'private-seed');
    expect(JSON.stringify(army.observe(initial, 0))).not.toContain('private-seed');
    expect(army.view(initial, 'spectator').cells.filter(Boolean).every(p => p?.hidden)).toBe(true);
    expect(army.legalActions(initial, 0).every(a => !Object.values(['司令', '地雷', '军旗']).some(name => a.label.includes(name)))).toBe(true);
  });

  it('retains only justified battle knowledge and removes a mine hypothesis when the defender later moves', () => {
    let state = sparse([[47, 0, 'platoon'], [52, 1, 'division'], [5, 0, 'engineer'], [50, 1, 'platoon']]);
    state = move(state, 47, 52);
    expect(army.view(state, 0).cells[52]).toMatchObject({ kind: 'unknown', label: '>排长或雷', hidden: true });
    state = move(state, 52, 51);
    expect(army.view(state, 0).cells[51]).toMatchObject({ kind: 'unknown', label: '>排长', hidden: true });
    const attack = move(sparse([[47, 0, 'general'], [52, 1, 'company'], [5, 0, 'engineer'], [50, 1, 'platoon']]), 47, 52);
    expect(army.view(attack, 1).cells[52]?.kind).toBe('general');
    expect(army.view(attack, 'spectator').cells[52]?.kind).toBe('general');
  });

  it('restores real legal games and rejects forged board or intel', () => {
    let state = army.create({}, 'replay');
    state = army.apply(state, 0, 'ready'); state = army.apply(state, 1, 'ready');
    for (let n = 0; n < 12 && !state.result; n++) state = army.apply(state, state.turn, army.legalActions(state, state.turn)[0].id);
    expect(army.restore(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(() => army.restore({ ...state, board: [] })).toThrow();
    expect(() => army.restore({ ...state, intel: [{ forged: { exact: 'flag' } }, {}] })).toThrow();
  });
});
