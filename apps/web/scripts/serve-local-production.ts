import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isAbsolute, resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { startArenaSocketBridge } from '../dev/arcade-websocket';
import { stampDevPublicOrigin } from '../dev/public-origin';
import { configuredPublicOrigin, DEV_PUBLIC_ORIGIN_HEADER } from '../src/lib/dev-public-origin';

type Middleware = (request: IncomingMessage, response: ServerResponse) => unknown;
export interface LocalProductionOptions {
  webPort: 5091;
  socketPort: 5094;
  publicOrigin: string | null;
  entry: URL;
}

/** The supervisor supplies the existing encrypted-vault/database environment.
 * Do not discover dotenv files or silently change the runtime mode here. */
export function localProductionOptions(env: NodeJS.ProcessEnv = process.env): LocalProductionOptions {
  if (env.NODE_ENV !== 'production' || env.ARENA_LOCAL_PRODUCTION !== 'true')
    throw new Error('Local production requires NODE_ENV=production and ARENA_LOCAL_PRODUCTION=true.');
  if (env.ARENA_LOCAL_BUILD_ENTRY && !isAbsolute(env.ARENA_LOCAL_BUILD_ENTRY))
    throw new Error('ARENA_LOCAL_BUILD_ENTRY must be an absolute path.');
  if (env.VITE_ARCADE_SOCKET_PORT && env.VITE_ARCADE_SOCKET_PORT !== '5094')
    throw new Error('Local production requires WebSocket port 5094.');
  if (!env.ARENA_INTERNAL_SECRET)
    throw new Error('Local production requires the existing runner bridge secret.');
  const runner = new URL(env.ARENA_RUNNER_URL || 'http://127.0.0.1:5092');
  if (runner.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(runner.hostname) ||
    runner.username || runner.password || runner.pathname !== '/' || runner.search || runner.hash)
    throw new Error('Local production requires a loopback runner origin.');
  return {
    webPort: 5091,
    socketPort: 5094,
    publicOrigin: configuredPublicOrigin(env.ARENA_PUBLIC_ORIGIN),
    entry: env.ARENA_LOCAL_BUILD_ENTRY
      ? pathToFileURL(env.ARENA_LOCAL_BUILD_ENTRY)
      : new URL('../.output/server/index.mjs', import.meta.url),
  };
}

/** Shared HTTP/upgrade edge: reject unknown Host values and remove every
 * client-supplied internal header before the authenticated application sees it. */
export function prepareLocalProductionRequest(
  request: IncomingMessage,
  options: LocalProductionOptions,
  transport: 'http' | 'websocket' = 'http'
): boolean {
  for (const name of Object.keys(request.headers)) {
    if (name.toLowerCase().startsWith('x-arena-')) delete request.headers[name];
  }
  for (let index = request.rawHeaders.length - 2; index >= 0; index -= 2) {
    if (request.rawHeaders[index].toLowerCase().startsWith('x-arena-')) request.rawHeaders.splice(index, 2);
  }
  const hosts = request.rawHeaders.filter((_value, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === 'host');
  if (hosts.length !== 1) return false;
  const host = request.headers.host?.toLowerCase();
  if ([`127.0.0.1:${options.webPort}`, `localhost:${options.webPort}`].includes(host || '')) return true;
  // Older local clients address the dedicated socket listener directly. Only
  // that actual listener may accept its Host; the web HTTP edge stays strict.
  if (transport === 'websocket' && request.socket.localPort === options.socketPort &&
    [`127.0.0.1:${options.socketPort}`, `localhost:${options.socketPort}`].includes(host || '')) return true;
  if (!options.publicOrigin || host !== new URL(options.publicOrigin).host) return false;
  stampDevPublicOrigin(request, options.publicOrigin);
  return request.headers[DEV_PUBLIC_ORIGIN_HEADER] === options.publicOrigin;
}

export function productionRequestHandler(middleware: Middleware, options: LocalProductionOptions) {
  return (request: IncomingMessage, response: ServerResponse) => {
    if (!prepareLocalProductionRequest(request, options)) {
      response.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      response.end('Forbidden host');
      return;
    }
    Promise.resolve().then(() => middleware(request, response)).catch(() => {
      // Never emit upstream errors, cookies, URLs or request bodies to logs.
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      response.end('The request could not be completed.');
    });
  };
}

export async function startLocalProduction(env: NodeJS.ProcessEnv = process.env) {
  const options = localProductionOptions(env);
  const metadata = JSON.parse(await readFile(new URL('../nitro.json', options.entry), 'utf8')) as { preset?: string };
  if (metadata.preset !== 'node-middleware')
    throw new Error('Build the node_middleware preset before starting local production.');
  const compiled = await import(options.entry.href) as { middleware?: Middleware };
  if (typeof compiled.middleware !== 'function') throw new Error('The production middleware export is missing.');

  const server = createServer(productionRequestHandler(compiled.middleware, options));
  const connections = new Set<Duplex>();
  server.on('connection', socket => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
  });
  const bridge = startArenaSocketBridge({
    webPort: options.webPort,
    port: options.socketPort,
    env,
    deferListen: true,
    acceptRequest: request => prepareLocalProductionRequest(request, options, 'websocket'),
  });
  // Local production clients use same-origin sockets; the separate listener
  // remains available for the already configured Tunnel WebSocket route.
  server.on('upgrade', bridge.upgrade);
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    await bridge.close();
    const forced = setTimeout(() => { for (const socket of connections) socket.destroy(); }, 5000);
    forced.unref();
    await new Promise<void>(done => { server.close(() => done()); server.closeIdleConnections(); });
    clearTimeout(forced);
  })();
  try {
    const webReady = once(server, 'listening');
    server.listen(options.webPort, '127.0.0.1');
    await webReady;
    const socketReady = once(bridge.server, 'listening');
    bridge.listen();
    await socketReady;
  } catch (error) {
    await close();
    throw error;
  }
  return { server, bridge, close };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startLocalProduction().then(runtime => {
    console.log('Decision Arena production is listening on 127.0.0.1:5091 (WebSocket bridge: 5094).');
    const stop = () => { void runtime.close().then(() => process.exit(0)); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const fail = () => {
      console.error('Decision Arena production listener failed.');
      void runtime.close().then(() => process.exit(1));
    };
    runtime.server.on('error', fail);
    runtime.bridge.server.on('error', fail);
  }).catch(() => {
    console.error('Decision Arena production could not start; verify its build, loopback ports and environment.');
    process.exitCode = 1;
  });
}
