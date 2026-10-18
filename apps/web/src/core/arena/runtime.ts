/** Server-only bindings. The main entry sets __CF_ENV__ on Workers. */
export interface ArenaBindings {
  MATCH_SERVICE?: { fetch(request: Request): Promise<Response> };
  REPLAYS?: {
    put(key: string, value: string, options?: unknown): Promise<unknown>;
    get(key: string): Promise<{ text(): Promise<string> } | null>;
  };
  ARENA_ENCRYPTION_KEY?: string;
}

export class ArenaError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

export function arenaBindings(): ArenaBindings {
  const globals = globalThis as typeof globalThis & {
    __CF_ENV__?: ArenaBindings;
    __env__?: ArenaBindings;
  };
  return globals.__CF_ENV__ ?? globals.__env__ ?? {};
}

export function vaultMasterKey(): string {
  const key =
    arenaBindings().ARENA_ENCRYPTION_KEY || process.env.ARENA_ENCRYPTION_KEY;
  if (!key || key.length < 32)
    throw new ArenaError(
      'Credential vault is not configured. Set ARENA_ENCRYPTION_KEY.',
      503
    );
  return key;
}

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(request.url).origin) {
    throw new ArenaError('A same-origin request is required.', 403);
  }
  if (request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new ArenaError('Cross-site requests are not allowed.', 403);
  }
}

export function matchQuery(params: URLSearchParams, options: { allowFull?: boolean } = {}): string {
  const allowed = new URLSearchParams();
  const seat = params.get('seat');
  if (seat !== null) {
    if (!['0', '1', 'spectator', ...(options.allowFull ? ['full'] : [])].includes(seat))
      throw new ArenaError('Invalid viewing seat.');
    allowed.set('seat', seat);
  }
  const since = params.get('since');
  if (since !== null) {
    if (!/^\d+$/.test(since) || !Number.isSafeInteger(Number(since)))
      throw new ArenaError('Invalid event cursor.');
    allowed.set('since', String(Number(since)));
  }
  return allowed.size ? `?${allowed}` : '';
}

export async function runnerFetch(
  ownerId: string,
  path: string,
  init?: RequestInit,
  admin = false
): Promise<Response> {
  if (
    !/^\/(?:matches|arcade-sessions)(?:\/|$|\?)/.test(path) &&
    !['/provider-test', '/validate-endpoint'].includes(path)
  )
    throw new ArenaError('Invalid runner path.');
  const headers = new Headers(init?.headers);
  headers.set('X-Arena-Owner', ownerId);
  headers.delete('X-Arena-Admin');
  if (admin) headers.set('X-Arena-Admin', '1');
  if (init?.body) headers.set('Content-Type', 'application/json');
  const binding = arenaBindings().MATCH_SERVICE;
  if (binding)
    return binding.fetch(
      new Request(`https://match.internal${path}`, { ...init, headers })
    );
  if (process.env.NODE_ENV === 'production')
    throw new ArenaError('Match service is not configured.', 503);
  const address = new URL(
    process.env.ARENA_RUNNER_URL || 'http://127.0.0.1:5092'
  );
  if (
    address.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname)
  ) {
    throw new ArenaError(
      'The development runner must use a loopback URL.',
      503
    );
  }
  const internalSecret = process.env.ARENA_INTERNAL_SECRET;
  if (!internalSecret)
    throw new ArenaError('Development runner secret is not configured.', 503);
  headers.set('X-Arena-Internal', internalSecret);
  return fetch(new URL(path, address), { ...init, headers });
}

export async function runnerJson<T>(
  ownerId: string,
  path: string,
  init?: RequestInit,
  admin = false
): Promise<T> {
  let response: Response;
  try {
    response = await runnerFetch(ownerId, path, init, admin);
  } catch (error) {
    if (error instanceof ArenaError) throw error;
    throw new ArenaError('Match service is unavailable.', 503);
  }
  const body = (await response.json().catch(() => null)) as {
    error?: string;
    message?: string;
  } | null;
  if (!response.ok) {
    const message = body?.error || body?.message || 'The match request failed.';
    throw new ArenaError(message.slice(0, 240), response.status);
  }
  return body as T;
}

const MAX_JSON_BYTES = 32_768;

/** Finish small rejected uploads so a local Worker proxy can safely reuse its connection. */
export async function discardRejectedBody(request: Request): Promise<void> {
  if (!request.body || request.bodyUsed || request.body.locked) return;
  const reader = request.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  if (Number(request.headers.get('content-length')) > MAX_JSON_BYTES) {
    cancel();
    reader.releaseLock();
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        let size = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) return;
          size += value.byteLength;
          if (size > MAX_JSON_BYTES) {
            cancel();
            return;
          }
        }
      })().catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          cancel();
          resolve();
        }, 250);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

export async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json'))
    throw new ArenaError('Expected application/json.', 415);
  if (Number(request.headers.get('content-length')) > MAX_JSON_BYTES)
    throw new ArenaError('Request is too large.', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new ArenaError('JSON body is required.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_JSON_BYTES) {
      await reader.cancel();
      throw new ArenaError('Request is too large.', 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new ArenaError('Invalid JSON.');
  }
}
