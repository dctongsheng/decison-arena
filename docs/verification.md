# Verification record

## Pre-commit security review — 2026-10-16

The security review found and fixed a human WebSocket claim path that could append release events repeatedly while a session was ready or paused. Repeating a claim on the owning connection now returns the existing controller token without resetting input sequence numbers or writing another event. New claims check the event budget before mutation; ending a session remains available at the limit.

After the fix, **304 unit/service/UI tests and 76 workerd integration tests passed**, together with workspace/web type checks, the runner dry-run build, and the Node/Nitro and Cloudflare web builds. The added WebSocket regressions cover ready/paused repeated claims, preserved input deduplication, event-budget rejection and terminal replay access.

Manual review covered authenticated ownership, control sessions, model requests, public replay fields, rendering and saved preferences. The credential scanner's two findings in the no-provider smoke script were confirmed to be explicitly synthetic fixture values, never real credentials; those single-AI test rooms are ended without starting inference. Exact-value checks against local private configuration and provider-token pattern checks found no credentials in the pending commit. Runtime databases, logs and private artifacts remain ignored. No paid model requests were made during this review.

## Snake half-speed follow-up — 2026-10-16

New Snake games use `snake-realtime-v2`, advancing one cell every 20 ticks at 60 Hz: **3 cells/second**, half the previous 6. Both human and model controls share the same interval. Model observations and bilingual rule descriptions match; prompt v4 reads the interval from the observation rather than embedding a fixed speed. The 120-second limit and enforced no-thinking policy are unchanged.

- **304 tests passed** across 26 files, covering the new movement boundary, short direction taps, growth/collisions, pause/restore, deterministic replay and browser prediction. Old v1 replay tests verify stored frames keep their original 10-tick positions instead of being resimulated with v2.
- **73 workerd tests passed**, including actual Snake displacement versus simulation ticks and the provider's 20-tick/3-cell observation. The existing rule-version guard rejects old v1 start/resume/retry without changing position or dispatching a model; ending and reading the old replay remain available.
- Workspace/web type checks, Node/Nitro and Cloudflare production builds passed. The local browser displays 3 cells/second, and the application returned HTTP 200 after both builds.

Existing v1 sessions must be ended and recreated for the new speed. Historical integration results below describe the speed used at the time and are not rewritten. This follow-up made no paid model calls.

## Realtime thinking disabled — 2026-10-16

All three arcade games now enforce thinking off, superseding the earlier per-session thinking choice. The web creation/clone service ignores old form thinking overrides and freezes `never`; the runner independently overrides every outgoing request, including old ready, paused and explicit-retry sessions. System One sends `think_mode: "never"` and `return_thought: false`. OpenRouter Decisions keeps its supported native request fields, with no invented thinking parameters. Shared model profiles and chess behavior are unchanged.

- **304 tests passed** across 26 files, including ownership, saved-profile preservation, clone policy, preference migration and response-based historical thinking display. **69 workerd tests passed**, including the three-game/new-ready-paused-retry System One request matrix and the Jev protocol boundary.
- Workspace/web type checks, Node/Nitro and Cloudflare production builds passed. The local application still returned HTTP 200 after the builds.
- Browser checks at 5091 verified all three creation pages have no thinking mode/budget controls, display the fixed policy and still restore both AI model choices after refresh. The private room states that subsequent requests disable thinking. Historical events use only their own returned metadata; V2 community model metadata is labeled as the creation-time thinking configuration.

No real model calls were made for this change. Fixture tests inspected outgoing request parameters, while browser checks did not start or resume sessions. Existing private historical events/replays and saved model profiles were not rewritten; a provider request already sent cannot be changed retroactively.

## Single-AI mode and remembered creation choices — 2026-10-16

Snake, Tetris and Platformer now accept `ai-solo`: one model, one track, one score and no opponent/winner. It uses the existing realtime runner, AI quota, pause/recovery and public replay controls. Creation choices are stored in this browser under a versioned account-specific key, separately for each mode and side. Only model-profile IDs and thinking settings are stored; removed profiles are cleared, and cloned configurations bypass the saved defaults.

