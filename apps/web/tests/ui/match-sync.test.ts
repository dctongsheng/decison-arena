import type { MatchSnapshot } from '@decision-arena/core';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { connectMatchStream, mergeMatchSnapshot } from '@/blocks/arena/match-sync';

const snapshot = (version: number, extra: Partial<MatchSnapshot> = {}) =>
  ({ id: 'chess-fixture', version, ...extra }) as MatchSnapshot;

describe('chess cache ordering', () => {
  it('cannot roll a finished match back when a slower HTTP poll completes after a push', async () => {
    const client = new QueryClient();
    const key = ['arena-match', 'owner', 'chess-fixture', 'spectator'];
    let finishPoll!: (data: MatchSnapshot) => void;
    const request = client.fetchQuery({
      queryKey: key,
      queryFn: () => new Promise<MatchSnapshot>((resolve) => { finishPoll = resolve; }),
      structuralSharing: (old, next) => mergeMatchSnapshot(old as MatchSnapshot | undefined, next as MatchSnapshot),
    });
    const final = snapshot(12, { status: 'finished' });
    client.setQueryData(key, final);
    finishPoll(snapshot(10, { status: 'running' }));
    await request;
    expect(client.getQueryData(key)).toBe(final);
    client.clear();
  });
  it('retains the newest snapshot and accepts a later revision', () => {
    const previous = snapshot(10);
    expect(mergeMatchSnapshot(previous, snapshot(9))).toBe(previous);
    expect(mergeMatchSnapshot(previous, snapshot(10))).toBe(previous);
    expect(mergeMatchSnapshot(previous, snapshot(11)).version).toBe(11);
    expect(mergeMatchSnapshot(previous, snapshot(1, { id: 'other-match' })).version).toBe(1);
  });
  it('keeps army player, spectator and account caches separate even at identical versions', () => {
    const client = new QueryClient();
    const seat0 = ['arena-match', 'owner', 'chess-fixture', 0];
    const seat1 = ['arena-match', 'owner', 'chess-fixture', 1];
    client.setQueryData(seat0, snapshot(10, { view: { cells: ['private-seat-0'] } as unknown as MatchSnapshot['view'] }));
    const seat1View = snapshot(10, { view: { cells: ['private-seat-1'] } as unknown as MatchSnapshot['view'] });
    client.setQueryData<MatchSnapshot>(seat1, (old) => mergeMatchSnapshot(old, seat1View));
    expect(client.getQueryData(seat1)).toBe(seat1View);
    expect(client.getQueryData(['arena-match', 'owner', 'chess-fixture', 'spectator'])).toBeUndefined();
    expect(client.getQueryData(['arena-match', 'other-owner', 'chess-fixture', 0])).toBeUndefined();
    client.clear();
  });
});

class Socket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  send = vi.fn();
  message(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
  push(version: number) { this.message({ type: 'snapshot', snapshot: snapshot(version) }); }
}
function stream() {
  const sockets: Socket[] = [];
  const onSnapshot = vi.fn(), onConnection = vi.fn();
  const stop = connectMatchStream({
    url: 'ws://localhost:5091/api/arena/matches/chess-fixture/socket?seat=0',
    matchId: 'chess-fixture', onSnapshot, onConnection,
    createSocket: () => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket; },
  });
  return { sockets, stop, onSnapshot, onConnection };
}
describe('chess push recovery', () => {
  afterEach(() => vi.useRealTimers());
  it('reconnects after a close and requires a fresh snapshot before reporting live', () => {
    vi.useFakeTimers();
    const s = stream();
    s.sockets[0].onopen?.();
    expect(s.onConnection).not.toHaveBeenCalledWith(true);
    s.sockets[0].push(1);
    expect(s.onConnection).toHaveBeenLastCalledWith(true);
    const staleCallback = s.sockets[0].onmessage!;
    s.sockets[0].onclose?.();
    expect(s.onConnection).toHaveBeenLastCalledWith(false);
    vi.advanceTimersByTime(1000);
    expect(s.sockets).toHaveLength(2);
    s.sockets[1].onopen?.();
    s.sockets[1].push(4);
    staleCallback({ data: JSON.stringify({ type: 'snapshot', snapshot: snapshot(3) }) });
    expect(s.onSnapshot).toHaveBeenCalledTimes(2);
    expect(s.onSnapshot).toHaveBeenLastCalledWith(snapshot(4));
    s.stop();
  });
  it.each([false, true])('recovers a stalled connection (handshake opened: %s)', (opened) => {
    vi.useFakeTimers();
    const s = stream();
    if (opened) s.sockets[0].onopen?.();
    vi.advanceTimersByTime(10000);
    expect(s.sockets[0].close).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1000);
    expect(s.sockets).toHaveLength(2);
    s.stop();
  });
  it('heartbeats a quiet board and reconnects if the transport silently stops responding', () => {
    vi.useFakeTimers();
    const s = stream();
    s.sockets[0].onopen?.();
    s.sockets[0].push(1);
    vi.advanceTimersByTime(10000);
    expect(s.sockets[0].send).toHaveBeenLastCalledWith('ping');
    s.sockets[0].onmessage?.({ data: 'pong' });
    vi.advanceTimersByTime(20000);
    expect(s.sockets[0].close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10000);
    expect(s.sockets[0].close).toHaveBeenCalledOnce();
    s.stop();
  });
  it('bounds retry backoff and cancels all callbacks when a viewer or account changes', () => {
    vi.useFakeTimers();
    const s = stream();
    for (const delay of [1000, 2000, 4000, 8000, 15000, 15000]) {
      s.sockets.at(-1)!.onerror?.();
      const count = s.sockets.length;
      vi.advanceTimersByTime(delay - 1);
      expect(s.sockets).toHaveLength(count);
      vi.advanceTimersByTime(1);
      expect(s.sockets).toHaveLength(count + 1);
    }
    const oldMessage = s.sockets.at(-1)!.onmessage!;
    s.stop();
    oldMessage({ data: JSON.stringify({ type: 'snapshot', snapshot: snapshot(99) }) });
    vi.advanceTimersByTime(60000);
    expect(s.sockets).toHaveLength(7);
    expect(s.onSnapshot).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('ignores malformed messages and snapshots for other rooms', () => {
    vi.useFakeTimers();
    const s = stream();
    s.sockets[0].onmessage?.({ data: 'broken JSON' });
    s.sockets[0].message(null);
    s.sockets[0].message({ type: 'snapshot', snapshot: snapshot(4, { id: 'other' }) });
    s.sockets[0].message({ type: 'snapshot', snapshot: snapshot(-1) });
    expect(s.onSnapshot).not.toHaveBeenCalled();
    s.stop();
  });
});
