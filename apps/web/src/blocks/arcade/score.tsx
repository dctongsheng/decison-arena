import type { ArcadeScore } from '@decision-arena/core';

import { a } from './messages';

export function arcadeReason(reason?: string) {
  if (!reason) return '';
  const key = `reason.${reason.toUpperCase()}`;
  const label = a(key);
  return label === key ? reason : label;
}

export function ScoreBreakdown({
  score,
  reason,
}: {
  score: ArcadeScore;
  reason?: string;
}) {
  const values: [string, string | number][] = [['score', score.points]];
  if (score.food !== undefined) values.push(['fruit', score.food]);
  if (score.lines !== undefined) values.push(['lines', score.lines]);
  if (score.progress !== undefined)
    values.push(['distance', `${score.progress.toFixed(2)}%`]);
  if (score.coins !== undefined) values.push(['coins', score.coins]);
  if (score.completed !== undefined)
    values.push(['completed', a(score.completed ? 'yes' : 'no')]);
  values.push(['survived', `${(score.survivedTicks / 60).toFixed(2)} s`]);
  return (
    <div className="arcade-score-breakdown">
      <dl>
        {values.map(([key, value]) => (
          <div key={key}>
            <dt>{a(key)}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {reason && <p>{arcadeReason(reason)}</p>}
    </div>
  );
}