- `pnpm test`: **295 tests passed** across 25 files. Coverage includes mode layouts, per-account preference restoration, deleted/foreign profile IDs, malformed/blocked browser storage, public single-track replay and cloning with the viewer's own profile.
- `pnpm test:runner`: **56 tests passed** (41 arcade and 15 existing chess cases). All three games run single AI without a viewer; quota, budget, pause/resume, restart/retry and single-track archive behavior passed. Owner WebSocket claims and fabricated inputs cannot take control of the AI track, both before and after starting.
- Workspace/web type checks, `pnpm build`, `pnpm build:cloudflare` and diff whitespace checks passed. The local 5091 arcade smoke and full compiled Cloudflare 5093 smoke passed, including single-AI creation, end/save, publication, anonymous replay, own-key cloning and withdrawal for all three games. Sampled loopback input acknowledgements were 1–3 ms and authoritative broadcasts 98–100 ms.
- Browser checks at 5091 verified independent left/right model selections through refresh, leaving/returning, mode switching and entering a different game. Each game's single-AI room displayed one panel, no player controls and a saved single-track result; Tetris and Platformer replay views were also checked. Thinking-setting persistence is covered by automated tests; the browser account used for this check had only a Jev profile.

This follow-up made **no paid model requests**. Workerd execution tests use fixture providers; browser and HTTP publication checks ended new rooms before starting them, with zero calls. Existing paused user sessions were preserved. Preference storage is local to the current browser, not synchronized between devices.

## Arcade control-description and scheduling fix — 2026-10-16

The three arcade games now send self-described coordinates, time/control units, game-specific objectives and distinct primitive candidates. The final model-facing revision is `decision-arena-arcade-v3`; deterministic physics, game speeds, thinking configurations and `*-realtime-v1` rules versions are unchanged. Equivalent one-shot choices were removed without removing legacy input durations from replay readers.

The runner persists an input-observation boundary with each accepted response. It waits for the effective physics tick, not the full held duration, before making the next observation. A final preflight guard after credential/DNS work rejects ended runs, obsolete generations/requests and changed Tetris pieces before the paid POST. Existing sessions keep their original replay header; new decision events record their own prompt version.

- `pnpm test`: **284 tests passed**, including readable observations, both provider protocols' choice mapping, old replay durations, mixed prompt-version public whitelists and cancellation during asynchronous custom DNS checks.
- `pnpm test:runner`: **47 tests passed** (32 arcade and 15 existing chess cases). New coverage includes the exact tick boundary, delayed-model physics, the next observation seeing the new Tetris piece, continued decisions during a 1,000 ms hold, old-record fallback and preflight invalidation.
- Type checks and both Node/Nitro and Cloudflare builds passed. Cloudflare's full local smoke passed all existing 19 categories and the three arcade WebSocket/control/replay/community flows; observed acknowledgements were 1 ms and broadcasts 100–102 ms on loopback.
- Chrome at port 5091 verified fresh practice runs for all three games: keyboard/touch inputs, pause/resume, saved terminal results, event navigation and replay playback. All test runs were ended; existing paused user sessions were preserved.

Real-provider checks made **23 requests total**, retaining the saved thinking settings. Counts by game for Jev/Decision were Snake **3/1**, Tetris **10/3** across two bounded samples, and Platformer **5/1**; no game/provider exceeded ten requests. Returned models were `typesafe/jev-1.13-20260917` and `startlux-decision-27b-autothink`. No recorded successor observation preceded its preceding applied-input tick. Limited test sessions were explicitly ended and outstanding requests were allowed to settle; their discarded late answers are not retry failures.

This verifies integration and scheduling, not good gameplay. Snake's Jev sample turned down, then answered left after death; Decision's first answer arrived after death. Platformer Jev applied alternating right+jump and right inputs. Tetris initially preferred release/no-op under v2; v3 clarifies that waiting is not a placement plan and that a suitable placement should be locked promptly. The final five-answer Jev sample contained two no-ops and three hard drops (four answers applied, the last arrived after test termination), with no horizontal movement, rotation or line clear. This is still weak observed Tetris play; the fix does not guarantee a model will choose a successful strategy or overcome API latency. No engine-generated placement, automatic avoidance, forced alternative move or speed reduction was added.

