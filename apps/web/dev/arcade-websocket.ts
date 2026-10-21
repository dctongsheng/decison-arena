import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Plugin } from 'vite';

const matchSocketPath = '^/api/arena/matches/[a-zA-Z0-9_-]{1,128}/socket(?:\\?seat=(?:0|1|spectator|full))?$';
const allowedSocketPath = new RegExp(matchSocketPath);

/** Explicit origins only: public dev access must use HTTPS. Do not inherit
 * auth wildcard domains or trust the request Host / forwarded headers. */
export function arcadeDevAllowedOrigins(
  port: number,
  env: { VITE_APP_URL?: string; AUTH_TRUSTED_ORIGINS?: string } = process.env
) {
  const origins = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ]);
  const configured = [env.VITE_APP_URL || '', ...(env.AUTH_TRUSTED_ORIGINS || '').split(',')];
  for (const entry of configured) {
    const value = entry.trim();
    if (!value || /[\s*\\]/.test(value)) continue;
    try {
      const url = new URL(value);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
        url.username || url.password || url.pathname !== '/' || url.search || url.hash
      ) continue;
      origins.add(url.origin);
    } catch {
      // Invalid or wildcard entries do not broaden the WebSocket allowlist.
    }
  }
  return origins;
}

export interface ArenaSocketBridgeOptions {
  webPort: number | (() => number | null);
  port?: number;
  env?: NodeJS.ProcessEnv;
  deferListen?: boolean;
  acceptRequest?: (request: IncomingMessage) => boolean;
  onError?: (error: Error) => void;
}

/** Shared by Vite and the explicit local-production Node entry. Session lookup
 * stays on loopback; the browser can never choose the upstream owner or target. */
export function startArenaSocketBridge(options: ArenaSocketBridgeOptions) {
  const env = options.env ?? process.env;
  const port = options.port ?? Number(env.VITE_ARCADE_SOCKET_PORT || 5094);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Invalid VITE_ARCADE_SOCKET_PORT');
  const socketServer = createServer((_request, response) => { response.writeHead(404); response.end(); });
  const clients = new Set<Duplex>();
  let closing: Promise<void> | undefined;
  const close = () => closing ??= new Promise<void>((resolve) => {
    for (const client of clients) client.destroy();
    socketServer.close(() => resolve());
  });
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (closing) { socket.destroy(); return; }
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    // Untrusted clients may disconnect while session authentication is pending.
    socket.on('error', () => socket.destroy());
    const path = request.url ?? '';
    if (!allowedSocketPath.test(path) && !/^\/api\/arena\/arcade-sessions\/[a-zA-Z0-9_-]{1,128}\/socket(?:\?since=\d+)?$/.test(path)) { socket.destroy(); return; }
    const reject = (status: number) => {
      if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    void (async () => {
      if (options.acceptRequest && !options.acceptRequest(request)) return reject(403);
      const webPort = typeof options.webPort === 'function' ? options.webPort() : options.webPort;
      if (!webPort || !Number.isInteger(webPort) || webPort < 1024 || webPort > 65535) return reject(503);
      const origin = request.headers.origin;
      if (!origin || !arcadeDevAllowedOrigins(webPort, env).has(origin)) return reject(403);
      const secret = env.ARENA_INTERNAL_SECRET;
      const runner = new URL(env.ARENA_RUNNER_URL || 'http://127.0.0.1:5092');
      if (!secret || runner.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(runner.hostname) ||
        runner.username || runner.password || runner.pathname !== '/' || runner.search || runner.hash) return reject(503);
      const response = await fetch(`http://127.0.0.1:${webPort}/api/auth/get-session`, {
        headers: { Cookie: request.headers.cookie || '' }, signal: AbortSignal.timeout(5000), redirect: 'error',
      });
      const session = response.ok ? await response.json() as { user?: { id?: string } } | null : null;
      const ownerId = session?.user?.id;
      if (typeof ownerId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(ownerId)) return reject(401);
      if (socket.destroyed || closing) return;
      const target = new URL(path.replace(/^\/api\/arena/, ''), runner);
      const upstream = httpRequest(target, {
        headers: {
          Connection: 'Upgrade', Upgrade: 'websocket',
          'Sec-WebSocket-Key': request.headers['sec-websocket-key'] || '',
          'Sec-WebSocket-Version': '13',
          'X-Arena-Owner': ownerId, 'X-Arena-Internal': secret,
        },
      });
      upstream.setTimeout(5000, () => upstream.destroy());
      upstream.on('upgrade', (result, remote, remoteHead) => {
        upstream.setTimeout(0);
        if (socket.destroyed || closing) { remote.destroy(); return; }
        const headers = Object.entries(result.headers).flatMap(([key, value]) =>
          value === undefined ? [] : [`${key}: ${Array.isArray(value) ? value.join(', ') : value}`]);
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers.join('\r\n')}\r\n\r\n`);
        if (remoteHead.length) socket.write(remoteHead);
        if (head.length) remote.write(head);
        relay(socket, remote);
      });
      upstream.on('response', result => { result.resume(); reject(result.statusCode || 502); });
      upstream.on('error', () => reject(502));
      socket.on('close', () => upstream.destroy());
      upstream.end();
    })().catch(() => reject(502));
  };
  socketServer.on('upgrade', upgrade);
  if (options.onError) socketServer.on('error', options.onError);
  const listen = () => {
    if (!closing) socketServer.listen(port, '127.0.0.1');
  };
  if (!options.deferListen) listen();
  return { server: socketServer, upgrade, listen, close };
}

/** Vite only controls the lifecycle; authentication is shared with production. */
export function arcadeWebSocketBridge(): Plugin {
  let closeBridge: (() => Promise<void>) | undefined;
  return {
    name: 'arena-authenticated-dev-websocket',
    apply: 'serve',
    config: () => ({ server: { proxy: {
      [matchSocketPath]: {
        target: `http://127.0.0.1:${process.env.VITE_ARCADE_SOCKET_PORT || '5094'}`,
        ws: true,
      },
    } } }),
    async buildEnd() { await closeBridge?.(); },
    async configureServer(server) {
      const bridge = startArenaSocketBridge({
        webPort: () => {
          const address = server.httpServer?.address();
          return address && typeof address !== 'string' ? address.port : null;
        },
        deferListen: true,
        onError: () => server.config.logger.error('Arena WebSocket bridge could not listen.'),
      });
      closeBridge = bridge.close;
      server.httpServer?.on('close', () => { void bridge.close(); });
      // Defer until Vite has closed the previous HMR listener on a restart.
      if (server.httpServer?.listening) bridge.listen();
      else server.httpServer?.once('listening', bridge.listen);
    },
  };
}

function relay(client: Duplex, upstream: Duplex) {
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  client.on('close', () => upstream.destroy());
  upstream.on('close', () => client.destroy());
  client.pipe(upstream).pipe(client);
}
