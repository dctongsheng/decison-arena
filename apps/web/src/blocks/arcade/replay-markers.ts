import type { ArcadeButton, ArcadeReplayV2 } from '@decision-arena/core';

export interface ReplayMarker {
  id: string;
  tick: number;
  order: number;
  kind:
    | 'created'
    | 'input'
    | 'decision'
    | 'status'
    | 'ended'
    | 'error'
    | 'run-ended'
    | 'run-won';
  runIndex?: number;
  buttons?: ArcadeButton[];
  appliedTick?: number;
  outcome?: 'applied' | 'dropped' | 'failed' | 'unknown';
  elapsedMs?: number;
  actualModel?: string;
  reason?: string;
}
const REASONS = new Set([
  'WALL_COLLISION',
  'SELF_COLLISION',
  'BOARD_FILLED',
  'SPAWN_BLOCKED',
  'TOP_OUT',
  'FELL_IN_PIT',
  'HAZARD_COLLISION',
  'ENEMY_COLLISION',
  'GOAL_REACHED',
  'TIME_LIMIT',
]);
const BUTTONS = new Set<ArcadeButton>([
  'up',
  'down',
  'left',
  'right',
  'rotate-cw',
  'rotate-ccw',
  'soft-drop',
  'hard-drop',
  'hold',
  'jump',
]);

/** Public timeline projection: intentionally never copies provider text or event messages. */
export function arcadeReplayMarkers(replay: ArcadeReplayV2): ReplayMarker[] {
  const lastTick = replay.frames.at(-1)?.tick ?? replay.maxTicks;
  const markers: ReplayMarker[] = [];
  for (const event of replay.events) {
    const tick =
      event.type === 'input' ? (event.appliedTick ?? event.tick) : event.tick;
    // Inputs queued beyond the terminal tick were never applied by the simulation.
    if (tick > lastTick) continue;
    const runIndex = event.runId ? replay.runIds.indexOf(event.runId) : -1;
    const marker: ReplayMarker = {
      id: `event-${event.seq}`,
      tick: Math.max(0, tick),
      order: event.seq,
      kind: event.type,
    };
    if (runIndex >= 0) marker.runIndex = runIndex;
    if (event.type === 'input') {
      marker.appliedTick = tick;
      marker.buttons = (event.input?.buttons || []).filter((button) =>
        BUTTONS.has(button)
      );
    }
    if (event.type === 'decision') {
      if (
        event.outcome &&
        ['applied', 'dropped', 'failed', 'unknown'].includes(event.outcome)
      )
        marker.outcome = event.outcome;
      if (Number.isFinite(event.metrics?.elapsedMs))
        marker.elapsedMs = event.metrics!.elapsedMs;
      if (event.metrics?.actualModel)
        marker.actualModel = event.metrics.actualModel.slice(0, 200);
    }
    markers.push(marker);
  }
  const frames = [...replay.frames].sort((a, b) => a.tick - b.tick);
  replay.runIds.forEach((_, runIndex) => {
    const endView = frames.find(
      (frame) => frame.views[runIndex]?.status === 'finished'
    )?.views[runIndex];
    const finalView = frames.at(-1)?.views[runIndex];
    const score = replay.result.scores[runIndex];
    if (
      !endView &&
      (!score ||
        (!score.completed && (!finalView?.reason || replay.result.aborted)))
    )
      return;
    const view = endView || finalView;
    const tick = endView?.tick ?? score.survivedTicks;
    const marker: ReplayMarker = {
      id: `run-end-${runIndex}`,
      tick,
      order: Number.MAX_SAFE_INTEGER - replay.runIds.length + runIndex,
      kind:
        (endView?.score.completed ?? score.completed) ? 'run-won' : 'run-ended',
      runIndex,
    };
    if (view?.reason && REASONS.has(view.reason)) marker.reason = view.reason;
    markers.push(marker);
  });
  return markers.sort((a, b) => a.tick - b.tick || a.order - b.order);
}

export function adjacentReplayMarker(
  markers: ReplayMarker[],
  tick: number,
  selectedId: string | null,
  direction: -1 | 1
): ReplayMarker | undefined {
  const selected = selectedId
    ? markers.findIndex((marker) => marker.id === selectedId)
    : -1;
  if (selected >= 0) return markers[selected + direction];
  return direction === 1
    ? markers.find((marker) => marker.tick > tick)
    : [...markers].reverse().find((marker) => marker.tick < tick);
}
