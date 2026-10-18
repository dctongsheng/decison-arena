import { IncomingMessage } from 'node:http';
import { createRequire } from 'node:module';
import { Socket } from 'node:net';
import { dirname } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { stampDevPublicOrigin } from '../../dev/public-origin';
import { assertSameOrigin } from '../../src/core/arena/runtime';
import {
  configuredPublicOrigin,
  DEV_PUBLIC_ORIGIN_HEADER,
  normalizeDevPublicRequest,
} from '../../src/lib/dev-public-origin';

const publicOrigin = 'https://arena.startlux-decision.com';
let NodeRequest: new (context: { req: IncomingMessage }) => Request;

beforeAll(async () => {
  // Exercise the adapter Nitro actually resolves, even if another dependency
  // installs a different srvx version at the workspace root.
  const require = createRequire(new URL('../../package.json', import.meta.url));
  const nitro = require.resolve('nitro/vite');
  const adapter = require.resolve('srvx/node', { paths: [dirname(nitro)] });
  ({ NodeRequest } = await import(adapter));
});

function incoming({
  address = '127.0.0.1',
  host = 'arena.startlux-decision.com',
  proto = 'https',
  origin = publicOrigin,
  method = 'GET',
  path = '/api/arena/models',
}: {
  address?: string;
  host?: string;
  proto?: string;
  origin?: string;
  method?: string;
  path?: string;
} = {}) {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: address });
  const request = new IncomingMessage(socket);
  request.method = method;
  request.url = path;
  request.headers = {
    host,
    ...(proto ? { 'x-forwarded-proto': proto } : {}),
    ...(origin ? { origin } : {}),
  };
  request.rawHeaders = Object.entries(request.headers).flatMap(([name, value]) => [name, String(value)]);
  return request;
}

function normalize(request: IncomingMessage, development = true) {
  stampDevPublicOrigin(request, publicOrigin);
  return normalizeDevPublicRequest(new NodeRequest({ req: request }), { development, publicOrigin });
}

