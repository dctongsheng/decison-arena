import type {
  ArcadeConfig,
  ArcadeEvent,
  ArcadeGameId,
  ArcadeView,
  ModelProfile,
  TetrisGoal,
  TetrisHarnessVersion,
} from '@decision-arena/core';
import { supportsDecisionImages } from '@decision-arena/providers';

export const TETRIS_BASELINE: TetrisHarnessVersion =
  'tetris-harness-baseline-v1';
export const TETRIS_V8: TetrisHarnessVersion = 'tetris-harness-v8-realtime-v1';

/** Interpret legacy recordings without adding metadata to the original object. */
export function displayedTetrisVersion(
  config: ArcadeConfig
): TetrisHarnessVersion {
  return config.tetrisHarnessVersion ?? TETRIS_BASELINE;
}

/** New sessions default to V8; a clone keeps its source's historical meaning. */
export function tetrisCreationVersion(
  sourceConfig?: ArcadeConfig
): TetrisHarnessVersion {
  return sourceConfig === undefined ? TETRIS_V8 : displayedTetrisVersion(sourceConfig);
}

export function arcadeFormConfig(
  gameId: ArcadeGameId,
  level: string,
  version: TetrisHarnessVersion
): ArcadeConfig {
  if (gameId === 'tetris') return { tetrisHarnessVersion: version };
  if (gameId === 'platformer') return { level: Number(level) as 1 | 2 | 3 };
  return {};
}

export function tetrisModelAllowed(
  gameId: ArcadeGameId,
  version: TetrisHarnessVersion,
  provider: string,
  model: string
): boolean {
  return (
    gameId !== 'tetris' ||
    version !== TETRIS_V8 ||
    supportsDecisionImages({ provider: provider as ModelProfile['provider'], model })
  );
}

export type ArcadeModelDisabledReason = 'bamboo' | 'unavailable' | 'v8';

/** Keep inaccessible models visible without allowing them to start a run. */
export function arcadeModelChoices<T extends {
  provider: string;
  model: string;
  available?: boolean;
  source?: 'manual' | 'bamboonode';
}>(
  models: T[] | undefined,
  gameId: ArcadeGameId,
  version: TetrisHarnessVersion,
  requiredProvider?: string,
  frozenModel?: string
) {
  return (models || [])
    .filter((model) => !requiredProvider || model.provider === requiredProvider)
    .map((model) => {
      const reasons: ArcadeModelDisabledReason[] = [];
      if (model.available === false)
        reasons.push(
          model.source === 'bamboonode' || model.provider.startsWith('bamboonode-')
            ? 'bamboo'
            : 'unavailable'
        );
      if (!tetrisModelAllowed(gameId, version, model.provider, frozenModel ?? model.model)) reasons.push('v8');
      return { model, reasons };
    });
}

/** Rendering never computes or chooses a destination; it only reads Decision's saved target. */
export function currentTetrisGoal(
  view: ArcadeView,
  goal?: TetrisGoal | null
): TetrisGoal | null {
  if (
    view.gameId !== 'tetris' ||
    view.status !== 'playing' ||
    !goal ||
    goal.pieceId !== view.pieceId ||
    !Number.isInteger(goal.leftmostColumn) ||
    goal.leftmostColumn < 0 ||
    goal.leftmostColumn > 9 ||
    ![0, 1, 2, 3].includes(goal.rotation)
  )
    return null;
  return {
    pieceId: goal.pieceId,
    leftmostColumn: goal.leftmostColumn,
    rotation: goal.rotation,
  };
}

export function replayTetrisDecision(
  events: ArcadeEvent[],
  runId: string,
  tick: number
) {
  return events
    .filter(
      (event) =>
        event.type === 'decision' &&
        event.runId === runId &&
        (event.settledTick ?? event.tick) <= tick
    )
    .sort((a, b) => b.seq - a.seq)[0];
}

export function replayTetrisGoal(
  events: ArcadeEvent[],
  runId: string,
  tick: number,
  view: ArcadeView
): TetrisGoal | null {
  const update = events
    .filter(
      (event) =>
        event.type === 'decision' &&
        event.runId === runId &&
        event.decisionStage === 'target' &&
        event.outcome === 'applied' &&
        (event.settledTick ?? event.tick) <= tick &&
        event.tetrisGoal !== undefined
    )
    .sort((a, b) => b.seq - a.seq)[0];
  return currentTetrisGoal(view, update?.tetrisGoal);
}
