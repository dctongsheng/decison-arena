import { describe, expect, it } from 'vitest';
import { tetris, tetrisCells, tetrisGravityTicks, TETROMINOES, type TetrisState } from '../src/arcade/tetris';
import type { ArcadeButton } from '@decision-arena/core';

const create = () => tetris.create({}, 'bag-fixture') as TetrisState;
const step = (s: TetrisState, ticks = 1) => tetris.step(s, ticks) as TetrisState;
const press = (s: TetrisState, buttons: ArcadeButton[]) => step(tetris.input(s, { buttons }) as TetrisState);
const release = (s: TetrisState) => press(s, []);

describe('independent realtime falling blocks', () => {
  it('deduplicates edge-only controls while retaining all horizontal/soft-drop durations', () => {
    const s = create(), candidates = tetris.candidates(s);
    expect(candidates).toHaveLength(14);
    const single = ['noop', 'rotate-cw', 'rotate-ccw', 'hard-drop', 'hold'];
    for (const key of single) expect(candidates.filter(c => c.id.startsWith(`${key}:`)).map(c => c.id)).toEqual([`${key}:100`]);
    for (const key of ['left', 'right', 'soft-drop'])
      expect(candidates.filter(c => c.id.startsWith(`${key}:`)).map(c => c.id)).toEqual([`${key}:100`, `${key}:300`, `${key}:1000`]);
    expect(tetris.candidates(press(s, ['hold']))).toHaveLength(13);
  });

  it('spawns from deterministic 7-bags and previews only five pieces', () => {
    let s = create();
    const seen: string[] = [];
    for (let n = 0; n < 21; n++) {
      seen.push(s.active!.type);
      s = press(s, ['hard-drop']);
      s.board.fill(0); // Isolate the random sequence from stack geometry.
      s = release(s);
    }
    for (let i = 0; i < 21; i += 7) expect(new Set(seen.slice(i, i + 7))).toEqual(new Set(TETROMINOES));
    expect(tetris.view(create()).next).toHaveLength(5);
    expect(create()).toEqual(create());
    expect(tetris.view(create()).cells).toHaveLength(200);
  });

  it('falls at 800ms initially, speeds up every ten lines and bottoms at 100ms', () => {
    const s = create(), y = s.active!.y;
    expect(step(s, 47).active!.y).toBe(y);
    expect(step(s, 48).active!.y).toBe(y + 1);
    s.score.lines = 10; expect(tetrisGravityTicks(s)).toBe(45);
    s.score.lines = 10000; expect(tetrisGravityTicks(s)).toBe(6);
  });

  it('uses a delayed horizontal repeat and exact duration expiry', () => {
    const s = create(), x = s.active!.x;
    const held = tetris.input(s, { buttons: ['right'], durationMs: 300 }) as TetrisState;
    expect(held.active!.x).toBe(x);
    expect(step(held, 1).active!.x).toBe(x + 1);
    expect(step(held, 9).active!.x).toBe(x + 1);
    expect(step(held, 10).active!.x).toBe(x + 2);
    const expired = step(held, 18);
    expect(expired.held).toEqual([]);
    expect(expired.releaseTick).toBeNull();
    expect(step(expired, 3).active!.x).toBe(expired.active!.x);
    expect(tetris.input(s, { buttons: ['left'] }).releaseTick).toBeNull();
  });

  it('edge triggers rotation and hard drop, without repeating a held key on the next piece', () => {
    const s = create(); s.active = { type: 'T', x: 3, y: 3, rotation: 0 };
    const rotated = press(s, ['rotate-cw']);
    expect(rotated.active!.rotation).toBe(1);
    expect(step(rotated, 10).active!.rotation).toBe(1);
    const ccw = press(release(rotated), ['rotate-ccw']);
    expect(ccw.active!.rotation).toBe(0);
    const dropped = press(s, ['hard-drop']);
    expect(dropped.pieceId).toBe(s.pieceId + 1);
    expect(dropped.board.some(Boolean)).toBe(true);
    expect(step(dropped, 10).pieceId).toBe(dropped.pieceId);
    expect(dropped.score.points).toBe(0);
  });

  it('recognizes a new key press immediately after actual macro expiry, but not a renewal before expiry', () => {
    const s = create(); s.active = { type: 'T', x: 3, y: 3, rotation: 0 };
    const macro = tetris.input(s, { buttons: ['rotate-cw'], durationMs: 100 }) as TetrisState;
    const beforeExpiry = step(macro, 5);
    expect(press(beforeExpiry, ['rotate-cw']).active!.rotation).toBe(1);
    const expired = step(macro, 6);
    expect(press(expired, ['rotate-cw']).active!.rotation).toBe(2);
    // Explicit key-up and key-down between ticks also form a real new press.
    const released = tetris.input(beforeExpiry, { buttons: [] }) as TetrisState;
    expect(press(released, ['rotate-cw']).active!.rotation).toBe(2);
  });

  it('preserves a hard-drop/rotation/horizontal tap before the next frame, and internal release cancels it', () => {
    const initial = create();
    const down = tetris.input(initial, { buttons: ['hard-drop'] }) as TetrisState;
    const up = tetris.input(down, { buttons: [] }) as TetrisState;
    expect(step(up).pieceId).toBe(initial.pieceId + 1);
    expect(step(tetris.release(up) as TetrisState).pieceId).toBe(initial.pieceId);
    const rotateDown = tetris.input(initial, { buttons: ['rotate-cw'] });
    expect(step(tetris.input(rotateDown, { buttons: [] }) as TetrisState).active!.rotation).toBe(1);
    const rightDown = tetris.input(initial, { buttons: ['right'] });
    expect(step(tetris.input(rightDown, { buttons: [] }) as TetrisState).active!.x).toBe(initial.active!.x + 1);
  });

  it('holds once per piece, makes stale piece IDs detectable and resets hold availability after lock', () => {
    const s = create(), first = s.active!.type, next = s.next[0];
    let held = press(s, ['hold']);
    expect(held.hold).toBe(first); expect(held.active!.type).toBe(next); expect(held.holdUsed).toBe(true);
    expect(held.pieceId).toBe(s.pieceId + 1);
    expect(tetris.candidates(held).some(a => a.input.buttons.includes('hold'))).toBe(false);
    const again = press(release(held), ['hold']);
    expect(again.active!.type).toBe(next); expect(again.pieceId).toBe(held.pieceId);
    held = press(again, ['hard-drop']);
    expect(held.holdUsed).toBe(false);
    const queue = [...held.next], stored = held.hold;
    held = press(release(held), ['hold']);
    expect(held.active!.type).toBe(stored);
    expect(held.next).toEqual(queue);
  });

  it('uses SRS wall kicks for clockwise and counterclockwise turns and rejects blocked rotations', () => {
    const s = create(); s.active = { type: 'T', rotation: 1, x: -1, y: 5 };
    expect(tetrisCells(s.active).every(p => p.x >= 0)).toBe(true);
    const cw = press(s, ['rotate-cw']);
    expect(cw.active).toMatchObject({ rotation: 2, x: 0 });
    const ccw = press(s, ['rotate-ccw']);
    expect(ccw.active).toMatchObject({ rotation: 0, x: 0 });
    const blocked = create(); blocked.active = { type: 'T', rotation: 0, x: 3, y: 10 };
    blocked.board.fill(1);
    for (const p of tetrisCells(blocked.active)) blocked.board[(p.y + 2) * 10 + p.x] = 0;
    const result = press(blocked, ['rotate-cw']);
    expect(result.active).toEqual(blocked.active);
  });

  it('locks after 30 grounded ticks and stops allowing lock-delay resets after 15', () => {
    const s = create(); s.active = { type: 'O', rotation: 0, x: 3, y: 18 };
    expect(step(s, 29).pieceId).toBe(s.pieceId);
    expect(step(s, 30).pieceId).toBe(s.pieceId + 1);
    let moving = s;
    for (let i = 0; i < 15; i++) moving = press(moving, [i % 2 ? 'right' : 'left']);
    expect(moving.lockResets).toBe(15);
    const lockTicks = moving.lockTicks;
    moving = press(moving, ['right']);
    expect(moving.lockResets).toBe(15); expect(moving.lockTicks).toBe(lockTicks + 1);
    moving = step(moving, 30);
    expect(moving.pieceId).toBeGreaterThan(s.pieceId);
  });

  it.each([[1, 100], [2, 300], [3, 500], [4, 800]])('clears %i rows, awards %i base points and preserves remaining rows', (count, points) => {
    const s = create(); s.active = { type: 'I', rotation: 1, x: 2, y: -2 };
    for (let y = 20 - count; y < 20; y++) for (let x = 0; x < 10; x++) if (x !== 4) s.board[(y + 2) * 10 + x] = 3;
    const cleared = press(s, ['hard-drop']);
    expect(cleared.score.lines).toBe(count);
    expect(cleared.score.points).toBe(points);
    expect(cleared.board.filter(Boolean)).toHaveLength(4 - count);
  });

  it('scores using the pre-clear level and does not award soft-drop points', () => {
    const s = create(); s.score.lines = 19; s.active = { type: 'I', rotation: 1, x: 2, y: -2 };
    for (let x = 0; x < 10; x++) if (x !== 4) s.board[210 + x] = 2;
    const cleared = press(s, ['hard-drop']);
    expect(cleared.score).toMatchObject({ lines: 20, points: 200 });
    const soft = step(tetris.input(create(), { buttons: ['soft-drop'] }) as TetrisState, 30);
    expect(soft.active!.y).toBe(8);
    expect(soft.score.points).toBe(0);
  });

  it('ends when a lock leaves occupied hidden rows and never pauses natural falling', () => {
    const s = create(); s.active = { type: 'O', rotation: 0, x: 3, y: -2 };
    s.board[24] = 1; s.board[25] = 1; // support on visible row zero
    const topOut = press(s, ['hard-drop']);
    expect(topOut.reason).toBe('TOP_OUT');
    expect(topOut.active).toBeNull();
    const unattended = step(create(), 7200);
    expect(unattended.status).toBe('finished');
    expect(unattended.tick).toBeGreaterThan(0);
    expect(unattended.tick).toBeLessThanOrEqual(7200);
    expect(unattended.reason).toBe('TOP_OUT');
    const almostTimedOut = create(); almostTimedOut.tick = 7199; almostTimedOut.score.survivedTicks = 7199;
    expect(step(almostTimedOut)).toMatchObject({ tick: 7200, reason: 'TIME_LIMIT' });
  });

  it('compares lines, then points, then survival; malformed input and save are rejected', () => {
    expect(tetris.compare({ lines: 2, points: 1, survivedTicks: 1 }, { lines: 1, points: 10000, survivedTicks: 1000 })).toBeGreaterThan(0);
    const s = create();
    expect(() => tetris.input(s, { buttons: ['left', 'right'] })).toThrow();
    expect(() => tetris.input(s, { buttons: ['rotate-cw', 'rotate-ccw'] })).toThrow();
    expect(() => tetris.input(s, { buttons: ['jump'] })).toThrow();
    expect(() => tetris.restore({ ...s, board: [] })).toThrow();
    expect(() => tetris.restore({ ...s, active: { ...s.active, type: 'X' } })).toThrow();
    expect(() => tetris.restore({ ...s, lockResets: 16 })).toThrow();
    expect(tetris.restore(JSON.parse(JSON.stringify(step(s, 100))))).toEqual(step(s, 100));
  });
});
