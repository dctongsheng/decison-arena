import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ArcadeButton,
  ArcadeInput,
  ArcadeRunSnapshot,
  ArcadeStatus,
  TetrisHarnessVersion,
} from '@decision-arena/core';
import {
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bot,
  ChevronDown,
  Gamepad2,
  RotateCcw,
  RotateCw,
} from 'lucide-react';

import { ArcadeCanvas } from './canvas';
import { arcadeButtons, isTypingTarget, keyButton } from './input';
import { a } from './messages';
import type { LocalArcadeInput } from './render-state';
import { arcadeReason } from './score';
import { TETRIS_V8 } from './tetris-harness';
import { TetrisPlanningPanel } from './tetris-planning';

export function RunPanel({
  run,
  index,
  status,
  single = false,
  enabled = false,
  onInput,
  onPause,
  tetrisHarnessVersion,
}: {
  run: ArcadeRunSnapshot;
  index: number;
  status: ArcadeStatus;
  single?: boolean;
  enabled?: boolean;
  onInput?: (input: ArcadeInput) => boolean;
  onPause?: () => void;
  tetrisHarnessVersion?: TetrisHarnessVersion;
}) {
  const [focused, setFocused] = useState(false),
    held = useRef(new Map<string, ArcadeButton>()),
    localInputs = useRef<LocalArcadeInput[]>([]),
    inputSeq = useRef(0),
    surface = useRef<HTMLDivElement>(null);
  const playing =
    enabled && status === 'running' && run.view.status === 'playing';
  const submitInput = useCallback(
    (input: ArcadeInput) => {
      if (onInput?.(input))
        localInputs.current = [
          ...localInputs.current.slice(-63),
          {
            seq: ++inputSeq.current,
            at: performance.now(),
            input: structuredClone(input),
          },
        ];
    },
    [onInput]
  );
  const flush = useCallback(() => {
    submitInput({
      buttons: arcadeButtons(run.view.gameId, [...held.current.values()]),
    });
  }, [submitInput, run.view.gameId]);
  const release = useCallback(() => {
    if (held.current.size) {
      held.current.clear();
      submitInput({ buttons: [] });
    }
  }, [submitInput]);
  useEffect(() => {
    const blur = () => {
      release();
      setFocused(false);
    };
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('blur', blur);
      release();
    };
  }, [release]);
  useEffect(() => {
    if (!playing) release();
  }, [playing, release]);
  const controls: {
    button: ArcadeButton;
    label: string;
    Icon: typeof ArrowUp;
  }[] =
    run.view.gameId === 'snake'
      ? [
          { button: 'left', label: 'left_key', Icon: ArrowLeft },
          { button: 'up', label: 'up_key', Icon: ArrowUp },
          { button: 'down', label: 'down_key', Icon: ArrowDown },
          { button: 'right', label: 'right_key', Icon: ArrowRight },
        ]
      : run.view.gameId === 'tetris'
        ? [
            { button: 'left', label: 'left_key', Icon: ArrowLeft },
            { button: 'rotate-ccw', label: 'rotate_ccw_key', Icon: RotateCcw },
            { button: 'rotate-cw', label: 'rotate_key', Icon: RotateCw },
            { button: 'soft-drop', label: 'down_key', Icon: ArrowDown },
            { button: 'right', label: 'right_key', Icon: ArrowRight },
            { button: 'hard-drop', label: 'drop_key', Icon: ChevronDown },
            { button: 'hold', label: 'hold_key', Icon: Archive },
          ]
        : [
            { button: 'left', label: 'left_key', Icon: ArrowLeft },
            { button: 'right', label: 'right_key', Icon: ArrowRight },
            { button: 'jump', label: 'jump_key', Icon: ArrowUp },
          ];
  return (
    <section
      className={
        index === 0
          ? 'arcade-run arcade-run-left'
          : 'arcade-run arcade-run-right'
      }
    >
      <header>
        <span className="arcade-run-avatar">
          {run.controller.kind === 'ai' ? (
            <Bot size={22} />
          ) : (
            <Gamepad2 size={22} />
          )}
        </span>
        <div>
          <small>
            {a(single ? 'single_lane' : index === 0 ? 'left' : 'right')} ·{' '}
            {a(run.controller.kind === 'ai' ? 'ai' : 'you')}
          </small>
          <strong>
            {run.controller.profile?.name ||
              a(run.controller.kind === 'ai' ? 'ai' : 'you')}
          </strong>
          <span>
            {run.controller.profile?.model || a(`goal.${run.view.gameId}`)}
          </span>
        </div>
        <div className="arcade-score">
          <small>{a('score')}</small>
          <b>{run.view.score.points}</b>
        </div>
      </header>
      <div
        ref={surface}
        className={focused ? 'arcade-surface focused' : 'arcade-surface'}
        tabIndex={run.controller.kind === 'human' ? 0 : undefined}
        aria-label={a(
          `${run.controller.kind === 'human' ? 'controls' : 'game'}.${run.view.gameId}`
        )}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          release();
          setFocused(false);
        }}
        onPointerDown={() => surface.current?.focus()}
        onKeyDown={(event) => {
          if (isTypingTarget(event.target)) return;
          if (event.code === 'Escape') {
            event.preventDefault();
            release();
            onPause?.();
            return;
          }
          const button = keyButton(run.view.gameId, event.code);
          if (!button || !playing) return;
          event.preventDefault();
          if (event.repeat || held.current.has(event.code)) return;
          held.current.set(event.code, button);
          flush();
        }}
        onKeyUp={(event) => {
          if (held.current.delete(event.code)) {
            event.preventDefault();
            flush();
          }
        }}
      >
        <ArcadeCanvas
          view={run.view}
          label={a(`game.${run.view.gameId}`)}
          predictionState={
            run.controller.kind === 'human' ? run.predictionState : undefined
          }
          active={
            run.controller.kind === 'human'
              ? playing
              : status === 'running' && run.view.status === 'playing'
          }
          localInputs={
            run.controller.kind === 'human' ? localInputs : undefined
          }
        />
        {status !== 'running' && (
          <div className="arcade-stage-overlay">
            <span>{a(status)}</span>
            {status === 'ready' && <small>{a('no_inputs')}</small>}
          </div>
        )}
        {status === 'running' && run.view.status === 'finished' && (
          <div className="arcade-stage-overlay">
            <span>
              {a(run.view.score.completed ? 'status.won' : 'status.dead')}
            </span>
            <small>{arcadeReason(run.view.reason)}</small>
          </div>
        )}
      </div>
      <div className="arcade-run-telemetry">
        <span>
          {a('current_action')}
          <strong>
            {run.view.currentButtons.length
              ? run.view.currentButtons.join(' + ')
              : a('none')}
          </strong>
        </span>
        {run.controller.kind === 'ai' ? (
          <>
            <span>
              {a('calls')}
              <strong>{run.calls}</strong>
            </span>
            <span>
              {a('latency')}
              <strong>
                {run.lastDecision?.metrics
                  ? `${(run.lastDecision.metrics.elapsedMs / 1000).toFixed(2)} s`
                  : a('not_returned')}
              </strong>
            </span>
          </>
        ) : (
          <span>
            {a('game_time')}
            <strong>{(run.view.tick / 60).toFixed(1)} s</strong>
          </span>
        )}
      </div>
      {run.view.gameId === 'tetris' && tetrisHarnessVersion === TETRIS_V8 && run.controller.kind === 'ai' && (
        <TetrisPlanningPanel view={run.view} goal={run.tetrisGoal} inflight={run.inflight} lastDecision={run.lastDecision} />
      )}
      {run.controller.kind === 'human' ? (
        <>
          <p className="arcade-focus-note">
            {a(focused ? 'focused' : 'focus')}
          </p>
          <div className="arcade-touch-controls">
            {controls.map(({ button, label, Icon }) => (
              <button
                type="button"
                key={button}
                disabled={!playing}
                aria-label={a(label)}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  held.current.set(`touch:${event.pointerId}`, button);
                  flush();
                }}
                onPointerUp={(event) => {
                  held.current.delete(`touch:${event.pointerId}`);
                  flush();
                }}
                onPointerCancel={(event) => {
                  held.current.delete(`touch:${event.pointerId}`);
                  flush();
                }}
                onLostPointerCapture={(event) => {
                  if (held.current.delete(`touch:${event.pointerId}`)) flush();
                }}
              >
                <Icon size={20} />
                <span>{a(label)}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="arcade-focus-note">
          {run.inflight ? (
            <>
              <i className="arcade-pulse" />
              {a('model_pending')}
            </>
          ) : (
            a('live_note')
          )}
        </p>
      )}
    </section>
  );
}
