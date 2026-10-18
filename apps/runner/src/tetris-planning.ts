import type { TetrisGoalTarget } from '@decision-arena/core';
import type { TetrisGoalMemory } from '@decision-arena/games';

export interface TetrisScope { pieceId: number; pieceType: string; boardKey: string }
export interface TetrisPlan {
  scope: TetrisScope; target: TetrisGoalTarget | null;
  appliedKeyActions: number; lastPlannedKeyActions: number; targetCreatedAt: number | null;
  recentActions: TetrisGoalMemory['recentActions'];
}
export const sameTetrisScope = (a: TetrisScope | undefined, b: TetrisScope) =>
  a?.pieceId === b.pieceId && a.pieceType === b.pieceType && a.boardKey === b.boardKey;
export function scopedTetrisPlan(plan: TetrisPlan | undefined, scope: TetrisScope): TetrisPlan {
  return sameTetrisScope(plan?.scope, scope) ? structuredClone(plan!) : {
    scope, target: null, appliedKeyActions: 0, lastPlannedKeyActions: -1, targetCreatedAt: null, recentActions: [],
  };
}
export const tetrisTargetDue = (plan: TetrisPlan) => plan.lastPlannedKeyActions < 0 || plan.appliedKeyActions - plan.lastPlannedKeyActions >= 4;
export function tetrisPose(position: unknown): { leftmostColumn: number; rotation: 0 | 1 | 2 | 3 } {
  const active = (position as { active: { cells: { x: number }[]; rotation: 0 | 1 | 2 | 3 } }).active;
  return { leftmostColumn: Math.min(...active.cells.map(cell => cell.x)), rotation: active.rotation };
}
export function tetrisMemory(plan: TetrisPlan, position: unknown): TetrisGoalMemory {
  const last = plan.recentActions.at(-1);
  if (last && last.afterLeftmostColumn === undefined) {
    const pose = tetrisPose(position);
    last.afterLeftmostColumn = pose.leftmostColumn; last.afterRotation = pose.rotation;
    last.afterObservedTick = (position as { tick: number }).tick;
  }
  return { target: plan.target, ageActions: plan.targetCreatedAt === null ? null : plan.appliedKeyActions - plan.targetCreatedAt, recentActions: plan.recentActions };
}
export function pngDataUrl(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return `data:image/png;base64,${btoa(binary)}`;
}
