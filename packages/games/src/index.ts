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
export { armyTerrain } from './army';
export { gomokuWinningLine } from './gomoku';
export { arcadeGames, getArcadeGame, snake, tetris, platformer } from './arcade';
export type { SnakeState, TetrisState, PlatformerState } from './arcade';
export { ARCADE_PROMPT_VERSION, arcadeDecisionInstructions } from './arcade/decision';
export { DEFAULT_SNAKE_HARNESS, SNAKE_HARNESS_PROTOCOL, SNAKE_HARNESS_VERSIONS, SNAKE_BASELINE_INSTRUCTIONS, SNAKE_REALTIME_INSTRUCTIONS, snakeHarnessVersion, snakeHarnessInstructions, snakeHarnessPosition, rememberSnakeObservation } from './arcade/snake-harness';
export type { SnakePreviousObservation, SnakeVisibleObservation } from './arcade/snake-harness';
