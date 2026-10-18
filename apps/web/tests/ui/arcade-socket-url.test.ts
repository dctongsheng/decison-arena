import { describe, expect, it, vi } from 'vitest';

vi.mock('@/core/auth/client', () => ({ useSession: vi.fn() }));
vi.mock('@/blocks/arcade/messages', () => ({ a: (key: string) => key }));

import { arcadeSocketUrl } from '@/blocks/arcade/live-session';

describe('arcade socket routing for local development and public tunnels', () => {
  it.each(['http://127.0.0.1:5091', 'http://localhost:5091', 'http://[::1]:5091'])(
    'keeps the independent loopback bridge for %s',
    (origin) => {
      const url = new URL(arcadeSocketUrl(origin, 'arcade-test', { development: true, since: 42 }));
      expect(url.port).toBe('5094');
      expect(url.hostname).toBe(new URL(origin).hostname);
      expect(url.protocol).toBe('ws:');
      expect(url.pathname).toBe('/api/arena/arcade-sessions/arcade-test/socket');
      expect(url.searchParams.get('since')).toBe('42');
    }
  );
  it('keeps the configured bridge port on loopback only', () => {
    expect(new URL(arcadeSocketUrl('http://localhost:5091', 'id', { development: true, port: '6094' })).port).toBe('6094');
    expect(arcadeSocketUrl('https://arena.startlux-decision.com', 'id', { development: true, port: '6094', since: 5 }))
      .toBe('wss://arena.startlux-decision.com/api/arena/arcade-sessions/id/socket?since=5');
  });
  it.each(['https://arena.startlux-decision.com:8443', 'https://localhost.evil.test', 'https://127.0.0.1.evil.test'])(
    'preserves the same origin for non-loopback development page %s',
    (origin) => {
      const url = new URL(arcadeSocketUrl(origin, 'id', { development: true }));
      expect(url.host).toBe(new URL(origin).host);
      expect(url.protocol).toBe('wss:');
    }
  );
  it('leaves production same-origin routing and encoded session paths unchanged', () => {
    const url = new URL(arcadeSocketUrl('http://localhost:5091', 'id/with space', { development: false, since: 0 }));
    expect(url.port).toBe('5091');
    expect(url.pathname).toBe('/api/arena/arcade-sessions/id%2Fwith%20space/socket');
    expect(url.search).toBe('');
  });
});
