import type { ArcadeGameId, GameId } from '@decision-arena/core';

import { GameArtwork } from '@/components/arena/board';

import { ArcadeArtwork } from './canvas';

export function ActivityArtwork({ gameId }: { gameId: GameId | ArcadeGameId }) {
  return gameId === 'snake' ||
    gameId === 'tetris' ||
    gameId === 'platformer' ? (
    <ArcadeArtwork gameId={gameId} />
  ) : (
    <GameArtwork gameId={gameId} />
  );
}
