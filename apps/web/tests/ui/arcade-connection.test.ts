import { afterEach, describe, expect, it, vi } from 'vitest';

import { watchArcadeConnection } from '@/blocks/arcade/connection-timeout';

describe('arcade handshake watchdog', () => {
  afterEach(() => vi.useRealTimers());
  it('closes a handshake stalled for 10 seconds so close-handler backoff can reconnect', () => {
    vi.useFakeTimers();
    const socket = { readyState: 0, close: vi.fn() },
      timeout = vi.fn();
    watchArcadeConnection(socket, timeout);
    vi.advanceTimersByTime(9999);
    expect(socket.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(timeout).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledOnce();
  });
  it('does not close a connection that opened before the deadline', () => {
    vi.useFakeTimers();
    const socket = { readyState: 0, close: vi.fn() },
      timeout = vi.fn();
    watchArcadeConnection(socket, timeout);
    socket.readyState = 1;
    vi.advanceTimersByTime(10000);
    expect(timeout).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  });
  it('cancels the stale timer on open, close, or component cleanup', () => {
    vi.useFakeTimers();
    const socket = { readyState: 0, close: vi.fn() },
      timeout = vi.fn();
    const cancel = watchArcadeConnection(socket, timeout);
    cancel();
    vi.advanceTimersByTime(20000);
    expect(timeout).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  });
});
