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
