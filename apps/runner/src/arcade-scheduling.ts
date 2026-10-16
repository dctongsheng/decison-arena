/** Persisted input boundaries survive both async storage yields and runtime restarts. */
export function canObserveAfterInput(run: {
  state: { tick: number };
  observeAfterTick?: number;
  lastDecision?: { appliedTick?: number };
}): boolean {
  // Older records only stored this boundary on their last accepted decision.
  const boundary = run.observeAfterTick ?? run.lastDecision?.appliedTick ?? 0;
  return run.state.tick >= boundary;
}

/** Recheck after async credential/DNS work, immediately before the paid fetch. */
export function canSendObservedDecision(
  session: { status: string; generation: number },
  run: { status: string; requestId?: string; pieceId?: number } | undefined,
  pending: { requestId: string; generation: number; pieceId?: number },
): boolean {
  return session.status === 'running' && session.generation === pending.generation &&
    run?.status === 'playing' && run.requestId === pending.requestId &&
    (pending.pieceId === undefined || pending.pieceId === run.pieceId);
}
