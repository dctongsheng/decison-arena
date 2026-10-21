import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';

import {
  localProductionOptions,
  prepareLocalProductionRequest,
  productionRequestHandler,
} from '../../scripts/serve-local-production';
import { DEV_PUBLIC_ORIGIN_HEADER } from '../../src/lib/dev-public-origin';

const publicOrigin = 'https://arena.startlux-decision.com';
const environment = {
  NODE_ENV: 'production', ARENA_LOCAL_PRODUCTION: 'true',
  ARENA_INTERNAL_SECRET: 'fixture-only-secret', ARENA_PUBLIC_ORIGIN: publicOrigin,
};
const options = localProductionOptions(environment);

function request(headers: Record<string, string>, address = '127.0.0.1', localPort = 5091) {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: address });
  Object.defineProperty(socket, 'localPort', { value: localPort });
  const message = new IncomingMessage(socket);
  message.url = '/api/arena/models';
  message.method = 'POST';
  message.headers = { ...headers };
  message.rawHeaders = Object.entries(headers).flat();
  return message;
}

describe('explicit local production startup options', () => {
  it.each([
    { NODE_ENV: 'development' }, { NODE_ENV: undefined },
    { ARENA_LOCAL_PRODUCTION: undefined }, { ARENA_LOCAL_PRODUCTION: 'false' },
  ])('cannot silently start outside the explicit production mode: %j', override => {
    expect(() => localProductionOptions({ ...environment, ...override })).toThrow('requires NODE_ENV=production');
  });
  it('uses fixed loopback listener ports and accepts an absolute frozen release entry', () => {
    const result = localProductionOptions({ ...environment, ARENA_LOCAL_BUILD_ENTRY: '/tmp/arena-release/web/server/index.mjs' });
    expect(result.webPort).toBe(5091);
    expect(result.socketPort).toBe(5094);
    expect(new URL('../nitro.json', result.entry).pathname).toBe('/tmp/arena-release/web/nitro.json');
    expect(result.publicOrigin).toBe(publicOrigin);
  });
  it.each([
    { ARENA_LOCAL_BUILD_ENTRY: './unfrozen/index.mjs' },
    { ARENA_INTERNAL_SECRET: '' },
    { VITE_ARCADE_SOCKET_PORT: '8080' },
    { ARENA_RUNNER_URL: 'https://attacker.example' },
    { ARENA_RUNNER_URL: 'http://user:password@127.0.0.1:5092' },
    { ARENA_RUNNER_URL: 'http://127.0.0.1:5092/unexpected-path' },
    { ARENA_RUNNER_URL: 'http://127.0.0.1:5092?query=value' },
  ])('rejects invalid runtime configuration: %j', override => {
    expect(() => localProductionOptions({ ...environment, ...override })).toThrow();
  });
});

