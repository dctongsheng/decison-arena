/** Internal marker overwritten by the loopback-only Node proxy middleware.
 * It is a public origin, never a credential. Do not accept a client-supplied copy. */
export const DEV_PUBLIC_ORIGIN_HEADER = 'x-arena-dev-public-origin';

export function configuredPublicOrigin(value?: string): string | null {
  if (!value) return null;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid ARENA_PUBLIC_ORIGIN'); }
  if (
    url.protocol !== 'https:' || url.username || url.password || url.port ||
    url.pathname !== '/' || url.search || url.hash ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(url.hostname) ||
    /^[\d.]+$/.test(url.hostname) || /(?:^|\.)(?:localhost|local|internal|invalid)$/.test(url.hostname)
  ) throw new Error('ARENA_PUBLIC_ORIGIN must be one public HTTPS origin on port 443');
  return url.origin;
}

/** Preserve HTTP's strict origin checks after TLS terminates at a local tunnel.
 * The dedicated Node wrapper/middleware is the trust boundary: it removes every incoming
 * marker, then stamps requests only from loopback with an exact Host and https
 * forwarding protocol. localProduction is a server-verified Node-only option;
 * production stays disabled without the explicit operator opt-in. */
export function normalizeDevPublicRequest(
  request: Request,
  { development, localProduction = false, publicOrigin }: {
    development: boolean;
    localProduction?: boolean;
    publicOrigin?: string;
  }
): Request {
  const marker = request.headers.get(DEV_PUBLIC_ORIGIN_HEADER);
  if (marker === null) return request;
  const headers = new Headers(request.headers);
  headers.delete(DEV_PUBLIC_ORIGIN_HEADER);
  const url = new URL(request.url);
  const configured = development || localProduction ? configuredPublicOrigin(publicOrigin) : null;
  if (
    configured && marker === configured &&
    url.protocol === 'http:' && url.host === new URL(configured).host
  ) url.protocol = 'https:';
  // Retain the same unread stream, signal and authentication headers. Cloning the
  // body would tee/buffer rejected requests; no body is consumed in this adapter.
  const init: RequestInit & { duplex: 'half' } = {
    method: request.method,
    headers,
    signal: request.signal,
    redirect: request.redirect,
    ...(request.method !== 'GET' && request.method !== 'HEAD' ? { body: request.body } : {}),
    duplex: 'half',
  };
  return new Request(url, init);
}
