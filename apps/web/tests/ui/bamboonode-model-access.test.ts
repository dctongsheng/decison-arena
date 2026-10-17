import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  arcadeCreateControllers,
  arcadeModelsReady,
} from '@/blocks/arcade/create-preferences';
import {
  availableModels,
  bambooConnectionKey,
  bambooReauthorization,
  bambooSyncOptions,
  canAutomaticallySyncBamboo,
  canEditModel,
  type BambooConnection,
} from '@/blocks/arena/bamboonode-access';

const connected: BambooConnection = {
  enabled: true,
  status: 'connected',
  models: 3,
};
afterEach(() => vi.unstubAllGlobals());

describe('BambooNode model synchronization', () => {
  it('deduplicates simultaneous mounts and invalidates only the current user’s profiles', async () => {
    const client = new QueryClient();
    client.setQueryData(['arena-models', 'alice'], { items: [] });
    client.setQueryData(['arena-models', 'bob'], {
      items: [{ id: 'bob-manual' }],
    });
    let resolve!: (connection: BambooConnection) => void;
    const sync = vi.fn(
      () =>
        new Promise<BambooConnection>((done) => {
          resolve = done;
        })
    );
    const options = bambooSyncOptions(client, 'alice', sync);
    const first = client.fetchQuery(options),
      second = client.fetchQuery(options);
    expect(sync).toHaveBeenCalledTimes(1);
    resolve(connected);
    expect(await first).toEqual(connected);
    expect(await second).toEqual(connected);
    expect(client.getQueryData(bambooConnectionKey('alice'))).toEqual(
      connected
    );
    expect(client.getQueryData(bambooConnectionKey('bob'))).toBeUndefined();
    expect(client.getQueryState(['arena-models', 'alice'])?.isInvalidated).toBe(
      true
    );
    expect(client.getQueryState(['arena-models', 'bob'])?.isInvalidated).toBe(
      false
    );
    await client.fetchQuery(options);
    expect(sync).toHaveBeenCalledTimes(1);
    client.clear();
  });

  it('does not invalidate BYOK profiles on failure or retry POST automatically on remount', async () => {
    const client = new QueryClient();
    client.setQueryData(['arena-models', 'alice'], {
      items: [{ id: 'own-key' }],
    });
    const sync = vi.fn().mockRejectedValue(new Error('connection unavailable'));
    const options = bambooSyncOptions(client, 'alice', sync);
    const first = new QueryObserver(client, options);
    const unsubscribe = first.subscribe(() => {});
    await vi.waitFor(() => expect(first.getCurrentResult().isError).toBe(true));
    unsubscribe();
    const again = new QueryObserver(client, options);
    const stop = again.subscribe(() => {});
    expect(sync).toHaveBeenCalledTimes(1);
    expect(client.getQueryState(['arena-models', 'alice'])?.isInvalidated).toBe(
      false
    );
    expect(client.getQueryData(['arena-models', 'alice'])).toEqual({
      items: [{ id: 'own-key' }],
    });
    sync.mockResolvedValue(connected);
    await again.refetch();
    expect(sync).toHaveBeenCalledTimes(2);
    stop();
    client.clear();
  });

  it('requires explicit recovery for disconnected, expired or failed access', () => {
    expect(canAutomaticallySyncBamboo(undefined)).toBe(false);
    expect(canAutomaticallySyncBamboo({ ...connected, enabled: false })).toBe(
      false
    );
    for (const status of [
      'reauthorize',
      'disconnected',
      'syncing',
      'error',
    ] as const) {
      expect(canAutomaticallySyncBamboo({ ...connected, status })).toBe(false);
    }
    expect(canAutomaticallySyncBamboo(connected)).toBe(true);
    expect(
      canAutomaticallySyncBamboo({ ...connected, status: 'not_connected' })
    ).toBe(true);
  });

  it('preserves BYOK editing while managed profiles cannot enter the key editor', () => {
    expect(canEditModel({})).toBe(true);
    expect(canEditModel({ source: 'manual' })).toBe(true);
    expect(canEditModel({ source: 'bamboonode' })).toBe(false);
  });

  it('lets one AI or two AIs use available catalog profiles and rejects disconnected ones', () => {
    const models = availableModels([
      { id: 'bamboo-jev-113', available: true },
      { id: 'bamboo-startlux', available: true },
      { id: 'bamboo-expired', available: false },
      { id: 'old-byok' },
    ]);
    const ids = models.map((model) => model.id);
    expect(ids).toEqual(['bamboo-jev-113', 'bamboo-startlux', 'old-byok']);
    expect(
      arcadeCreateControllers(
        'ai-solo',
        { profile0: 'bamboo-jev-113', profile1: '' },
        ids
      )
    ).toEqual([{ kind: 'ai', profileId: 'bamboo-jev-113' }]);
    expect(
      arcadeModelsReady(
        'ai-ai',
        { profile0: 'bamboo-jev-113', profile1: 'bamboo-startlux' },
        ids
      )
    ).toBe(true);
    expect(
      arcadeModelsReady(
        'ai-ai',
        { profile0: 'bamboo-jev-113', profile1: 'bamboo-expired' },
        ids
      )
    ).toBe(false);
  });

  it('reauthorizes directly with a safe localized callback and no sign-in loop', () => {
    vi.stubGlobal('window', {
      location: {
        origin: 'https://arena.example',
        href: 'https://arena.example/zh/arcade/new',
      },
    });
    const input = bambooReauthorization(
      '/arcade/new?game=snake&bamboo_error=1&error=old',
      'zh'
    );
    expect(input.providerId).toBe('bamboonode');
    expect(input.callbackURL).toBe('/zh/arcade/new?game=snake');
    expect(input.errorCallbackURL).toBe(
      '/zh/arcade/new?game=snake&bamboo_error=1'
    );
    expect(
      bambooReauthorization('https://evil.example/steal', 'zh').callbackURL
    ).toBe('/zh/models');
  });
});
