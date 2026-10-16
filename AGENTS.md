# Decision Arena

MIT licensed game platform. Read apps/web/AGENTS.md before changing the template app.

- Shared contracts: packages/core. Game engines: packages/games. Provider transport and credential encryption: packages/providers.
- apps/runner owns authoritative match state in SQLite Durable Objects. D1 and R2 are projections, never the match authority.
- Never log or commit credentials, raw provider requests, raw reasoning, local databases, or private replay state.
- Never expose hidden Army Chess identities through live views, events, model candidates or replay APIs.
- Every mutation authenticates a server-derived owner. Never trust browser-supplied userId.
- Models may only select validated legal actions. Errors pause; never substitute a random move or silently retry an uncertain paid request.
- Keep game rules and adapters deterministic and free of network calls.
- Run pnpm test, pnpm typecheck, pnpm build and pnpm build:cloudflare. Live provider smoke checks use explicit private local credentials, never CI defaults.
- Preserve third-party MIT/BSD notices. Do not copy code from the legacy GPL or unlicensed demos.
