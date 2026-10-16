import { describe, expect, it, vi } from 'vitest';

import { discardRejectedBody } from '@/core/arena/runtime';

function streamingRequest(body: ReadableStream<Uint8Array>, length?: string) {
  return {
    body,
    bodyUsed: false,
    headers: new Headers(length ? { 'content-length': length } : {}),
  } as Request;
}

describe('rejected request body cleanup', () => {
  it('consumes a small rejected JSON body without changing its authorization error', async () => {
    const request = new Request(
      'https://arena.invalid/api/arena/community/post',
      {
        method: 'POST',
        body: JSON.stringify({ action: 'comment', body: 'Anonymous comment' }),
      }
    );
    await discardRejectedBody(request);
    expect(request.bodyUsed).toBe(true);
    expect(request.body?.locked).toBe(false);
  });

  it('cancels a declared oversized upload without reading its contents', async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      { pull, cancel },
      { highWaterMark: 0 }
    );
    await discardRejectedBody(streamingRequest(body, '32769'));
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('stops an unknown-length upload at the 32 KiB limit', async () => {
    const cancel = vi.fn();
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          chunks++;
          controller.enqueue(new Uint8Array(8192));
        },
        cancel,
      },
      { highWaterMark: 0 }
    );
    await discardRejectedBody(streamingRequest(body));
    expect(chunks).toBe(5);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('cancels a slow upload after 250 ms so authorization responses cannot hang', async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>(
        { cancel },
        { highWaterMark: 0 }
      );
      const pending = discardRejectedBody(streamingRequest(body));
      await vi.advanceTimersByTimeAsync(250);
      await pending;
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
