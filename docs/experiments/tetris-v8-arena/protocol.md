# Frozen V8 → Arena: preregistered real-time comparison

Date: 2026-10-18. This protocol is written before the first live V8 Arena request.

The reference is `/Users/biws01/Desktop/003_chat/game-harness-lab`, read-only. Its V8 validation used a paused clock, 80 native actions, images on both arms, and a different baseline. Its reported 0 → 708.33 points is **not an Arena result**. Its frozen goal prompt is not part of generic GEPA evolution.

The [migration and viewing guide](../../tetris-v8-harness.md) describes the source hashes, conditional landing semantics, provider compatibility and UI. The [real-time game guide](../../realtime-games.md) describes the shared controls and persistence. These operational details do not change the frozen arms, seeds, budgets or decision rule below.

## Arms and unchanged environment

- A: `tetris-harness-baseline-v1`, existing Arena text/key policy, no new target calls or images.
- V8: `tetris-harness-v8-realtime-v1`, frozen reference goal/key strategy with explicitly documented Arena real-time adaptations; public-state PNG + structured facts + all 40 conditional landings, Decision target memory, Decision native keys.
- V8 requires an image-capable System One protocol provider (`systemone`, `custom-systemone` or `bamboonode-systemone`). OpenRouter/Jev remains baseline-only in this migration; no image-to-text fallback is substituted. Both comparison arms use the same saved compatible profile.
- Both: Arena `tetris-realtime-v1`; 10×20 plus two spawn rows; the existing SRS, seven-bag, hold, DAS/ARR, gravity, lock delay and scoring; 120 seconds; 300 total provider dispatches per run; 500 ms minimum dispatch interval; `think_mode=never`.
- Goal calls count against the same total budget as key calls. A new target is not an input and does not pause gravity. No automatic control, reachable-path search, candidate ranking/filtering, local argmax, fallback or silent paid retry.
- This compares complete integrations, **not** the isolated causal effect of images, context, goal prompt or latency. Baseline stays the default regardless of this small experiment.

## Seeds, order, budget

Use one existing Arena System One-compatible profile belonging to the signed-in owner for both arms; freeze its requested model, metadata digest and code hashes in the local plan. Record the first actual returned model in the ledger and halt if subsequent reported model identifiers differ; an unreported identifier is not proof of model identity. Never copy credentials or a database from the reference.

Pilot (development, excluded from acceptance): `arena-v8-pilot-20261018-01`, A then V8. Maximum 600 dispatches / four simulation minutes plus request settlement. Estimate actual calls, latency and duration before starting acceptance. Fix integration defects here, not after looking at acceptance results.

Independent acceptance seeds, fixed now:

1. `arena-v8-final-20261018-101` — A, V8
2. `arena-v8-final-20261018-203` — V8, A
3. `arena-v8-final-20261018-307` — A, V8
4. `arena-v8-final-20261018-409` — V8, A
5. `arena-v8-final-20261018-503` — A, V8
6. `arena-v8-final-20261018-607` — V8, A

One explicit repeat of seed 101, V8 then A, reported separately. Formal maximum: 14 runs × 300 = 4,200 dispatches, 28 simulation minutes plus settlement. Pilot plus formal upper bound is 4,800. Each start reserves the full 300 calls before dispatch; released only after confirmed completion and settlement. The source hashes and profile are checked before each run. A failed/paused/unknown run halts the batch and is never silently retried or scored as zero. Do not replace unfavorable seeds. Infrastructure and unsupported-provider failures remain visible as missing pairs.

The random bag sequence is shared by seed, but hold and consumption may differ between arms. Model output and network latency are stochastic; pairing does not make the paths, observations or wall-clock service load identical. Run serially, alternate arm order, and avoid builds/heavy local tests during measured games.

## Measurements and decision rule

Record original lines → points → survival-tick comparison, terminal reason, total/target/key calls, applied/dropped/failed/unknown outcomes, latency median/P95, observed/returned/effective ticks, actual model, reported thinking telemetry, image count/hash metadata and immutable Harness/rules versions. Reconstruct each completed game from seed and accepted native inputs to verify saved scores and checkpoints. Do not archive raw requests, provider reasoning, credentials or private endpoints in the report.

Report all six paired line/point differences, wins/ties/losses under the native comparator, and repeat variability. No model-strength or statistical significance claim from six seeds. A provisional improvement requires complete valid pairs, positive mean paired line difference, at least four native-comparator wins out of six, and no increase in failed/unknown calls. Otherwise state “no demonstrated improvement”; keep V8 experimental. Even passing is insufficient for a default promotion.

## Scope and rollback

Versions freeze at session creation; resumed sessions keep their version. Missing historical Tetris versions mean the old scheme and are never relabeled V8. Select the baseline for the next game to roll back. Existing input-based replays keep their original results. Nothing is automatically published to the community or deployed.
