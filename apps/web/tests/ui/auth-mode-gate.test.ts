import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthModeGate } from '@/blocks/auth/auth-mode-gate';

const state = vi.hoisted(() => ({
  config: {
    data: undefined as Record<string, unknown> | undefined,
    isPending: true,
    isFetchedAfterMount: false,
    isError: false,
    isFetching: true,
    refetch: vi.fn(),
  },
  session: { data: null, isPending: false },
}));
vi.mock('@/hooks/use-public-config', () => ({
  usePublicConfig: () => state.config,
}));
vi.mock('@/core/auth/client', () => ({
  authClient: { signIn: { oauth2: vi.fn() } },
  useSession: () => state.session,
}));
vi.mock('@/core/i18n/navigation', () => ({
  Link: ({ href, children, ...props }: { href: string; children: ReactNode }) =>
    createElement('a', { href, ...props }, children),
}));
vi.mock('@/paraglide/messages.js', () => ({
  m: new Proxy({}, { get: (_, key) => () => String(key) }),
}));

function render(intent: 'sign-in' | 'sign-up' | 'account' = 'sign-in') {
  const localForm = createElement(
    'form',
    { 'data-local-auth': 'true' },
    createElement('input', { type: 'password' })
  );
  return renderToStaticMarkup(
    createElement(AuthModeGate, { intent, children: localForm })
  );
}

describe('auth mode UI boundary', () => {
  beforeEach(() => {
    state.config.data = undefined;
    state.config.isPending = false;
    state.config.isFetchedAfterMount = true;
    state.config.isError = false;
    state.config.isFetching = false;
  });
  it('does not mount local fields while the public configuration is loading', () => {
    state.config.isPending = true;
    const html = render();
    expect(html).toContain('common.bamboo.loading_title');
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('data-local-auth');
  });
  it('withholds cached local fields while the entry verifies the current server mode', () => {
    state.config.data = { auth_mode: 'local' };
    state.config.isFetching = true;
    state.config.isFetchedAfterMount = false;
    const html = render();
    expect(html).toContain('common.bamboo.loading_title');
    expect(html).not.toContain('data-local-auth');
  });
  it('fails closed with a retry when configuration loading fails', () => {
    state.config.isError = true;
    const html = render();
    expect(html).toContain('common.bamboo.config_error_title');
    expect(html).toContain('common.bamboo.retry');
    expect(html).not.toContain('data-local-auth');
  });
  it('preserves the local form in local mode', () => {
    state.config.data = { auth_mode: 'local' };
    expect(render()).toContain('type="password"');
  });
  it('keeps the existing local behavior when auth_mode is absent', () => {
    state.config.data = {};
    expect(render()).toContain('type="password"');
  });
  it.each(['sign-in', 'sign-up'] as const)(
    'replaces %s with the unified entry',
    (intent) => {
      state.config.data = {
        auth_mode: 'bamboonode',
        bamboonode_auth_ready: true,
      };
      const html = render(intent);
      expect(html).toContain('common.bamboo.redirect_title');
      expect(html).not.toContain('data-local-auth');
      expect(html).not.toContain('type="password"');
      expect(html).not.toContain('api.bamboonode.dev');
    }
  );
  it('does not pretend to log in before the provider is configured', () => {
    state.config.data = {
      auth_mode: 'bamboonode',
      bamboonode_auth_ready: false,
    };
    const html = render();
    expect(html).toContain('common.bamboo.unavailable_title');
    expect(html).not.toContain('common.bamboo.continue');
    expect(html).not.toContain('data-local-auth');
    expect(html).not.toContain('href="/login"');
  });
  it('replaces local password reset and verification forms with account management', () => {
    state.config.data = {
      auth_mode: 'bamboonode',
      bamboonode_auth_ready: true,
      bamboonode_account_url: 'https://bamboonode.dev/account',
    };
    const html = render('account');
    expect(html).toContain('common.bamboo.account_description');
    expect(html).toContain('href="https://bamboonode.dev/account"');
    expect(html).not.toContain('data-local-auth');
    expect(html).not.toContain('type="password"');
  });
  it('does not invent an account management URL', () => {
    state.config.data = {
      auth_mode: 'bamboonode',
      bamboonode_auth_ready: true,
    };
    const html = render('account');
    expect(html).toContain('common.bamboo.account_no_url');
    expect(html).not.toContain('href="https://bamboonode.dev');
  });
});
