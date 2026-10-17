import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BambooModelConnection } from '@/blocks/arena/bamboonode-connection';

const state = vi.hoisted(() => ({
  connection: {
    data: undefined as Record<string, unknown> | undefined,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  },
  sync: { isFetching: false, isError: false, refetch: vi.fn() },
}));
vi.mock('@/core/auth/client', () => ({
  authClient: { signIn: { oauth2: vi.fn() } },
  useSession: () => ({ data: { user: { id: 'alice' } } }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey: string[] }) => options.queryKey[0] === 'arena-bamboonode' ? state.connection : state.sync,
  useQueryClient: () => ({}),
  useMutation: () => ({ isPending: false, isError: false, mutate: vi.fn() }),
}));
vi.mock('@/paraglide/messages.js', () => ({ m: new Proxy({}, { get: (_, key) => () => String(key) }) }));

const render = () => renderToStaticMarkup(createElement(BambooModelConnection));
beforeEach(() => {
  state.connection.data = { enabled: true, status: 'connected', models: 3 };
  state.connection.isPending = false;
  state.connection.isError = false;
  state.sync.isFetching = false;
  state.sync.isError = false;
});

describe('BambooNode connection banner', () => {
  it('shows account billing without raw quota, credentials or a key form', () => {
    state.connection.data = { ...state.connection.data, quota: { unknown_unit: 'private-quota-marker' }, message: '<script>untrusted</script>' };
    const html = render();
    expect(html).toContain('arena.bamboo.quota_note');
    expect(html).toContain('arena.bamboo.disconnect');
    expect(html).toContain('https://bamboonode.dev');
    expect(html).toContain('&lt;script&gt;untrusted&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('private-quota-marker');
    expect(html).not.toContain('type="password"');
  });
  it.each(['reauthorize', 'disconnected'])('offers explicit authorization for %s without a sync action', status => {
    state.connection.data = { enabled: true, status, models: 0 };
    const html = render();
    expect(html).toContain('arena.bamboo.reauthorize');
    expect(html).not.toMatch(/>arena\.bamboo\.sync</);
  });
  it('reports synchronization failures with a manual retry instead of blocking the page', () => {
    state.connection.data = undefined;
    state.connection.isError = true;
    const html = render();
    expect(html).toContain('arena.bamboo.failed');
    expect(html).toContain('arena.bamboo.sync');
    expect(html).toContain('role="alert"');
  });
  it('renders nothing when the BambooNode integration is disabled', () => {
    state.connection.data = { enabled: false, status: 'not_connected', models: 0 };
    expect(render()).toBe('');
  });
});
