import type { GameAdapter, GameId } from '@decision-arena/core';
import { army } from './army';
import { gomoku } from './gomoku';
import { xiangqi } from './xiangqi';

export const games: readonly GameAdapter[] = Object.freeze([army, xiangqi, gomoku]);
export function getGame(id: GameId | string): GameAdapter {
  const game = games.find(entry => entry.id === id);
  if (!game) throw new Error('未知游戏');
  return game;
}
export { armyTerrain, armyWatchView } from './army';
export { gomokuWinningLine } from './gomoku';
export { arcadeGames, getArcadeGame, snake, tetris, platformer } from './arcade';
export type { SnakeState, TetrisState, PlatformerState } from './arcade';
export { ARCADE_PROMPT_VERSION, arcadeDecisionInstructions } from './arcade/decision';
export { DEFAULT_SNAKE_HARNESS, SNAKE_HARNESS_PROTOCOL, SNAKE_HARNESS_VERSIONS, SNAKE_BASELINE_INSTRUCTIONS, SNAKE_REALTIME_INSTRUCTIONS, snakeHarnessVersion, snakeHarnessInstructions, snakeHarnessPosition, rememberSnakeObservation } from './arcade/snake-harness';
export type { SnakePreviousObservation, SnakeVisibleObservation } from './arcade/snake-harness';
export { DEFAULT_TETRIS_HARNESS, TETRIS_HARNESS_VERSIONS, TETRIS_HARNESS_PROTOCOL, TETRIS_BASELINE_INSTRUCTIONS, TETRIS_V8_GOAL_INSTRUCTIONS, TETRIS_V8_ACTION_INSTRUCTIONS, tetrisHarnessVersion, tetrisHarnessInstructions, tetrisHarnessPosition, tetrisGoalScope, tetrisGoalCandidates, applyTetrisGoalChoice, tetrisLandingProjections } from './arcade/tetris-harness';
export type { TetrisGoalMemory, TetrisGoalActionEvidence } from './arcade/tetris-harness';
export { TETRIS_V8_SOURCE_GOAL_INSTRUCTIONS, TETRIS_V8_SOURCE_ACTION_INSTRUCTIONS, TETRIS_V8_SOURCE_STRATEGY_NOTES, TETRIS_V8_ARENA_ADDENDUM } from './arcade/tetris-harness';
export { TETRIS_VISION_VERSION, TETRIS_IMAGE_WIDTH, TETRIS_IMAGE_HEIGHT, renderTetrisObservationPng } from './arcade/tetris-vision';
