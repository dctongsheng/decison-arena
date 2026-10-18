import type { MatchEvent, MatchSnapshot, Viewer } from '@decision-arena/core';

import { privateReasoningPresentation } from '@/lib/arena-reasoning';
import { DecisionReasoning } from '@/components/arena/decision-reasoning';

import { arenaText as t } from './messages';

export function PrivateDecisionReasoning({
  event,
  snapshot,
  viewer,
  obscured,
  compact,
}: {
  event: MatchEvent;
  snapshot: MatchSnapshot;
  viewer: Viewer;
  obscured?: boolean;
  compact?: boolean;
}) {
  if (
    event.type !== 'action' ||
    event.seat === undefined ||
    snapshot.seats[event.seat].kind !== 'ai'
  )
    return null;
  const armyDuelWatch = snapshot.gameId === 'army' && snapshot.seats.every((seat) => seat.kind === 'ai');
  return (
    <DecisionReasoning
      presentation={privateReasoningPresentation(event, {
        gameId: snapshot.gameId,
        status: snapshot.status,
        viewer,
        obscured,
        armyDuelWatch,
        provider: snapshot.seats[event.seat].profile?.provider,
        thinkMode: snapshot.seats[event.seat].profile?.thinkMode,
      })}
      compact={compact}
      labels={{
        title: t('room.reasoning'),
        returned: t('room.reasoning_returned'),
        restricted: t(armyDuelWatch ? 'room.watch_reasoning_restricted' : 'room.reasoning_restricted'),
        disabled: t('room.reasoning_disabled'),
        notUsed: t('room.reasoning_not_used'),
        missing: t('room.reasoning_missing'),
        missingUsed: t('room.reasoning_missing_used'),
        history: t('room.reasoning_history'),
        truncated: t('room.reasoning_truncated'),
      }}
    />
  );
}
