/** Close a stalled handshake; the socket close handler owns reconnect backoff. */
export function watchArcadeConnection(
  socket: { readonly readyState: number; close(): void },
  onTimeout: () => void
) {
  const timer = setTimeout(() => {
    // CONNECTING = 0; this also works with browser WebSocket wrappers.
    if (socket.readyState !== 0) return;
    onTimeout();
    socket.close();
  }, 10_000);
  return () => clearTimeout(timer);
}
