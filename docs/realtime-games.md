# Real-time arcade games

Decision Arena includes Snake, falling blocks, and an original platform game. These run in an `ArcadeSessionObject`, separate from the existing turn-based `MatchObject`.

## Play locally

Run `pnpm dev`, sign in at `http://127.0.0.1:5091/zh`, and choose an arcade game from the lobby. The four modes are human practice, a single AI run (`ai-solo`), human versus model, and model versus model. Each controller owns an independent world. Human practice and single AI runs have one view; comparisons have two.

The creation page remembers the most recently selected mode and each mode's model selections in this browser, separately for each signed-in account. AI-versus-AI remembers its left and right choices independently. Switching games or modes, refreshing, or returning to the creator restores those choices. Only saved profile identifiers are stored; keys, endpoint URLs and profile contents are not. Old saved thinking overrides are ignored. Deleted or unavailable profiles are cleared against the current account's model list. Community cloning uses the source challenge's explicit game/model configuration and asks for the viewer's own model credentials without replacing the remembered defaults. Browser storage restrictions or corrupted preferences do not prevent creating a session.

A single AI run needs one saved model and has no human input/heartbeat requirement. After Start it keeps running when the viewing page closes, uses the normal account AI activity allowance and per-run request budget, and supports pause, resume, end, records, publication and one-track replay. Its result is a single score and terminal reason, without a comparison winner. Single AI and two-model sessions cannot bypass the shared one-active-AI-activity quota.

The local Vite plugin runs an independent loopback WebSocket listener on `127.0.0.1:5094` (`VITE_ARCADE_SOCKET_PORT` can override it). It authenticates upgrades against the normal server session on the web port, then forwards only the derived owner identity to the loopback runner using its internal secret. Cloudflare uses the existing authenticated main Worker and internal Service Binding instead. No API keys or internal secret are exposed to the browser.

All modes use each game's configured speed and a 120-second simulation limit. Slow model responses do not freeze physics. Snake keeps moving; blocks keep falling; gravity and enemies keep running. This measures control and response speed together, not decision quality independent of latency. There is no hidden planning, automatic avoidance or engine substitute.

Click the canvas to focus keyboard controls. Touch buttons are also available; losing focus releases held buttons. Escape pauses the session.

| Game | Keyboard controls |
| --- | --- |
| Snake | Arrow keys or WASD |
| Falling blocks | Left/right or A/D; down/S soft drop; up/W/X clockwise; Z counterclockwise; Space hard drop; C/Shift hold |
| Platformer | Left/right or A/D; up/W/Space jump; combine direction and jump |

Models choose the same buttons. Held inputs offer 100, 300 or 1,000 ms; rotation, hard drop, hold and jump trigger once on a press. One session shares the seed, level and simulation clock across its runs, while each run maintains its own game and controller state.

Equivalent candidates are offered once: Snake has one short tap per legal direction; releasing keys and standalone taps (rotate, hard drop, hold, jump) use 100 ms. Tetris left/right/soft drop and platformer horizontal motion offer all three durations. A platformer direction-plus-jump candidate presses jump once while holding the horizontal key for the selected duration. Old saved inputs with other supported durations remain replayable. Snake keeps moving after a direction tap expires; 100 ms is not a one-cell movement command.

## Models and budgets

Choose an existing saved model for each AI controller. All three realtime games enforce **thinking off** in every mode: System One and compatible providers receive `think_mode: "never"` and `return_thought: false`; OpenRouter Decisions has no thinking toggle in the supported protocol. The server overrides saved profile settings, old form submissions and cloned challenges. The runner enforces this again for every request, including the next request after resuming/retrying an older session. The saved model profile and chess settings are unchanged, and previous events/replays retain their historical information. A request already sent cannot be changed retroactively.

Other model parameters are frozen when the session is created. Each request contains the rules, current visible state, current buttons, the latest 20 actions from that run, and finite button choices. It does not contain the other run's state or private reasoning.

