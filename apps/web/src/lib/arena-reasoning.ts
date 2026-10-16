import type {
  GameId,
  MatchEvent,
  MatchStatus,
  PublicModelProfile,
  Viewer,
} from '@decision-arena/core';

export type ReasoningPresentation =
  | { kind: 'returned'; text: string; truncated: boolean }
  | {
      kind: 'restricted' | 'disabled' | 'not-used' | 'missing' | 'missing-used';
    };

/** Private-room projection. Never use this as a public replay serializer. */
export function privateReasoningPresentation(
  event: MatchEvent,
  context: {
    gameId: GameId;
    status: MatchStatus;
    viewer: Viewer;
    provider?: PublicModelProfile['provider'];
    thinkMode?: PublicModelProfile['thinkMode'];
    obscured?: boolean;
  }
): ReasoningPresentation {
  if (
    context.gameId === 'army' &&
    context.status !== 'finished' &&
    (context.obscured || context.viewer !== event.seat)
  ) {
    return { kind: 'restricted' };
  }
  if (event.reasoning?.text.trim()) {
    return {
      kind: 'returned',
      text: event.reasoning.text,
      truncated: event.reasoning.truncated,
    };
  }
  if (event.metrics?.thoughtUsed === true) return { kind: 'missing-used' };
  if (
    (context.provider === 'systemone' ||
      context.provider === 'custom-systemone') &&
    context.thinkMode === 'never'
  )
    return { kind: 'disabled' };
  if (event.metrics?.thoughtUsed === false) return { kind: 'not-used' };
  return { kind: 'missing' };
}
