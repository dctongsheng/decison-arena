import type { DecisionMetrics, DecisionReasoning } from '@decision-arena/core';

import type { ReasoningPresentation } from '@/lib/arena-reasoning';

/** Use only the recorded response, never today's controller configuration. */
export function arcadeReasoningPresentation(
  reasoning?: DecisionReasoning,
  metrics?: DecisionMetrics
): ReasoningPresentation {
  if (reasoning?.text.trim()) return { kind: 'returned', ...reasoning };
  if (metrics?.thoughtUsed === true) return { kind: 'missing-used' };
  if (metrics?.thoughtUsed === false) return { kind: 'not-used' };
  return { kind: 'missing' };
}