The `decision-arena-arcade-v4` model description gives each game its own explicit objective and control semantics. Snake identifies the head, tail, body order, coordinate directions and movement timing. Tetris sends its locked board as 22 labeled rows (including y=-2 and y=-1), a column legend and separately identified active cells; hard drop explicitly locks the current orientation/column without searching for a placement or earning drop points. Platformer observations specify pixel/tick units, grounded state, key edges, terrain and current enemy movement. These are descriptions of the visible game, not a solver, recommended move or hidden automatic controller. The same description is sent to both provider protocols under the realtime no-thinking policy.

There is at most one in-flight request per run and two per comparison. Request starts are at least 500 ms apart. Each side has a 300-request ceiling, including failures and uncertain interrupted calls. Hitting that ceiling pauses the session rather than declaring a loss. Calls time out after 120 seconds. Returned reasoning is available only in the owner's private room when the provider actually supplies it.

An action takes effect after its response arrives, never retroactively. Falling-block replies belong to a particular piece and are discarded if that piece has already locked. A discarded reply can still have incurred provider usage. Provider charges cannot be guaranteed exactly once; interrupted calls are never silently repeated.

After accepting a response, the runner waits until its effective physics tick has passed before observing for another request on that run. It does not wait for the entire key-hold duration or block the other run. This prevents a hard-drop answer from immediately triggering a paid request for the previous piece before that drop executes. Natural piece changes during a slow response can still make a reply stale. Each decision records its prompt version; older sessions and mixed-version continuations preserve the original replay header rather than relabeling historical calls.

The runner also rechecks the control generation, run status, request identifier and piece identifier immediately before the provider POST, after asynchronous credential and endpoint checks. A request made obsolete during preflight is discarded without sending the paid POST. Once a POST has started, a later death or pause cannot guarantee that the provider did not charge; its response is still recorded and discarded as appropriate.

## Clocks, persistence and recovery

The pure rules advance at 60 ticks per second. The runner processes elapsed time in roughly 50 ms batches and pushes durable views at roughly 10 Hz. The browser animates independently. Human controllers receive an owner-only rule-state checkpoint for at most 100 ms of local render prediction; new server snapshots correct it. AI views interpolate consecutive authoritative positions. Local prediction never uploads state, changes the official score, or decides a winner, and stops on pause/end. Public replay excludes the prediction checkpoint. The timer is not a durable queue or a promise of hard real-time scheduling.

SQLite Durable Object state is authoritative. Inputs and their applied ticks are persisted, with replay checkpoints. D1 receives rebuildable summaries every five seconds and on status changes; R2 receives the completed replay. Projection failures do not undo confirmed gameplay. A five-second alarm checks liveness and retries projections, not paid model calls.

Pause freezes the whole session and releases keys. In-flight calls settle without applying their obsolete actions; resume waits for those calls. A disconnected human controller pauses both worlds after its two-second heartbeat lease expires. Pure AI sessions continue when the viewing tab closes. A process restart or a simulation scheduling stall exceeding 250 ms pauses the session at its durable tick; offline time is not fast-forwarded. The UI distinguishes these interruptions from normal game deaths.

## Rules and results

- Snake: 20×20 grid, length three, three moves per second, wall/body collision, no reversal. Entering the departing tail is allowed when not growing. Compare food, then survival ticks. Seeded food selection uses the free cells in each world, so diverging paths need not produce identical food coordinates.
- Falling blocks: 10×20 visible grid, two hidden spawn rows, seeded seven-bag sequence, five-piece preview, hold once per piece, SRS rotations, 500 ms lock delay with up to 15 movement resets. Gravity starts at 800 ms per row, decreases by 50 ms per ten lines, and stops decreasing at 100 ms. Compare lines, then level-weighted line score, then survival ticks. There are no T-spin/combo or garbage-line mechanics.
- Platformer: three original selectable levels with fixed geometry and tick-driven enemies; one life per attempt. Contact with hazards/enemies or falling ends the run; no enemy stomping. Completion outranks incomplete progress; completed runs compare finish time, otherwise furthest progress, coins and survival time. Deterministic input recordings verify each level is completable.