## Real-time arcade follow-up — 2026-10-16

Snake, falling blocks and the original three-stage platformer now share an authoritative realtime session runner. The earlier chess executor and its migration remain intact. Local acceptance uses port 5091; the compiled Cloudflare application was also exercised on port 5093 with isolated local D1/R2. No production resources were changed.

- **265 rule/service/UI tests passed**, including deterministic fixed-step physics, short taps, pause/release/replay ordering, all three platform-stage completion recordings, model-owner isolation, public V2 field whitelists, connection-timeout cleanup, exact replay event navigation, bounded render prediction/interpolation and the existing hidden Army views.
- **35 workerd integration tests passed**, including 20 new realtime cases, the nine game/mode combinations, independent in-flight calls, physics during delayed responses, stale-piece responses, duplicate input/alarm handling, heartbeat expiry, deleted credentials, restart/explicit retry and the existing 15 chess cases.
- Workspace/web type checks, Node/Nitro production build and Cloudflare production build passed. The full Cloudflare smoke also passed the existing 19 categories and the new three-game WebSocket/community flow: create, authenticated control, pause/resume, end, private replay, publish, anonymous replay, clone, like, comment, report and withdrawal. Anonymous, cross-owner and cross-origin WebSocket upgrades were rejected.
- On this loopback machine, sampled input acknowledgements were **1–4 ms**, and the first authoritative broadcasts containing their applied ticks arrived in **95–102 ms**. This measures receipt timestamps rather than the smoke's polling interval; it is a small local sample, not an Internet latency guarantee.

Browser acceptance covered the three practice canvases, direct keyboard/touch controls, pause/resume/end and saved results on port 5091. A fresh room navigation and full reload both established authenticated WebSockets and allowed play. The compiled Cloudflare application additionally passed browser publication, anonymous replay, playback/result navigation, likes, comments, reports, cloning configuration and withdrawal. The final replay UI was checked for clickable applied-input markers and previous/next events, including distinct events at the same tick. The Vite connection effect waits for the authenticated session snapshot, avoids StrictMode opening-and-canceling the first socket, and has bounded connection timeout/reconnection. Same-port Vite upgrades intermittently stalled before a browser handshake was sent; moving only HMR did not resolve it. The development game bridge now listens independently on loopback port 5094, while the page and authenticated session stay on 5091. Browser upgrades then completed normally; the exact browser/dev-port stall mechanism remains unproven. Cloudflare keeps its native same-origin transport. Finished sessions with pending calls keep polling/reconnecting, show a settling notice, and enable replay/publication only when the calls have finished.

Real-provider validation made **19 total calls**. Per game, Jev/Decision counts were Snake **3/1**, falling blocks **5/3**, and platformer **5/2**—all below the requested ten-call bound. Existing thinking configurations were preserved: Jev `never`, Decision `always` with budget 4096. Returned models were `typesafe/jev-1.13-20260917` and `startlux-decision-27b-autothink`; these results do not describe a 4B model. Recorded latency ranged from **758–1,564 ms** for Jev and **2,946–14,470 ms** for Decision. Both providers produced applied controls in the platformer and falling blocks; Decision's Snake response arrived after its run died and was correctly recorded as dropped. A separate human-versus-Decision falling-block run verified a real control applied after 14.47 seconds while gravity continued. See [sanitized call samples](realtime-integration-samples.json).

The Snake sample ended naturally: both ate zero food; Jev survived 190 ticks versus Decision's 160 and won that run under the configured tie-breaker. The other smoke runs were manually ended and therefore have no winner. These limited calls establish integration and realtime timing, not model strength.

At a 390 px mobile viewport, both game panels stacked vertically at 354 px wide and the document had no horizontal overflow. A final Cloudflare browser reload showed no new console errors after shared record dates were made timezone-stable with an explicit UTC label; the production fallback brand was corrected to Decision Arena.

