import { memo, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { Button } from '@/components/ui/button';

import { a } from './messages';
import type { ReplayMarker } from './replay-markers';
import { arcadeReason } from './score';

const keyLabels: Record<string, string> = {
  up: 'up_key',
  down: 'down_key',
  left: 'left_key',
  right: 'right_key',
  'rotate-cw': 'rotate_key',
  'rotate-ccw': 'rotate_ccw_key',
  'soft-drop': 'down_key',
  'hard-drop': 'drop_key',
  hold: 'hold_key',
  jump: 'jump_key',
};
const PAGE_SIZE = 40;

/** Memoized so 60 Hz playback does not rebuild the event list. */
export const ReplayTimeline = memo(function ReplayTimeline({
  markers,
  selectedId,
  onSelect,
}: {
  markers: ReplayMarker[];
  selectedId: string | null;
  onSelect: (marker: ReplayMarker) => void;
}) {
  const [page, setPage] = useState(0);
  useEffect(() => {
    const index = markers.findIndex((marker) => marker.id === selectedId);
    if (index >= 0) setPage(Math.floor(index / PAGE_SIZE));
  }, [markers, selectedId]);
  const pages = Math.max(1, Math.ceil(markers.length / PAGE_SIZE));
  return (
    <section className="arcade-replay-timeline">
      <header>
        <strong>{a('replay_events')}</strong>
        <span>
          {markers.length} {a('replay_event_count')}
        </span>
      </header>
      <ol>
        {markers
          .slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
          .map((marker) => (
            <li key={marker.id}>
              <button
                type="button"
                className={selectedId === marker.id ? 'selected' : ''}
                aria-current={selectedId === marker.id ? 'step' : undefined}
                onClick={() => onSelect(marker)}
              >
                <code>
                  {(marker.tick / 60).toFixed(2)}s <small>t{marker.tick}</small>
                </code>
                <span>
                  <strong>
                    {marker.runIndex !== undefined
                      ? `${a(marker.runIndex === 0 ? 'left' : 'right')} · `
                      : ''}
                    {a(`event.${marker.kind}`)}
                  </strong>
                  <small>
                    {marker.kind === 'input'
                      ? `${a('event.applied_tick')} ${marker.appliedTick} · ${marker.buttons?.length ? marker.buttons.map((button) => a(keyLabels[button])).join(' + ') : a('event.release')}`
                      : marker.kind === 'decision'
                        ? `${a('event.returned_tick')} ${marker.tick}${marker.outcome ? ` · ${a(`outcome.${marker.outcome}`)}` : ''}`
                        : marker.reason
                          ? arcadeReason(marker.reason)
                          : ''}
                  </small>
                </span>
                {marker.kind === 'decision' && (
                  <span className="arcade-marker-metrics">
                    <strong>
                      {marker.elapsedMs === undefined
                        ? a('not_returned')
                        : `${(marker.elapsedMs / 1000).toFixed(2)}s`}
                    </strong>
                    <small>{marker.actualModel || a('not_returned')}</small>
                  </span>
                )}
              </button>
            </li>
          ))}
      </ol>
      {!markers.length && <p>{a('log_empty')}</p>}
      {pages > 1 && (
        <footer>
          <Button
            variant="ghost"
            size="icon"
            aria-label={a('replay_event_page_previous')}
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            <ChevronLeft size={16} />
          </Button>
          <span>
            {page + 1} / {pages}
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label={a('replay_event_page_next')}
            disabled={page >= pages - 1}
            onClick={() => setPage(page + 1)}
          >
            <ChevronRight size={16} />
          </Button>
        </footer>
      )}
    </section>
  );
});
