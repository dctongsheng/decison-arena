import type {
  ArcadeReplayV2,
  ArcadeState,
  ArcadeView,
} from '@decision-arena/core';
import { getArcadeGame } from '@decision-arena/games/arcade';

/** Reconstruct simulation time; a model's HTTP latency is already in appliedTick. */
export function createArcadeReplayReader(replay: ArcadeReplayV2) {
  const adapter = getArcadeGame(replay.gameId),
    compatible = adapter.rulesVersion === replay.rulesVersion;
  const inputs = new Map<number, typeof replay.events>();
  for (const event of [...replay.events].sort((a, b) => a.seq - b.seq))
    if (event.input && event.runId && event.type === 'input') {
      const tick = event.appliedTick ?? event.tick;
      inputs.set(tick, [...(inputs.get(tick) || []), event]);
    }
  const initial = () =>
    replay.controllers.map(() => adapter.create(replay.config, replay.seed));
  const checkpoints = new Map<number, ArcadeState[]>(
    compatible ? [[0, initial()]] : []
  );
  const lastTick = Math.max(0, replay.frames.at(-1)?.tick ?? replay.maxTicks);
  return {
    compatible,
    lastTick,
    read(requested: number): ArcadeView[] {
      const target = Math.max(0, Math.min(lastTick, Math.floor(requested)));
      if (!compatible) {
        return (
          [...replay.frames].reverse().find((frame) => frame.tick <= target)
            ?.views ||
          replay.frames[0]?.views ||
          []
        );
      }
      const start =
        [...checkpoints.keys()]
          .filter((tick) => tick <= target)
          .sort((a, b) => b - a)[0] ?? 0;
      let states = structuredClone(checkpoints.get(start)!);
      for (let tick = start; tick < target; tick++) {
        for (const event of inputs.get(tick + 1) || []) {
          const index = replay.runIds.indexOf(event.runId!);
          if (index >= 0 && states[index].status === 'playing')
            states[index] = event.release
              ? adapter.release(states[index])
              : adapter.input(states[index], event.input!);
        }
        states = states.map((state) =>
          state.status === 'playing' ? adapter.step(state, 1) : state
        );
        if ((tick + 1) % 60 === 0 && !checkpoints.has(tick + 1))
          checkpoints.set(tick + 1, structuredClone(states));
      }
      // Ending releases pending controls without simulating another physics tick.
      if (
        target === lastTick &&
        replay.events.some(
          (event) => event.type === 'ended' && event.tick <= target
        )
      )
        states = states.map((state) => adapter.release(state));
      return states.map((state) => adapter.view(state));
    },
  };
}
