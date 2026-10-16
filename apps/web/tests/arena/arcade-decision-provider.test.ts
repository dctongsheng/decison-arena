import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArcadeGameId, ModelProfile } from '@decision-arena/core';
import { decide, ENDPOINTS } from '@decision-arena/providers';
import { ARCADE_PROMPT_VERSION, arcadeDecisionInstructions, getArcadeGame } from '@decision-arena/games';

afterEach(() => vi.unstubAllGlobals());

describe('arcade observation through the decision provider boundary', () => {
  it.each((['snake', 'tetris', 'platformer'] as const).flatMap(gameId =>
    (['openrouter', 'systemone'] as const).map(provider => ({ gameId, provider }))
  ))('$gameId / $provider maps the returned choice to the requested primitive without substituting down', async ({ gameId, provider }) => {
    const game = getArcadeGame(gameId), initial = game.create({}, 'protocol-fixture');
    const actions = game.candidates(initial);
    const wanted: Record<ArcadeGameId, string> = { snake: 'up:100', tetris: 'left:300', platformer: 'right+jump:300' };
    const chosen = actions.findIndex(action => action.id === wanted[gameId]);
    expect(chosen).toBeGreaterThanOrEqual(0);
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      const payload = JSON.parse(init!.body as string);
      expect(payload.state.position).toEqual(game.observe(initial));
      expect(payload.state.promptVersion).toBe(ARCADE_PROMPT_VERSION);
      expect(payload.questions.primary_move.instructions).toBe(arcadeDecisionInstructions(gameId));
      expect(payload.questions.primary_move.criteria[`m${chosen}`]).toBe(actions[chosen].label);
      expect(Object.keys(payload.questions.primary_move.criteria)).toHaveLength(actions.length);
      if (provider === 'systemone') {
        expect(payload.think_mode).toBe('never');
        expect(payload.think_budget).toBe(4096);
        expect(payload.return_thought).toBe(false);
      } else {
        expect(payload).not.toHaveProperty('think_mode');
      }
      return Response.json({ model: 'fixture/returned-version', answers: { primary_move: { choice: `m${chosen}` } } });
    });
    vi.stubGlobal('fetch', transport);
    const profile: ModelProfile = { id: 'fixture-profile', ownerId: 'fixture-owner', credentialId: 'fixture-credential', name: 'Fixture',
      provider, endpoint: ENDPOINTS[provider], model: 'fixture/requested-version', thinkMode: 'never', thinkBudget: 4096 };
    const response = await decide(profile, 'fixture-only-key', {
      state: { game: gameId, promptVersion: ARCADE_PROMPT_VERSION, rules: game.rules, position: game.observe(initial), recentInputs: [] },
      instructions: arcadeDecisionInstructions(gameId), actions,
    });
    expect(response.actionId).toBe(wanted[gameId]);
    expect(response.metrics.actualModel).toBe('fixture/returned-version');
    expect(transport).toHaveBeenCalledTimes(1);
    const controlled = game.input(initial, actions[chosen].input);
    const advanced = game.step(controlled, gameId === 'snake' ? 20 : 1);
    if (gameId === 'snake') expect(advanced.body).toEqual([{ x: 4, y: 9 }, { x: 4, y: 10 }, { x: 3, y: 10 }]);
    if (gameId === 'tetris') expect(advanced.active).toMatchObject({ x: 2 });
    if (gameId === 'platformer') expect(advanced.player).toMatchObject({ vx: 4 });
  });
});
