import { createElement } from 'react';
import type { MatchEvent } from '@decision-arena/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { privateReasoningPresentation } from '@/lib/arena-reasoning';
import {
  DecisionReasoning,
  type ReasoningLabels,
} from '@/components/arena/decision-reasoning';

const event: MatchEvent = {
  seq: 4,
  type: 'action',
  seat: 0,
  at: 1,
  metrics: { elapsedMs: 100, thoughtUsed: true },
  reasoning: {
    text: 'First line\nSecond line <script>unsafe()</script>',
    truncated: false,
  },
};
const context = {
  gameId: 'gomoku' as const,
  status: 'running' as const,
  viewer: 'spectator' as const,
};
const labels: ReasoningLabels = {
  title: 'Reasoning',
  returned: 'Provider text',
  restricted: 'View restricted',
  disabled: 'Thinking disabled',
  notUsed: 'Thinking not used',
  missing: 'Text not returned',
  missingUsed: 'Thinking used without text',
  history: 'Historical text cannot be restored',
  truncated: 'Only the saved prefix is shown',
};

function render(value: MatchEvent, options = context) {
  return renderToStaticMarkup(
    createElement(DecisionReasoning, {
      presentation: privateReasoningPresentation(value, options),
      labels,
    })
  );
}

describe('private decision reasoning display', () => {
  it('renders actual returned text as collapsible plain text with line breaks intact', () => {
    const html = render(event);
    expect(html).toContain('<details');
    expect(html).toContain('<summary>');
    expect(html).toContain('arena-reasoning-text');
    expect(html).toContain(
      'First line\nSecond line &lt;script&gt;unsafe()&lt;/script&gt;'
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain(labels.missing);
  });
  it('warns when the returned text was truncated', () => {
    const html = render({
      ...event,
      reasoning: { text: 'Saved prefix', truncated: true },
    });
    expect(html).toContain('Saved prefix');
    expect(html).toContain(labels.truncated);
  });
  it('keeps the compact variant as a separate CSS class', () => {
    const html = renderToStaticMarkup(
      createElement(DecisionReasoning, {
        presentation: { kind: 'missing' },
        labels,
        compact: true,
      })
    );
    expect(html).toContain('class="arena-reasoning compact"');
    expect(html).not.toContain('arena-reasoningcompact');
  });
  it.each(['openrouter', 'custom-openrouter'] as const)(
    'does not claim thinking is disabled for %s legacy profiles',
    (provider) => {
      const presentation = privateReasoningPresentation(
        { ...event, reasoning: undefined, metrics: { elapsedMs: 100 } },
        { ...context, provider, thinkMode: 'never' }
      );
      expect(presentation).toEqual({ kind: 'missing' });
    }
  );
  it('does not infer thinking text from thoughtUsed or token counts', () => {
    const html = render({
      ...event,
      reasoning: undefined,
      metrics: {
        elapsedMs: 100,
        thoughtUsed: true,
        usage: { reasoning_tokens: 512 },
      },
    });
    expect(html).toContain(labels.missingUsed);
    expect(html).toContain(labels.history);
    expect(html).not.toContain('<pre');
    expect(html).not.toContain('512');
  });
  it('does not label old records as returned when only whitespace is saved', () => {
    expect(
      render({
        ...event,
        reasoning: { text: ' \n ', truncated: false },
        metrics: { elapsedMs: 100 },
      })
    ).toContain(labels.missing);
  });
  it('distinguishes a disabled profile from a service reporting no thinking this move', () => {
    const withoutText = {
      ...event,
      reasoning: undefined,
      metrics: { elapsedMs: 100, thoughtUsed: false },
    };
    expect(
      privateReasoningPresentation(withoutText, {
        ...context,
        provider: 'systemone',
        thinkMode: 'never',
      })
    ).toEqual({ kind: 'disabled' });
    expect(
      privateReasoningPresentation(withoutText, {
        ...context,
        provider: 'systemone',
        thinkMode: 'auto',
      })
    ).toEqual({ kind: 'not-used' });
  });
  it('prefers the real provider text over requested thinking settings', () => {
    expect(
      privateReasoningPresentation(event, {
        ...context,
        provider: 'systemone',
        thinkMode: 'never',
      })
    ).toEqual({ kind: 'returned', ...event.reasoning });
  });
  it.each([1, 'spectator', 'full'] as const)(
    'does not put hidden live Army text into viewer %s DOM',
    (viewer) => {
      const presentation = privateReasoningPresentation(event, {
        gameId: 'army',
        status: 'running',
        viewer,
      });
      expect(presentation).toEqual({ kind: 'restricted' });
      const html = renderToStaticMarkup(
        createElement(DecisionReasoning, { presentation, labels })
      );
      expect(html).toContain(labels.restricted);
      expect(html).not.toContain('First line');
      expect(html).not.toContain(labels.missing);
      expect(html).not.toContain('<pre');
    }
  );
  it('does not confuse server-redacted live text with a missing provider response', () => {
    expect(
      privateReasoningPresentation(
        { ...event, reasoning: undefined },
        { gameId: 'army', status: 'paused', viewer: 'spectator' }
      )
    ).toEqual({ kind: 'restricted' });
  });
  it.each(['running', 'finished'] as const)('honors explicit AI duel watch perspectives while %s', (status) => {
    expect(privateReasoningPresentation(event, { gameId: 'army', status, viewer: 'full', armyDuelWatch: true }).kind).toBe('returned');
    expect(privateReasoningPresentation(event, { gameId: 'army', status, viewer: 0, armyDuelWatch: true }).kind).toBe('returned');
    expect(privateReasoningPresentation(event, { gameId: 'army', status, viewer: 1, armyDuelWatch: true }).kind).toBe('restricted');
    expect(privateReasoningPresentation(event, { gameId: 'army', status, viewer: 'spectator', armyDuelWatch: true }).kind).toBe('restricted');
  });
  it('hides even the current seat text during the handover curtain', () => {
    expect(
      privateReasoningPresentation(event, {
        gameId: 'army',
        status: 'running',
        viewer: 0,
        obscured: true,
      })
    ).toEqual({ kind: 'restricted' });
  });
  it('permits the authorized Army seat and completed private match text', () => {
    expect(
      privateReasoningPresentation(event, {
        gameId: 'army',
        status: 'running',
        viewer: 0,
      }).kind
    ).toBe('returned');
    expect(
      privateReasoningPresentation(event, {
        gameId: 'army',
        status: 'finished',
        viewer: 'spectator',
      }).kind
    ).toBe('returned');
  });
});
