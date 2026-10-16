import type { ArcadeAdapter, ArcadeGameId } from '@decision-arena/core';
import { snake } from './snake';
import { tetris } from './tetris';
import { platformer } from './platformer';

export const arcadeGames: readonly ArcadeAdapter[] = Object.freeze([snake, tetris, platformer]);
export function getArcadeGame(id: ArcadeGameId | string): ArcadeAdapter {
  const game = arcadeGames.find(entry => entry.id === id);
  if (!game) throw new Error('未知实时游戏');
  return game;
}
export { snake, tetris, platformer };
export type { SnakeState } from './snake';
export type { TetrisState } from './tetris';
export type { PlatformerState } from './platformer';
export { ARCADE_PROMPT_VERSION, arcadeDecisionInstructions } from './decision';