The source security scan found no findings when run from the repository root. Independent review traced session-derived owners, fixed-loopback development forwarding, public replay whitelists and cloning with the viewer's own credentials. All new game code/artwork is independently written; no external game assets or dependencies were added.

## Initial platform verification — 2026-10-15

This is local implementation acceptance. No Cloudflare resources were provisioned remotely, no production deployment was performed, and no GitHub repository was published.

## Private thinking display follow-up — 2026-10-15

The private thought-text change passed **171 unit/service/UI tests**, **15 workerd integration tests**, workspace/web type checks, and both production builds. Tests cover bounded provider text, missing text without fabrication, plain-text rendering, Army HTTP/WebSocket view isolation, restart recovery, late-response rejection, exclusion from subsequent model prompts and public D1/R2 replay artifacts.

A new 9×9 Gomoku match made one real StartLux call with thinking enabled and `return_thought: true`: the service returned `startlux-decision-27b-autothink`, `thoughtUsed: true`, **273 characters** of text and **3,381 ms** latency. The private room's latest-decision disclosure was expanded in the browser and confirmed to show that text. The match remains paused after one move. Only these validation metrics are documented; the actual text remains in the private match. This does not establish OpenRouter thought-text support or reconstruct older records.

## BambooNode login follow-up — 2026-10-15

After the game-platform acceptance below, the optional BambooNode OAuth login integration passed **142 tests** (including 52 new OAuth/configuration/UI tests), the full workspace/web type check, and both Node/Nitro and Cloudflare builds. The installed Better Auth plugin was exercised with mocked token/userinfo responses for code/state/PKCE, replay rejection, encrypted tokens and account isolation. The running local preview still reports `auth_mode=local` and `bamboonode_auth_ready=false`; no real OAuth client or remote server setting has been created or changed.

The live discovery document confirms `https://bamboonode.dev/oauth/authorize` as the user-facing authorization page and `https://api.bamboonode.dev` as issuer/token/userinfo backend. A real browser login and callback remain pending the operator's registration of the dedicated client. See [the registration checklist](bamboonode-client-registration.json) and [integration instructions](bamboonode-auth.md). A successful build or mock flow is not a real BambooNode authentication result.

## Automated checks

- Initial game-platform `pnpm test`: 90 passed (31 rules, 17 providers, 18 service, 18 redirect, 2 hidden-board rendering, 4 rejected-request body cleanup).
- Actual Miniflare/workerd integration: 13 cases covering persisted actions, duplicate/concurrent commands, runtime restart, alarm recovery, paused/ended requests, revoked keys, tenant inference quota, endpoint DNS/redirect policies, Army hidden information through HTTP/WebSocket/provider observations, R2 final replay, human action limits and bounded event recovery.
- TypeScript checks passed for the workspace core, runner and complete web application. The complete web check was rerun after the final request-body cleanup change and passed.
- Both Node/Nitro and Cloudflare builds are checked locally. Runner builds use `wrangler deploy --dry-run`, which does not publish.
- Final `pnpm test:cloudflare`: all 19 acceptance categories passed against the final built main Worker, internal Service Binding, Durable Objects, D1 and private R2 together. It verified WebSocket HTTP 101 and 10 snapshots, a nine-ply Gomoku win, anonymous replay, publication/withdrawal, cloning, two-account key/profile/match isolation, Origin checks, rejected-POST connection stability, likes/comments/reports, moderation and permission revocation. It uses disposable fixture accounts and never calls a paid model.

The final Cloudflare run uncovered an early-rejection edge case: after an anonymous POST returned 401 without consuming its body, Wrangler 4.98 sometimes lost its upstream connection on the next request and reported a misleading “Worker restarted mid-request” 503. There was no reload; temporary proxy diagnostics identified `Network connection lost`. Thirty bodyless rejection/check pairs succeeded, while the same experiment with request bodies produced two 503 responses. The API now drains small rejected bodies before returning the original 401/403, with a shared 32 KiB bound and 250 ms deadline; oversized or stalled uploads are canceled. Four unit tests cover the cleanup bounds. The final smoke added 30 rounds of anonymous and cross-origin rejection followed by authenticated permission checks: all 120 requests returned their expected 401/403, with no 503. Temporary Wrangler diagnostic changes were restored byte-for-byte before the final build. Mutations are never automatically retried by the smoke script.

