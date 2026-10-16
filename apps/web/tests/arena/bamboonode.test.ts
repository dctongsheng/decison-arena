import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { describe, expect, it, vi } from 'vitest';

import {
  authMode,
  bambooAuthOptions,
  bambooProvider,
  bambooSettings,
  publicBambooAuth,
} from '@/core/auth/bamboonode';

const environment = {
  auth_mode: 'bamboonode',
  bamboonode_issuer: 'https://api.bamboonode.dev',
  bamboonode_authorization_url: 'https://bamboonode.dev/oauth/authorize',
  bamboonode_token_url: 'https://api.bamboonode.dev/oauth/token',
  bamboonode_userinfo_url: 'https://api.bamboonode.dev/oauth/userinfo',
  bamboonode_client_id: 'fixture-arena-client',
  bamboonode_client_secret: 'fixture-only-oauth-client-secret',
  bamboonode_account_url: 'https://bamboonode.dev',
};
const origin = 'https://arena.example';
const identity = {
  sub: 'bamboo-user-1',
  email: 'player@example.invalid',
  name: 'Bamboo player',
  role: 'root',
};
const verifier = 'a'.repeat(64);

function fixture(users: Record<string, unknown>[] = []) {
  const database: Record<string, any[]> = {
    user: [...users],
    session: [],
    account: [],
    verification: [],
  };
  let currentIdentity: Record<string, unknown> = { ...identity };
  const fetcher = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === environment.bamboonode_token_url) {
        const body = new URLSearchParams(init?.body as string);
        expect(body.get('code_verifier')).toMatch(/^[\w~-]{43,128}$/);
        expect(body.get('redirect_uri')).toBe(
          `${origin}/api/auth/oauth2/callback/bamboonode`
        );
        return Response.json({
          access_token: 'fixture-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'unused-fixture-refresh',
          id_token: 'unverified.fixture.jwt',
        });
      }
      expect(String(url)).toBe(environment.bamboonode_userinfo_url);
      expect(new Headers(init?.headers).get('Authorization')).toBe(
        'Bearer fixture-access-token'
      );
      return Response.json(currentIdentity);
    }
  );
  const options = bambooAuthOptions(environment, fetcher as typeof fetch);
  const auth = betterAuth({
    baseURL: origin,
    secret: 'fixture-auth-signing-secret-at-least-thirty-two-characters',
    database: memoryAdapter(database),
    emailAndPassword: { enabled: false },
    logger: { disabled: true },
    ...options,
  });
  async function start(extra: Record<string, unknown> = {}) {
    const response = await auth.handler(
      new Request(`${origin}/api/auth/sign-in/oauth2`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: 'bamboonode',
          callbackURL: `${origin}/history`,
          errorCallbackURL: `${origin}/sign-in?oauth_error=1`,
          ...extra,
        }),
      })
    );
    const payload = await response.json();
    return {
      response,
      payload,
      cookie: response.headers
        .getSetCookie()
        .map((value) => value.split(';', 1)[0])
        .join('; '),
    };
  }
  async function callback(
    flow: Awaited<ReturnType<typeof start>>,
    overrides: Record<string, string> = {},
    cookie = flow.cookie
  ) {
    const state = new URL(flow.payload.url).searchParams.get('state')!;
    const query = new URLSearchParams({
      code: 'fixture-code',
      state,
      ...overrides,
    });
    return auth.handler(
      new Request(`${origin}/api/auth/oauth2/callback/bamboonode?${query}`, {
        headers: { Cookie: cookie },
      })
    );
  }
  return {
    auth,
    database,
    fetcher,
    start,
    callback,
    setIdentity: (value: Record<string, unknown>) => {
      currentIdentity = value;
    },
  };
}

