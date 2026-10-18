import type {
  ArcadeConfig,
  ArcadeEvent,
  ArcadeRunSnapshot,
  ArcadeView,
  TetrisGoal,
} from '@decision-arena/core';

import { a } from './messages';
import { m } from '@/paraglide/messages.js';
import {
  currentTetrisGoal,
  displayedTetrisVersion,
  TETRIS_V8,
} from './tetris-harness';

export function TetrisHarnessNotice({ config }: { config: ArcadeConfig }) {
  const version = displayedTetrisVersion(config);
  return (
    <section className="arcade-tetris-harness">
      <strong>
        {a('tetris.harness')} ·{' '}
        {a(version === TETRIS_V8 ? 'tetris.v8' : 'tetris.baseline')}
      </strong>
      {version === TETRIS_V8 && (
        <p><strong>{m['arcade.tetris.shared_scheme']()}</strong></p>
      )}
      <p>
        {a(version === TETRIS_V8 ? 'tetris.v8_note' : 'tetris.baseline_note')}
      </p>
      <small>
        {a('tetris.frozen')} <code>{version}</code>
      </small>
    </section>
  );
}

export function TetrisPlanningPanel({
  view,
  goal,
  inflight,
  lastDecision,
}: {
  view: ArcadeView;
  goal?: TetrisGoal | null;
  inflight?: ArcadeRunSnapshot['inflight'];
  lastDecision?: ArcadeRunSnapshot['lastDecision'] | ArcadeEvent;
}) {
  const current = currentTetrisGoal(view, goal);
  const column = view.active?.cells.length
    ? Math.min(...view.active.cells.map((cell) => cell.x))
    : undefined;
  const rotation = view.active?.rotation;
  const stage = inflight?.decisionStage ?? lastDecision?.decisionStage;
  return (
    <section
      className="arcade-tetris-planning"
      aria-label={a('tetris.planning')}
    >
      <header>
        <strong>{a('tetris.planning')}</strong>
        <span>
          {a('tetris.piece')} #{view.pieceId ?? '—'} ·{' '}
          {view.active?.type || '—'}
        </span>
      </header>
      <dl>
        <div>
          <dt>{a('tetris.current_pose')}</dt>
          <dd>
            {a('tetris.column')} {column ?? '—'} · {a('tetris.rotation')}{' '}
            {rotation ?? a('not_returned')}
          </dd>
        </div>
        <div>
          <dt>{a('tetris.target')}</dt>
          <dd>
            {current
              ? `${a('tetris.column')} ${current.leftmostColumn} · ${a('tetris.rotation')} ${current.rotation}`
              : a('tetris.no_target')}
          </dd>
        </div>
        <div>
          <dt>{a('tetris.stage')}</dt>
          <dd>
            {stage ? a(`tetris.stage.${stage}`) : a('none')}
            {inflight
              ? ` · ${a('model_pending')}`
              : lastDecision?.outcome
                ? ` · ${a(`outcome.${lastDecision.outcome}`)}`
                : ''}
          </dd>
        </div>
      </dl>
      <p>{a('tetris.coordinates')}</p>
      <small>{a('tetris.conditional')}</small>
    </section>
  );
}
