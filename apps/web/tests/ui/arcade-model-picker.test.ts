import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ArcadeModelPicker } from '@/blocks/arcade/create-session';
import { arcadeCreateControllers } from '@/blocks/arcade/create-preferences';
import {
  arcadeModelChoices,
  TETRIS_BASELINE,
  TETRIS_V8,
  tetrisCreationVersion,
} from '@/blocks/arcade/tetris-harness';
import type { SavedModel } from '@/blocks/arena/shared';

vi.mock('@/paraglide/messages.js', () => ({
  m: new Proxy({}, { get: (_, key) => () => String(key) }),
}));
vi.mock('@/blocks/arena/shared', () => ({ t: (key: string) => key }));
vi.mock('@/core/i18n/navigation', () => ({
  Link: ({ children, ...props }: { children: string; href: string }) =>
    createElement('a', props, children),
}));

const models: SavedModel[] = [
  { id: 'local', name: 'Local StartLux', provider: 'custom-systemone', model: '', endpoint: 'http://private.invalid/local' },
  { id: 'bamboo-startlux', name: 'Bamboo StartLux', provider: 'bamboonode-systemone', model: 'startlux', source: 'bamboonode', available: false, endpoint: 'https://private.invalid/managed' },
  { id: 'bamboo-jev', name: 'Bamboo Jev', provider: 'bamboonode-decisions', model: 'typesafe/jev-1.13', source: 'bamboonode', available: false, endpoint: 'https://private.invalid/managed' },
  { id: 'openrouter', name: 'Own Jev', provider: 'openrouter', model: 'typesafe/jev-1.14', available: true, endpoint: 'https://private.invalid/byok' },
  { id: 'unknown', name: 'Unverified model', provider: 'custom-openrouter', model: 'unknown/model', available: true, endpoint: 'https://private.invalid/custom' },
];

function render(choices: ReturnType<typeof arcadeModelChoices<SavedModel>>, value = '') {
  return renderToStaticMarkup(createElement(ArcadeModelPicker, { choices, value, onChange: vi.fn() }));
}

function option(html: string, id: string) {
  return html.match(new RegExp(`<option[^>]*value="${id}"[^>]*>[^<]*</option>`))?.[0];
}

describe('arcade model availability presentation', () => {
  it('keeps inaccessible Bamboo models visible in baseline with the previous selection and recovery links', () => {
    const choices = arcadeModelChoices(models, 'tetris', TETRIS_BASELINE);
    const html = render(choices, 'bamboo-jev');
    expect(choices.map(({ model }) => model.id)).toEqual(models.map((model) => model.id));
    expect(option(html, 'bamboo-jev')).toContain('disabled=""');
    expect(option(html, 'bamboo-jev')).toContain('selected=""');
    expect(option(html, 'bamboo-jev')).toContain('arcade.model_unavailable.bamboo');
    expect(option(html, 'bamboo-startlux')).toContain('arcade.model_unavailable.bamboo');
    expect(option(html, 'local')).not.toContain('disabled');
    expect(option(html, 'openrouter')).not.toContain('disabled');
    expect(html).toContain('href="#arcade-bamboonode-connection"');
    expect(html).toContain('href="/models"');
    expect(html).not.toContain('private.invalid');
    const allowedIds = choices.filter(({ reasons }) => !reasons.length).map(({ model }) => model.id);
    expect(arcadeCreateControllers('ai-solo', { profile0: 'bamboo-jev', profile1: '' }, allowedIds)).toBeNull();
  });

  it('allows both verified Jev versions and System One under V8, keeping unknown models visible but disabled', () => {
    const connected = models.map((model) => ({ ...model, available: true }));
    const v8 = render(arcadeModelChoices(connected, 'tetris', TETRIS_V8));
    expect(option(v8, 'unknown')).toContain('disabled=""');
    expect(option(v8, 'unknown')).toContain('arcade.model_unavailable.v8');
    for (const id of ['local', 'bamboo-startlux', 'bamboo-jev', 'openrouter'])
      expect(option(v8, id)).not.toContain('disabled');
    for (const choice of arcadeModelChoices(connected, 'tetris', TETRIS_BASELINE))
      expect(choice.reasons).toEqual([]);
    expect(render(arcadeModelChoices(connected, 'tetris', TETRIS_BASELINE))).not.toContain('disabled');
    for (const game of ['snake', 'platformer'] as const)
      expect(arcadeModelChoices(connected, game, TETRIS_V8).every(({ reasons }) => !reasons.length)).toBe(true);
  });

  it('keeps remembered Jev versus Decision selections on full default V8 and never downgrades unknown models', () => {
    const version = tetrisCreationVersion();
    const connected = models.map((model) => ({ ...model, available: true }));
    const choices = arcadeModelChoices(connected, 'tetris', version);
    const ids = choices.filter(({ reasons }) => !reasons.length).map(({ model }) => model.id);
    const remembered = { profile0: 'bamboo-jev', profile1: 'local' };
    expect(option(render(choices, remembered.profile0), remembered.profile0)).not.toContain('disabled');
    expect(arcadeCreateControllers('ai-ai', remembered, ids)).toEqual([
      { kind: 'ai', profileId: 'bamboo-jev' },
      { kind: 'ai', profileId: 'local' },
    ]);
    expect(arcadeCreateControllers('ai-ai', { ...remembered, profile0: 'unknown' }, ids)).toBeNull();
    expect(version).toBe(TETRIS_V8);
    expect(remembered).toEqual({ profile0: 'bamboo-jev', profile1: 'local' });
    const comparisonIds = arcadeModelChoices(connected, 'tetris', TETRIS_BASELINE).filter(({ reasons }) => !reasons.length).map(({ model }) => model.id);
    expect(arcadeCreateControllers('ai-ai', remembered, comparisonIds)).toEqual([
      { kind: 'ai', profileId: 'bamboo-jev' },
      { kind: 'ai', profileId: 'local' },
    ]);
  });

  it('distinguishes missing authorization from protocol restrictions and preserves clone provider requirements', () => {
    const choices = arcadeModelChoices(models, 'tetris', TETRIS_V8);
    expect(choices.find(({ model }) => model.id === 'bamboo-jev')?.reasons).toEqual(['bamboo']);
    expect(choices.find(({ model }) => model.id === 'unknown')?.reasons).toEqual(['v8']);
    const clone = arcadeModelChoices(models, 'tetris', TETRIS_BASELINE, 'bamboonode-systemone');
    expect(clone.map(({ model }) => model.id)).toEqual(['bamboo-startlux']);
    expect(clone[0].reasons).toEqual(['bamboo']);
    expect(arcadeModelChoices([{ ...models[0], available: false }], 'tetris', TETRIS_BASELINE)[0].reasons).toEqual(['unavailable']);
    expect(models[1].available).toBe(false);
  });

  it('checks a clone’s frozen model while retaining its own credential provider and availability', () => {
    const choices = arcadeModelChoices(models, 'tetris', TETRIS_V8, 'custom-openrouter', 'typesafe/jev-1.13');
    expect(choices.map(({ model }) => model.id)).toEqual(['unknown']);
    expect(choices[0].reasons).toEqual([]);
    const unsupported = arcadeModelChoices(models, 'tetris', TETRIS_V8, 'openrouter', 'unknown/model');
    expect(unsupported[0].model.id).toBe('openrouter');
    expect(unsupported[0].reasons).toEqual(['v8']);
    const unavailable = arcadeModelChoices(models, 'tetris', TETRIS_V8, 'bamboonode-decisions', 'typesafe/jev-1.14');
    expect(unavailable[0].reasons).toEqual(['bamboo']);
  });
});
