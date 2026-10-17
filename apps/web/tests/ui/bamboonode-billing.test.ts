import { createElement } from 'react';
import { BAMBOONODE_INSUFFICIENT_QUOTA } from '@decision-arena/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';

import { overwriteGetLocale } from '@/paraglide/runtime.js';
import { BambooJevNotice } from '@/blocks/arena/bamboonode-billing';
import { modelErrorKind, modelErrorText } from '@/blocks/arena/model-errors';
import { ErrorNotice, eventLabel } from '@/blocks/arena/shared';

const legacy = 'Model provider returned HTTP 403';
afterEach(() => overwriteGetLocale(() => 'en'));

describe('BambooNode paid-model and quota notices', () => {
  it('recognizes only the exact provider-normalized insufficient-quota code', () => {
    expect(modelErrorKind(new Error(BAMBOONODE_INSUFFICIENT_QUOTA))).toBe(
      'quota'
    );
    for (const message of [
      legacy,
      'Insufficient user quota',
      `prefix ${BAMBOONODE_INSUFFICIENT_QUOTA}`,
      'HTTP 500',
    ]) {
      expect(modelErrorKind(message)).toBeUndefined();
    }
  });

  it('keeps legacy 403 uncertain and requires BambooNode context, including mixed games', () => {
    for (const providers of [
      ['bamboonode-decisions'],
      ['bamboonode-systemone'],
      ['openrouter', 'bamboonode-decisions'],
    ]) {
      expect(modelErrorKind(legacy, providers)).toBe('forbidden');
      expect(modelErrorText(legacy, providers)).toContain(
        'does not identify the cause'
      );
    }
    expect(modelErrorKind(legacy, ['openrouter'])).toBeUndefined();
    expect(modelErrorText(legacy, ['openrouter'])).toBe(legacy);
    expect(modelErrorText('Request timed out', ['bamboonode-decisions'])).toBe(
      'Request timed out'
    );
  });

  it.each(['en', 'zh'] as const)(
    'renders localized confirmed errors and a safe recharge link in %s',
    (locale) => {
      overwriteGetLocale(() => locale);
      const html = renderToStaticMarkup(
        createElement(ErrorNotice, {
          error: new Error(BAMBOONODE_INSUFFICIENT_QUOTA),
          providers: ['bamboonode-decisions'],
        })
      );
      expect(html).toContain(
        locale === 'zh'
          ? '本人 BambooNode 账户额度不足'
          : 'Your BambooNode account has insufficient quota'
      );
      expect(html).toContain(
        locale === 'zh' ? '手动继续或重试' : 'continue or retry manually'
      );
      expect(html).toContain(
        locale === 'zh' ? 'Jev 是收费模型' : 'Jev is a paid model'
      );
      expect(html).toContain('href="https://bamboonode.dev/recharge"');
      expect(html).toContain('rel="noreferrer"');
      expect(html).not.toContain(BAMBOONODE_INSUFFICIENT_QUOTA);
    }
  );

  it('does not label StartLux quota errors as Jev billing', () => {
    const html = renderToStaticMarkup(
      createElement(ErrorNotice, {
        error: BAMBOONODE_INSUFFICIENT_QUOTA,
        providers: ['bamboonode-systemone'],
      })
    );
    expect(html).toContain('insufficient quota');
    expect(html).not.toContain('Jev');
  });

  it('localizes stored chess and arcade errors without showing the internal code', () => {
    const event = {
      seq: 1,
      at: 1,
      type: 'error' as const,
      message: BAMBOONODE_INSUFFICIENT_QUOTA,
    };
    expect(eventLabel(event)).toBe(modelErrorText(event.message));
    expect(
      eventLabel({ ...event, message: legacy }, ['bamboonode-decisions'])
    ).toContain('does not identify the cause');
    expect(eventLabel({ ...event, message: legacy }, ['openrouter'])).toBe(
      legacy
    );
  });

  it('shows the selected paid-model note only for BambooNode Jev profiles', () => {
    const html = renderToStaticMarkup(
      createElement(BambooJevNotice, {
        profile: { provider: 'bamboonode-decisions' },
      })
    );
    expect(html).toContain('Jev is a paid model');
    expect(html).toContain('https://bamboonode.dev/recharge');
    for (const provider of [
      'openrouter',
      'custom-openrouter',
      'bamboonode-systemone',
      undefined,
    ]) {
      expect(
        renderToStaticMarkup(
          createElement(BambooJevNotice, { profile: { provider } })
        )
      ).toBe('');
    }
  });
});