describe('BambooNode configuration and provider transport', () => {
  it('keeps local auth as the default and exposes no credentials', () => {
    expect(authMode({})).toBe('local');
    expect(() => authMode({ auth_mode: 'typo' })).toThrow('Invalid AUTH_MODE');
    const publicConfig = publicBambooAuth(environment);
    expect(publicConfig.bamboonode_auth_ready).toBe(true);
    expect(publicConfig.bamboonode_account_url).toBe('https://bamboonode.dev/');
    expect(publicConfig.email_auth_enabled).toBe('false');
    expect(JSON.stringify(publicConfig)).not.toContain(
      environment.bamboonode_client_secret
    );
    expect(JSON.stringify(publicConfig)).not.toContain(
      environment.bamboonode_client_id
    );
    expect(
      publicBambooAuth({ ...environment, auth_mode: 'local' })
    ).not.toHaveProperty('email_auth_enabled');
  });

  it.each([
    ['bamboonode_issuer', 'https://evil.example'],
    [
      'bamboonode_authorization_url',
      'https://api.bamboonode.dev/oauth/authorize',
    ],
    [
      'bamboonode_authorization_url',
      'https://bamboonode.dev.evil.example/oauth/authorize',
    ],
    ['bamboonode_token_url', 'http://api.bamboonode.dev/oauth/token'],
    [
      'bamboonode_token_url',
      'https://user:password@api.bamboonode.dev/oauth/token',
    ],
    ['bamboonode_userinfo_url', 'https://bamboonode.dev/oauth/userinfo'],
    [
      'bamboonode_userinfo_url',
      'https://api.bamboonode.dev/oauth/userinfo?token=unexpected',
    ],
    ['bamboonode_client_secret', ''],
    ['bamboonode_scopes', 'openid profile email quota model_gateway'],
  ])('fails closed for invalid %s', (key, value) => {
    expect(bambooSettings({ ...environment, [key]: value })).toBeNull();
    expect(
      publicBambooAuth({ ...environment, [key]: value }).bamboonode_auth_ready
    ).toBe(false);
  });

  it('supports confidential Basic auth and discards unneeded refresh/ID tokens', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        access_token: 'fixture-access',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'discard-this',
        id_token: 'discard-this',
      })
    );
    const provider = bambooProvider(
      bambooSettings({
        ...environment,
        bamboonode_token_auth_method: 'basic',
      })!,
      fetcher
    );
    const token = await provider.getToken!({
      code: 'fixture-code',
      redirectURI: `${origin}/api/auth/oauth2/callback/bamboonode`,
      codeVerifier: verifier,
    });
    expect(token).not.toHaveProperty('refreshToken');
    expect(token).not.toHaveProperty('idToken');
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get('Authorization')).toMatch(/^Basic /);
    expect(String(init.body)).not.toContain('client_secret');
    expect(init.redirect).toBe('error');
    expect(token.scopes).toEqual(['openid', 'profile', 'email']);
  });

  it('uses only authenticated userinfo claims and ignores external roles and id_token', async () => {
    const fetcher = vi.fn(async () => Response.json(identity));
    const provider = bambooProvider(bambooSettings(environment)!, fetcher);
    const user = await provider.getUserInfo!({
      accessToken: 'fixture-access',
      idToken: 'not.a.trusted.identity',
    });
    expect(user).toEqual({
      id: identity.sub,
      email: identity.email,
      emailVerified: false,
      name: identity.name,
    });
    expect(user).not.toHaveProperty('role');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects missing email and does not trust a string email_verified claim', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ ...identity, email: undefined })
    );
    await expect(
      bambooProvider(bambooSettings(environment)!, fetcher).getUserInfo!({
        accessToken: 'fixture-access',
      })
    ).rejects.toThrow('Invalid BambooNode user identity');
    fetcher.mockImplementation(async () =>
      Response.json({ ...identity, email_verified: 'true' })
    );
    await expect(
      bambooProvider(bambooSettings(environment)!, fetcher).getUserInfo!({
        accessToken: 'fixture-access',
      })
    ).rejects.toThrow('Invalid BambooNode user identity');
  });

  it.each([
    () => new Response('private provider error', { status: 500 }),
    () =>
      new Response(null, {
        status: 302,
        headers: { Location: 'https://evil.example' },
      }),
    () => Response.json({ sub: 'x'.repeat(20_000) }),
  ])('fails closed without reflecting provider errors', async (response) => {
    const provider = bambooProvider(
      bambooSettings(environment)!,
      vi.fn(async () => response())
    );
    await expect(
      provider.getUserInfo!({ accessToken: 'fixture-access' })
    ).rejects.toThrow(
      'BambooNode authentication service returned an invalid response'
    );
  });
});

