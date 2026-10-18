import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { WatchViewSelector } from '@/components/arena/watch-view-selector';

describe('AI duel watch selector', () => {
  it.each(['full', 0, 1] as const)('marks exactly the selected perspective %s and keeps controls accessible', (value) => {
    const html = renderToStaticMarkup(createElement(WatchViewSelector, {
      value, onChange: () => {},
      labels: { title: '观战视角', full: '全局', seat0: '只看蓝方', seat1: '只看红方', help: '两个 AI 仍按各自可见局面决策。' },
    }));
    expect(html).toContain('role="group" aria-label="观战视角"');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toContain(`aria-pressed="true">${value === 'full' ? '全局' : value === 0 ? '只看蓝方' : '只看红方'}`);
    expect(html).toContain('两个 AI 仍按各自可见局面决策。');
  });
});
