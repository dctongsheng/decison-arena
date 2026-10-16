import type { BetterAuthOptions } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { genericOAuth } from 'better-auth/plugins';
import type { GenericOAuthConfig } from 'better-auth/plugins/generic-oauth';
import { z } from 'zod';

export const BAMBOO_ISSUER = 'https://api.bamboonode.dev';
export const BAMBOO_FRONTEND = 'https://bamboonode.dev';
const SCOPES = ['openid', 'profile', 'email'];
const MAX_RESPONSE_BYTES = 16_384;

export function authMode(env: Record<string, string>): 'local' | 'bamboonode' {
  const mode = env.auth_mode || 'local';
  if (mode !== 'local' && mode !== 'bamboonode')
    throw new Error('Invalid AUTH_MODE.');
  return mode;
}

function trustedUrl(input: string, origin: string): string {
  const url = new URL(input);
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw new Error('Invalid BambooNode endpoint.');
  return url.href;
}

export interface BambooSettings {
  issuer: string;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  clientId: string;
  clientSecret: string;
  authentication: 'basic' | 'post';
  scopes: string[];
}

/** Configuration is supplied only by the server environment, never by DB settings. */
export function bambooSettings(
  env: Record<string, string>
): BambooSettings | null {
  try {
    if (new URL(env.bamboonode_issuer).href !== `${BAMBOO_ISSUER}/`)
      return null;
    const clientId = env.bamboonode_client_id?.trim();
    const clientSecret = env.bamboonode_client_secret;
    if (
      !clientId ||
      !clientSecret ||
      clientId.length > 512 ||
      clientSecret.length > 4096 ||
      /[\u0000-\u001f\u007f]/.test(clientId + clientSecret)
    )
      return null;
    const authentication = env.bamboonode_token_auth_method || 'post';
    if (authentication !== 'basic' && authentication !== 'post') return null;
    const scopes = [
      ...new Set(
        (env.bamboonode_scopes || SCOPES.join(' ')).split(/\s+/).filter(Boolean)
      ),
    ];
    if (
      scopes.length !== SCOPES.length ||
      scopes.some((scope) => !SCOPES.includes(scope))
    )
      return null;
    return {
      issuer: BAMBOO_ISSUER,
      authorizationUrl: trustedUrl(
        env.bamboonode_authorization_url,
        BAMBOO_FRONTEND
      ),
      tokenUrl: trustedUrl(env.bamboonode_token_url, BAMBOO_ISSUER),
      userInfoUrl: trustedUrl(env.bamboonode_userinfo_url, BAMBOO_ISSUER),
      clientId,
      clientSecret,
      authentication,
      scopes,
    };
  } catch {
    return null;
  }
}

export function publicBambooAuth(env: Record<string, string>) {
  const mode = authMode(env);
  let accountUrl: string | undefined;
  try {
    accountUrl = trustedUrl(env.bamboonode_account_url, BAMBOO_FRONTEND);
  } catch {}
  return {
    auth_mode: mode,
    bamboonode_auth_ready:
      mode === 'bamboonode' && bambooSettings(env) !== null,
    ...(accountUrl ? { bamboonode_account_url: accountUrl } : {}),
    ...(mode === 'bamboonode'
      ? {
          email_auth_enabled: 'false',
          google_auth_enabled: 'false',
          github_auth_enabled: 'false',
          google_one_tap_enabled: 'false',
          password_reset_enabled: 'false',
          email_verification_enabled: 'false',
          desktop_auth_schemes: '',
        }
      : {}),
  };
}

async function providerJson(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit
) {
  try {
    const response = await fetcher(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (
      !response.ok ||
      !response.headers.get('content-type')?.includes('application/json')
    )
      throw new Error();
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
      void response.body?.cancel().catch(() => {});
      throw new Error();
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error();
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<
      string,
      unknown
    >;
  } catch {
    // Provider bodies can contain tokens or personal data; never reflect them.
    throw new Error(
      'BambooNode authentication service returned an invalid response.'
    );
  }
}

const accessTokenSchema = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[\x21-\x7e]+$/);
const identitySchema = z.object({
  sub: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^\s\u0000-\u001f\u007f]+$/),
  email: z.string().email().max(320),
  email_verified: z.boolean().optional(),
  name: z.string().max(200).optional(),
  picture: z.string().max(2048).optional(),
});

