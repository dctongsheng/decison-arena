import type { ArcadeButton, ArcadeGameId } from '@decision-arena/core';

export function keyButton(
  game: ArcadeGameId,
  code: string
): ArcadeButton | undefined {
  if (code === 'ArrowLeft' || code === 'KeyA') return 'left';
  if (code === 'ArrowRight' || code === 'KeyD') return 'right';
  if (game === 'snake') {
    if (code === 'ArrowUp' || code === 'KeyW') return 'up';
    if (code === 'ArrowDown' || code === 'KeyS') return 'down';
  }
  if (game === 'tetris') {
    if (code === 'ArrowUp' || code === 'KeyW' || code === 'KeyX')
      return 'rotate-cw';
    if (code === 'KeyZ') return 'rotate-ccw';
    if (code === 'ArrowDown' || code === 'KeyS') return 'soft-drop';
    if (code === 'Space') return 'hard-drop';
    if (code === 'KeyC' || code === 'ShiftLeft' || code === 'ShiftRight')
      return 'hold';
  }
  if (
    game === 'platformer' &&
    (code === 'ArrowUp' || code === 'KeyW' || code === 'Space')
  )
    return 'jump';
  return undefined;
}
export function isTypingTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

/** Snake has one directional key; newer keys replace an older held direction. */
export function arcadeButtons(
  game: ArcadeGameId,
  buttons: ArcadeButton[]
): ArcadeButton[] {
  const unique = [...new Set(buttons)];
  return game === 'snake' ? unique.slice(-1) : unique;
}
