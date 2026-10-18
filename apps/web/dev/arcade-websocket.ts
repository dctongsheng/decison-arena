import { createServer, request as httpRequest } from 'node:http';
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

/** Node fetch cannot relay a workerd WebSocket upgrade. This dev-only bridge
 * validates the existing server session before forwarding to the loopback runner. */
export function arcadeWebSocketBridge(): Plugin {
  let closeBridge: (() => Promise<void>) | undefined;
  return {
    name: 'arena-authenticated-dev-websocket',
    apply: 'serve',
    // Chess clients use same-origin URLs, including through the existing Tunnel.
    // Vite must relay the upgrade before Nitro's Node fetch handler sees it.
    config: () => ({ server: { proxy: {
      [matchSocketPath]: {
        target: `http://127.0.0.1:${process.env.VITE_ARCADE_SOCKET_PORT || '5094'}`,
        ws: true,
      },
    } } }),
    // Await port release while Vite closes the old server during dev restart.
    async buildEnd() { await closeBridge?.(); },
    async configureServer(server) {
      // Keep realtime upgrades independent of Vite's HMR handshake lifecycle.
      const port = Number(process.env.VITE_ARCADE_SOCKET_PORT || 5094);
      if (!Number.isInteger(port) || port < 1024 || port > 65535)
        throw new Error('Invalid VITE_ARCADE_SOCKET_PORT');
      const socketServer = createServer((_request, response) => { response.writeHead(404); response.end(); });
      const clients = new Set<Duplex>();
      let closing: Promise<void> | undefined;
      const close = () => closing ??= new Promise<void>((resolve) => {
        for (const client of clients) client.destroy();
        socketServer.close(() => resolve());
      });
      closeBridge = close;
      server.httpServer?.on('close', () => { void close(); });
      socketServer.on('upgrade', (request, socket, head) => {
        clients.add(socket);
        socket.on('close', () => clients.delete(socket));
        const path = request.url ?? '';
        if (!allowedSocketPath.test(path) && !/^\/api\/arena\/arcade-sessions\/[a-zA-Z0-9_-]{1,128}\/socket(?:\?since=\d+)?$/.test(path)) { socket.destroy(); return; }
        const reject = (status: number) => {
          if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        };
        void (async () => {
          const address = server.httpServer?.address();
          if (!address || typeof address === 'string') return reject(503);
          const origin = request.headers.origin;
          if (!origin || !arcadeDevAllowedOrigins(address.port).has(origin)) return reject(403);
          const secret = process.env.ARENA_INTERNAL_SECRET;
          const runner = new URL(process.env.ARENA_RUNNER_URL || 'http://127.0.0.1:5092');
          if (!secret || runner.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(runner.hostname)) return reject(503);
          const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/get-session`, {
            headers: { Cookie: request.headers.cookie || '' }, signal: AbortSignal.timeout(5000), redirect: 'error',
          });
          const session = response.ok ? await response.json() as { user?: { id?: string } } | null : null;
          const ownerId = session?.user?.id;
          if (typeof ownerId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(ownerId)) return reject(401);
          if (socket.destroyed) return;
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
            if (socket.destroyed) { remote.destroy(); return; }
            const headers = Object.entries(result.headers).flatMap(([key, value]) =>
              value === undefined ? [] : [`${key}: ${Array.isArray(value) ? value.join(', ') : value}`]);
            socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers.join('\r\n')}\r\n\r\n`);
            if (remoteHead.length) socket.write(remoteHead);
            if (head.length) remote.write(head);
            relay(socket, remote);
          });
          upstream.on('response', result => { result.resume(); reject(result.statusCode || 502); });
          upstream.on('error', () => reject(502));
          socket.on('error', () => upstream.destroy());
          upstream.end();
        })().catch(() => reject(502));
      });
      // Vite constructs the next plugin before closing the old server. Binding
      // inside configureServer races the old listener; wait for the new HTTP
      // server to listen, which happens after old-server cleanup has completed.
      socketServer.on('error', (error) => server.config.logger.error(`Arena WebSocket bridge: ${error.message}`));
      const listen = () => {
        if (!closing) socketServer.listen(port, '127.0.0.1');
      };
      if (server.httpServer?.listening) listen();
      else server.httpServer?.once('listening', listen);
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
