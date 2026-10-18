import type { IncomingMessage } from 'node:http';
import type { Plugin } from 'vite';

import {
  configuredPublicOrigin,
  DEV_PUBLIC_ORIGIN_HEADER,
} from '../src/lib/dev-public-origin';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Exported for tests using Nitro's actual srvx NodeRequest adapter. */
export function stampDevPublicOrigin(request: IncomingMessage, origin: string | null) {
  // IncomingMessage.rawHeaders is used when srvx lazily materializes Headers.
  // Scrub both representations; retaining rawHeaders would allow duplicate-header
  // spoofing even after the dictionary entry had been replaced.
  delete request.headers[DEV_PUBLIC_ORIGIN_HEADER];
  for (let index = request.rawHeaders.length - 2; index >= 0; index -= 2) {
    if (request.rawHeaders[index].toLowerCase() === DEV_PUBLIC_ORIGIN_HEADER)
      request.rawHeaders.splice(index, 2);
  }
  if (
    !origin || !LOOPBACK.has(request.socket.remoteAddress || '') ||
    request.headers.host?.toLowerCase() !== new URL(origin).host ||
    request.headers['x-forwarded-proto'] !== 'https'
  ) return;
  request.headers[DEV_PUBLIC_ORIGIN_HEADER] = origin;
  request.rawHeaders.push(DEV_PUBLIC_ORIGIN_HEADER, origin);
}

/** Must precede nitro() in Vite's plugins. No dependency patch or global proxy trust. */
export function publicOriginProxy(): Plugin {
  return {
    name: 'arena-loopback-public-origin',
    apply: 'serve',
    enforce: 'pre',
    configureServer(server) {
      const origin = configuredPublicOrigin(process.env.ARENA_PUBLIC_ORIGIN);
      server.middlewares.use((request, _response, next) => {
        stampDevPublicOrigin(request, origin);
        next();
      });
    },
  };
}