New Snake sessions use `snake-realtime-v2`: one cell every 20 simulation ticks (3 cells/second), half the former v1 speed. Human and model controllers share that speed. The model observation and rules describe the same movement interval; the overall simulation remains 60 Hz and the match limit remains 120 seconds. Existing v1 sessions must be ended and recreated to use the new rule version. Their replays use stored frames rather than being resimulated by the slower engine, preserving historical positions and scores.

One side finishing freezes that side's result while the other completes its own attempt. Identical score vectors tie. Manual termination is marked aborted and does not manufacture a winner.

## Replays and community

Arcade uses version 2 replays with run IDs, public controller descriptions, initial seed/configuration, tick-stamped inputs, checkpoints, final scores, and bounded public metrics. Chess remains version 1. Publication and readback both pass through a field whitelist; credentials, private URLs, provider payloads and reasoning are excluded.

Publish only after the activity ends. Existing likes, comments, reports, withdrawal and moderation apply. Cloning copies the challenge seed, rules configuration and public model settings, but the viewer must select their own matching provider credentials. Anonymous users can view only published replays.

Replays offer a common time slider, playback speed, previous/next event and a clickable event list. Inputs locate their effective tick; model responses locate their return tick and retain applied/discarded status. Death, completion and final results are separate markers. Events at the same tick can still be selected individually.

## Extending and checking

Add an `ArcadeAdapter` in `packages/games/src/arcade`, register it with `getArcadeGame`, and supply its view renderer and translations. The contract separates `input` from `step`: input changes control state; physics and edge-triggered actions run on the next tick. A quick key-down/up still queues one press. Internal `release` cancels those pending presses on pause or termination; its replay event carries `release: true` to distinguish it from a player's ordinary key-up. Use serializable RNG state, not `Math.random`, and include round-trip restore, deterministic replay, collision and scoring tests.

Run `pnpm test`, `pnpm test:runner`, `pnpm typecheck`, `pnpm build`, and `pnpm build:cloudflare`. Start `pnpm dev:cloudflare -- --skip-build` and run `pnpm test:cloudflare`; its arcade checks use disposable accounts and no model credentials. `ARENA_SMOKE_ORIGIN=http://127.0.0.1:5091 node scripts/smoke-arcade.mjs` checks the authenticated development bridge as well; set `ARENA_SMOKE_WS_ORIGIN` when overriding its port.

The optional `node scripts/smoke-arcade-models.mjs --confirm-live` uses an existing private `artifacts/local-fixture.json` login and saved OpenRouter/System One profiles against port 5091. It makes paid calls under the same enforced no-thinking policy, stops at five dispatches per side or 25 seconds, and waits for outstanding calls to settle. It never retries a failure automatically. Its sanitized local report records actual returned model names, latency and applied/discarded ticks; this is connection evidence, not a ranking.

For Cloudflare deployment, use the existing documented D1/R2/secret setup and the appended arcade Durable Object migration. Never remove or rename the existing chess namespace or its migration. This feature does not automatically deploy or provision remote resources.
# Snake 可比较 Harness 实验

贪吃蛇新增创建时可选的 `config.snakeHarnessVersion`：`snake-harness-a-v1`（缺省原版）、`snake-harness-b-v1`（仅策略）、`snake-harness-c-v1`（B加可见状态整理）。仅下一局可选，局内不能更换，规则仍为20×20、3格/s、120秒。其他游戏不使用该字段。尚无独立验收通过前默认保持A。

参见 [真实死亡窗口](experiments/snake-harness-v1/trace-audit.md)、[实验预声明](experiments/snake-harness-v1/preregistration.md)、[版本与回滚/GEPA边界](experiments/snake-harness-v1/design.md)。实验通过现有账号与模型配置运行，绝不自动发布社区或部署生产。
