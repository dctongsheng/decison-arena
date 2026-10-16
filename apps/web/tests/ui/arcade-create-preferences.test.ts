import { describe, expect, it, vi } from 'vitest';

import {
  arcadeControllerKinds,
  arcadeCreateControllers,
  arcadeModelsReady,
  arcadePreferenceKey,
  emptyArcadeSelection,
  readArcadePreferences,
  rememberArcadeSelection,
  sanitizeArcadePreferences,
  selectArcadeMode,
  writeArcadePreferences,
} from '@/blocks/arcade/create-preferences';

const ids = ['jev-owned', 'decision-owned'];
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
}
const pair = () => ({
  ...emptyArcadeSelection(),
  profile0: ids[0],
  profile1: ids[1],
});

describe('arcade create selections', () => {
  it('keeps AI-AI left/right independent across save and reload', () => {
    const storage = memoryStorage();
    const preferences = rememberArcadeSelection(
      readArcadePreferences(storage, 'alice', ids),
      'ai-ai',
      pair(),
      ids
    );
    writeArcadePreferences(storage, 'alice', preferences, ids);
    const restored = readArcadePreferences(storage, 'alice', ids);
    expect(restored.mode).toBe('ai-ai');
    expect(restored.selections['ai-ai']).toEqual(pair());
  });

  it('remembers each mode separately while switching and restores the most recent mode', () => {
    const storage = memoryStorage();
    let preferences = readArcadePreferences(storage, 'alice', ids);
    preferences = selectArcadeMode(
      preferences,
      'ai-ai',
      pair(),
      'ai-solo',
      ids
    );
    const solo = {
      ...emptyArcadeSelection(),
      profile0: ids[1],
    };
    preferences = selectArcadeMode(
      preferences,
      'ai-solo',
      solo,
      'human-ai',
      ids
    );
    const humanAI = { ...emptyArcadeSelection(), profile1: ids[0] };
    preferences = selectArcadeMode(
      preferences,
      'human-ai',
      humanAI,
      'practice',
      ids
    );
    preferences = selectArcadeMode(
      preferences,
      'practice',
      emptyArcadeSelection(),
      'ai-ai',
      ids
    );
    expect(preferences.selections['ai-ai']).toEqual(pair());
    expect(preferences.selections['ai-solo']).toEqual(solo);
    expect(preferences.selections['human-ai']).toEqual(humanAI);
    writeArcadePreferences(storage, 'alice', preferences, ids);
    expect(readArcadePreferences(storage, 'alice', ids)).toEqual(preferences);
  });

  it('namespaces accounts and rejects IDs absent from the authenticated model list', () => {
    const storage = memoryStorage();
    const preferences = rememberArcadeSelection(
      readArcadePreferences(storage, 'alice', ids),
      'ai-ai',
      pair(),
      ids
    );
    writeArcadePreferences(storage, 'alice', preferences, ids);
    expect(readArcadePreferences(storage, 'bob', ids).selections).toEqual({});
    expect(arcadePreferenceKey('alice')).not.toBe(arcadePreferenceKey('bob'));
    const restored = readArcadePreferences(storage, 'alice', [ids[0]]);
    expect(restored.selections['ai-ai']?.profile0).toBe(ids[0]);
    expect(restored.selections['ai-ai']?.profile1).toBe('');
    expect(
      arcadeModelsReady('ai-ai', restored.selections['ai-ai']!, [ids[0]])
    ).toBe(false);
    writeArcadePreferences(storage, 'alice', restored, [ids[0]]);
    expect(storage.values.get(arcadePreferenceKey('alice'))).not.toContain(
      ids[1]
    );
  });

  it('serializes only whitelisted IDs, never profile objects or clone metadata', () => {
    const storage = memoryStorage();
    const polluted = {
      version: 1,
      mode: 'ai-ai',
      endpoint: 'private-endpoint',
      apiKey: 'private-key',
      seed: 'private-seed',
      selections: {
        'ai-ai': {
          ...pair(),
          profile: { apiKey: 'private-key' },
          credentialId: 'credential',
          endpoint: 'private-endpoint',
        },
      },
    };
    writeArcadePreferences(storage, 'alice', polluted as never, ids);
    const raw = storage.values.get(arcadePreferenceKey('alice'))!;
    expect(JSON.parse(raw)).toEqual({
      version: 1,
      mode: 'ai-ai',
      selections: { 'ai-ai': pair() },
    });
    expect(raw).not.toMatch(/private|credential|endpoint|apiKey/);
  });

  it('does not read or write preferences when reusing a public replay', () => {
    const storage = memoryStorage();
    const preferences = rememberArcadeSelection(
      sanitizeArcadePreferences(null, ids),
      'ai-ai',
      pair(),
      ids
    );
    writeArcadePreferences(storage, 'alice', preferences, ids);
    const before = storage.values.get(arcadePreferenceKey('alice'));
    storage.getItem.mockClear();
    storage.setItem.mockClear();
    expect(
      readArcadePreferences(storage, 'alice', ids, true).selections
    ).toEqual({});
    writeArcadePreferences(
      storage,
      'alice',
      { ...preferences, mode: 'ai-solo' },
      ids,
      true
    );
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.values.get(arcadePreferenceKey('alice'))).toBe(before);
  });

  it('handles broken storage and drops unsupported fields', () => {
    const storage = memoryStorage();
    storage.values.set(arcadePreferenceKey('alice'), '{bad-json');
    expect(readArcadePreferences(storage, 'alice', ids).mode).toBe('practice');
    const denied = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(readArcadePreferences(denied, 'alice', ids).mode).toBe('practice');
    expect(() =>
      writeArcadePreferences(
        denied,
        'alice',
        sanitizeArcadePreferences(null, ids),
        ids
      )
    ).not.toThrow();
    const result = sanitizeArcadePreferences(
      {
        version: 1,
        mode: 'unknown',
        selections: {
          'ai-solo': { profile0: ids[0], think0: 'bad', budget0: 999999 },
        },
      },
      ids
    );
    expect(result.mode).toBe('practice');
    expect(result.selections['ai-solo']).toEqual({
      ...emptyArcadeSelection(),
      profile0: ids[0],
    });
  });

  it('creates one AI-only controller and requires just its own profile', () => {
    expect(arcadeControllerKinds('ai-solo')).toEqual(['ai']);
    expect(arcadeControllerKinds('practice')).toEqual(['human']);
    expect(arcadeControllerKinds('human-ai')).toEqual(['human', 'ai']);
    expect(arcadeControllerKinds('ai-ai')).toEqual(['ai', 'ai']);
    const solo = { ...emptyArcadeSelection(), profile0: ids[1] };
    expect(arcadeModelsReady('ai-solo', solo, ids)).toBe(true);
    expect(arcadeModelsReady('ai-ai', solo, ids)).toBe(false);
    expect(
      arcadeModelsReady('ai-solo', { ...solo, profile0: 'other-owner' }, ids)
    ).toBe(false);
    expect(arcadeModelsReady('practice', emptyArcadeSelection(), [])).toBe(
      true
    );
  });

  it('migrates saved thinking preferences away while retaining every mode’s model choices', () => {
    const storage = memoryStorage();
    storage.values.set(
      arcadePreferenceKey('alice'),
      JSON.stringify({
        version: 1,
        mode: 'ai-ai',
        selections: {
          'ai-ai': {
            ...pair(),
            think0: 'always',
            think1: 'auto',
            budget0: 4096,
            budget1: 8192,
          },
          'ai-solo': { profile0: ids[1], think0: 'always', budget0: 8192 },
          'human-ai': { profile1: ids[0], think1: 'always', budget1: 4096 },
        },
      })
    );
    const restored = readArcadePreferences(storage, 'alice', ids);
    expect(restored.selections['ai-ai']).toEqual(pair());
    expect(restored.selections['ai-solo']).toEqual({
      profile0: ids[1],
      profile1: '',
    });
    expect(restored.selections['human-ai']).toEqual({
      profile0: '',
      profile1: ids[0],
    });
    writeArcadePreferences(storage, 'alice', restored, ids);
    expect(storage.values.get(arcadePreferenceKey('alice'))).not.toMatch(
      /think|budget/
    );
  });

  it.each(['ai-solo', 'human-ai', 'ai-ai'] as const)(
    'submits only profile references for %s even with stale thinking or cloned settings',
    (mode) => {
      const stale = {
        ...pair(),
        think0: 'always',
        think1: 'always',
        budget0: 8192,
        budget1: 8192,
        profile: { thinkMode: 'always', thinkBudget: 8192 },
      };
      const controllers = arcadeCreateControllers(mode, stale, ids)!;
      expect(controllers).toHaveLength(arcadeControllerKinds(mode).length);
      for (const controller of controllers) {
        expect(Object.keys(controller).sort()).toEqual(
          controller.kind === 'ai' ? ['kind', 'profileId'] : ['kind']
        );
      }
      expect(JSON.stringify(controllers)).not.toMatch(/think|budget/);
      expect(arcadeCreateControllers(mode, stale, [])).toBeNull();
    }
  );
});
