# Verification record — 2026-10-15

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

The Vite/Node preview on port 5091 uses polling because Node's normal fetch cannot forward the Worker WebSocket upgrade. The full Cloudflare preview on port 5093 uses the verified WebSocket path. Running a production build alongside Vite can briefly regenerate translation modules; restart/reload the preview if necessary.

## Security and licenses

The template security scanner was adapted for the independent repository's initial uncommitted state and monorepo paths. Findings were reviewed: example `user:pass@localhost` strings, dynamic PEM wrappers in retained template payment adapters, and synthetic test credentials are not live credentials. An exact-value scan of 690 publishable source/build files found no occurrences of the local auth/vault secrets or authorized provider keys.

Migrations are included in Git; obsolete single-package Docker files/workflow were removed. Local environment files, credentials, SQLite/R2/DO state, logs and acceptance artifacts are ignored. Army/Gomoku are independent implementations; Xiangqi is pinned BSD-2-Clause. MIT template notices are retained. The development toolchain contains libvips LGPL components, described in THIRD_PARTY_NOTICES.md.

## Remaining deployment work and limits

- Create production D1/R2, set real Worker secrets/origins, configure authentication and deploy using docs/cloudflare.md. Production OAuth/email delivery was not exercised.
- This release enforces one active inference per account, bounded request/match duration and per-match events. Account-wide storage budgets and broad signup/comment/create-match abuse controls are not yet implemented; configure these before a large public launch.
- Army rules use the documented two-player variant; Xiangqi does not implement full tournament long-check/long-chase adjudication.
- Network failures can leave an upstream charge uncertain. Retrying is explicit; exactly-once provider billing is not promised.
