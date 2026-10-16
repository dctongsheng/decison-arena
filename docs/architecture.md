# Architecture

The browser talks to the TanStack Worker. Authentication derives the account ID from the server-side session; browser-provided owner IDs are never accepted. The main Worker calls the internal match Worker through MATCH_SERVICE. Production does not expose a runner URL.

Each match has its own SQLite Durable Object. Its persisted record includes game state, immutable seat profiles, rules version, revision, runtime budget and an in-flight attempt marker. Separate SQLite rows store events, full replay frames and accepted command IDs. Hidden full frames are never returned by live endpoints.

A human action and an AI action use the same legal-action check. The model sees only its seat's observation, the rules, up to 20 recent visible moves and all legal candidates. It returns a candidate choice. Candidate IDs are mapped back to engine action IDs only after validation.

An alarm executes one model turn. The attempt marker is saved before making the paid call; the result commits only if the attempt and board revision still match. A duplicated alarm with an unresolved attempt pauses instead of making another uncertain call. Pause lets the current request finish and stops subsequent scheduling; ending a match invalidates the attempt and rejects a late result. Upper limits pause without inventing a winner.

Cloudflare alarms are at-least-once. The application prevents duplicate committed moves, but cannot promise exactly-once provider charging without provider-side idempotency.

D1 is a projection of match state. Monotonic version checks prevent a slower old projection overwriting a newer one. Failed D1/R2 writes remain pending and are retried independently. Final replay artifacts use stable keys in a private R2 bucket. Reads check current publication status, so withdrawing a publication blocks subsequent access.

Saved credentials use AES-GCM with owner ID as authenticated additional data. ARENA_ENCRYPTION_KEY must exist; there is no plaintext fallback. Deleting a credential prevents later inference and prevents an in-flight response from being committed after revocation. Rotating the master key requires explicit re-encryption; do not simply replace it.

Public artifacts are constructed from an allowlist. Provider keys, credential IDs, private endpoints, prompts and raw reasoning are excluded. Army Chess has separate player/spectator projections; AI-seat snapshots cannot be requested by the owner during play. The human-human UI obscures the screen between turns, while the server still restricts AI seat access.

The rules version is fixed at match creation. A deployment with an incompatible adapter pauses old matches. Keep old adapter versions when implementing long-term backward compatibility; replay frames remain independent of rule execution.
