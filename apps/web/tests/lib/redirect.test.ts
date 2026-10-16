import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveAfterAuthUrl, safeInternalPath } from '@/lib/redirect';

// Locale stripping is exercised separately by the generated Paraglide runtime.
// This isolates the security boundary from browser globals in URL localization.
vi.mock('@/paraglide/runtime.js', () => ({
  deLocalizeHref: (path: string) =>
    path.replace(/^\/(zh|en)(?=\/|\?|#|$)/, '') || '/',
}));

describe('safe auth return paths', () => {
  beforeEach(() =>
    vi.stubGlobal('window', { location: { origin: 'https://arena.example' } })
  );
  afterEach(() => vi.unstubAllGlobals());
  it('preserves same-origin paths, query strings and fragments', () => {
    expect(safeInternalPath('/zh/new?game=army#seats')).toBe(
      '/zh/new?game=army#seats'
    );
    expect(safeInternalPath('https://arena.example/zh/history')).toBe(
      '/zh/history'
    );
    expect(safeInternalPath('/a/../history')).toBe('/history');
  });
  it.each([
    'https://evil.example/',
    '//evil.example/',
    '/\\evil.example/',
    '\\evil.example',
    'javascript:alert(1)',
    'https://arena.example@evil.example/',
    'https://user:pass@arena.example/',
    '/\nevil.example',
    '/%5Cevil.example',
  ])('rejects unsafe target %s', (input) => {
    expect(safeInternalPath(input)).toBeNull();
  });
  it.each([
    '/sign-in',
    '/zh/sign-in',
    '/zh/sign-up?callbackUrl=/',
    '/zh/%73ign-in',
    '/foo/../sign-in',
    '/zh/auth-callback?redirect=x',
  ])('prevents localized or normalized auth loops %s', (input) => {
    expect(safeInternalPath(input)).toBeNull();
  });
  it('falls back safely when supplied callbacks are external', () => {
    expect(
      resolveAfterAuthUrl({ callbackUrl: '/\\evil.example/', fallback: '/' })
    ).toBe('/');
  });
  it('supports root-relative paths without a browser but rejects unknown origins', () => {
    vi.unstubAllGlobals();
    expect(safeInternalPath('/new?game=xiangqi')).toBe('/new?game=xiangqi');
    expect(safeInternalPath('https://arena.example/history')).toBeNull();
    expect(safeInternalPath('//arena.example/history')).toBeNull();
  });
});