describe('production HTTP and WebSocket trust edge', () => {
  it('preserves Cookie/Origin while removing every externally supplied internal header', () => {
    const message = request({
      host: 'arena.startlux-decision.com', 'x-forwarded-proto': 'https', origin: publicOrigin,
      cookie: 'fixture-session=fixture', 'x-arena-owner': 'forged-owner',
      'x-arena-internal': 'forged-secret', 'x-arena-admin': '1',
      [DEV_PUBLIC_ORIGIN_HEADER]: 'https://attacker.example',
    });
    message.rawHeaders.push('X-Arena-Owner', 'other-forged-owner', 'X-Arena-Dev-Public-Origin', 'https://attacker.example');
    expect(prepareLocalProductionRequest(message, options)).toBe(true);
    expect(message.headers.cookie).toBe('fixture-session=fixture');
    expect(message.headers.origin).toBe(publicOrigin);
    expect(Object.entries(message.headers).filter(([key]) => key.startsWith('x-arena-')))
      .toEqual([[DEV_PUBLIC_ORIGIN_HEADER, publicOrigin]]);
    expect(message.rawHeaders.filter((key, index) => index % 2 === 0 && key.toLowerCase().startsWith('x-arena-')))
      .toEqual([DEV_PUBLIC_ORIGIN_HEADER]);
  });
  it.each(['localhost:5091', '127.0.0.1:5091'])('allows local %s without trusting forwarded origin', host => {
    const message = request({ host, 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'https', [DEV_PUBLIC_ORIGIN_HEADER]: publicOrigin });
    expect(prepareLocalProductionRequest(message, options)).toBe(true);
    expect(message.headers[DEV_PUBLIC_ORIGIN_HEADER]).toBeUndefined();
  });
  it.each(['localhost:5094', '127.0.0.1:5094'])('allows %s only on the dedicated WebSocket listener', host => {
    const headers = { host, origin: 'http://127.0.0.1:5091', [DEV_PUBLIC_ORIGIN_HEADER]: publicOrigin };
    const socketRequest = request(headers, '127.0.0.1', 5094);
    expect(prepareLocalProductionRequest(socketRequest, options, 'websocket')).toBe(true);
    expect(socketRequest.headers[DEV_PUBLIC_ORIGIN_HEADER]).toBeUndefined();
    expect(socketRequest.headers.origin).toBe('http://127.0.0.1:5091');
    expect(prepareLocalProductionRequest(request(headers, '127.0.0.1', 5094), options)).toBe(false);
    expect(prepareLocalProductionRequest(request(headers, '127.0.0.1', 5091), options, 'websocket')).toBe(false);
  });
  it.each([
    { host: 'attacker.example', 'x-forwarded-proto': 'https' },
    { host: 'arena.startlux-decision.com.attacker.example', 'x-forwarded-proto': 'https' },
    { host: 'arena.startlux-decision.com:5091', 'x-forwarded-proto': 'https' },
    { host: 'arena.startlux-decision.com', 'x-forwarded-proto': 'http' },
    { host: 'arena.startlux-decision.com', 'x-forwarded-proto': 'https, http' },
    { host: 'arena.startlux-decision.com', 'x-forwarded-proto': '' },
    { host: '127.0.0.1:5094', 'x-forwarded-proto': '' },
  ])('rejects unknown hosts or an unverified tunnel request: %j', headers => {
    expect(prepareLocalProductionRequest(request(headers), options)).toBe(false);
  });
  it('does not permit a duplicate Host or a non-loopback forwarding source', () => {
    const duplicate = request({ host: '127.0.0.1:5091' });
    duplicate.rawHeaders.push('Host', 'attacker.example');
    expect(prepareLocalProductionRequest(duplicate, options)).toBe(false);
    const foreign = request({ host: 'arena.startlux-decision.com', 'x-forwarded-proto': 'https' }, '192.0.2.1');
    expect(prepareLocalProductionRequest(foreign, options)).toBe(false);
  });
  it('does not change a cross-site Origin into a same-origin request', () => {
    const message = request({ host: 'arena.startlux-decision.com', 'x-forwarded-proto': 'https', origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' });
    expect(prepareLocalProductionRequest(message, options)).toBe(true);
    expect(message.headers.origin).toBe('https://attacker.example');
    expect(message.headers['sec-fetch-site']).toBe('cross-site');
  });
  it('does not invoke production middleware for an unknown host', () => {
    const middleware = vi.fn();
    const response = { writeHead: vi.fn(), end: vi.fn() };
    productionRequestHandler(middleware, options)(request({ host: 'attacker.example' }), response as never);
    expect(middleware).not.toHaveBeenCalled();
    expect(response.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
  });
  it('sanitizes synchronous/asynchronous middleware failures', async () => {
    const middleware = vi.fn(async () => { throw new Error('private upstream body fixture'); });
    const response = { headersSent: false, writeHead: vi.fn(), end: vi.fn() };
    productionRequestHandler(middleware, options)(request({ host: '127.0.0.1:5091' }), response as never);
    await vi.waitFor(() => expect(response.end).toHaveBeenCalledWith('The request could not be completed.'));
    expect(response.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
  });
});
