import type { MatchSnapshot } from '@decision-arena/core';

/** Only compare snapshots inside the same owner/match/viewer query key. */
export function mergeMatchSnapshot(
  previous: MatchSnapshot | undefined,
  incoming: MatchSnapshot
): MatchSnapshot {
  return previous?.id === incoming.id && previous.version >= incoming.version
    ? previous
    : incoming;
}

/** Reconnect transport only; never replay commands or restart model requests. */
export function connectMatchStream(options: {
  url: string;
  matchId: string;
  onSnapshot: (snapshot: MatchSnapshot) => void;
  onConnection: (connected: boolean) => void;
  createSocket?: (url: string) => WebSocket;
}) {
  let disposed = false;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let attempts = 0;

  const clearConnection = () => {
    clearTimeout(deadline);
    clearInterval(heartbeat);
    const old = socket;
    socket = undefined;
    if (old) {
      old.onopen = old.onmessage = old.onerror = old.onclose = null;
      old.close();
    }
  };
  const reconnect = () => {
    if (disposed) return;
    clearConnection();
    clearTimeout(retry);
    options.onConnection(false);
    retry = setTimeout(connect, Math.min(15000, 1000 * 2 ** Math.min(attempts++, 4)));
  };
  const connect = () => {
    if (disposed) return;
    let ws: WebSocket;
    try {
      ws = (options.createSocket ?? ((url) => new WebSocket(url)))(options.url);
    } catch {
      reconnect();
      return;
    }
    socket = ws;
    let lastReceived = Date.now();
    const current = () => !disposed && socket === ws;
    // A successful handshake alone does not prove snapshots are arriving.
    deadline = setTimeout(() => { if (current()) reconnect(); }, 10000);
    ws.onopen = () => {
      if (!current()) return;
      heartbeat = setInterval(() => {
        if (!current()) return;
        if (Date.now() - lastReceived >= 25000) return reconnect();
        try { ws.send('ping'); } catch { reconnect(); }
      }, 10000);
    };
    ws.onmessage = (event) => {
      if (!current()) return;
      if (event.data === 'pong') { lastReceived = Date.now(); return; }
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message?.type !== 'snapshot' || message.snapshot?.id !== options.matchId ||
          !Number.isSafeInteger(message.snapshot.version) || message.snapshot.version < 0) return;
      lastReceived = Date.now();
      clearTimeout(deadline);
      attempts = 0;
      options.onSnapshot(message.snapshot);
      options.onConnection(true);
    };
    ws.onerror = ws.onclose = () => { if (current()) reconnect(); };
  };
  options.onConnection(false);
  connect();
  return () => {
    disposed = true;
    clearTimeout(retry);
    clearConnection();
  };
}
