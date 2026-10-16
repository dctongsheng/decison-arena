import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ArcadeReplayV2 } from '@decision-arena/core';
import {
  Pause,
  Play,
  SkipBack,
  SkipForward,
  StepBack,
  StepForward,
} from 'lucide-react';

import { Button } from '@/components/ui/button';

import { ArcadeCanvas } from './canvas';
import { a } from './messages';
import { createArcadeReplayReader } from './replay-engine';
import {
  adjacentReplayMarker,
  arcadeReplayMarkers,
  type ReplayMarker,
} from './replay-markers';
import { ReplayTimeline } from './replay-timeline';
import { ScoreBreakdown } from './score';

import './arcade.css';

export function ArcadeReplayPlayer({ replay }: { replay: ArcadeReplayV2 }) {
  const reader = useMemo(() => createArcadeReplayReader(replay), [replay]),
    markers = useMemo(() => arcadeReplayMarkers(replay), [replay]),
    [selectedId, setSelectedId] = useState<string | null>(null),
    [tick, setTick] = useState(0),
    [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState(1),
    cursor = useRef(0);
  useEffect(() => {
    setPlaying(false);
    setTick(0);
    setSelectedId(null);
    cursor.current = 0;
  }, [replay.matchId]);
  useEffect(() => {
    if (!playing) return;
    let last = 0,
      handle = 0;
    const advance = (time: number) => {
      if (last)
        cursor.current = Math.min(
          reader.lastTick,
          cursor.current + ((Math.min(100, time - last) * 60) / 1000) * speed
        );
      last = time;
      setTick(Math.floor(cursor.current));
      if (cursor.current >= reader.lastTick) {
        setPlaying(false);
        return;
      }
      handle = requestAnimationFrame(advance);
    };
    handle = requestAnimationFrame(advance);
    return () => cancelAnimationFrame(handle);
  }, [playing, speed, reader]);
  const seek = useCallback((next: number) => {
    cursor.current = next;
    setTick(next);
    setPlaying(false);
    setSelectedId(null);
  }, []);
  const selectMarker = useCallback(
    (marker: ReplayMarker) => {
      seek(Math.min(reader.lastTick, marker.tick));
      setSelectedId(marker.id);
    },
    [seek, reader.lastTick]
  );
  const previous = adjacentReplayMarker(markers, tick, selectedId, -1);
  const next = adjacentReplayMarker(markers, tick, selectedId, 1);
  const views = reader.read(tick);
  return (
    <div className="arcade-replay">
      <div className="arcade-replay-heading">
        <span>{a('replay_title')}</span>
        <code>
          {(tick / 60).toFixed(1)} / {(reader.lastTick / 60).toFixed(1)} s
        </code>
      </div>
      <div
        className={
          views.length === 1
            ? 'arcade-replay-tracks solo'
            : 'arcade-replay-tracks'
        }
      >
        {views.map((view, index) => (
          <div key={index}>
            <header>
              <strong>
                {replay.controllers[index]?.profile?.name ||
                  a(replay.controllers[index]?.kind === 'ai' ? 'ai' : 'you')}
              </strong>
              <span>
                {a('score')} {view.score.points}
              </span>
            </header>
            <ScoreBreakdown score={view.score} reason={view.reason} />
            <ArcadeCanvas
              view={view}
              label={`${a(views.length === 1 ? 'single_lane' : index === 0 ? 'left' : 'right')} ${a(`game.${replay.gameId}`)}`}
            />
          </div>
        ))}
      </div>
      <div className="arcade-replay-controls">
        <Button
          size="icon"
          variant="ghost"
          aria-label={a('replay_first')}
          onClick={() => seek(0)}
        >
          <SkipBack size={17} />
        </Button>
        <Button
          size="icon"
          aria-label={a(playing ? 'replay_pause' : 'replay_play')}
          onClick={() => {
            if (tick >= reader.lastTick) {
              cursor.current = 0;
              setTick(0);
            }
            setSelectedId(null);
            setPlaying(!playing);
          }}
        >
          {playing ? <Pause size={17} /> : <Play size={17} />}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label={a('replay_end')}
          onClick={() => seek(reader.lastTick)}
        >
          <SkipForward size={17} />
        </Button>
        <input
          type="range"
          aria-label={a('replay_progress')}
          min={0}
          max={Math.max(1, reader.lastTick)}
          value={tick}
          onChange={(event) => seek(Number(event.target.value))}
        />
        <select
          aria-label={a('replay_speed')}
          value={speed}
          onChange={(event) => setSpeed(Number(event.target.value))}
        >
          {[0.5, 1, 2, 4].map((value) => (
            <option key={value} value={value}>
              {value}×
            </option>
          ))}
        </select>
      </div>
      <div className="arcade-replay-event-controls">
        <Button
          variant="outline"
          disabled={!previous}
          onClick={() => previous && selectMarker(previous)}
        >
          <StepBack size={16} />
          {a('replay_previous_event')}
        </Button>
        <Button
          variant="outline"
          disabled={!next}
          onClick={() => next && selectMarker(next)}
        >
          {a('replay_next_event')}
          <StepForward size={16} />
        </Button>
      </div>
      <ReplayTimeline
        key={replay.matchId}
        markers={markers}
        selectedId={selectedId}
        onSelect={selectMarker}
      />
      <p className="arcade-notice">{a(`comparison.${replay.gameId}`)}</p>
      {!reader.compatible && (
        <p className="arcade-notice">{a('replay_version_fallback')}</p>
      )}
      <div className="arcade-room-footnote">
        <span>{replay.rulesVersion}</span>
        <span>
          {a('seed')}: {replay.seed.slice(0, 32)}
        </span>
      </div>
    </div>
  );
}