describe('BambooNode authorization-code flow using Better Auth 1.6.2', () => {
  it('uses state + S256 and creates a separate local ID with encrypted OAuth tokens', async () => {
    const f = fixture();
    const flow = await f.start();
    expect(flow.response.status).toBe(200);
    const authorize = new URL(flow.payload.url);
    expect(authorize.origin).toBe('https://bamboonode.dev');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('state')).toBeTruthy();
    expect(authorize.searchParams.get('scope')?.split(' ').sort()).toEqual([
      'email',
      'openid',
      'profile',
    ]);
    const response = await f.callback(flow);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(`${origin}/history`);
    expect(f.database.user).toHaveLength(1);
    expect(f.database.user[0].id).not.toBe(identity.sub);
    expect(f.database.user[0].emailVerified).toBe(false);
    expect(f.database.user[0]).not.toHaveProperty('role');
    expect(f.database.account[0].accountId).toBe(identity.sub);
    expect(f.database.account[0].providerId).toBe('bamboonode');
    expect(f.database.account[0].accessToken).toBeTruthy();
    expect(f.database.account[0].accessToken).not.toBe('fixture-access-token');
    expect(f.database.account[0].password).toBeFalsy();
    expect(f.database.account[0].refreshToken).toBeFalsy();
    expect(f.database.account[0].idToken).toBeFalsy();
    expect(f.database.session).toHaveLength(1);
  });

  it('rejects altered state or a callback without its browser cookie before token exchange', async () => {
    const f = fixture();
    const flow = await f.start();
    const response = await f.callback(flow, { state: 'forged-state' });
    expect(response.headers.get('Location')).toContain('error=');
    expect(f.fetcher).not.toHaveBeenCalled();
    const next = await f.start();
    const absent = await f.callback(next, {}, '');
    expect(absent.headers.get('Location')).toContain('error=');
    expect(f.database.session).toHaveLength(0);
  });

  it('does not replay an already-consumed authorization callback', async () => {
    const f = fixture();
    const flow = await f.start();
    await f.callback(flow);
    const count = f.fetcher.mock.calls.length;
    const replay = await f.callback(flow);
    expect(replay.headers.get('Location')).toContain('error=');
    expect(f.fetcher.mock.calls.length).toBe(count);
    expect(f.database.session).toHaveLength(1);
  });

  it('rejects a different subject with the same email, even if it claims verified email', async () => {
    const f = fixture();
    await f.callback(await f.start());
    const original = { ...f.database.user[0] };
    f.setIdentity({
      ...identity,
      sub: 'other-bamboo-subject',
      email_verified: true,
    });
    const response = await f.callback(await f.start());
    expect(response.headers.get('Location')).toContain('account_not_linked');
    expect(f.database.user).toEqual([original]);
    expect(f.database.account).toHaveLength(1);
    expect(f.database.session).toHaveLength(1);
  });

  it('does not migrate an existing local account with the same email', async () => {
    const localUser = {
      id: 'existing-arena-owner',
      email: identity.email,
      name: 'Existing owner',
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const f = fixture([localUser]);
    const response = await f.callback(await f.start());
    expect(response.headers.get('Location')).toContain('account_not_linked');
    expect(f.database.user[0].id).toBe('existing-arena-owner');
    expect(f.database.account).toHaveLength(0);
    expect(f.database.session).toHaveLength(0);
  });

  it('denies new local credentials, linking and extra scopes at the server', async () => {
    const f = fixture();
    for (const path of [
      '/sign-up/email',
      '/sign-in/email',
      '/sign-in/social',
      '/oauth2/link',
      '/set-password',
      '/request-password-reset',
      '/get-access-token',
    ]) {
      const response = await f.auth.handler(
        new Request(`${origin}/api/auth${path}`, {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: identity.email,
            password: 'fixture-password',
            name: 'fixture',
          }),
        })
      );
      expect(response.status, path).toBe(404);
    }
    expect((await f.start({ scopes: ['quota'] })).response.status).toBe(400);
    expect((await f.start({ providerId: 'github' })).response.status).toBe(400);
    expect(f.database.user).toHaveLength(0);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
