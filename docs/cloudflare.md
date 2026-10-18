# Cloudflare deployment

The project uses two Workers, D1, private R2 and SQLite Durable Objects. Production setup is explicit; local setup never provisions cloud resources.

The public origin is `https://arena.startlux-decision.com`. It currently uses a [local Cloudflare Tunnel](local-tunnel.md), not a deployed main Worker. Build with that `VITE_APP_URL`, and set `AUTH_URL` and `AUTH_TRUSTED_ORIGINS` to the same HTTPS origin when deploying Workers later. The [production BambooNode registration checklist](bamboonode-production-client-registration.json) contains the corrected OAuth callback; its upstream registration still needs correction.

1. Create a D1 database and an R2 bucket in your Cloudflare account. Keep the bucket private. Put the database ID and bucket name in both Worker configs. Replace the main app URL with the real HTTPS origin.
2. Set `AUTH_SECRET`, `CONFIG_ENCRYPTION_KEY` and `ARENA_ENCRYPTION_KEY` as main Worker secrets. Set the **same** `ARENA_ENCRYPTION_KEY` on the runner. Use fresh random secrets and keep a backup of the vault key. Do not deploy the local `.dev.vars` files or `LOCAL_DEV=true`.
3. Review `apps/web/drizzle/0000_powerful_solo.sql`, then apply the reviewed migrations to the production D1 database. Never use db:push against production. Configure authentication and optional OAuth for the final origin.
4. Build with `pnpm build:cloudflare`. Deploy `apps/runner` first, then the generated main Worker in `apps/web/.output/server/wrangler.json`. The main Worker must bind `MATCH_SERVICE` to `decision-arena-runner`, D1 as `DB`, and R2 as `REPLAYS`.
5. Keep runner `workers_dev=false`, preview URLs disabled and no public routes. Its default HTTP handler is for Service Binding calls. Only the main app is public.
6. Register two test accounts and verify isolation, a complete local/human game, one bounded real AI run, reconnect, publish, anonymous replay and withdrawal. Check the bundled client output for secrets.

The real D1 schema source is apps/web/src/config/db/schema.sqlite.ts; build scripts regenerate schema.ts. Add future schema changes to that source and generate a reviewed migration.

Monitor error/paused match counts, provider latency/status codes, projection retries and resource usage. Do not log provider bodies, raw reasoning or credentials. Start with one active AI match per account; change quota policy deliberately with concurrency tests.

## Local Cloudflare runtime

`pnpm setup:local` creates a persistent local D1 file shared by the Node development frontend and the workerd runner. `pnpm test:runner` runs isolated workerd integration tests with mocked provider responses. No real account credentials are required for automated tests.

For the full application running in the Cloudflare runtime, use two terminals:

```sh
# Once, after pnpm install:
pnpm setup:local

# Terminal 1: builds the main Worker, applies only local migrations, and starts both Workers.
pnpm dev:cloudflare

# Terminal 2: validates the running application without calling a model provider.
pnpm test:cloudflare
```

Open `http://127.0.0.1:5093/zh`. The main application and match runner execute in workerd, with a real local Service Binding between them. The runner is an auxiliary Worker with no public development port. This follows Cloudflare's [multiple-Worker local development](https://developers.cloudflare.com/workers/local-development/multi-workers/) workflow.

This preview keeps its D1 database, private R2 artifacts, Durable Object state, generated configuration and secret files under the ignored `.wrangler/cloudflare-dev/` directory. Its accounts and matches are separate from the Node frontend on 5091 and runner on 5092. Both Workers in the Cloudflare preview share the preview's D1/R2 resources.

`scripts/dev-cloudflare.mjs` reads only the required local secrets from the ignored `apps/web/.env.development` created by setup. It writes generated `.dev.vars` files with mode `0600`; it never prints secret values or passes them as command-line arguments. This script runs Wrangler with `--local`, disables remote D1/R2 bindings, and does not deploy or create cloud resources.

