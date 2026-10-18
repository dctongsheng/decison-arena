import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ArcadeClientMessage,
  ArcadeCommand,
  ArcadeInput,
  ArcadeServerMessage,
  ArcadeSession,
} from '@decision-arena/core';

import { useSession } from '@/core/auth/client';
import { apiGet, apiPost } from '@/lib/api-client';

import { watchArcadeConnection } from './connection-timeout';
import { a } from './messages';
import {
  arcadeCompletionState,
  canSendArcadeInput,
  mergeArcadeSnapshot,
} from './session-state';

/** Local development uses the independent bridge. A public tunnel routes the
 * same-origin socket path to that bridge, without exposing its loopback port. */
export function arcadeSocketUrl(
  origin: string,
  id: string,
  options: { development: boolean; port?: string; since?: number }
) {
  const url = new URL(
    `/api/arena/arcade-sessions/${encodeURIComponent(id)}/socket`,
    origin
  );
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (options.development && loopback) url.port = options.port || '5094';
  if (Number.isSafeInteger(options.since) && options.since! > 0)
    url.searchParams.set('since', String(options.since));
  return url.toString();
}

export function useArcadeSession(id: string) {
  const { data: identity } = useSession(),
    ownerId = identity?.user.id,
    client = useQueryClient();
  const key = ['arena-arcade-session', ownerId, id] as const;
  const [connected, setConnected] = useState(false),
    [controllerReady, setControllerReady] = useState(false),
    [socketError, setSocketError] = useState('');
  const socket = useRef<WebSocket | null>(null),
    controller = useRef<{ runId: string; token: string; seq: number } | null>(
      null
    ),
    snapshotRef = useRef<ArcadeSession | undefined>(undefined),
    claimed = useRef(false);
  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      const lastSeq =
        client.getQueryData<ArcadeSession>(key)?.events.at(-1)?.seq || 0;
      const data = await apiGet<ArcadeSession>(
        `/api/arena/arcade-sessions/${encodeURIComponent(id)}?since=${lastSeq}`
      );
      return mergeArcadeSnapshot(client.getQueryData<ArcadeSession>(key), data);
    },
    refetchInterval: (query) =>
      arcadeCompletionState(query.state.data, connected).pollInterval,
    refetchIntervalInBackground: true,
  });
  snapshotRef.current = query.data;
  const loadedSessionId = query.data?.id;
  const send = useCallback((message: ArcadeClientMessage) => {
    if (socket.current?.readyState !== WebSocket.OPEN) return false;
    socket.current.send(JSON.stringify(message));
    return true;
  }, []);
  const sendInput = useCallback(
    (input: ArcadeInput) => {
      const current = controller.current;
      if (!current || !canSendArcadeInput(snapshotRef.current, current.runId))
        return false;
      return send({
        type: 'input',
        runId: current.runId,
        controllerSession: current.token,
        clientSeq: ++current.seq,
        input,
      });
    },
    [send]
  );
  useEffect(() => {
    if (!ownerId || loadedSessionId !== id) return;
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined,
      retries = 0;
    let cancelConnectTimeout: (() => void) | undefined;
    const claim = () => {
      const human = snapshotRef.current?.runs.find(
        (run) => run.controller.kind === 'human'
      );
      if (
        human &&
        !claimed.current &&
        socket.current?.readyState === WebSocket.OPEN &&
        snapshotRef.current?.status !== 'finished'
      ) {
        claimed.current = true;
        send({ type: 'claim', runId: human.id });
      }
    };
    const connect = () => {
      if (
        disposed ||
        arcadeCompletionState(snapshotRef.current, false).archiveReady
      )
        return;
      const url = arcadeSocketUrl(window.location.origin, id, {
        development: import.meta.env.DEV,
        port: import.meta.env.VITE_ARCADE_SOCKET_PORT,
        since: snapshotRef.current?.events.at(-1)?.seq,
      });
      const ws = new WebSocket(url);
      socket.current = ws;
      cancelConnectTimeout = watchArcadeConnection(ws, () => {
        if (!disposed) {
          setConnected(false);
          setSocketError(a('connection_timeout'));
        }
      });
      ws.onopen = () => {
        cancelConnectTimeout?.();
        if (disposed) return;
        retries = 0;
        setConnected(true);
        setSocketError('');
        claim();
      };
      ws.onmessage = (event) => {
        if (disposed) return;
        try {
          const message = JSON.parse(event.data) as ArcadeServerMessage;
          if (message.type === 'snapshot' && message.snapshot.id === id) {
            snapshotRef.current = mergeArcadeSnapshot(
              snapshotRef.current,
              message.snapshot
            );
            client.setQueryData(key, (previous: ArcadeSession | undefined) =>
              mergeArcadeSnapshot(previous, message.snapshot)
            );
            if (message.snapshot.status === 'finished') setSocketError('');
            claim();
          } else if (message.type === 'controller') {
            controller.current = {
              runId: message.runId,
              token: message.controllerSession,
              seq: 0,
            };
            setControllerReady(true);
            setSocketError('');
          } else if (message.type === 'ack') {
            setSocketError('');
          } else if (
            message.type === 'error' &&
            snapshotRef.current?.status !== 'finished'
          ) {
            setSocketError(message.message);
          }
        } catch {
          /* The polling snapshot remains authoritative when a message cannot be parsed. */
        }
      };
      ws.onerror = () => {
        cancelConnectTimeout?.();
        if (disposed) return;
        setConnected(false);
        ws.close();
      };
      ws.onclose = () => {
        cancelConnectTimeout?.();
        if (disposed) return;
        setConnected(false);
        setControllerReady(false);
        controller.current = null;
        claimed.current = false;
        if (arcadeCompletionState(snapshotRef.current, false).shouldReconnect)
          timer = setTimeout(connect, Math.min(5000, 750 * 2 ** retries++));
      };
    };
    // Let StrictMode cleanup cancel the first mount before opening a socket.
    timer = setTimeout(connect, 0);
    const heartbeat = setInterval(() => {
      if (snapshotRef.current?.status === 'finished') return;
      if (controller.current)
        send({
          type: 'heartbeat',
          controllerSession: controller.current.token,
        });
      else claim();
    }, 500);
    return () => {
      disposed = true;
      clearTimeout(timer);
      cancelConnectTimeout?.();
      clearInterval(heartbeat);
      sendInput({ buttons: [] });
      socket.current?.close();
      socket.current = null;
      controller.current = null;
      claimed.current = false;
      setConnected(false);
      setControllerReady(false);
    };
  }, [id, ownerId, loadedSessionId, client, send, sendInput]);
  const command = useMutation({
    mutationFn: (type: ArcadeCommand['type']) =>
      apiPost<ArcadeSession>(
        `/api/arena/arcade-sessions/${encodeURIComponent(id)}/commands`,
        { type, operationId: crypto.randomUUID() }
      ),
    onSuccess: (data) => {
      if (data?.id)
        client.setQueryData(key, (previous: ArcadeSession | undefined) =>
          mergeArcadeSnapshot(previous, data)
        );
      client.invalidateQueries({ queryKey: ['arena-arcade-sessions'] });
    },
  });
  return { query, command, connected, controllerReady, socketError, sendInput };
}
