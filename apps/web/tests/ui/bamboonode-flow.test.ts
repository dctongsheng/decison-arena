import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bambooAccountUrl,
  bambooDestinations,
  bambooMode,
  bambooReady,
  createBambooLoginFlow,
  type BambooPhase,
} from '@/blocks/auth/bamboonode-flow';

const input = {
  providerId: 'bamboonode' as const,
  callbackURL: '/zh/history',
  errorCallbackURL: '/zh/sign-in?oauth_error=1',
};

describe('BambooNode OAuth entry behavior', () => {
  it('automatically starts only once, including effect replays', async () => {
    const signIn = vi.fn().mockResolvedValue({});
    const phases: BambooPhase[] = [];
    const flow = createBambooLoginFlow({
      input,
      callbackFailed: false,
      signIn,
      onPhase: (phase) => phases.push(phase),
    });
    await flow.start('auto');
    await flow.start('auto');
    expect(signIn).toHaveBeenCalledExactlyOnceWith(input);
    expect(phases).toEqual(['redirecting']);
  });
  it('blocks concurrent automatic attempts and rapid manual clicks', async () => {
    let complete!: (value: {}) => void;
    const signIn = vi.fn(
      () =>
        new Promise<{}>((resolve) => {
          complete = resolve;
        })
    );
    const flow = createBambooLoginFlow({
      input,
      callbackFailed: false,
      signIn,
      onPhase: vi.fn(),
    });
    const first = flow.start('auto');
    expect(await flow.start('auto')).toBe(false);
    expect(await flow.start('manual')).toBe(false);
    expect(signIn).toHaveBeenCalledTimes(1);
    complete({});
    expect(await first).toBe(true);
  });
  it('never automatically retries a failed OAuth callback but permits explicit retry', async () => {
    const signIn = vi.fn().mockResolvedValue({});
    const onPhase = vi.fn();
    const flow = createBambooLoginFlow({
      input,
      callbackFailed: true,
      signIn,
      onPhase,
    });
    expect(await flow.start('auto')).toBe(false);
    expect(signIn).not.toHaveBeenCalled();
    expect(await flow.start('manual')).toBe(true);
    expect(signIn).toHaveBeenCalledExactlyOnceWith(input);
    expect(onPhase).toHaveBeenCalledWith('redirecting');
  });
  it.each(['response', 'network'])(
    'shows a retryable error on %s failure without automatic loops',
    async (kind) => {
      const signIn =
        kind === 'response'
          ? vi
              .fn()
              .mockResolvedValue({
                error: { message: 'private upstream detail' },
              })
          : vi.fn().mockRejectedValue(new Error('network unavailable'));
      const phases: BambooPhase[] = [];
      const flow = createBambooLoginFlow({
        input,
        callbackFailed: false,
        signIn,
        onPhase: (phase) => phases.push(phase),
      });
      expect(await flow.start('auto')).toBe(false);
      expect(await flow.start('auto')).toBe(false);
      expect(signIn).toHaveBeenCalledTimes(1);
      expect(phases).toEqual(['redirecting', 'error']);
      signIn.mockResolvedValue({});
      expect(await flow.start('manual')).toBe(true);
      expect(phases).toEqual(['redirecting', 'error', 'redirecting']);
    }
  );
});

describe('BambooNode destinations and public configuration', () => {
  beforeEach(() =>
    vi.stubGlobal('window', {
      location: {
        origin: 'https://arena.example',
        href: 'https://arena.example/zh/sign-in',
      },
    })
  );
  afterEach(() => vi.unstubAllGlobals());

  it('retains the entry locale and a safe destination through signup and error callbacks', () => {
    const result = bambooDestinations(
      '?callbackUrl=%2Fhistory%3FgameId%3Darmy%23recent',
      'zh',
      '/sign-up'
    );
    expect(result.input.providerId).toBe('bamboonode');
    expect(result.input.callbackURL).toBe('/zh/history?gameId=army#recent');
    const failure = new URL(
      result.input.errorCallbackURL,
      'https://arena.example'
    );
    expect(failure.pathname).toBe('/zh/sign-up');
    expect(failure.searchParams.get('oauth_error')).toBe('1');
    expect(failure.searchParams.get('callbackUrl')).toBe(
      '/history?gameId=army#recent'
    );
    expect(
      bambooDestinations(failure.search, 'zh', '/sign-up').input.callbackURL
    ).toBe(result.input.callbackURL);
  });
  it.each([
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    '/zh/sign-in',
    '/auth-callback',
    'myapp://auth/callback',
  ])('rejects unsafe or looping callback %s', (target) => {
    const result = bambooDestinations(
      `?${new URLSearchParams({ callbackUrl: target })}`,
      'zh',
      '/sign-in'
    );
    expect(result.input.callbackURL).toMatch(/^\/zh\/?$/);
  });
  it('supports safe redirect fallback and either OAuth error parameter', () => {
    expect(
      bambooDestinations(
        '?callbackUrl=https://evil.example&redirect=/new',
        'en',
        '/sign-in'
      ).input.callbackURL
    ).toBe('/new');
    expect(
      bambooDestinations('?oauth_error=1', 'zh', '/sign-in').callbackFailed
    ).toBe(true);
    expect(
      bambooDestinations('?error=access_denied', 'zh', '/sign-in')
        .callbackFailed
    ).toBe(true);
    expect(bambooDestinations('', 'zh', '/sign-in').callbackFailed).toBe(false);
  });
  it('accepts only an explicitly configured trustworthy frontend account URL', () => {
    expect(bambooAccountUrl('https://bamboonode.dev/account')).toBe(
      'https://bamboonode.dev/account'
    );
    for (const value of [
      undefined,
      '',
      'http://bamboonode.dev',
      'https://api.bamboonode.dev',
      'https://bamboonode.dev.evil.example',
      'https://user:pass@bamboonode.dev',
      'https://bamboonode.dev:8080',
      '/account',
    ]) {
      expect(bambooAccountUrl(value)).toBeUndefined();
    }
  });
  it('only enables ready BambooNode mode from affirmative configuration', () => {
    expect(bambooMode({ auth_mode: 'bamboonode' })).toBe(true);
    expect(bambooMode({ auth_mode: 'local' })).toBe(false);
    expect(bambooReady({ bamboonode_auth_ready: true })).toBe(true);
    expect(bambooReady({ bamboonode_auth_ready: 'true' })).toBe(true);
    expect(bambooReady({ bamboonode_auth_ready: false })).toBe(false);
    expect(bambooReady({ bamboonode_auth_ready: 'false' })).toBe(false);
    expect(bambooReady(undefined)).toBe(false);
  });
});
