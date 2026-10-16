import type {
  ArcadeInput,
  ArcadePoint,
  ArcadeState,
  ArcadeView,
} from '@decision-arena/core';
import { getArcadeGame } from '@decision-arena/games/arcade';

export const PREDICTION_WINDOW_MS = 100;
const MAX_PREDICTED_TICKS = 6;
export interface LocalArcadeInput {
  seq: number;
  at: number;
  input: ArcadeInput;
}
const mix = (from: number, to: number, fraction: number) =>
  from + (to - from) * fraction;
const point = <T extends ArcadePoint>(
  from: ArcadePoint,
  to: T,
  fraction: number
): T => ({
  ...to,
  x: mix(from.x, to.x, fraction),
  y: mix(from.y, to.y, fraction),
});

/** Only coordinates interpolate. Current server score, board and terminal state always win. */
export function interpolateArcadeView(
  from: ArcadeView,
  to: ArcadeView,
  fraction: number
): ArcadeView {
  if (
    from.gameId !== to.gameId ||
    from.status !== 'playing' ||
    to.status !== 'playing'
  )
    return to;
  const t = Math.max(0, Math.min(1, fraction)),
    result = { ...to };
  if (from.player && to.player)
    result.player = point(from.player, to.player, t);
  if (from.enemies?.length === to.enemies?.length && to.enemies)
    result.enemies = to.enemies.map((enemy, index) =>
      point(from.enemies![index], enemy, t)
    );
  if (from.snake && to.snake)
    result.snake = to.snake.map((segment, index) =>
      point(
        from.snake![Math.min(index, from.snake!.length - 1)] || segment,
        segment,
        t
      )
    );
  if (
    from.pieceId === to.pieceId &&
    from.active &&
    to.active &&
    from.active.type === to.active.type &&
    from.active.cells.length === to.active.cells.length
  ) {
    result.active = {
      ...to.active,
      cells: to.active.cells.map((cell, index) =>
        point(from.active!.cells[index], cell, t)
      ),
    };
  }
  return result;
}

/** Render-only replica. No networking, candidate selection, scoring or result authority. */
export class ArcadeRenderState {
  private view: ArcadeView;
  private previous: ArcadeView;
  private state?: ArcadeState;
  private sourceState?: ArcadeState;
  private receivedAt: number;
  private interpolationAt: number;
  private interpolationMs = 100;
  private active: boolean;
  private lastInput = 0;

  constructor(
    view: ArcadeView,
    state: ArcadeState | undefined,
    active: boolean,
    now: number
  ) {
    this.view = view;
    this.previous = view;
    this.receivedAt = now;
    this.interpolationAt = now;
    this.active = active;
    this.sourceState = state;
    this.state = this.copyPrediction(state);
  }
  private copyPrediction(state?: ArcadeState) {
    if (
      !state ||
      state.gameId !== this.view.gameId ||
      state.tick !== this.view.tick
    )
      return undefined;
    try {
      return getArcadeGame(state.gameId).restore(state);
    } catch {
      return undefined;
    }
  }
  receive(
    view: ArcadeView,
    state: ArcadeState | undefined,
    active: boolean,
    now: number
  ) {
    if (
      view === this.view &&
      state === this.sourceState &&
      active === this.active
    )
      return;
    const tickChanged = view.tick !== this.view.tick;
    const restarted = active && !this.active;
    const from = this.frame(now);
    this.interpolationMs = Math.min(
      100,
      Math.max(1000 / 60, (Math.abs(view.tick - this.view.tick) * 1000) / 60)
    );
    this.previous = from;
    this.view = view;
    this.sourceState = state;
    this.active = active;
    this.state = this.copyPrediction(state);
    this.interpolationAt = now;
    // Same-tick heartbeat/control updates must not extend the prediction horizon.
    if (tickChanged || restarted) this.receivedAt = now;
    if (!active && this.state)
      this.state = getArcadeGame(view.gameId).release(this.state);
  }
  input(value: LocalArcadeInput) {
    if (value.seq <= this.lastInput) return;
    this.lastInput = value.seq;
    if (
      !this.active ||
      !this.state ||
      this.view.status !== 'playing' ||
      value.at < this.receivedAt ||
      value.at - this.receivedAt > PREDICTION_WINDOW_MS
    )
      return;
    this.advance(value.at);
    if (this.state.status !== 'playing') return;
    try {
      this.state = getArcadeGame(this.view.gameId).input(
        this.state,
        value.input
      );
    } catch {
      /* Invalid/reversed keys remain a server decision; never substitute controls. */
    }
  }
  private advance(now: number) {
    if (!this.state || !this.active || this.view.status !== 'playing') return;
    const elapsed = Math.max(0, now - this.receivedAt);
    const target =
      this.view.tick +
      Math.min(MAX_PREDICTED_TICKS, Math.floor((elapsed * 60) / 1000));
    const adapter = getArcadeGame(this.view.gameId);
    if (this.state.status === 'playing' && target > this.state.tick)
      this.state = adapter.step(this.state, target - this.state.tick);
    if (elapsed >= PREDICTION_WINDOW_MS)
      this.state = adapter.release(this.state);
  }
  frame(now: number): ArcadeView {
    if (!this.active || this.view.status !== 'playing') return this.view;
    if (this.state) {
      this.advance(now);
      const predicted = getArcadeGame(this.view.gameId).view(this.state);
      // Forecast motion only: score/terminal status/reason never come from the replica.
      return {
        ...predicted,
        score: this.view.score,
        status: this.view.status,
        reason: this.view.reason,
      };
    }
    return interpolateArcadeView(
      this.previous,
      this.view,
      (now - this.interpolationAt) / this.interpolationMs
    );
  }
}
