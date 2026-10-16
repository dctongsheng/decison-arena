import type { ArcadeSession } from '@decision-arena/core';

export function mergeArcadeSnapshot(
  previous: ArcadeSession | undefined,
  incoming: ArcadeSession
): ArcadeSession {
  if (
    previous &&
    previous.id === incoming.id &&
    previous.version > incoming.version
  )
    return previous;
  const events = new Map(
    (previous?.id === incoming.id ? previous.events : []).map((event) => [
      event.seq,
      event,
    ])
  );
  for (const event of incoming.events) events.set(event.seq, event);
  return {
    ...incoming,
    events: [...events.values()].sort((a, b) => a.seq - b.seq).slice(-500),
  };
}

export function canSendArcadeInput(
  snapshot: ArcadeSession | undefined,
  runId: string
): boolean {
  return (
    snapshot?.status === 'running' &&
    snapshot.runs.some(
      (run) =>
        run.id === runId &&
        run.controller.kind === 'human' &&
        run.view.status === 'playing'
    )
  );
}

/** Retry is explicit because an interrupted upstream request may already be billed. */
export function arcadeControlState(
  snapshot: ArcadeSession,
  connected: boolean,
  controllerReady: boolean
) {
  const waiting = snapshot.runs.some((run) => !!run.inflight);
  const activeHuman = snapshot.runs.some(
    (run) => run.controller.kind === 'human' && run.view.status === 'playing'
  );
  const command =
    snapshot.needsRetry || snapshot.status === 'error'
      ? 'retry'
      : snapshot.status === 'ready'
        ? 'start'
        : 'resume';
  return {
    command: command as 'retry' | 'start' | 'resume',
    waiting,
    enabled: !waiting && (!activeHuman || (connected && controllerReady)),
  };
}

/** Physics can be finished while a provider request still needs to settle. */
export function arcadeCompletionState(
  snapshot: ArcadeSession | undefined,
  connected: boolean
) {
  const finished = snapshot?.status === 'finished';
  const settling = finished && snapshot.runs.some((run) => !!run.inflight);
  const archiveReady = finished && !settling;
  return {
    settling,
    archiveReady,
    shouldReconnect: !archiveReady,
    pollInterval: archiveReady
      ? (false as const)
      : settling || !connected
        ? 1500
        : 10000,
  };
}
