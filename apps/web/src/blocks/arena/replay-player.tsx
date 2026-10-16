import { useEffect, useState } from 'react';
import type { ReplayManifest } from '@decision-arena/core';
import {
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  SkipBack,
  SkipForward,
} from 'lucide-react';

import { Board } from '@/components/arena/board';
import { Button } from '@/components/ui/button';

import { gameName, resultName, t } from './shared';

export function ReplayPlayer({ replay }: { replay: ReplayManifest }) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(
      () =>
        setIndex((current) => {
          if (current >= replay.frames.length - 1) {
            setPlaying(false);
            return current;
          }
          return current + 1;
        }),
      1000
    );
    return () => clearInterval(id);
  }, [playing, replay.frames.length]);
  const view = replay.frames[index];
  if (!view) return <p>{t('replay.empty')}</p>;
  const event = replay.events.filter((e) => e.type === 'action')[
    Math.max(0, index - 1)
  ];
  return (
    <div className="arena-replay-player">
      <div className="arena-replay-bar">
        <span>
          {gameName(replay.gameId)}
          <span className="arena-tag">{t('replay.label')}</span>
        </span>
        <strong>
          {index} / {replay.frames.length - 1}
        </strong>
      </div>
      <Board
        view={view}
        lastTo={index > 0 ? event?.action?.to : undefined}
        labels={{
          board: t('board.label'),
          empty: t('board.empty'),
          hidden: t('board.hidden'),
          river: t('board.river'),
          camp: t('board.camp'),
        }}
      />
      <div className="arena-replay-controls">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
            setIndex(0);
            setPlaying(false);
          }}
          aria-label={t('replay.first')}
        >
          <SkipBack size={17} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          disabled={index === 0}
          onClick={() => {
            setIndex(Math.max(0, index - 1));
            setPlaying(false);
          }}
          aria-label={t('replay.previous')}
        >
          <ChevronLeft size={19} />
        </Button>
        <Button
          className="arena-replay-play"
          size="icon"
          onClick={() => {
            if (index === replay.frames.length - 1) setIndex(0);
            setPlaying(!playing);
          }}
          aria-label={t(playing ? 'replay.pause' : 'replay.play')}
        >
          {playing ? <Pause size={17} /> : <Play size={17} />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          disabled={index === replay.frames.length - 1}
          onClick={() => {
            setIndex(Math.min(replay.frames.length - 1, index + 1));
            setPlaying(false);
          }}
          aria-label={t('replay.next')}
        >
          <ChevronRight size={19} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
            setIndex(replay.frames.length - 1);
            setPlaying(false);
          }}
          aria-label={t('replay.last')}
        >
          <SkipForward size={17} />
        </Button>
        <span>{index > 0 ? event?.action?.label : t('replay.initial')}</span>
      </div>
      <input
        className="arena-replay-slider"
        type="range"
        min={0}
        max={replay.frames.length - 1}
        value={index}
        aria-label={t('replay.progress')}
        onChange={(e) => {
          setIndex(Number(e.target.value));
          setPlaying(false);
        }}
      />
      <div className="arena-replay-meta">
        <span>{replay.rulesVersion}</span>
        <span>{resultName(replay.result, replay.gameId)}</span>
      </div>
    </div>
  );
}