/** Never use the 1.6.2 plugin's decode-only id_token path for identity. */
export function bambooProvider(
  settings: BambooSettings,
  fetcher: typeof fetch = fetch
): GenericOAuthConfig {
  return {
    providerId: 'bamboonode',
    ...settings,
    pkce: true,
    getToken: async ({ code, redirectURI, codeVerifier }) => {
      if (
        !code ||
        code.length > 4096 ||
        !codeVerifier ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)
      )
        throw new Error('Invalid BambooNode authorization callback.');
      const data = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectURI,
        code_verifier: codeVerifier,
      });
      const headers: Record<string, string> = {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      };
      if (settings.authentication === 'basic') {
        headers.Authorization = `Basic ${btoa(`${encodeURIComponent(settings.clientId)}:${encodeURIComponent(settings.clientSecret)}`)}`;
      } else {
        data.set('client_id', settings.clientId);
        data.set('client_secret', settings.clientSecret);
      }
      const result = await providerJson(fetcher, settings.tokenUrl, {
        method: 'POST',
        headers,
        body: data.toString(),
      });
      const parsed = accessTokenSchema.safeParse(result.access_token);
      if (
        !parsed.success ||
        typeof result.token_type !== 'string' ||
        result.token_type.toLowerCase() !== 'bearer'
      )
        throw new Error('Invalid BambooNode token response.');
      const expires = result.expires_in;
      if (
        expires !== undefined &&
        (typeof expires !== 'number' ||
          !Number.isFinite(expires) ||
          expires <= 0 ||
          expires > 31_536_000)
      )
        throw new Error('Invalid BambooNode token expiry.');
      return {
        accessToken: parsed.data,
        ...(typeof expires === 'number'
          ? { accessTokenExpiresAt: new Date(Date.now() + expires * 1000) }
          : {}),
        scopes: settings.scopes,
        // Refresh/id tokens are not needed for login and are deliberately discarded.
      };
    },
    getUserInfo: async (tokens) => {
      const token = accessTokenSchema.safeParse(tokens.accessToken);
      if (!token.success) throw new Error('Invalid BambooNode access token.');
      const response = await providerJson(fetcher, settings.userInfoUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token.data}`,
          Accept: 'application/json',
        },
      });
      const parsed = identitySchema.safeParse(response);
      if (!parsed.success) throw new Error('Invalid BambooNode user identity.');
      const user = parsed.data;
      let image: string | undefined;
      try {
        const url = new URL(user.picture || '');
        if (url.protocol === 'https:' && !url.username && !url.password)
          image = url.href;
      } catch {}
      return {
        id: user.sub,
        email: user.email.toLowerCase(),
        emailVerified: user.email_verified === true,
        name: user.name?.trim() || user.email.split('@')[0],
        ...(image ? { image } : {}),
      };
    },
  };
}

/** Server enforcement remains closed even when the external provider is not configured. */
export function bambooAuthOptions(
  env: Record<string, string>,
  fetcher: typeof fetch = fetch
): Pick<BetterAuthOptions, 'plugins' | 'account' | 'disabledPaths' | 'hooks'> {
  const settings = bambooSettings(env);
  return {
    plugins: settings
      ? [genericOAuth({ config: [bambooProvider(settings, fetcher)] })]
      : [],
    account: {
      encryptOAuthTokens: true,
      storeStateStrategy: 'database',
      skipStateCookieCheck: false,
      accountLinking: {
        enabled: false,
        disableImplicitLinking: true,
        allowDifferentEmails: false,
      },
    },
    disabledPaths: [
      '/sign-in/email',
      '/sign-up/email',
      '/sign-in/social',
      '/link-social',
      '/oauth2/link',
      '/unlink-account',
      '/request-password-reset',
      '/reset-password',
      '/change-password',
      '/set-password',
      '/verify-password',
      '/change-email',
      '/send-verification-email',
      '/verify-email',
      '/one-tap/callback',
      '/get-access-token',
      '/refresh-token',
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === '/sign-in/oauth2') {
          if (!settings)
            throw new APIError('SERVICE_UNAVAILABLE', {
              message: 'BambooNode authentication is not configured.',
            });
          if (
            ctx.body?.providerId !== 'bamboonode' ||
            (ctx.body?.scopes &&
              (!Array.isArray(ctx.body.scopes) ||
                ctx.body.scopes.some(
                  (scope: unknown) =>
                    typeof scope !== 'string' || !SCOPES.includes(scope)
                )))
          )
            throw new APIError('BAD_REQUEST', {
              message: 'Invalid BambooNode login request.',
            });
        }
      }),
    },
  };
}
