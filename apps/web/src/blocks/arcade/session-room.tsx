import { useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ArcadeReplayV2 } from '@decision-arena/core';
import {
  ArrowLeft,
  Bot,
  Clock3,
  Pause,
  Play,
  Radio,
  RotateCcw,
  Send,
  ShieldCheck,
  Square,
  Trophy,
} from 'lucide-react';
import { z } from 'zod';

import { useSession } from '@/core/auth/client';
import { Link, useRouter } from '@/core/i18n/navigation';
import { apiGet, apiPost } from '@/lib/api-client';
import { modelErrorKind, modelErrorText } from '@/blocks/arena/model-errors';
import {
  ArenaShell,
  AuthGate,
  ErrorNotice,
  Loading,
  SubmitButton,
  t,
} from '@/blocks/arena/shared';
import { Button } from '@/components/ui/button';

import { useArcadeSession } from './live-session';
import { a } from './messages';
import { arcadeResult, PrivateArcadeReasoning } from './presentation';
import { ArcadeReplayPlayer } from './replay-player';
import { RunPanel } from './run-panel';
import { arcadeReason, ScoreBreakdown } from './score';
import { arcadeCompletionState, arcadeControlState } from './session-state';

import './arcade.css';

export function ArcadeRoomPage({ id }: { id: string }) {
  return (
    <ArenaShell>
      <AuthGate>
        <Room id={id} />
      </AuthGate>
    </ArenaShell>
  );
}
function Room({ id }: { id: string }) {
  const { query, command, connected, controllerReady, socketError, sendInput } =
      useArcadeSession(id),
    [confirmEnd, setConfirmEnd] = useState(false),
    [showReplay, setShowReplay] = useState(false);
  const { data: identity } = useSession();
  const completion = arcadeCompletionState(query.data, connected);
  const replay = useQuery({
    queryKey: ['arena-arcade-replay', identity?.user.id, id],
    queryFn: () =>
      apiGet<ArcadeReplayV2>(
        `/api/arena/arcade-sessions/${encodeURIComponent(id)}/replay`
      ),
    enabled: showReplay && completion.archiveReady,
  });
  const snapshot = query.data;
  if (query.isPending) return <Loading />;
  if (!snapshot) return <ErrorNotice error={query.error} />;
  const human = snapshot.runs.some((run) => run.controller.kind === 'human'),
    finished = snapshot.status === 'finished',
    controls = arcadeControlState(snapshot, connected, controllerReady);
  const pauseNotice =
    snapshot.status === 'paused' &&
    (snapshot.error === 'Paused by user'
      ? a('paused')
      : snapshot.error ===
          'The human controller disconnected. Reconnect and resume.'
        ? a('paused_disconnected')
        : '');
  const decisions = snapshot.events
    .filter((event) => event.type === 'decision')
    .slice(-30)
    .reverse();
  return (
    <>
      <div className="arena-room-breadcrumb">
        <Link href="/history">
          <ArrowLeft size={15} />
          {t('nav.history')}
        </Link>
        <span>/</span>
        <span>{a(`game.${snapshot.gameId}`)}</span>
        <code>#{id.slice(0, 8)}</code>
      </div>
      <div className="arcade-room-title">
        <div>
          <div className="arcade-eyebrow">
            <Radio size={14} />
            {a('eyebrow')}
          </div>
          <h1>
            {a(`game.${snapshot.gameId}`)} <span>{a('room_title')}</span>
          </h1>
          <p>
            <ShieldCheck size={14} />
            {a('saved_note')}
          </p>
        </div>
        <div className="arcade-clock">
          <small>{a('game_time')}</small>
          <strong>
            {(snapshot.tick / 60).toFixed(1)}{' '}
            <span>/ {snapshot.limits.maxTicks / 60}s</span>
          </strong>
          <div>
            <i
              style={{
                width: `${Math.min(100, (snapshot.tick / snapshot.limits.maxTicks) * 100)}%`,
              }}
            />
          </div>
        </div>
      </div>
      <ErrorNotice
        providers={snapshot.runs.map((run) => run.controller.profile?.provider)}
        error={
          query.error ||
          command.error ||
          socketError ||
          (!pauseNotice && snapshot.error)
        }
      />
      {snapshot.runs.some((run) => run.controller.kind === 'ai') && (
        <p className="arcade-control-help">{a('thinking_disabled_room')}</p>
      )}
      {pauseNotice && (
        <p className="arcade-control-help" role="status">
          {pauseNotice}
        </p>
      )}
      <div className="arcade-session-toolbar">
        <span
          className={
            connected || completion.archiveReady
              ? 'arcade-connection connected'
              : 'arcade-connection'
          }
        >
          <i />
          {a(
            completion.settling
              ? 'settling'
              : completion.archiveReady
                ? 'saved'
                : connected
                  ? 'connected'
                  : 'reconnecting'
          )}
        </span>
        <span className="arena-tag">{a('standard')} · 60 Hz</span>
        <span className="arcade-toolbar-spacer" />
        {!finished && (
          <>
            {snapshot.status === 'running' ? (
              <Button
                className="arena-button secondary"
                disabled={command.isPending}
                onClick={() => command.mutate('pause')}
              >
                <Pause size={16} />
                {a('pause')}
              </Button>
            ) : (
              <Button
                className="arena-button"
                disabled={command.isPending || !controls.enabled}
                onClick={() => command.mutate(controls.command)}
              >
                <Play size={16} />
                {a(controls.command)}
              </Button>
            )}
            <Button
              variant="ghost"
              disabled={command.isPending}
              onClick={() => setConfirmEnd(true)}
            >
              <Square size={14} />
              {a('end')}
            </Button>
          </>
        )}
        {finished && (
          <Link
            className="arena-button"
            href={`/arcade/new?game=${snapshot.gameId}`}
          >
            {a('challenge_again')}
          </Link>
        )}
        {finished && (
          <Button
            className="arena-button secondary"
            disabled={!completion.archiveReady}
            onClick={() => setShowReplay(!showReplay)}
          >
            <RotateCcw size={16} />
            {showReplay ? t('room.back_board') : a('replay')}
          </Button>
        )}
      </div>
      {completion.settling && (
        <p className="arcade-control-help" role="status">
          {a('finished_settling')}
        </p>
      )}
      {!finished && snapshot.status !== 'running' && controls.waiting && (
        <p className="arcade-control-help" role="status">
          {a('wait_settle')}
        </p>
      )}
      {!finished && controls.command === 'retry' && (
        <p className="arcade-notice">{a('retry_note')}</p>
      )}
      {confirmEnd && (
        <div className="arena-end-confirm">
          <p>{a('end_confirm')}</p>
          <Button
            variant="destructive"
            disabled={command.isPending}
            onClick={() =>
              command.mutate('end', { onSuccess: () => setConfirmEnd(false) })
            }
          >
            {a('end')}
          </Button>
          <Button variant="ghost" onClick={() => setConfirmEnd(false)}>
            {a('cancel')}
          </Button>
        </div>
      )}
      {finished && (
        <div className="arena-winner arcade-winner">
          <span>
            <Trophy size={28} />
          </span>
          <div>
            <small>{a('result')}</small>
            <h2>{arcadeResult(snapshot.result)}</h2>
            <p>
              {snapshot.result?.scores
                .map(
                  (score, index) =>
                    `${a(snapshot.runs.length === 1 ? 'score' : index === 0 ? 'left' : 'right')}: ${score.points}`
                )
                .join('  ·  ')}
            </p>
          </div>
        </div>
      )}
      {finished && (
        <section className="arena-panel arcade-score-summary">
          <h3>{arcadeReason(snapshot.result?.reason)}</h3>
          <p>{a(`comparison.${snapshot.gameId}`)}</p>
          <div className="arcade-score-tracks">
            {snapshot.runs.map((run, index) => (
              <div key={run.id}>
                <strong>
                  {a(
                    snapshot.runs.length === 1
                      ? 'single_lane'
                      : index === 0
                        ? 'left'
                        : 'right'
                  )}{' '}
                  ·{' '}
                  {run.controller.profile?.name ||
                    a(run.controller.kind === 'ai' ? 'ai' : 'you')}
                </strong>
                <ScoreBreakdown
                  score={run.view.score}
                  reason={run.view.reason}
                />
              </div>
            ))}
          </div>
        </section>
      )}
      {showReplay && completion.archiveReady ? (
        <>
          <ErrorNotice error={replay.error} />
          {replay.data ? (
            <ArcadeReplayPlayer replay={replay.data} />
          ) : (
            <Loading />
          )}
        </>
      ) : (
        <div
          className={
            snapshot.runs.length === 1 ? 'arcade-runs solo' : 'arcade-runs'
          }
        >
          {snapshot.runs.map((run, index) => (
            <RunPanel
              key={run.id}
              run={run}
              index={index}
              single={snapshot.runs.length === 1}
              status={snapshot.status}
              enabled={controllerReady && run.controller.kind === 'human'}
              onInput={run.controller.kind === 'human' ? sendInput : undefined}
              onPause={() => {
                if (snapshot.status === 'running') command.mutate('pause');
              }}
            />
          ))}
        </div>
      )}
      <div className="arcade-room-footnote">
        <span>
          <Clock3 size={14} />
          {a('live_note')}
        </span>
        <span>
          <code>
            {a('seed')}: {snapshot.seed.slice(0, 32)}
          </code>
        </span>
      </div>
      {human && (
        <p className="arcade-control-help">
          {a(`controls.${snapshot.gameId}`)}
          <br />
          {a('release_note')}
        </p>
      )}
      {snapshot.runs.some((run) => run.controller.kind === 'ai') && (
        <div className="arcade-model-panels">
          {snapshot.runs
            .filter((run) => run.controller.kind === 'ai')
            .map((run) => (
              <section className="arena-panel arcade-model-panel" key={run.id}>
                <header>
                  <Bot size={18} />
                  <h2>{run.controller.profile?.name || a('ai')}</h2>
                  <code>
                    {run.calls} / {snapshot.limits.maxCallsPerRun}
                  </code>
                </header>
                {run.lastDecision ? (
                  <>
                    <PrivateArcadeReasoning
                      reasoning={run.lastDecision.reasoning}
                      metrics={run.lastDecision.metrics}
                    />
                    <div className="arena-metric-line">
                      <span>{t('room.actual_model')}</span>
                      <strong>
                        {run.lastDecision.metrics?.actualModel ||
                          a('not_returned')}
                      </strong>
                    </div>
                    <div className="arena-metric-line">
                      <span>{t('room.usage')}</span>
                      <strong>
                        {run.lastDecision.metrics?.usage
                          ? Object.entries(run.lastDecision.metrics.usage)
                              .map(([key, value]) => `${key}: ${value}`)
                              .join(' · ')
                          : a('not_returned')}
                      </strong>
                    </div>
                    <p className="arcade-caption">
                      {run.lastDecision.observedTick} →{' '}
                      {run.lastDecision.appliedTick ?? '—'} tick ·{' '}
                      {run.lastDecision.outcome}
                    </p>
                  </>
                ) : (
                  <p className="arcade-caption">{a('log_empty')}</p>
                )}
              </section>
            ))}
        </div>
      )}
      {decisions.length > 0 && (
        <section className="arena-panel arcade-log">
          <h2>{a('log')}</h2>
          {decisions.map((event) => (
            <div className="arcade-log-entry" key={event.seq}>
              <span>
                #{event.seq}
                <small>{(event.tick / 60).toFixed(1)}s</small>
              </span>
              <div>
                <strong>
                  {snapshot.runs.find((run) => run.id === event.runId)
                    ?.controller.profile?.name || a('ai')}{' '}
                  · {event.actionId || event.outcome}
                </strong>
                <small>
                  {event.metrics
                    ? `${(event.metrics.elapsedMs / 1000).toFixed(2)}s`
                    : a('not_returned')}
                </small>
                {modelErrorKind(event.message, [snapshot.runs.find((run) => run.id === event.runId)?.controller.profile?.provider]) && (
                  <small>{modelErrorText(event.message, [snapshot.runs.find((run) => run.id === event.runId)?.controller.profile?.provider])}</small>
                )}
                <PrivateArcadeReasoning
                  reasoning={event.reasoning}
                  metrics={event.metrics}
                  compact
                />
              </div>
            </div>
          ))}
        </section>
      )}
      {finished && <ArcadePublish id={id} ready={completion.archiveReady} />}
    </>
  );
}
function ArcadePublish({ id, ready }: { id: string; ready: boolean }) {
  const router = useRouter();
  const mutation = useMutation({
    mutationFn: (data: { title: string; description: string }) =>
      apiPost<{ id: string }>('/api/arena/community', { matchId: id, ...data }),
    onSuccess: (post) => router.push(`/community/${post.id}`),
  });
  const form = useForm({
    defaultValues: { title: '', description: '' },
    validators: {
      onSubmit: z.object({
        title: z.string().trim().min(3).max(120),
        description: z.string().max(2000),
      }),
    },
    onSubmit: async ({ value }) => {
      if (!ready) return;
      await mutation.mutateAsync(value);
    },
  });
  return (
    <section className="arena-panel arcade-publish">
      <div>
        <Send size={23} />
        <h2>{a('publish')}</h2>
        <p>{a('publish_privacy')}</p>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <form.Field name="title">
          {(field) => (
            <label className="arena-field">
              <span>{a('publish_title')}</span>
              <input
                required
                minLength={3}
                maxLength={120}
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
            </label>
          )}
        </form.Field>
        <form.Field name="description">
          {(field) => (
            <label className="arena-field">
              <span>{a('publish_notes')}</span>
              <textarea
                maxLength={2000}
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
            </label>
          )}
        </form.Field>
        <ErrorNotice error={mutation.error} />
        <SubmitButton
          type="submit"
          pending={mutation.isPending}
          disabled={!ready}
        >
          {a('publish_submit')}
          <Send size={15} />
        </SubmitButton>
      </form>
    </section>
  );
}
