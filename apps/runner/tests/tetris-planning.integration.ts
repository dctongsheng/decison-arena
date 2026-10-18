import { describe, expect, it } from 'vitest';
import { getArcadeGame, tetrisGoalScope, applyTetrisGoalChoice } from '@decision-arena/games';
import { scopedTetrisPlan, tetrisTargetDue, tetrisMemory } from '../src/tetris-planning';

describe('persisted Tetris planning schedule', () => {
  const position = () => getArcadeGame('tetris').observe(getArcadeGame('tetris').create({}, 'fixture-tetris-plan'));
  it('plans once per new scope, then after four accepted keys, even when the model clears its target', () => {
    const scope = tetrisGoalScope(position()), plan = scopedTetrisPlan(undefined, scope);
    expect(tetrisTargetDue(plan)).toBe(true);
    plan.target = applyTetrisGoalChoice(plan.target, 'clear'); plan.lastPlannedKeyActions = 0;
    for (let count = 0; count < 4; count++) { plan.appliedKeyActions = count; expect(tetrisTargetDue(plan)).toBe(false); }
    plan.appliedKeyActions = 4; expect(tetrisTargetDue(plan)).toBe(true);
    plan.lastPlannedKeyActions = 4; expect(tetrisTargetDue(plan)).toBe(false);
  });
  it.each(['pieceId', 'pieceType', 'boardKey'] as const)('invalidates a target when %s changes and preserves same-scope restores', field => {
    const scope = tetrisGoalScope(position()), plan = scopedTetrisPlan(undefined, scope);
    plan.target = { leftmostColumn: 3, rotation: 1 }; plan.lastPlannedKeyActions = 0;
    expect(scopedTetrisPlan(JSON.parse(JSON.stringify(plan)), scope)).toEqual(plan);
    const changed = { ...scope, [field]: typeof scope[field] === 'number' ? Number(scope[field]) + 1 : `${scope[field]}changed` };
    const fresh = scopedTetrisPlan(plan, changed);
    expect(fresh.target).toBeNull(); expect(tetrisTargetDue(fresh)).toBe(true); expect(plan.target).not.toBeNull();
  });
  it('records after-position only from a later actual observation without inferring timed displacement', () => {
    const visible = position(), plan = scopedTetrisPlan(undefined, tetrisGoalScope(visible));
    plan.targetCreatedAt = 0; plan.appliedKeyActions = 1;
    plan.recentActions = [{ actionId: 'left:1000', observedTick: 0, appliedTick: 1, beforeLeftmostColumn: 5, beforeRotation: 0 }];
    const memory = tetrisMemory(plan, { ...(visible as object), tick: 40 });
    expect(memory.ageActions).toBe(1); expect(memory.recentActions[0].afterObservedTick).toBe(40);
    expect(memory.recentActions[0].afterLeftmostColumn).not.toBe(5 - 18);
  });
});
