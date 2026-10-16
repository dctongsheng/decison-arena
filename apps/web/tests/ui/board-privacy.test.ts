import { createElement } from 'react';
import type { GameView } from '@decision-arena/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Board } from '@/components/arena/board';

const view: GameView = {
  gameId: 'army',
  rows: 12,
  cols: 5,
  turn: 0,
  phase: 'setup',
  ply: 0,
  legalActions: [],
  cells: Array.from({ length: 60 }, (_, index) =>
    index === 0
      ? { id: 'private-piece', seat: 0, kind: 'commander', label: '司令' }
      : null
  ),
};
const labels = {
  board: '棋盘',
  empty: '空位',
  hidden: '隐藏',
  river: '河界',
  camp: '行营',
};

describe('army handover privacy', () => {
  it('unmounts piece identities and accessible controls while obscured', () => {
    const html = renderToStaticMarkup(
      createElement(Board, { view, labels, obscured: true })
    );
    expect(html).toContain('arena-board-placeholder');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('司令');
    expect(html).not.toContain('commander');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('aria-label');
  });
  it('renders the authorized player view after an explicit reveal', () => {
    const html = renderToStaticMarkup(
      createElement(Board, { view, labels, obscured: false })
    );
    expect(html).toContain('司令');
    expect(html).toContain('<button');
  });
});
