import type { DecisionMetrics } from '@decision-arena/core';
import { describe, expect, it } from 'vitest';

import { arcadeReasoningPresentation } from '@/blocks/arcade/reasoning';

describe('arcade historical reasoning', () => {
  it('does not infer that an old response disabled thinking from the current policy', () => {
    expect(arcadeReasoningPresentation()).toEqual({ kind: 'missing' });
    expect(
      arcadeReasoningPresentation(undefined, {
        elapsedMs: 20,
        usage: { tokens: 10 },
      } as DecisionMetrics)
    ).toEqual({ kind: 'missing' });
  });

  it('preserves historical reported thinking when no text was saved', () => {
    expect(
      arcadeReasoningPresentation(undefined, {
        elapsedMs: 20,
        thoughtUsed: true,
      } as DecisionMetrics)
    ).toEqual({ kind: 'missing-used' });
    expect(
      arcadeReasoningPresentation(undefined, {
        elapsedMs: 20,
        thoughtUsed: false,
      } as DecisionMetrics)
    ).toEqual({ kind: 'not-used' });
  });

  it('shows actual historical text regardless of today’s disabled policy', () => {
    const reasoning = { text: 'Saved response\nsecond line', truncated: false };
    expect(
      arcadeReasoningPresentation(reasoning, {
        elapsedMs: 20,
        thoughtUsed: false,
      } as DecisionMetrics)
    ).toEqual({ kind: 'returned', ...reasoning });
    expect(
      arcadeReasoningPresentation({ text: '  ', truncated: false })
    ).toEqual({ kind: 'missing' });
  });
});
