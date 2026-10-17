import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { describe, expect, it, vi } from 'vitest';

import {
  authMode,
  BAMBOO_REQUIRED_SCOPES,
  bambooAuthOptions,
  bambooProvider,
  bambooSettings,
  decryptBambooToken,
  encryptBambooToken,
  getBambooIdentity,
  hasBambooGatewayScopes,
  publicBambooAuth,
  refreshBambooTokens,
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
const fixtureTokens = {
  access_token: 'fixture-access-token',
  token_type: 'Bearer',
  expires_in: 3600,
  refresh_token: 'fixture-rotating-refresh',
  scope: BAMBOO_REQUIRED_SCOPES.join(' '),
  id_token: 'unverified.fixture.jwt',
};

function fixture(users: Record<string, unknown>[] = []) {
  const database: Record<string, any[]> = {
    user: [...users],
    session: [],
    account: [],
    verification: [],
  };
  let currentIdentity: Record<string, unknown> = { ...identity };
  let currentTokens: Record<string, unknown> = { ...fixtureTokens };
  const fetcher = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === environment.bamboonode_token_url) {
        const body = new URLSearchParams(init?.body as string);
        expect(body.get('code_verifier')).toMatch(/^[\w~-]{43,128}$/);
        expect(body.get('redirect_uri')).toBe(
          `${origin}/api/auth/oauth2/callback/bamboonode`
        );
        return Response.json(currentTokens);
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
    setTokens: (value: Record<string, unknown>) => {
      currentTokens = value;
    },
  };
}

