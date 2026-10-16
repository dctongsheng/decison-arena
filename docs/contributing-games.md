# Add a game

1. Add a deterministic GameAdapter under packages/games. Register its ID/manifest and export it from the registry; update the shared GameId type and API game/config validation.
2. Implement create, legalActions, apply, observe, view and restore. State must be JSON-serializable; apply must not mutate its input. Random initialization must use the supplied seed.
3. Give the rule implementation a stable rulesVersion. Keep older versions available or deliberately pause incompatible active matches. Do not reinterpret an old replay as a new ruleset.
4. Add a board renderer/configuration entry in the web game registry. Prefer GameView where it fits; a new kind of game can add a typed view and renderer without changing auth, credentials or the community pipeline.
5. Add contract/rules tests: legal and illegal moves, terminal results, recovery, determinism, boundary coordinates and per-player information visibility. Validate that action labels and histories cannot reveal hidden state.
6. Include the game's rules in English and Chinese, explain any simplified adjudication, and retain licenses for all upstream code or assets.

Game adapters never perform network requests, read keys or depend on UI state. They decide what is legal and who won. Provider adapters choose from legal candidates; the match runner commits validated actions. A contributor does not need to change account isolation or build a separate inference server.

Only reviewed code contributions register games. Community users cannot upload executable plugins.

# Real-time games

For continuous simulation games use the separate `ArcadeAdapter` contract rather than the alternating-turn chess adapter. See [real-time rules, controls, persistence and verification](realtime-games.md).

Give each arcade game's model observation explicit coordinate, time and control units, and add its objective/control instructions to `packages/games/src/arcade/decision.ts`. Observations describe the current game; they must not contain a solver's recommended action or another run's state. Deduplicate equivalent one-shot inputs while keeping old saved input durations replayable. Version model-facing changes with `ARCADE_PROMPT_VERSION`, independently of physics/rules changes. Verify both the provider choice mapping and the runner's requirement that an accepted input reaches a physics tick before the next observation.