describe('explicit loopback HTTPS tunnel origin', () => {
  it('repairs the actual Nitro HTTP URL while keeping the strict same-origin guard', () => {
    const original = new NodeRequest({ req: incoming() });
    expect(original.url).toBe('http://arena.startlux-decision.com/api/arena/models');
    expect(() => assertSameOrigin(original)).toThrow('same-origin');

    const request = normalize(incoming());
    expect(request.url).toBe(`${publicOrigin}/api/arena/models`);
    expect(request.headers.has(DEV_PUBLIC_ORIGIN_HEADER)).toBe(false);
    expect(() => assertSameOrigin(request)).not.toThrow();
  });

  it.each(['::1', '::ffff:127.0.0.1'])('supports the exact loopback address %s', address => {
    expect(normalize(incoming({ address })).url).toBe(`${publicOrigin}/api/arena/models`);
  });

  it.each([
    { origin: 'https://attacker.example' },
    { origin: 'http://arena.startlux-decision.com' },
    { origin: '' },
  ])('does not weaken mutation Origin rejection: %j', options => {
    expect(() => assertSameOrigin(normalize(incoming(options)))).toThrow('same-origin');
  });

  it('preserves the cross-site Fetch Metadata rejection', () => {
    const request = incoming();
    request.headers['sec-fetch-site'] = 'cross-site';
    request.rawHeaders.push('Sec-Fetch-Site', 'cross-site');
    expect(() => assertSameOrigin(normalize(request))).toThrow('Cross-site');
  });

  it('normalizes OAuth callbacks without an Origin and preserves the exact callback query', () => {
    const path = '/api/auth/oauth2/callback/bamboonode?code=fixture-code&state=fixture-state';
    const request = normalize(incoming({ origin: '', path }));
    expect(request.url).toBe(`${publicOrigin}${path}`);
    expect(request.headers.has('origin')).toBe(false);
  });

  it.each([
    { address: '192.0.2.1' },
    { address: '127.0.0.2' },
    { host: 'attacker.example' },
    { host: 'arena.startlux-decision.com.attacker.example' },
    { host: 'arena.startlux-decision.com:5091' },
    { proto: '' },
    { proto: 'http' },
    { proto: 'https, http' },
  ])('rejects forwarding trust outside the configured tuple: %j', options => {
    const request = incoming(options);
    request.headers[DEV_PUBLIC_ORIGIN_HEADER] = publicOrigin;
    request.rawHeaders.push('X-Arena-Dev-Public-Origin', publicOrigin);
    request.rawHeaders.push(DEV_PUBLIC_ORIGIN_HEADER, publicOrigin);
    const result = normalize(request);
    expect(new URL(result.url).protocol).toBe('http:');
    expect(result.headers.has(DEV_PUBLIC_ORIGIN_HEADER)).toBe(false);
    expect(request.rawHeaders.some(header => header.toLowerCase() === DEV_PUBLIC_ORIGIN_HEADER)).toBe(false);
  });

  it('replaces duplicate client markers before Headers is lazily materialized', () => {
    const request = incoming();
    request.headers[DEV_PUBLIC_ORIGIN_HEADER] = 'https://attacker.example';
    request.rawHeaders.push('X-Arena-Dev-Public-Origin', 'https://attacker.example');
    request.rawHeaders.push(DEV_PUBLIC_ORIGIN_HEADER, 'https://other.example');
    stampDevPublicOrigin(request, publicOrigin);
    const adapted = new NodeRequest({ req: request });
    const materialized = new Headers(adapted.headers);
    expect(materialized.get(DEV_PUBLIC_ORIGIN_HEADER)).toBe(publicOrigin);
    expect(normalizeDevPublicRequest(adapted, { development: true, publicOrigin }).url)
      .toBe(`${publicOrigin}/api/arena/models`);
  });

  it('keeps direct localhost HTTP requests unchanged', () => {
    const original = incoming({ host: '127.0.0.1:5091', proto: '', origin: 'http://127.0.0.1:5091' });
    const request = normalize(original);
    expect(request.url).toBe('http://127.0.0.1:5091/api/arena/models');
    expect(() => assertSameOrigin(request)).not.toThrow();
  });

  it('does not opt in without configuration or in production', () => {
    const original = incoming();
    original.headers[DEV_PUBLIC_ORIGIN_HEADER] = publicOrigin;
    original.rawHeaders.push(DEV_PUBLIC_ORIGIN_HEADER, publicOrigin);
    stampDevPublicOrigin(original, null);
    expect(new NodeRequest({ req: original }).headers.has(DEV_PUBLIC_ORIGIN_HEADER)).toBe(false);
    const production = normalize(incoming(), false);
    expect(production.url).toBe('http://arena.startlux-decision.com/api/arena/models');
    expect(production.headers.has(DEV_PUBLIC_ORIGIN_HEADER)).toBe(false);
  });

  it('preserves a real IncomingMessage POST body and authentication headers without consuming it', async () => {
    const incomingRequest = incoming({ method: 'POST' });
    incomingRequest.headers.cookie = 'fixture-session=fixture-only';
    incomingRequest.headers['content-type'] = 'application/json';
    incomingRequest.rawHeaders.push('Cookie', 'fixture-session=fixture-only', 'Content-Type', 'application/json');
    const request = normalize(incomingRequest);
    expect(request.bodyUsed).toBe(false);
    expect(incomingRequest.readableDidRead).toBe(false);
    expect(request.headers.get('cookie')).toBe('fixture-session=fixture-only');
    incomingRequest.complete = true;
    incomingRequest.push(Buffer.from('{"title":"fixture"}'));
    incomingRequest.push(null);
    expect(await request.json()).toEqual({ title: 'fixture' });
  });

  it('retains cancellation of the original Request signal', () => {
    const controller = new AbortController();
    const original = new Request('http://arena.startlux-decision.com/', {
      headers: { [DEV_PUBLIC_ORIGIN_HEADER]: publicOrigin },
      signal: controller.signal,
    });
    const normalized = normalizeDevPublicRequest(original, { development: true, publicOrigin });
    controller.abort();
    expect(normalized.signal.aborted).toBe(true);
  });

  it.each([
    'http://arena.startlux-decision.com',
    'https://user:password@arena.startlux-decision.com',
    'https://arena.startlux-decision.com:5091',
    'https://arena.startlux-decision.com/path',
    'https://arena.startlux-decision.com?query=1',
    'https://arena.startlux-decision.com#hash',
    'https://127.0.0.1',
    'https://localhost',
    'https://host.local',
    'not-a-url',
  ])('fails closed for a non-public or non-origin config: %s', value => {
    expect(() => configuredPublicOrigin(value)).toThrow();
  });
});