The default command rebuilds first. When the existing Cloudflare output is current, use `pnpm dev:cloudflare --skip-build`. To use another port, run `ARENA_CF_PORT=5094 pnpm dev:cloudflare`, then test with `ARENA_SMOKE_ORIGIN=http://127.0.0.1:5094 pnpm test:cloudflare`. Rebuild after changing the port because public authentication URLs are included in the client bundle.

The smoke script creates temporary owner, second-user and moderator accounts plus a human-vs-human Gomoku match. It saves a fake credential to exercise the vault and deletes that model after a successful run. It withdraws and republishes the test post, then takes it down through the moderator API. It never invokes OpenRouter, StartLux or another inference endpoint. Test accounts and game records remain in the isolated preview database for inspection.

For the moderation checks, the script uses `wrangler d1 execute --local` against **only** `.wrangler/cloudflare-dev/state`. It verifies the generated runner's local-preview name and grants `admin.posts.write` to the freshly created `cf-smoke-moderator-…@example.invalid` account. It then disables that fixture role and verifies access is revoked. It does not modify real users or production data. Keep the Worker build/source stable while the smoke suite runs; a hot restart can interrupt a POST, and the script deliberately does not retry mutations automatically. After a restart, rerun the whole suite with new fixture accounts.

### Verified acceptance (2026-10-15)

The full local preview passed these checks with the actual built main Worker and runner:

- Anonymous private-model access returns 401; account signup issues a valid session.
- Model configuration accepts a test key and returns only its mask.
- A match created through the main Worker reaches the runner through its Service Binding.
- Nine legal human moves complete a Gomoku game with seat 0 as the winner.
- An authenticated WebSocket handshake returns 101 and receives 10 snapshots, including live updates.
- The completed replay is stored/read through private R2 and becomes anonymously readable only after explicit community publication.
- Cloning a published game preserves its game and board settings despite different client-supplied values.
- Another account cannot read the private match (404). Its model/key lists contain no owner data; attempts to test, use, edit or delete the owner's model and to use, edit or delete the owner's credential return 404. The owner's model/key records remain unchanged.
- A cross-origin mutation is rejected (403), and an anonymous comment is rejected (401).
- Thirty rounds of anonymous and cross-origin POST rejection, each followed by an authenticated permission check (120 requests), preserve their expected 401/403 responses without breaking the next connection.
- Repeating an explicit like does not increment its count twice, and unlike reduces the count. A posted comment is readable in the anonymous public detail with the expected comment count.
- Repeated reports create one report. Ordinary accounts cannot read the report queue or moderate content; the temporary content moderator can read the report and reporter details.
- Withdrawing a publication makes its public detail and clone source unavailable (404).
- A content moderator can take down the republished post. It disappears from the anonymous list and detail; the owner cannot republish it (403) or clone it (404).
- Disabling the fixture moderator role immediately removes report-queue and takedown access (403).

The terminal result is a JSON object with `ok: true`, the check names, and `websocketSnapshots`. This is local runtime acceptance, not evidence of a production deployment or a model-strength benchmark. Provider parsing, DNS validation, AI concurrency and interrupted-call recovery are covered separately by `pnpm test` and `pnpm test:runner`.

During local acceptance, Wrangler 4.98 could report a misleading `Your worker restarted mid-request` 503 after a rejected POST, even without a reload. Its proxy's underlying error was `Network connection lost`. A controlled comparison reproduced this after unread request bodies, while bodyless requests succeeded. The API now finishes small rejected bodies before returning the original authorization error, with a shared 32 KiB limit and a 250 ms deadline; oversized or stalled bodies are canceled. Unit tests cover those bounds, and the repeated rejection check above exercises the built Workers. The smoke test reports unexpected response bodies and never retries mutations automatically.

`pnpm build:cloudflare` builds both Worker artifacts without deploying them. A production rollout still requires the explicit configuration and verification steps above.
