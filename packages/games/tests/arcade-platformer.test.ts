import { describe, expect, it } from 'vitest';
import type { ArcadeButton } from '@decision-arena/core';
import { platformer, type PlatformerState } from '../src/arcade/platformer';

const create = (level: 1 | 2 | 3 = 1) => platformer.create({ level }, 'same-course') as PlatformerState;
const step = (s: PlatformerState, ticks = 1) => platformer.step(s, ticks) as PlatformerState;
const input = (s: PlatformerState, buttons: ArcadeButton[], durationMs?: number) => platformer.input(s, { buttons, durationMs }) as PlatformerState;

/** Fixed input recordings, not an adaptive solver or a model-assisted safety controller.
 * Each tick here means input accepted after that completed tick, before its successor.
 */
const GOLDEN_RECORDINGS = {
  1: [{ tick: 0, buttons: ['right'] }, { tick: 89, buttons: ['right', 'jump'] }, { tick: 90, buttons: ['right'] },
    { tick: 217, buttons: ['right', 'jump'] }, { tick: 218, buttons: ['right'] }, { tick: 345, buttons: ['right', 'jump'] }, { tick: 346, buttons: ['right'] }],
  2: [{ tick: 0, buttons: ['right'] }, { tick: 89, buttons: ['right', 'jump'] }, { tick: 90, buttons: ['right'] },
    { tick: 217, buttons: ['right', 'jump'] }, { tick: 218, buttons: ['right'] }, { tick: 345, buttons: ['right', 'jump'] }, { tick: 346, buttons: ['right'] }],
  3: [{ tick: 0, buttons: ['right'] }, { tick: 109, buttons: ['right', 'jump'] }, { tick: 110, buttons: ['right'] },
    { tick: 231, buttons: ['right', 'jump'] }, { tick: 232, buttons: ['right'] }, { tick: 377, buttons: ['right', 'jump'] }, { tick: 378, buttons: ['right'] }],
} as const;

function replay(level: 1 | 2 | 3, partition = 7200): PlatformerState {
  let s = create(level);
  for (const event of GOLDEN_RECORDINGS[level]) {
    let remaining = event.tick - s.tick;
    while (remaining > 0) { const n = Math.min(partition, remaining); s = step(s, n); remaining -= n; }
    s = input(s, [...event.buttons]);
  }
  while (s.status === 'playing') s = step(s, partition);
  return s;
}