## Real provider calls

The user's already-authorized credentials were loaded locally, tested through the new application and saved only in its encrypted local vault. They are not in source or this report.

| Connection | Requested model | Actual returned model | Observed result |
| --- | --- | --- | --- |
| OpenRouter Decisions | `typesafe/jev-1.13` | `typesafe/jev-1.13-20260917` | Connection and legal game actions succeeded |
| StartLux System One | Service default | `startlux-decision-27b-autothink` | Connection and legal game actions succeeded; thinking used |
| Custom System One protocol | Service default | `startlux-decision-27b-autothink` | Public HTTPS validation and connection succeeded; thinking used |

The StartLux endpoint currently returned a **27B** model, so this run is not evidence about the earlier local 4B model. Thinking was enabled with a 4096-token budget.

All three games passed local two-player, human-versus-StartLux and AI-versus-AI short matches. Jev-versus-Jev was exercised in Gomoku; Jev-versus-StartLux was exercised in Xiangqi and Army Chess. Each smoke match was explicitly ended after two game plies. These establish integration, not playing strength or a model winner. Representative per-call latency ranged from 786 ms to 45,298 ms. See the sanitized [integration samples](integration-samples.json) for returned models, actions, timing and usage.

Custom DNS checks initially timed out because this machine could not directly reach Cloudflare/Google DoH from workerd. An isolated no-credential probe found Alibaba DoH reachable. Fixed trusted-resolver fallback restored the custom call; private-address answers still fail immediately, redirects remain disabled, and all inference still runs in workerd.

## Browser acceptance

On the local application, an authenticated user created a 9×9 Gomoku game, played nine moves, saw “黑方 · 获胜 / 连成五子”, published the replay, navigated forward/back/to-result, liked, commented and submitted a report. Army Chess covered legal setup swaps, both players confirming deployment, movement into a camp and handover. A real Jev-versus-StartLux Xiangqi game was also started through the UI; its browser tab was closed and reopened, revealing nine completed plies while the page was absent. The match was then paused; its already-started request completed as the tenth ply, and no further move was scheduled. Handover removes piece identities from the DOM as well as covering the screen; automated HTML checks cover this boundary.

At initial acceptance, the Vite/Node preview on port 5091 used polling because Node's normal fetch cannot forward the Worker WebSocket upgrade. The October 16 arcade integration adds an authenticated development upgrade bridge; chess retains its original fallback. The full Cloudflare preview on port 5093 uses the native WebSocket path. Running a production build alongside Vite can briefly regenerate translation modules; restart/reload the preview if necessary.

## Security and licenses

The template security scanner was adapted for the independent repository's initial uncommitted state and monorepo paths. Findings were reviewed: example `user:pass@localhost` strings, dynamic PEM wrappers in retained template payment adapters, and synthetic test credentials are not live credentials. An exact-value scan of 690 publishable source/build files found no occurrences of the local auth/vault secrets or authorized provider keys.

Migrations are included in Git; obsolete single-package Docker files/workflow were removed. Local environment files, credentials, SQLite/R2/DO state, logs and acceptance artifacts are ignored. Army/Gomoku are independent implementations; Xiangqi is pinned BSD-2-Clause. MIT template notices are retained. The development toolchain contains libvips LGPL components, described in THIRD_PARTY_NOTICES.md.

## Remaining deployment work and limits

- Create production D1/R2, set real Worker secrets/origins, configure authentication and deploy using docs/cloudflare.md. Production OAuth/email delivery was not exercised.
- This release enforces one active AI match/session per account (up to two independent concurrent calls inside an arcade comparison), bounded request/match duration and per-match events. Account-wide storage budgets and broad signup/comment/create-match abuse controls are not yet implemented; configure these before a large public launch.
- Army rules use the documented two-player variant; Xiangqi does not implement full tournament long-check/long-chase adjudication.
- Network failures can leave an upstream charge uncertain. Retrying is explicit; exactly-once provider billing is not promised.
