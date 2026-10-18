import { useEffect, useRef, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  MatchCommand,
  MatchSnapshot,
  ReplayManifest,
  Seat,
  Viewer,
} from '@decision-arena/core';
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  Clock3,
  Eye,
  EyeOff,
  Flag,
  LoaderCircle,
  Pause,
  Play,
  Radio,
  RotateCcw,
  Send,
  ShieldCheck,
  Square,
  StepForward,
  Trophy,
  UserRound,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';

import { useSession } from '@/core/auth/client';
import { Link, useRouter } from '@/core/i18n/navigation';
import { apiGet, apiPost } from '@/lib/api-client';
import { Board } from '@/components/arena/board';
import { WatchViewSelector } from '@/components/arena/watch-view-selector';
import { TextField } from '@/components/form-field';
import { Button } from '@/components/ui/button';

import { PrivateDecisionReasoning } from './decision-reasoning';
import { connectMatchStream, mergeMatchSnapshot } from './match-sync';
import { ReplayPlayer } from './replay-player';
import {
  ArenaShell,
  AuthGate,
  ErrorNotice,
  eventLabel,
  gameName,
  Loading,
  reasonName,
  resultName,
  seatName,
  StatusBadge,
  SubmitButton,
  t,
} from './shared';

export function MatchRoomPage({ id }: { id: string }) {
  return (
    <ArenaShell>
      <AuthGate>
        <MatchRoomContent key={id} id={id} />
      </AuthGate>
    </ArenaShell>
  );
}
function MatchRoomContent({ id }: { id: string }) {
  const client = useQueryClient();
  const { data: session } = useSession();
  const ownerId = session?.user?.id;
  const [viewer, setViewer] = useState<Viewer>('spectator');
  const [selected, setSelected] = useState<number | null>(null);
  const [curtain, setCurtain] = useState(false);
  const [connected, setConnected] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [showReplay, setShowReplay] = useState(false);
  const initialized = useRef(false);
  const queryKey = ['arena-match', ownerId, id, viewer];
  const query = useQuery({
    queryKey,
    queryFn: () =>
      apiGet<MatchSnapshot>(
        `/api/arena/matches/${encodeURIComponent(id)}?seat=${viewer}`
      ),
    // Applies at cache commit time, including an HTTP response that raced a push.
    structuralSharing: (previous, incoming) => mergeMatchSnapshot(
      previous as MatchSnapshot | undefined, incoming as MatchSnapshot
    ),
    refetchInterval: (query) =>
      query.state.data?.status === 'finished'
        ? false
        : connected
          ? 15000
          : 3000,
    refetchIntervalInBackground: true,
  });
  const snapshot = query.data;
  useEffect(() => {
    if (!snapshot) return;
    const humans = snapshot.seats.flatMap((s, i) =>
      s.kind === 'human' ? [i as Seat] : []
    );
    if (!initialized.current) {
      initialized.current = true;
      if (humans.length) {
        setViewer(humans[0]);
        if (snapshot.gameId === 'army' && humans.length === 2) setCurtain(true);
      } else if (snapshot.gameId === 'army') {
        setViewer('full');
      }
      return;
    }
    if (
      humans.length === 2 &&
      snapshot.view.phase === 'playing' &&
      viewer !== snapshot.view.turn
    ) {
      setViewer(snapshot.view.turn);
      setSelected(null);
      if (snapshot.gameId === 'army') setCurtain(true);
    }
  }, [snapshot, viewer]);
  useEffect(() => {
    if (!ownerId || !snapshot) return;
    const url = new URL(
      `/api/arena/matches/${encodeURIComponent(id)}/socket`,
      window.location.origin
    );
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('seat', String(viewer));
    const disconnect = connectMatchStream({
      url: url.toString(), matchId: id, onConnection: setConnected,
      onSnapshot: (incoming) => client.setQueryData<MatchSnapshot>(
        ['arena-match', ownerId, id, viewer],
        (previous) => mergeMatchSnapshot(previous, incoming)
      ),
    });
    return () => {
      disconnect();
      setConnected(false);
    };
  }, [id, ownerId, viewer, client, !!snapshot]);
  const command = useMutation({
    mutationFn: (input: Omit<MatchCommand, 'operationId'>) =>
      apiPost(
        `/api/arena/matches/${encodeURIComponent(id)}/commands?seat=${viewer}`,
        { ...input, operationId: crypto.randomUUID() }
      ),
    onSuccess: () => {
      setSelected(null);
      setConfirmEnd(false);
      client.invalidateQueries({ queryKey: ['arena-match', ownerId, id] });
      client.invalidateQueries({ queryKey: ['arena-matches'] });
    },
  });
  const replay = useQuery({
    queryKey: ['arena-private-replay', ownerId, id],
    queryFn: () =>
      apiGet<ReplayManifest>(
        `/api/arena/matches/${encodeURIComponent(id)}/replay`
      ),
    enabled: showReplay && snapshot?.status === 'finished',
  });
  if (query.isPending) return <Loading />;
  if (!snapshot)
    return (
      <>
        <ErrorNotice error={query.error} />
        <Link href="/history" className="arena-text-link">
          {t('nav.history')}
        </Link>
      </>
    );
  const { view, seats } = snapshot;
  const allHuman = seats.every((s) => s.kind === 'human');
  const armyDuelWatch = snapshot.gameId === 'army' && seats.every((s) => s.kind === 'ai');
  const finished = snapshot.status === 'finished';
  const currentHuman =
    viewer !== 'spectator' &&
    viewer !== 'full' &&
    seats[viewer].kind === 'human';
  const canAct =
    currentHuman &&
    !finished &&
    !curtain &&
    !command.isPending &&
    (view.phase === 'setup' || viewer === view.turn);
  const legal = canAct ? view.legalActions : [];
  const destinations =
    selected === null
      ? []
      : legal
          .filter((a) => a.from === selected)
          .flatMap((a) => (a.to === undefined ? [] : [a.to]));
  const actionEvents = snapshot.events.filter((e) => e.type === 'action');
  const lastAction = actionEvents.at(-1);
  const lastDecision = [...actionEvents]
    .reverse()
    .find(
      (event) => event.seat !== undefined && seats[event.seat].kind === 'ai'
    );
  const metrics = lastDecision?.metrics;
  const onCell = (index: number) => {
    const direct = legal.find((a) => a.to === index && a.from === undefined);
    if (direct) {
      command.mutate({
        type: 'action',
        actionId: direct.id,
        seat: viewer as Seat,
        version: snapshot.version,
      });
      return;
    }
    const action =
      selected === null
        ? undefined
        : legal.find((a) => a.from === selected && a.to === index);
    if (action) {
      command.mutate({
        type: 'action',
        actionId: action.id,
        seat: viewer as Seat,
        version: snapshot.version,
      });
      return;
    }
    setSelected(legal.some((a) => a.from === index) ? index : null);
  };
  const changeSeat = (seat: Seat) => {
    if (seat === viewer) return;
    setCurtain(true);
    setViewer(seat);
    setSelected(null);
  };
  return (
    <>
      <div className="arena-room-breadcrumb">
        <Link href="/history">
          <ArrowLeft size={15} />
          {t('nav.history')}
        </Link>
        <span>/</span>
        <span>{gameName(snapshot.gameId)}</span>
        <code>#{id.slice(0, 8)}</code>
      </div>
      <div className="arena-room-heading">
        <div>
          <h1>
            {gameName(snapshot.gameId)} <span>{t('room.title')}</span>
          </h1>
          <p>
            <ShieldCheck size={14} />
            {t('room.private')}
            <span>·</span>
            <span>
              {connected ? (
                <>
                  <span className="arena-dot" />
                  {t('room.live')}
                </>
              ) : (
                t('room.polling')
              )}
            </span>
          </p>
        </div>
        <StatusBadge status={snapshot.status} />
      </div>
      {finished && (
        <div className="arena-winner" role="status">
          <span>
            <Trophy size={31} />
          </span>
          <div>
            <small>{t('room.final_result')}</small>
            <h2>{resultName(view.result, snapshot.gameId)}</h2>
            <p>{reasonName(view.result?.reason)}</p>
          </div>
          <Button
            variant="outline"
            className="arena-button secondary"
            onClick={() => setShowReplay(!showReplay)}
          >
            <RotateCcw size={17} />
            {t(showReplay ? 'room.back_board' : 'room.replay')}
          </Button>
        </div>
      )}
      <ErrorNotice
        error={query.error || command.error || snapshot.error}
        providers={seats.map((seat) => seat.profile?.provider)}
      />
      <div className="arena-room-layout">
        <div className="arena-room-main">
          <div className="arena-players">
            {seats.map((seat, i) => (
              <div
                key={i}
                className={`arena-player ${view.turn === i && !finished ? 'active' : ''} seat-${i}`}
              >
                <span className="arena-player-icon">
                  {seat.kind === 'ai' ? (
                    <Bot size={22} />
                  ) : (
                    <UserRound size={22} />
                  )}
                </span>
                <div>
                  <small>
                    {seatName(snapshot.gameId, i)}
                    {i === 0 ? ` · ${t('new.first')}` : ''}
                  </small>
                  <strong>{seat.profile?.name || t('human')}</strong>
                  <span>
                    {seat.kind === 'ai'
                      ? seat.profile?.model || t('models.service_default')
                      : t(allHuman ? 'room.local_player' : 'room.you')}
                  </span>
                </div>
                {view.turn === i && !finished && (
                  <span className="arena-turn-indicator" />
                )}
              </div>
            ))}
          </div>
          <section className="arena-board-panel arena-panel">
            <div className="arena-board-heading">
              <div>
                <span className="arena-dot" />
                {view.phase === 'setup'
                  ? t('room.setup')
                  : finished
                    ? t('room.finished')
                    : `${seatName(snapshot.gameId, view.turn)} · ${seats[view.turn].kind === 'human' ? t('room.your_move') : snapshot.status === 'running' ? t('room.thinking') : t('room.await_start')}`}
              </div>
              <span>
                {t('room.ply')} {view.ply}
              </span>
            </div>
            {armyDuelWatch && !showReplay && (
              <WatchViewSelector
                value={typeof viewer === 'number' ? viewer : 'full'}
                onChange={(next) => { setViewer(next); setSelected(null); }}
                labels={{ title: t('room.watch_view'), full: t('room.watch_full'),
                  seat0: t('room.watch_blue'), seat1: t('room.watch_red'), help: t('room.watch_help') }}
              />
            )}
            {showReplay && finished ? (
              <>
                <ErrorNotice error={replay.error} />
                {replay.data ? (
                  <ReplayPlayer replay={replay.data} />
                ) : (
                  <Loading />
                )}
              </>
            ) : (
              <div className="arena-board-stage">
                <Board
                  view={view}
                  obscured={curtain && !finished}
                  selected={selected}
                  destinations={destinations}
                  lastTo={lastAction?.action?.to}
                  onCell={canAct ? onCell : undefined}
                  disabled={!canAct}
                  labels={{
                    board: t('board.label'),
                    empty: t('board.empty'),
                    hidden: t('board.hidden'),
                    river: t('board.river'),
                    camp: t('board.camp'),
                  }}
                />
                {curtain && !finished && (
                  <div className="arena-handoff">
                    <span>
                      <EyeOff size={34} />
                    </span>
                    <h2>{t('room.handoff')}</h2>
                    <p>
                      {seatName(
                        snapshot.gameId,
                        typeof viewer === 'number' ? viewer : 0
                      )}{' '}
                      · {t('room.handoff_description')}
                    </p>
                    <Button
                      className="arena-button"
                      onClick={() => setCurtain(false)}
                    >
                      <Eye size={17} />
                      {t('room.reveal')}
                    </Button>
                  </div>
                )}
              </div>
            )}
            {view.phase === 'setup' && !finished && (
              <div className="arena-setup-tools">
                <p>{t('room.setup_help')}</p>
                {allHuman && (
                  <div className="arena-seat-switch">
                    {([0, 1] as const).map((seat) => (
                      <Button
                        variant={viewer === seat ? 'default' : 'outline'}
                        key={seat}
                        onClick={() => changeSeat(seat)}
                      >
                        {seatName(snapshot.gameId, seat)}{' '}
                        {view.ready?.[seat] && <Check size={14} />}
                      </Button>
                    ))}
                  </div>
                )}
                <Button
                  className="arena-button"
                  disabled={!canAct || !legal.some((a) => a.id === 'ready')}
                  onClick={() =>
                    command.mutate({
                      type: 'action',
                      actionId: 'ready',
                      seat: viewer as Seat,
                      version: snapshot.version,
                    })
                  }
                >
                  <Check size={16} />
                  {t('room.ready')}
                </Button>
              </div>
            )}
            {!finished && (
              <div className="arena-room-controls">
                {snapshot.status === 'running' ? (
                  <Button
                    className="arena-button secondary"
                    disabled={command.isPending}
                    onClick={() => command.mutate({ type: 'pause' })}
                  >
                    <Pause size={16} />
                    {t('room.pause')}
                  </Button>
                ) : (
                  <Button
                    className="arena-button"
                    disabled={
                      command.isPending || view.phase === 'setup' || allHuman
                    }
                    onClick={() =>
                      command.mutate({
                        type: snapshot.status === 'ready' ? 'start' : 'resume',
                      })
                    }
                  >
                    <Play size={16} />
                    {t(
                      snapshot.status === 'ready' ? 'room.start' : 'room.resume'
                    )}
                  </Button>
                )}
                <Button
                  variant="outline"
                  className="arena-button secondary"
                  disabled={
                    command.isPending ||
                    snapshot.status === 'running' ||
                    view.phase === 'setup' ||
                    seats[view.turn].kind === 'human'
                  }
                  onClick={() => command.mutate({ type: 'step' })}
                >
                  <StepForward size={16} />
                  {t('room.step')}
                </Button>
                <span />
                <Button
                  variant="ghost"
                  disabled={command.isPending}
                  onClick={() => setConfirmEnd(true)}
                >
                  <Square size={14} />
                  {t('room.end')}
                </Button>
              </div>
            )}
            {confirmEnd && (
              <div className="arena-end-confirm">
                <p>{t('room.end_confirm')}</p>
                <Button
                  variant="destructive"
                  disabled={command.isPending}
                  onClick={() => command.mutate({ type: 'end' })}
                >
                  {t('room.end')}
                </Button>
                <Button variant="ghost" onClick={() => setConfirmEnd(false)}>
                  {t('cancel')}
                </Button>
              </div>
            )}
          </section>
          {!finished && (
            <p className="arena-room-note">
              <Radio size={15} />
              {t('room.background_note')}
            </p>
          )}
          {canAct && legal.length > 0 && (
            <details className="arena-legal-actions">
              <summary>
                {t('room.legal')} ({legal.length})<ChevronDown size={16} />
              </summary>
              <div>
                {legal.map((action) => (
                  <button
                    key={action.id}
                    onClick={() =>
                      command.mutate({
                        type: 'action',
                        actionId: action.id,
                        seat: viewer as Seat,
                        version: snapshot.version,
                      })
                    }
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            </details>
          )}
          {finished && <PublishPanel matchId={id} gameId={snapshot.gameId} />}
        </div>
        <aside className="arena-room-sidebar">
          <section className="arena-panel arena-decision-panel">
            <div className="arena-panel-heading">
              <h2>
                <Activity size={17} />
                {t('room.decision')}
              </h2>
              <span className="arena-tag">
                {lastDecision ? `#${lastDecision.seq}` : '—'}
              </span>
            </div>
            {lastDecision && (
              <PrivateDecisionReasoning
                key={lastDecision.seq}
                event={lastDecision}
                snapshot={snapshot}
                viewer={viewer}
                obscured={curtain}
              />
            )}
            {metrics ? (
              <>
                <div className="arena-decision-model">
                  <span>{t('room.actual_model')}</span>
                  <strong>{metrics.actualModel || t('not_returned')}</strong>
                </div>
                <div className="arena-metrics-grid">
                  <div>
                    <span>{t('room.latency')}</span>
                    <strong>
                      {(metrics.elapsedMs / 1000).toFixed(2)}
                      <small>s</small>
                    </strong>
                  </div>
                  <div>
                    <span>{t('room.confidence')}</span>
                    <strong>
                      {metrics.confidence === undefined
                        ? '—'
                        : `${Math.round(metrics.confidence * 100)}%`}
                    </strong>
                  </div>
                </div>
                <div className="arena-metric-line">
                  <span>{t('room.thought')}</span>
                  <strong>
                    {metrics.thoughtUsed === undefined
                      ? t('not_returned')
                      : t(metrics.thoughtUsed ? 'yes' : 'no')}
                  </strong>
                </div>
                <div className="arena-metric-line">
                  <span>{t('room.usage')}</span>
                  <strong>
                    {metrics.usage
                      ? Object.entries(metrics.usage)
                          .map(([k, v]) => `${k}: ${v}`)
                          .join(' · ')
                      : t('not_returned')}
                  </strong>
                </div>
                {metrics.probabilities && (
                  <div className="arena-probabilities">
                    <h3>{t('room.probabilities')}</h3>
                    {Object.entries(metrics.probabilities)
                      .sort((a, b) => b[1] - a[1])
                      .slice(0, 5)
                      .map(([action, probability]) => (
                        <div key={action}>
                          <span>
                            <code>{action}</code>
                            <strong>{(probability * 100).toFixed(1)}%</strong>
                          </span>
                          <i
                            style={{
                              width: `${Math.max(1, probability * 100)}%`,
                            }}
                          />
                        </div>
                      ))}
                  </div>
                )}
              </>
            ) : (
              <div className="arena-sidebar-empty">
                <Bot size={25} />
                <p>{t(lastDecision ? 'not_returned' : 'room.no_decision')}</p>
              </div>
            )}
            {!allHuman && (
              <p className="arena-reasoning-timing">
                {t('room.reasoning_timing')}
              </p>
            )}
          </section>
          <section className="arena-panel arena-moves-panel">
            <div className="arena-panel-heading">
              <h2>
                <Clock3 size={17} />
                {t('room.timeline')}
              </h2>
              <span>{actionEvents.length}</span>
            </div>
            <div className="arena-timeline">
              {snapshot.events.length ? (
                snapshot.events
                  .slice()
                  .reverse()
                  .map((event) => (
                    <div
                      key={event.seq}
                      className={`arena-event ${event.type}`}
                    >
                      <span className="arena-event-number">
                        {event.seq.toString().padStart(2, '0')}
                      </span>
                      <div>
                        <strong>{eventLabel(event, event.seat === undefined
                          ? seats.map((seat) => seat.profile?.provider)
                          : [seats[event.seat].profile?.provider]
                        )}</strong>
                        <span>
                          {event.seat === undefined
                            ? ''
                            : `${seatName(snapshot.gameId, event.seat)} · `}
                          {new Date(event.at).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          })}
                          {event.metrics
                            ? ` · ${(event.metrics.elapsedMs / 1000).toFixed(1)}s`
                            : ''}
                        </span>
                        <PrivateDecisionReasoning
                          event={event}
                          snapshot={snapshot}
                          viewer={viewer}
                          obscured={curtain}
                          compact
                        />
                      </div>
                    </div>
                  ))
              ) : (
                <p>{t('room.no_moves')}</p>
              )}
            </div>
          </section>
          <div className="arena-session-budget">
            <span>{t('room.session_limit')}</span>
            <strong>
              {view.ply} / {snapshot.limits.maxPlies} {t('room.plies')}
              <span>·</span>
              {Math.floor(snapshot.limits.activeMs / 60000)} /{' '}
              {Math.floor(snapshot.limits.maxActiveMs / 60000)} min
            </strong>
            <div>
              <i
                style={{
                  width: `${Math.min(100, (view.ply / snapshot.limits.maxPlies) * 100)}%`,
                }}
              />
            </div>
            <p>{t('room.limit_help')}</p>
          </div>
        </aside>
      </div>
    </>
  );
}
function PublishPanel({
  matchId,
  gameId,
}: {
  matchId: string;
  gameId: string;
}) {
  const router = useRouter();
  const mutation = useMutation({
    mutationFn: (payload: unknown) =>
      apiPost<{ id: string }>('/api/arena/community', payload),
    onSuccess: (post) => {
      toast.success(t('publish.success'));
      router.push(`/community/${post.id}`);
    },
  });
  const form = useForm({
    defaultValues: { title: '', description: '' },
    validators: {
      onSubmit: z.object({
        title: z.string().min(3).max(120),
        description: z.string().max(2000),
      }),
    },
    onSubmit: async ({ value }) => {
      await mutation.mutateAsync({ matchId, ...value });
    },
  });
  return (
    <section className="arena-panel arena-publish">
      <div className="arena-panel-heading">
        <h2>
          <Send size={18} />
          {t('publish.title')}
        </h2>
        <span className="arena-tag">{t('private')}</span>
      </div>
      <p>{t('publish.description')}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit();
        }}
      >
        <form.Field name="title">
          {(field) => (
            <TextField
              field={field}
              label={t('publish.post_title')}
              placeholder={t('publish.placeholder')}
              required
            />
          )}
        </form.Field>
        <form.Field name="description">
          {(field) => (
            <label className="arena-field">
              <span>{t('publish.notes')}</span>
              <textarea
                maxLength={2000}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder={t('publish.notes_placeholder')}
              />
            </label>
          )}
        </form.Field>
        <ErrorNotice error={mutation.error} />
        <SubmitButton pending={mutation.isPending} type="submit">
          <Send size={16} />
          {t('publish.submit')}
        </SubmitButton>
        <p className="arena-field-help">{t('publish.privacy')}</p>
      </form>
    </section>
  );
}