describe('original fixed-point platform game', () => {
  it.each([1, 2, 3] as const)('has a fixed, demonstrably completable level %i without runtime generation', level => {
    const final = replay(level);
    expect(final).toMatchObject({ status: 'finished', reason: 'GOAL_REACHED', tick: 452 });
    expect(final.score).toMatchObject({ completed: true, progress: 100, survivedTicks: 452 });
    expect(replay(level, 1)).toEqual(final);
    expect(platformer.restore(JSON.parse(JSON.stringify(final)))).toEqual(final);
    expect(platformer.create({ level }, 'other-seed')).toEqual(create(level));
    expect(platformer.candidates(final)).toEqual([]);
    expect(step(final, 100)).toEqual(final);
  });

  it('offers one noop/jump pulse and three durations for horizontal movement combinations', () => {
    const candidates = platformer.candidates(create());
    expect(candidates).toHaveLength(14);
    expect(new Set(candidates.map(c => c.input.durationMs))).toEqual(new Set([100, 300, 1000]));
    expect(new Set(candidates.map(c => c.input.buttons.join('+')))).toEqual(new Set(['', 'left', 'right', 'jump', 'left+jump', 'right+jump']));
    expect(candidates.filter(c => c.input.buttons.length === 0 || c.id.startsWith('jump:')).map(c => c.id)).toEqual(['noop:100', 'jump:100']);
    expect(candidates.filter(c => c.id.startsWith('right+jump:')).map(c => c.id)).toEqual(['right+jump:100', 'right+jump:300', 'right+jump:1000']);
    expect(() => platformer.input(create(), { buttons: ['left', 'right'] })).toThrow();
  });

  it('starts a macro on the next tick, releases exactly at duration, and does not drive after a slow response', () => {
    const initial = create(), command = input(initial, ['right'], 300);
    expect(command.player).toEqual(initial.player);
    const during = step(command, 18);
    expect(during.player.x).toBeGreaterThan(initial.player.x);
    expect(during.held).toEqual([]);
    expect(during.releaseTick).toBeNull();
    const stopped = step(during, 10), later = step(stopped, 100);
    expect(stopped.player.vx).toBe(0);
    expect(later.player.x).toBe(stopped.player.x);
    expect(later.tick).toBe(128);
  });

  it('requires a new grounded press to jump and does not bunny-hop while jump remains held', () => {
    const s = input(create(), ['jump']);
    const airborne = step(s, 10);
    expect(airborne.player.onGround).toBe(false);
    const stillHeld = step(s, 100);
    expect(stillHeld.player.onGround).toBe(true);
    expect(stillHeld.player.y).toBe(create().player.y);
    const released = step(input(stillHeld, []));
    const secondJump = step(input(released, ['jump']));
    expect(secondJump.player.vy).toBeLessThan(0);
    const midairReleased = step(input(airborne, []));
    const midairRepressed = step(input(midairReleased, ['jump']));
    expect(midairRepressed.player.vy).toBe(midairReleased.player.vy + 4);
  });

  it('accepts a fresh grounded jump at a macro boundary after a real release', () => {
    const held = input(create(), ['jump'], 1000);
    const renewedEarly = input(step(held, 59), ['jump'], 1000);
    expect(step(renewedEarly).player.onGround).toBe(true);
    const expired = step(held, 60);
    expect(expired.held).toEqual([]);
    const pressedAgain = step(input(expired, ['jump'], 1000));
    expect(pressedAgain.player.onGround).toBe(false);
    expect(pressedAgain.player.vy).toBeLessThan(0);
  });

  it('preserves an immediate jump tap but cancels the pending edge on internal release', () => {
    const down = input(create(), ['jump']), up = input(down, []);
    expect(step(up).player).toMatchObject({ y: 2256, vy: -80, onGround: false });
    const canceled = platformer.release(up) as PlatformerState;
    expect(step(canceled).player).toMatchObject({ y: 2336, vy: 0, onGround: true });
    const once = step(up, 100);
    expect(once.player.onGround).toBe(true);
    expect(once.pendingEdges).toEqual([]);
  });

  it('blocks horizontal passage through walls and resolves both floors and ceilings', () => {
    const s = step(input(create(), ['right']), 200);
    expect(s.player.x + s.player.width).toBe(12 * 256);
    expect(s.player.onGround).toBe(true);
    const ceiling = create();
    ceiling.player.x = 12 * 256 + 32; ceiling.player.y = 10 * 256 + 20; ceiling.player.vy = -60; ceiling.player.onGround = false;
    // This isolated fixture approaches the solid ground underside from below.
    const collided = step(ceiling);
    expect(collided.player.vy).toBe(0);
    expect(collided.player.y).toBe(12 * 256);
  });

  it('ends on falling or enemy contact instead of steering or jumping automatically', () => {
    const pit = step(input(create(2), ['right']), 1000);
    expect(pit.reason).toBe('FELL_IN_PIT');
    expect(pit.score.completed).toBe(false);
    const enemy = step(input(create(3), ['right']), 1000);
    expect(enemy.reason).toBe('ENEMY_COLLISION');
    expect(enemy.score.completed).toBe(false);
  });

  it('moves enemies by absolute simulation tick and does not need inputs to advance', () => {
    const s = create(3), before = platformer.view(s).enemies;
    const direct = step(s, 200), partitioned = step(step(s, 80), 120);
    expect(direct).toEqual(partitioned);
    expect(platformer.view(direct).enemies).not.toEqual(before);
    expect(platformer.view(direct).enemies!.every(e => Number.isFinite(e.x))).toBe(true);
  });

  it('collects each coin once and never loses the recorded maximum progress when walking back', () => {
    const coins = replay(2);
    expect(coins.score.coins).toBe(3);
    expect(coins.remainingCoins).toEqual([]);
    let s = step(input(create(), ['right']), 50), progress = s.score.progress!;
    s = step(input(s, ['left']), 6); // Braking inertia may advance the maximum a little farther.
    expect(s.score.progress).toBeGreaterThanOrEqual(progress);
    progress = s.score.progress!;
    s = step(s, 50);
    expect(s.score.progress).toBe(progress);
    expect(s.score.coins).toBe(0);
  });

  it('stops at 120s with no input and ranks completion, finish time, progress, coins, survival in order', () => {
    const timeout = step(create(), 7200);
    expect(timeout).toMatchObject({ tick: 7200, reason: 'TIME_LIMIT', score: { completed: false, progress: 0 } });
    const base = { points: 0, progress: 50, coins: 0, survivedTicks: 200, completed: false };
    expect(platformer.compare({ ...base, completed: true }, { ...base, progress: 100 })).toBeGreaterThan(0);
    expect(platformer.compare({ ...base, completed: true }, { ...base, completed: true, survivedTicks: 201, coins: 3 })).toBeGreaterThan(0);
    expect(platformer.compare({ ...base, progress: 51 }, { ...base, coins: 3, survivedTicks: 7200 })).toBeGreaterThan(0);
    expect(platformer.compare({ ...base, coins: 1 }, { ...base, survivedTicks: 7200 })).toBeGreaterThan(0);
    expect(platformer.compare({ ...base, survivedTicks: 201 }, base)).toBeGreaterThan(0);
    expect(platformer.compare(base, base)).toBe(0);
  });

  it('projects pixels consistently and rejects corrupt saved physics and scores', () => {
    const s = create(), v = platformer.view(s);
    expect(v).toMatchObject({ width: 1536, height: 384, level: 1, player: { width: 24, height: 28, onGround: true } });
    expect(() => platformer.create({ level: 4 } as never, '')).toThrow();
    expect(() => platformer.restore({ ...s, player: { ...s.player, vx: Infinity } })).toThrow();
    expect(() => platformer.restore({ ...s, remainingCoins: [0, 0] })).toThrow();
    expect(() => platformer.restore({ ...s, score: { ...s.score, points: 999 } })).toThrow();
    v.player!.x = 999;
    expect(platformer.view(s).player!.x).not.toBe(999);
  });
});
