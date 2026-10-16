import { createFileRoute } from '@tanstack/react-router';
import { ZodError } from 'zod';

import {
  ArenaError,
  assertSameOrigin,
  discardRejectedBody,
  matchQuery,
  readJson,
  runnerFetch,
} from '@/core/arena/runtime';
import { idSchema } from '@/core/arena/validation';
import { getAuth } from '@/core/auth';
import * as arena from '@/modules/arena/service';
import { respData, respErr } from '@/lib/resp';

async function handler({ request }: { request: Request }) {
  try {
    const url = new URL(request.url);
    const parts = url.pathname
      .replace(/^\/api\/arena\/?/, '')
      .split('/')
      .filter(Boolean);
    const [resource, rawId, subresource] = parts;
    const auth = getAuth();
    const session = await auth.api.getSession({ headers: request.headers });
    const ownerId = session?.user?.id as string | undefined;
    const publicRead = request.method === 'GET' && resource === 'community';
    if (!ownerId && !publicRead)
      throw new ArenaError('Sign in to continue.', 401);
    if (!['GET', 'HEAD'].includes(request.method)) assertSameOrigin(request);
    const admin =
      ownerId && resource === 'community'
        ? await arena.canModerate(ownerId)
        : false;
    const method = request.method;
    const id = rawId ? idSchema.parse(rawId) : undefined;
    let result: unknown;

    if (resource === 'credentials' && !id) {
      if (method === 'GET') result = await arena.listCredentials(ownerId!);
      else if (method === 'POST')
        result = await arena.saveCredential(ownerId!, await readJson(request));
      else if (method === 'DELETE')
        result = await arena.deleteCredential(
          ownerId!,
          idSchema.parse(url.searchParams.get('id'))
        );
      else throw new ArenaError('Method not allowed.', 405);
    } else if (resource === 'models' && !id) {
      if (method === 'GET') result = await arena.listProfiles(ownerId!);
      else if (method === 'POST')
        result = await arena.saveProfile(ownerId!, await readJson(request));
      else if (method === 'DELETE')
        result = await arena.deleteProfile(
          ownerId!,
          idSchema.parse(url.searchParams.get('id'))
        );
      else throw new ArenaError('Method not allowed.', 405);
    } else if (resource === 'models' && id === 'test' && method === 'POST') {
      result = await arena.testProfile(ownerId!, await readJson(request));
    } else if (resource === 'matches' && !id) {
      if (method === 'GET') result = await arena.listMatches(ownerId!);
      else if (method === 'POST')
        result = await arena.createMatch(ownerId!, await readJson(request));
      else throw new ArenaError('Method not allowed.', 405);
    } else if (resource === 'matches' && id) {
      const query = matchQuery(url.searchParams);
      if (subresource === 'socket' && method === 'GET') {
        assertSameOrigin(request);
        if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
          throw new ArenaError('WebSocket upgrade required.', 426);
        return await runnerFetch(ownerId!, `/matches/${id}/socket${query}`, {
          headers: { Upgrade: 'websocket' },
        });
      }
      if (!subresource && method === 'GET')
        result = await arena.getMatch(ownerId!, id, query);
      else if (subresource === 'commands' && method === 'POST')
        result = await arena.commandMatch(
          ownerId!,
          id,
          await readJson(request),
          query
        );
      else if (subresource === 'replay' && method === 'GET')
        result = await arena.getReplay(ownerId!, id);
      else throw new ArenaError('Not found.', 404);
    } else if (resource === 'arcade-sessions' && !id) {
      if (method === 'GET') result = await arena.listArcadeSessions(ownerId!);
      else if (method === 'POST') result = await arena.createArcadeSession(ownerId!, await readJson(request));
      else throw new ArenaError('Method not allowed.', 405);
    } else if (resource === 'arcade-sessions' && id) {
      const query = matchQuery(url.searchParams);
      if (subresource === 'socket' && method === 'GET') {
        assertSameOrigin(request);
        if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
          throw new ArenaError('WebSocket upgrade required.', 426);
        return await runnerFetch(ownerId!, `/arcade-sessions/${id}/socket${query}`, { headers: { Upgrade: 'websocket' } });
      }
      if (!subresource && method === 'GET') result = await arena.getArcadeSession(ownerId!, id, query);
      else if (subresource === 'commands' && method === 'POST') result = await arena.commandArcadeSession(ownerId!, id, await readJson(request));
      else if (subresource === 'replay' && method === 'GET') result = await arena.getArcadeReplay(ownerId!, id);
      else throw new ArenaError('Not found.', 404);
    } else if (resource === 'community' && !id) {
      if (method === 'GET')
        result = await arena.listCommunity(
          ownerId,
          url.searchParams.get('gameId') || undefined,
          url.searchParams.get('model') || undefined
        );
      else if (method === 'POST')
        result = await arena.publishReplay(ownerId!, await readJson(request));
      else throw new ArenaError('Method not allowed.', 405);
    } else if (
      resource === 'community' &&
      id === 'reports' &&
      method === 'GET'
    ) {
      result = await arena.listReports(admin);
    } else if (resource === 'community' && id) {
      if (method === 'GET')
        result = await arena.communityDetail(id, ownerId, admin);
      else if (method === 'POST')
        result = await arena.communityAction(
          ownerId!,
          id,
          await readJson(request),
          admin
        );
      else throw new ArenaError('Method not allowed.', 405);
    } else throw new ArenaError('Not found.', 404);
    return respData(result, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    await discardRejectedBody(request);
    if (error instanceof ZodError)
      return respErr(
        'Invalid request: ' +
          error.issues
            .map(
              (issue) => `${issue.path.join('.') || 'input'} ${issue.message}`
            )
            .join('; ')
            .slice(0, 400),
        { status: 400 }
      );
    if (error instanceof ArenaError)
      return respErr(error.message, { status: error.status });
    // Do not log unknown errors: database drivers can include SQL values (keys).
    return respErr(
      'Unable to complete this request. Please retry or check the service configuration.',
      { status: 500 }
    );
  }
}

export const Route = createFileRoute('/api/arena/$')({
  server: { handlers: { GET: handler, POST: handler, DELETE: handler } },
});
