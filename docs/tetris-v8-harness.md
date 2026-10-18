# Tetris V8: frozen research Harness, adapted to Arena

For newly created Tetris sessions with AI controllers, **V8 is now the default**, including AI versus AI. On **Arcade → Tetris → create**, the old direct-key policy remains available as an explicit baseline choice. A model selects both the goal and every native key/duration. This default change applies to new sessions; it does not upgrade existing sessions or change historical experiments. Human practice still uses native controls; the Harness only affects AI controllers. No game is published automatically.

V8 AI seats support **System One** (`systemone`, `custom-systemone`, `bamboonode-systemone`) and **Jev 1.13/1.14** (`openrouter`, `custom-openrouter`, `bamboonode-decisions`, with exact requested IDs `typesafe/jev-1.13` or `typesafe/jev-1.14`). Jev and StartLux can occupy opposite seats without changing the frozen V8 policy. Both target and key requests include a public-observation PNG; System One uses top-level `images`, while Jev uses `state: [JSON.stringify(structuredState), {type: 'image_url', image_url: {url: pngDataUrl}}]`. A single shared capability check governs the picker, Web service and Runner. Unsupported models are rejected without dropping images or changing versions; custom endpoints must implement the respective image protocol. See [OpenRouter's multimodal Decisions contract](https://openrouter.ai/docs/guides/community/multimodal-decisions) and the [Jev integration receipt](experiments/tetris-v8-arena/jev-integration.md). All arcade requests retain the enforced no-thinking policy; Jev has no System One thinking parameter, and missing returned telemetry remains unknown.

See [real-time games](realtime-games.md) for play, controls and recovery, and the [preregistered comparison](experiments/tetris-v8-arena/protocol.md) for the separate experimental limits and decision rule. Selecting V8 does not claim better results.

## Reference and interface audit

Read-only source: `/Users/biws01/Desktop/003_chat/game-harness-lab`.

The inspected chain is `tetris_experience.py` → `Lab.play` → `runtime.run_episode` → `TetrisDecisionHarness.decide` → `VisionDecisionProvider` → the Decision choice protocol; native input then goes through that project's Arena-derived game bridge. The reference does not ship a reachability solver or a key macro as part of the verified policy. Its visual wrapper attaches a PNG through the System One top-level `images` field.

Frozen source: `docs/experiments/tetris-landing-v8/research-harness.json`, ID `landing-planning-2fd8b603374a82bb`, SHA-256 `73e437b7aacb4e5ac8afdfd8a178e5bf4dd00f6a3a21bb1a5f65875f328eaa24`. Goal text hash: `4a3d30b81be0fd58983549888699e6c377ab8d950a6818ff2bfc7e324dae23b8`. Key strategy hash: `38b7d6e45e00a5c5b12a40783673a7b4263a31c3bd978d42111797049c8ef1da`.

| Interface | Reference V8 | Arena adaptation |
| --- | --- | --- |
| Rules | Arena-derived 10×20 + two hidden rows, SRS, 7-bag, hold, DAS/ARR | Current native Arena engine remains authoritative; conditional lock/clear arithmetic is checked against it |
| Clock | Pauses while the model answers; steps the selected duration | Continuous 60 Hz; request latency, natural gravity and lock delay continue |
| Limit / scoring | 80 native actions; compares points | 120 seconds, 300 total requests; compare lines, then points, then survival |
| Replanning | New piece/locked-board scope, then every four native actions | Same scope/four applied-key cadence; goal requests consume time and the shared request budget |
| Target | `keep`, `clear`, all 40 column/rotation combinations | Same complete catalogue; all targets remain Decision choices, including invalid conditional poses |
| Key | A separate Decision choice per native key/duration | Existing native key candidates and validation; effective tick recorded after response |
| Feedback | Exactly one executed duration between observations | Actual observed elapsed ticks and controls; do not pretend a response interval equals its chosen duration |
| Visual | Pillow-rendered public observation PNG | Deterministic server-side PNG from the same current public observation, no DOM, seed, RNG or hidden queue |
| Failure | Frozen research receipt checks | Existing tenant, budget, pause/restart, request-generation and piece-ID guards; no automatic paid retry |

The reference reported a small paired benefit under its own paused conditions. This integration must be evaluated independently. Our baseline also differs: it is the old Arena direct-key policy, not the reference's older vision-and-goal policy. Therefore the experiment measures the entire migrated pipeline, not the isolated effect of one prompt or image.

## Conditional facts are not execution

For each column 0–9 and rotation 0–3, assume the current piece has reached that orientation and **leftmost occupied column**, keep its current local-frame y, and project a vertical hard drop. Describe its four cells, line/point consequences, holes, heights and hidden-row occupancy. Invalid assumed poses retain their catalogue entries and null consequence fields. Every entry says native reachability is unproven.

This does not search for a path, simulate SRS reachability, reserve a landing, score candidates with weights or choose a direction. The target is memory only. Even an apparently good target can be unreachable or become stale while the model responds. Only a subsequently validated Decision key can enter the native input stream. A response for an old piece or pre-pause generation is discarded.

Images show only the observed board/active piece and the five public previews/hold. No ghost landing, recommended target, future bag, credential or opponent state is embedded. Events retain bounded image metadata, not PNG/base64 request bodies. Public replay continues using a whitelist and excludes reasoning and private endpoints.

Transport tests verify the complete PNG reaches the System One `images` field and the Jev `state` image part, and live receipts record its hash and dimensions. A successful response does not by itself prove that the upstream model used the image. This bundled comparison cannot separate the contribution of vision from structured consequences, goal memory, instructions or latency; a later ablation would be a separate preregistered experiment.

## Watching a session or replay

The room shows the active piece, its current leftmost occupied column and rotation, the current Decision-selected target, and whether the pending/latest request selects a **target** or a **key**. Columns are 0–9; rotations 0–3 start at spawn orientation and turn clockwise. A target is shown only while its piece is still playing and its scope remains valid; a new piece, hold or changed locked board invalidates it.

Target responses update memory only, including `keep` and `clear`. They have a return/settlement tick but no applied input tick. Only key responses can produce a native input event, effective on the next physics tick. The replay reconstructs that distinction, shows the target at the selected time, and supports event navigation. Once a piece/run has ended, an old target is not displayed as a live instruction. Neither the room nor replay turns the target into an automatic path or action.

In AI versus AI, the two runs share the chosen Harness version, initial seed and simulation clock. Each run has its own board, target, piece/board scope, recent actions, request counter and last-response timing. A piece change clears only that run's goal. There is at most one outstanding request per run, so two requests may be outstanding at once, even when both seats use the same saved model. An upstream model may queue or rate-limit those concurrent requests; the two responses need not arrive together. Physics continues during those delays. Matching the model and seed does not guarantee equal scores or isolate decision quality from serving latency. These are execution semantics, not an additional measured benchmark result.

## Versioning and rollback

- `tetris-harness-baseline-v1`: original direct-key scheme.
- `tetris-harness-v8-realtime-v1`: frozen V8 source prompts plus explicit real-time/control-contract adaptations.
- A session freezes `config.tetrisHarnessVersion` at creation. Missing historical values mean baseline without rewriting the old recording. Viewing, resuming, cloning or replaying must not relabel old decisions as V8. A community clone keeps the source version and requires the viewer's own compatible model credentials; request parameters cannot override that version.
- Roll back by selecting baseline for the **next** session. Old recordings retain their native key inputs, scores and version metadata.
- The independent goal prompt is a frozen research component. Generic GEPA does **not** currently optimize it. This migration starts no coach, population search or reference-project experiment.

## Real experiment

The completed Arena comparison is documented in [results](experiments/tetris-v8-arena/results.md), with all paired scores, costs, repeated-run variation, timing windows and validation evidence. Baseline was the product default when that comparison was frozen; the experiment explicitly selected A and V8 for each run. The subsequent user-requested default change does not revise the frozen protocol, recorded versions, results or acceptance conclusions. A separate [dual AI activation smoke check](experiments/tetris-v8-arena/dual-ai-activation.md) verified both V8 pipelines, but scored zero on both sides; it is integration evidence, not an additional improvement claim.

See [preregistered protocol](experiments/tetris-v8-arena/protocol.md). Use the owner's existing signed-in Arena account and a saved, image-capable System One profile. Supply that owner's session through a protected local auth file; no replacement fixture account is created, and the script never extracts model keys or reads the reference database. The paths below are examples, not credentials.

```sh
node scripts/tetris-v8-experiment.mjs inspect --auth-file YOUR_PROTECTED_AUTH_FILE
node scripts/tetris-v8-experiment.mjs plan --phase pilot --profile YOUR_EXISTING_PROFILE_ID --plan artifacts/tetris-v8/pilot.json --auth-file YOUR_PROTECTED_AUTH_FILE
node scripts/tetris-v8-experiment.mjs run --plan artifacts/tetris-v8/pilot.json --auth-file YOUR_PROTECTED_AUTH_FILE --confirm-live
# After integration checks and pilot review, freeze a separate formal plan:
node scripts/tetris-v8-experiment.mjs plan --phase acceptance --profile YOUR_EXISTING_PROFILE_ID --plan artifacts/tetris-v8/acceptance.json --auth-file YOUR_PROTECTED_AUTH_FILE
node scripts/tetris-v8-experiment.mjs run --plan artifacts/tetris-v8/acceptance.json --auth-file YOUR_PROTECTED_AUTH_FILE --confirm-live
node scripts/tetris-v8-experiment.mjs report --plan artifacts/tetris-v8/acceptance.json
```

`--auth-file` selects an existing protected file containing the owner's session cookie; do not commit it. `--origin` only accepts loopback HTTP. Each run freezes the source manifest/profile digest and reserves the full native call cap. Interrupted or unknown ledger entries halt; restarting the command does not resume/retry them. Source changes invalidate a frozen batch. Private local ledgers contain sanitized decision timing/metrics, not raw requests, images, reasoning, keys or full private replay data.

A completed game is reconstructed from its initial seed and recorded native input events, then compared against stored checkpoints and final scores. Goal events do not affect physics. Pairing uses the same bag seed and same limits, not identical paths or identical wall-clock latency. Acceptance and repeated runs remain separate from development calibration.
