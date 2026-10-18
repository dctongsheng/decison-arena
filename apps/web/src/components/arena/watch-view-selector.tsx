import type { Seat } from '@decision-arena/core';

export function WatchViewSelector({ value, onChange, labels }: {
  value: 'full' | Seat;
  onChange: (value: 'full' | Seat) => void;
  labels: { title: string; full: string; seat0: string; seat1: string; help: string };
}) {
  return (
    <div className="arena-watch-view">
      <div className="arena-watch-view-options" role="group" aria-label={labels.title}>
        <span>{labels.title}</span>
        {(['full', 0, 1] as const).map((seat) => (
          <button type="button" key={seat} aria-pressed={value === seat} onClick={() => onChange(seat)}>
            {seat === 'full' ? labels.full : seat === 0 ? labels.seat0 : labels.seat1}
          </button>
        ))}
      </div>
      <p>{labels.help}</p>
    </div>
  );
}