describe('BambooNode configuration and provider transport', () => {
  it('requires an operator scope upgrade for legacy identity-only configuration', () => {
    expect(bambooSettings(environment)!.scopes).toEqual(BAMBOO_REQUIRED_SCOPES);
    const legacy = publicBambooAuth({
      ...environment,
      bamboonode_scopes: 'openid profile email',
    });
    expect(legacy.bamboonode_auth_ready).toBe(false);
    expect(legacy.bamboonode_scope_upgrade_required).toBe(true);
    expect(
      publicBambooAuth(environment).bamboonode_scope_upgrade_required
    ).toBe(false);
    expect(
      hasBambooGatewayScopes('openid,profile,email,quota,model_gateway')
    ).toBe(true);
    expect(hasBambooGatewayScopes(null)).toBe(false);
  });

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
    ['bamboonode_scopes', 'openid profile email'],
    ['bamboonode_scopes', 'openid profile email quota model_gateway admin'],
    ['bamboonode_token_url', 'https://api.bamboonode.cn/oauth/token'],
    ['bamboonode_authorization_url', 'https://bamboonode.cn/oauth/authorize'],
  ])('fails closed for invalid %s', (key, value) => {
    expect(bambooSettings({ ...environment, [key]: value })).toBeNull();
    expect(
      publicBambooAuth({ ...environment, [key]: value }).bamboonode_auth_ready
    ).toBe(false);
  });

  it('supports confidential Basic auth, preserves refresh and expiry, and discards ID tokens', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        access_token: 'fixture-access',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'fixture-refresh',
        refresh_token_expires_in: 7200,
        scope: 'openid profile email',
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
    expect(token.refreshToken).toBe('fixture-refresh');
    expect(token.accessTokenExpiresAt).toBeInstanceOf(Date);
    expect(token.refreshTokenExpiresAt!.getTime()).toBeGreaterThan(
      token.accessTokenExpiresAt!.getTime()
    );
    expect(token).not.toHaveProperty('idToken');
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get('Authorization')).toMatch(/^Basic /);
    expect(String(init.body)).not.toContain('client_secret');
    expect(init.redirect).toBe('error');
    expect(token.scopes).toEqual(['openid', 'profile', 'email']);
    expect(hasBambooGatewayScopes(token.scopes)).toBe(false);
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

  it.each([undefined, '', 'openid profile email'])(
    'stores actual approved scope without inventing missing gateway privileges: %s',
    async (scope) => {
      const provider = bambooProvider(
        bambooSettings(environment)!,
        vi.fn(async () => Response.json({ ...fixtureTokens, scope }))
      );
      const tokens = await provider.getToken!({
        code: 'fixture-code',
        redirectURI: `${origin}/api/auth/oauth2/callback/bamboonode`,
        codeVerifier: verifier,
      });
      expect(tokens.scopes).toEqual(scope ? scope.split(' ') : []);
      expect(hasBambooGatewayScopes(tokens.scopes)).toBe(false);
    }
  );

  it.each([
    { refresh_token: undefined },
    { refresh_token: '' },
    { access_token: 'newline\ntoken' },
    { token_type: 'MAC' },
    { expires_in: undefined },
    { expires_in: 0 },
    { expires_in: 1.2 },
    { refresh_token_expires_in: -1 },
    { scope: ['openid'] },
    { scope: 'openid,profile,email,quota,model_gateway' },
    { scope: 'openid admin' },
  ])(
    'rejects malformed token response without exposing it',
    async (overrides) => {
      const provider = bambooProvider(
        bambooSettings(environment)!,
        vi.fn(async () => Response.json({ ...fixtureTokens, ...overrides }))
      );
      await expect(
        provider.getToken!({
          code: 'fixture-code',
          redirectURI: `${origin}/api/auth/oauth2/callback/bamboonode`,
          codeVerifier: verifier,
        })
      ).rejects.toThrow(/^Invalid BambooNode token/);
    }
  );

  it('keeps manual PKCE checks before any token network request', async () => {
    const fetcher = vi.fn();
    const provider = bambooProvider(bambooSettings(environment)!, fetcher);
    for (const codeVerifier of [undefined, 'too-short', 'a'.repeat(129)]) {
      await expect(
        provider.getToken!({
          code: 'fixture-code',
          redirectURI: `${origin}/api/auth/oauth2/callback/bamboonode`,
          codeVerifier,
        })
      ).rejects.toThrow('Invalid BambooNode authorization callback');
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refreshes exactly once with the rotated token and actual approved scopes', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        ...fixtureTokens,
        refresh_token: 'fixture-next-refresh',
        scope: 'openid profile email',
      })
    );
    const tokens = await refreshBambooTokens(
      bambooSettings(environment)!,
      'fixture-previous-refresh',
      fetcher
    );
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(environment.bamboonode_token_url);
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('fixture-previous-refresh');
    expect(body.get('client_id')).toBe(environment.bamboonode_client_id);
    expect(body.has('code')).toBe(false);
    expect(body.has('scope')).toBe(false);
    expect(init.redirect).toBe('error');
    expect(tokens.refreshToken).toBe('fixture-next-refresh');
    expect(tokens.refreshTokenExpiresAt).toBeUndefined();
    expect(hasBambooGatewayScopes(tokens.scopes)).toBe(false);
  });

  it('does not retry unknown refresh outcomes or expose provider errors', async () => {
    for (const response of [
      async () => {
        throw new Error('fixture-private-provider-data');
      },
      async () =>
        Response.json(
          {
            error: 'invalid_grant',
            error_description: 'fixture-private-provider-data',
          },
          { status: 400 }
        ),
      async () =>
        Response.json({ access_token: 'fixture-private-provider-data' }),
    ]) {
      const fetcher = vi.fn(response);
      const error = await refreshBambooTokens(
        bambooSettings(environment)!,
        'fixture-refresh',
        fetcher
      ).catch((error: Error) => error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(
        'fixture-private-provider-data'
      );
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it('never sends refresh credentials or userinfo Bearer tokens to an overridden issuer origin', async () => {
    const fetcher = vi.fn();
    const settings = bambooSettings(environment)!;
    await expect(
      refreshBambooTokens(
        { ...settings, tokenUrl: 'https://api.bamboonode.cn/oauth/token' },
        'fixture-refresh',
        fetcher
      )
    ).rejects.toThrow('Invalid BambooNode endpoint');
    await expect(
      getBambooIdentity(
        { ...settings, userInfoUrl: 'https://evil.example/oauth/userinfo' },
        'fixture-access',
        fetcher
      )
    ).rejects.toThrow('Invalid BambooNode endpoint');
    expect(fetcher).not.toHaveBeenCalled();
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
    expect(authorize.searchParams.get('prompt')).toBe('consent');
    expect(authorize.searchParams.get('scope')?.split(' ').sort()).toEqual([
      'email',
      'model_gateway',
      'openid',
      'profile',
      'quota',
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
    expect(f.database.account[0].refreshToken).toBeTruthy();
    expect(f.database.account[0].refreshToken).not.toBe(
      fixtureTokens.refresh_token
    );
    const { secretConfig } = await f.auth.$context;
    expect(
      await decryptBambooToken(f.database.account[0].accessToken, secretConfig)
    ).toBe(fixtureTokens.access_token);
    expect(
      await decryptBambooToken(f.database.account[0].refreshToken, secretConfig)
    ).toBe(fixtureTokens.refresh_token);
    expect(hasBambooGatewayScopes(f.database.account[0].scope)).toBe(true);
    expect(f.database.account[0].accessTokenExpiresAt).toBeInstanceOf(Date);
    expect(f.database.account[0].refreshTokenExpiresAt).toBeFalsy();
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

  it('updates an existing owner only after a new explicit flow and preserves actual reduced scope', async () => {
    const f = fixture();
    await f.callback(await f.start());
    const first = { ...f.database.account[0] };
    f.setTokens({
      ...fixtureTokens,
      refresh_token: 'fixture-new-consent-refresh',
      scope: undefined,
    });
    const flow = await f.start();
    expect(
      new URL(flow.payload.url).searchParams.get('scope')!.split(' ').sort()
    ).toEqual([...BAMBOO_REQUIRED_SCOPES].sort());
    await f.callback(flow);
    const current = f.database.account[0];
    expect(f.database.account).toHaveLength(1);
    expect(current.userId).toBe(first.userId);
    expect(current.id).toBe(first.id);
    expect(current.refreshToken).not.toBe(first.refreshToken);
    expect(hasBambooGatewayScopes(current.scope)).toBe(false);
    expect(current.scope).toBe('');
    expect(
      await decryptBambooToken(
        current.refreshToken,
        (await f.auth.$context).secretConfig
      )
    ).toBe('fixture-new-consent-refresh');
  });

  it('does not retain an old refresh token when the new authorization response omits it', async () => {
    const f = fixture();
    await f.callback(await f.start());
    const first = { ...f.database.account[0] };
    f.setTokens({ ...fixtureTokens, refresh_token: undefined });
    const failed = await f.callback(await f.start());
    expect(failed.headers.get('Location')).toContain(
      'oauth_code_verification_failed'
    );
    expect(f.database.account[0]).toEqual(first);
    expect(f.database.session).toHaveLength(1);
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
      '/refresh-token',
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
    const accountInfo = await f.auth.handler(
      new Request(`${origin}/api/auth/account-info?providerId=bamboonode`, {
        headers: { Origin: origin },
      })
    );
    expect(accountInfo.status).toBe(404);
    expect((await f.start({ scopes: ['quota'] })).response.status).toBe(400);
    expect((await f.start({ providerId: 'github' })).response.status).toBe(400);
    expect(f.database.user).toHaveLength(0);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});

describe('BambooNode server-side OAuth token encryption', () => {
  const secret = 'fixture-auth-signing-secret-at-least-thirty-two-characters';

  it('uses Better Auth-compatible encryption with bare and versioned secret configs', async () => {
    const keys = [secret, { currentVersion: 2, keys: new Map([[2, secret]]) }];
    for (const key of keys) {
      const encrypted = await encryptBambooToken('fixture-refresh-token', key);
      expect(encrypted).not.toContain('fixture-refresh-token');
      expect(await decryptBambooToken(encrypted, key)).toBe(
        'fixture-refresh-token'
      );
      expect(await encryptBambooToken('fixture-refresh-token', key)).not.toBe(
        encrypted
      );
      const tampered =
        encrypted.slice(0, -2) + (encrypted.endsWith('00') ? 'ff' : '00');
      await expect(decryptBambooToken(tampered, key)).rejects.toThrow(
        'reauthorize'
      );
    }
  });

  it('fails closed for plaintext legacy tokens, a different encryption key and invalid plaintext', async () => {
    await expect(
      decryptBambooToken('fixture-refresh-token', secret)
    ).rejects.toThrow('reauthorize');
    const encrypted = await encryptBambooToken('fixture-refresh-token', secret);
    await expect(
      decryptBambooToken(
        encrypted,
        'different-fixture-secret-thirty-two-characters'
      )
    ).rejects.toThrow('reauthorize');
    await expect(encryptBambooToken('token\nheader', secret)).rejects.toThrow(
      'Invalid BambooNode OAuth token'
    );
  });
});
