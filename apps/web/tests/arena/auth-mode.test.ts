import { beforeEach, describe, expect, it, vi } from 'vitest';

const { environment, rows, buildAuth } = vi.hoisted(() => ({
  environment: {} as Record<string, string>,
  rows: [] as { name: string; value: string }[],
  buildAuth: vi.fn((options: Record<string, any>) => ({ options })),
}));
vi.mock('@/config', () => ({
  envConfigs: environment,
  AUTH_SECRET_PLACEHOLDER: 'development-placeholder',
}));
vi.mock('better-auth', () => ({ betterAuth: buildAuth }));
vi.mock('better-auth/adapters/drizzle', () => ({
  drizzleAdapter: vi.fn(() => ({})),
}));
vi.mock('@/core/db', () => ({
  db: () => ({ select: () => ({ from: async () => rows }) }),
}));
vi.mock('@/modules/credits/service', () => ({ grantForNewUser: vi.fn() }));
vi.mock('@/modules/rbac/service', () => ({ grantRoleForNewUser: vi.fn() }));

const external = {
  auth_mode: 'bamboonode',
  bamboonode_issuer: 'https://api.bamboonode.dev',
  bamboonode_authorization_url: 'https://bamboonode.dev/oauth/authorize',
  bamboonode_token_url: 'https://api.bamboonode.dev/oauth/token',
  bamboonode_userinfo_url: 'https://api.bamboonode.dev/oauth/userinfo',
  bamboonode_client_id: 'fixture-client',
  bamboonode_client_secret: 'fixture-server-secret',
};

beforeEach(() => {
  vi.resetModules();
  buildAuth.mockClear();
  rows.splice(0);
  for (const key of Object.keys(environment)) delete environment[key];
  Object.assign(environment, {
    auth_mode: 'local',
    app_url: 'https://arena.example',
    auth_secret: 'fixture-secret-with-more-than-thirty-two-characters',
    database_provider: 'd1',
  });
});

describe('server-owned authentication mode', () => {
  it('keeps local defaults despite database-supplied Bamboo settings', async () => {
    const { getAuth } = await import('@/core/auth');
    const auth = getAuth({ ...external, email_auth_enabled: 'true' });
    expect(auth.options.emailAndPassword.enabled).toBe(true);
    expect(auth.options.plugins).toHaveLength(0);
  });

  it('disables email/social/one-tap on both session-only and configured auth calls', async () => {
    Object.assign(environment, external);
    const { getAuth } = await import('@/core/auth');
    const sessionOnly = getAuth();
    expect(sessionOnly.options.emailAndPassword.enabled).toBe(false);
    expect(sessionOnly.options.socialProviders).toEqual({});
    expect(sessionOnly.options.account.encryptOAuthTokens).toBe(true);
    const configured = getAuth({
      auth_mode: 'local',
      email_auth_enabled: 'true',
      google_client_id: 'db-google',
      google_client_secret: 'db-secret',
      google_one_tap_enabled: 'true',
    });
    expect(configured.options.emailAndPassword.enabled).toBe(false);
    expect(configured.options.socialProviders).toEqual({});
    expect(
      configured.options.plugins.map((plugin: { id: string }) => plugin.id)
    ).toEqual(['generic-oauth']);
    expect(
      configured.options.account.accountLinking.disableImplicitLinking
    ).toBe(true);
  });

  it('invalidates the cached instance from server configuration without needing DB settings', async () => {
    const { getAuth } = await import('@/core/auth');
    const local = getAuth();
    expect(getAuth()).toBe(local);
    Object.assign(environment, external);
    const externalAuth = getAuth();
    expect(externalAuth).not.toBe(local);
    expect(externalAuth.options.emailAndPassword.enabled).toBe(false);
    expect(getAuth()).toBe(externalAuth);
    environment.bamboonode_client_secret = 'rotated-fixture-secret';
    expect(getAuth()).not.toBe(externalAuth);
  });

  it('does not fall back to local registration when Bamboo configuration is incomplete', async () => {
    environment.auth_mode = 'bamboonode';
    const { getAuth } = await import('@/core/auth');
    const auth = getAuth({ email_auth_enabled: 'true' });
    expect(auth.options.emailAndPassword.enabled).toBe(false);
    expect(auth.options.plugins).toHaveLength(0);
    expect(auth.options.disabledPaths).toContain('/sign-up/email');
  });

  it('ignores DB mode/credential overrides and prevents exposing them through config filters', async () => {
    Object.assign(environment, external);
    rows.push(
      { name: 'auth_mode', value: 'local' },
      { name: 'bamboonode_client_secret', value: 'db-controlled-secret' },
      { name: 'bamboonode_auth_ready', value: 'true' },
      { name: 'app_name', value: 'Public arena name' }
    );
    const {
      getAllConfigs,
      getDbConfigs,
      filterPublicConfigs,
      replaceCustomConfigs,
    } = await import('@/modules/config/service');
    expect(await getDbConfigs()).toEqual({ app_name: 'Public arena name' });
    const all = await getAllConfigs();
    expect(all.auth_mode).toBe('bamboonode');
    expect(all.bamboonode_client_secret).toBe(
      external.bamboonode_client_secret
    );
    expect(
      filterPublicConfigs(all, [
        'auth_mode',
        'bamboonode_client_secret',
        'app_name',
      ])
    ).toEqual({ app_name: 'Public arena name' });
    await expect(
      replaceCustomConfigs([
        { key: 'bamboonode_arbitrary_override', value: 'unsafe' },
      ])
    ).rejects.toThrow('Reserved key not allowed');
  });
});
