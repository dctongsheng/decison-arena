import type {
  ArcadeGameId,
  ArcadeResult,
  DecisionMetrics,
  DecisionReasoning as Reasoning,
} from '@decision-arena/core';

import { t } from '@/blocks/arena/shared';
import { DecisionReasoning } from '@/components/arena/decision-reasoning';

import { a } from './messages';
import { arcadeReasoningPresentation } from './reasoning';

export function isArcadeGame(game: string): game is ArcadeGameId {
  return ['snake', 'tetris', 'platformer'].includes(game);
}
export function arcadeResult(result?: ArcadeResult) {
  if (!result) return a('in_progress');
  if (result.aborted) return a('finished');
  if (result.scores.length === 1) return a('solo_complete');
  return result.winner === null
    ? a('draw')
    : `${a(result.winner === 0 ? 'left' : 'right')} · ${a('win')}`;
}
export function PrivateArcadeReasoning({
  reasoning,
  metrics,
  compact = false,
}: {
  reasoning?: Reasoning;
  metrics?: DecisionMetrics;
  compact?: boolean;
}) {
  return (
    <DecisionReasoning
      presentation={arcadeReasoningPresentation(reasoning, metrics)}
      compact={compact}
      labels={{
        title: t('room.reasoning'),
        returned: t('room.reasoning_returned'),
        restricted: t('room.reasoning_restricted'),
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
