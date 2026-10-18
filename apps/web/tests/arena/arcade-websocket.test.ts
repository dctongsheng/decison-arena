import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ createServer: vi.fn(), request: vi.fn() }));
vi.mock('node:http', () => ({ createServer: mocked.createServer, request: mocked.request }));

import { arcadeDevAllowedOrigins, arcadeWebSocketBridge } from '../../dev/arcade-websocket';

describe('explicit development WebSocket origins', () => {
  it('keeps local origins and adds only configured exact public HTTPS origins', () => {
    const origins = arcadeDevAllowedOrigins(5091, {
      VITE_APP_URL: 'https://arena.startlux-decision.com/',
      AUTH_TRUSTED_ORIGINS: ' https://preview.example.com:8443, http://localhost:6091 ',
    });
    expect([...origins]).toEqual([
      'http://127.0.0.1:5091', 'http://localhost:5091',
      'https://arena.startlux-decision.com', 'https://preview.example.com:8443', 'http://localhost:6091',
    ]);
    expect(origins.has('https://arena.startlux-decision.com.evil.test')).toBe(false);
    expect(origins.has('https://other.startlux-decision.com')).toBe(false);
    expect(origins.has('http://arena.startlux-decision.com')).toBe(false);
  });
  it.each([
    '*', '.e2b.app', 'https://*.example.com', 'null',
    'http://public.example.com', 'wss://public.example.com', 'javascript:alert(1)',
    'https://user:password@example.com', 'https://example.com/path',
    'https://example.com?token=value', 'https://example.com/#fragment',
    'https://example.com\\@evil.test', 'https://example.com\n.evil.test',
  ])('ignores unsafe/non-origin configuration %s', (value) => {
    expect([...arcadeDevAllowedOrigins(5091, { VITE_APP_URL: value, AUTH_TRUSTED_ORIGINS: value })])
      .toEqual(['http://127.0.0.1:5091', 'http://localhost:5091']);
  });
  it('has no public-origin default when configuration is missing', () => {
    expect([...arcadeDevAllowedOrigins(5091, {})]).toEqual(['http://127.0.0.1:5091', 'http://localhost:5091']);
  });
});

