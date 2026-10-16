# Decision Arena

An MIT-licensed, multi-user playground for decision models. Play Army Chess, Chinese Xiangqi and Gomoku yourself, challenge AI, compare two independent model configurations, and publish completed matches to a replay community.

基于 TanStack Start 的开源决策模型游戏社区。支持个人账户隔离、自己的 API Key、后台 AI 对局、三款棋类游戏及可撤回的社区回放。

## Quick start

Requires Node.js 22.12+ and pnpm 10.32.1.

```sh
pnpm install
pnpm setup:local
pnpm dev
```

Open **http://127.0.0.1:5091/zh** (English: `/`). Sign up with email/password; there is no built-in admin account or shared model key. The setup command generates private local vault/auth secrets, initializes a local D1 database and creates RBAC roles. It never changes a production database.

For a deployment that uses BambooNode accounts, see [BambooNode unified login](docs/bamboonode-auth.md). Register a dedicated OAuth client before enabling `AUTH_MODE=bamboonode`. This mode sends login and signup to `bamboonode.dev` and uses `api.bamboonode.dev` for the server-side code exchange and identity check.

The frontend listens on 5091; the internal Cloudflare runner listens on 5092. Both use the same local D1 SQLite file. The fast Vite development frontend falls back to polling when its Node server cannot forward a WebSocket upgrade. Production uses an authenticated Cloudflare Service Binding and WebSockets.

## Play and share

1. Open Models, add OpenRouter Decisions, StartLux System One, or a compatible public HTTPS endpoint, and test the connection.
2. Create a match, select a game and independently choose a human or saved model for each seat.
3. Play manually, take a single AI step, or start automatic play. Automatic AI turns continue after closing the page.
4. Completed matches remain private until you publish them. The community supports replay, likes, comments, reports and withdrawal.
5. Reuse a public configuration with your own saved models and keys.

Each account can run one active AI inference match at a time. A match pauses at 300 plies or 60 minutes of model execution (and at 1,000 stored events including setup/control); provider requests time out after 120 seconds. These are operational limits, not a game's win condition. Interrupted or uncertain paid requests pause and require explicit retry. Invalid model actions never become random moves.

## Packages

| Location | Responsibility |
| --- | --- |
| `apps/web` | TanStack UI, better-auth, account isolation, encrypted model vault and community |
| `apps/runner` | Internal Worker, one SQLite Durable Object per match, alarms and WebSocket projections |
| `packages/core` | Versioned game/model/match/replay contracts |
| `packages/games` | Deterministic Army Chess, Xiangqi and Gomoku adapters |
| `packages/providers` | Decision protocols, response validation, endpoint policy, AES-GCM credential vault |

The Durable Object owns the game. D1 contains rebuildable match indexes and user/community records. R2 holds replay artifacts in a private bucket. See [architecture](docs/architecture.md), [deployment](docs/cloudflare.md), [model providers](docs/providers.md) and [adding a game](docs/contributing-games.md).

## Verification

```sh
pnpm test
pnpm typecheck
pnpm test:runner
pnpm build
pnpm build:cloudflare
# In separate terminals for full local Service Binding + WebSocket tests:
pnpm dev:cloudflare --skip-build
pnpm test:cloudflare
```

The rule tests include hidden-information projections, legal deployment, Xiangqi public-API move-generation baselines, Gomoku wins/draws and recovery. Runner tests execute inside Miniflare/workerd. Service tests use disposable SQLite databases. Test credentials and replay fixtures contain no real API keys.

To grant moderation access to an account you have registered locally:

```sh
pnpm --filter @decision-arena/web rbac:assign --email=you@example.com --role=admin
```

## Rules and reproducibility

- **Army Chess:** two-player hidden-information 12×5 rules, legal deployment, railway movement, camps, mines/bombs and flag capture. The server chooses a secret deployment seed. Full information is available only after completion.
- **Xiangqi:** standard opening, legal moves/check, checkmate and stalemate losses, threefold repetition and 120 plies without capture. This is an experience ruleset, not the complete tournament long-check/long-chase adjudication system. Arbitrary FEN imports are not exposed.
- **Gomoku:** 9×9 or 15×15 freestyle; five or more in a line wins, no forbidden moves.

The replay records the rules/prompt version, seed, independent model settings, actions, returned metrics and result. Models receive a fresh legal position and recent visible history on each turn; raw private reasoning is not published.

## License and provenance

MIT. The application starts from the MIT-licensed [Dougo SaaS template](https://github.com/dctongsheng/dougo-shipany-tanstack) at `b5abaa8d0eefcc200d9f64eebf1d33dcf2cbd0f0`. Its copyright notice is retained. Xiangqi uses the pinned BSD-2-Clause `xiangqi.js` implementation; see [third-party notices](THIRD_PARTY_NOTICES.md). Army Chess and Gomoku rules are new TypeScript implementations. No legacy GPL application code, private Git history, API keys or previous match datasets are included.

See [the verification record](docs/verification.md) for measured integration results and remaining deployment work.