describe('development bridge authentication (mock transports only)', () => {
  let socketServer: EventEmitter & { listen: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  let viteServer: EventEmitter & { address: () => { port: number } };
  let upstream: EventEmitter & { setTimeout: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
  let plugin: ReturnType<typeof arcadeWebSocketBridge>;
  const fetchMock = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv('VITE_APP_URL', 'https://arena.startlux-decision.com');
    vi.stubEnv('AUTH_TRUSTED_ORIGINS', '');
    vi.stubEnv('ARENA_RUNNER_URL', 'http://127.0.0.1:5092');
    vi.stubEnv('ARENA_INTERNAL_SECRET', 'fixture-bridge-secret');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ user: { id: 'fixture-owner' } }) });
    socketServer = Object.assign(new EventEmitter(), {
      listen: vi.fn(), close: vi.fn((done: () => void) => done()),
    });
    viteServer = Object.assign(new EventEmitter(), { address: () => ({ port: 5091 }) });
    upstream = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), end: vi.fn(), destroy: vi.fn() });
    mocked.createServer.mockReturnValue(socketServer);
    mocked.request.mockReturnValue(upstream);
    plugin = arcadeWebSocketBridge();
    const configure = plugin.configureServer;
    if (typeof configure !== 'function') throw new Error('Expected server hook');
    await configure.call({} as never, { httpServer: viteServer } as never);
    expect(socketServer.listen).not.toHaveBeenCalled();
    viteServer.emit('listening');
  });
  afterEach(() => {
    viteServer.emit('close');
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  function upgrade(origin?: string, headers: Record<string, string> = {}, path = '/api/arena/arcade-sessions/arcade-fixture/socket?since=42') {
    const socket = Object.assign(new EventEmitter(), { destroyed: false, end: vi.fn(), destroy: vi.fn() });
    socketServer.emit('upgrade', {
      url: path,
      headers: { origin, cookie: 'fixture-cookie', 'sec-websocket-key': 'fixture-websocket-key', ...headers },
    }, socket, Buffer.alloc(0));
    return socket;
  }
  it('routes same-origin chess upgrades to the authenticated bridge, leaving ordinary HTTP routes alone', async () => {
    const config = plugin.config;
    if (typeof config !== 'function') throw new Error('Expected config hook');
    const result = await config.call({} as never, {}, { command: 'serve', mode: 'development' });
    const proxy = result!.server!.proxy!;
    const [pattern, target] = Object.entries(proxy)[0];
    expect(target).toEqual({ target: 'http://127.0.0.1:5094', ws: true });
    expect(new RegExp(pattern).test('/api/arena/matches/id/socket?seat=0')).toBe(true);
    expect(new RegExp(pattern).test('/api/arena/matches/id/commands')).toBe(false);
  });
  it('releases the independent listener before Vite restarts', async () => {
    const close = plugin.buildEnd;
    if (typeof close !== 'function') throw new Error('Expected buildEnd hook');
    await close.call({} as never);
    expect(socketServer.close).toHaveBeenCalledOnce();
    viteServer.emit('close');
    expect(socketServer.close).toHaveBeenCalledOnce();
  });
  it('authenticates a configured tunnel origin locally and derives owner only from that session', async () => {
    upgrade('https://arena.startlux-decision.com', { 'x-arena-owner': 'forged-owner', 'x-forwarded-host': 'evil.test' });
    await vi.waitFor(() => expect(mocked.request).toHaveBeenCalledOnce());
    expect(socketServer.listen).toHaveBeenCalledWith(5094, '127.0.0.1');
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:5091/api/auth/get-session', expect.objectContaining({
      headers: { Cookie: 'fixture-cookie' }, redirect: 'error',
    }));
    const [target, options] = mocked.request.mock.calls[0];
    expect(target.toString()).toBe('http://127.0.0.1:5092/arcade-sessions/arcade-fixture/socket?since=42');
    expect(options.headers['X-Arena-Owner']).toBe('fixture-owner');
    expect(options.headers['X-Arena-Internal']).toBe('fixture-bridge-secret');
    expect(options.headers.Cookie).toBeUndefined();
    expect(upstream.end).toHaveBeenCalledOnce();
  });
  it.each([undefined, 'null', 'https://evil.test', 'https://arena.startlux-decision.com.evil.test', 'https://arena.startlux-decision.com/'])(
    'rejects an untrusted Origin before Cookie authentication: %s', async (origin) => {
      const socket = upgrade(origin, { host: 'arena.startlux-decision.com', 'x-forwarded-host': 'arena.startlux-decision.com' });
      await vi.waitFor(() => expect(socket.end).toHaveBeenCalledWith(expect.stringContaining('403 Rejected')));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocked.request).not.toHaveBeenCalled();
    }
  );
  it('does not forward a configured origin without a valid authenticated owner', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => null });
    const socket = upgrade('https://arena.startlux-decision.com');
    await vi.waitFor(() => expect(socket.end).toHaveBeenCalledWith(expect.stringContaining('401 Rejected')));
    expect(mocked.request).not.toHaveBeenCalled();
  });
  it.each(['0', '1', 'spectator', 'full'])('preserves chess viewer %s and authenticates the derived owner', async (seat) => {
    upgrade('http://127.0.0.1:5091', { 'x-arena-owner': 'forged-owner' }, `/api/arena/matches/chess-fixture/socket?seat=${seat}`);
    await vi.waitFor(() => expect(mocked.request).toHaveBeenCalledOnce());
    const [target, options] = mocked.request.mock.calls[0];
    expect(target.toString()).toBe(`http://127.0.0.1:5092/matches/chess-fixture/socket?seat=${seat}`);
    expect(options.headers['X-Arena-Owner']).toBe('fixture-owner');
    expect(options.headers.Cookie).toBeUndefined();
  });
  it('rejects anonymous chess upgrades', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => null });
    const socket = upgrade('http://127.0.0.1:5091', {}, '/api/arena/matches/id/socket?seat=0');
    await vi.waitFor(() => expect(socket.end).toHaveBeenCalledWith(expect.stringContaining('401 Rejected')));
    expect(mocked.request).not.toHaveBeenCalled();
  });
  it('rejects foreign-origin chess upgrades before authentication', () => {
    const socket = upgrade('https://evil.test', {}, '/api/arena/matches/id/socket?seat=1');
    expect(socket.end).toHaveBeenCalledWith(expect.stringContaining('403 Rejected'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(['?seat=admin', '?seat=0&owner=other', '?seat=0&seat=1', '?seat=2', '/../../secrets'])(
    'does not broaden the chess path allowlist: %s', (suffix) => {
      const socket = upgrade('http://127.0.0.1:5091', {}, `/api/arena/matches/id/socket${suffix}`);
      expect(socket.destroy).toHaveBeenCalledOnce();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
});
