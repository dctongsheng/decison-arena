# Decision providers

Supported protocols are typed Decisions, not chat completions:

- OpenRouter: `https://openrouter.ai/api/alpha/decisions`, model ID required (for example `typesafe/jev-1.13`).
- StartLux System One: `https://startlux-decision.com/v1/systemone`; new model forms and new BambooNode System One profiles default to thinking `never`, with a budget of 4096 for when thinking is explicitly enabled.
- Custom OpenRouter-compatible or System One-compatible public HTTPS endpoint.

Each seat has its own saved profile. Different Jev versions or thinking profiles can play one another. Availability is confirmed by the user's connection test; the app does not claim every OpenRouter chat model supports the Decisions API.

The new-profile default does not rewrite saved `auto`/`always` settings or existing chess matches. BambooNode synchronization preserves existing profile settings, and chess matches retain the model configuration frozen when they were created. Legacy chess profiles without a thinking field keep their original provider fallback. Snake, Tetris and Platformer always force thinking to `never`, including older or cloned sessions. OpenRouter/Jev thinking behavior is managed by that provider; Arena does not send unsupported System One thinking controls to it.

The provider request has `state` and a `questions.primary_move` choice question with short `m0`, `m1`, … keys. The response must contain `answers.primary_move.choice` matching one of those keys. Optional confidence must be finite in [0,1]; optional probabilities must cover all candidates and sum approximately to one. Omitted metrics display as unavailable.

Game turns require a legal action, so all System One providers (built-in, custom and BambooNode) explicitly send top-level `allow_none: false`. This overrides services that enable abstention by default and asks the service to select from the supplied candidates. The separate `none_check` setting is left unchanged. OpenRouter-compatible providers do not receive this System One control. A null or unknown choice still stops the turn; Arena never substitutes the highest-probability candidate or retries automatically.

System One profiles send `think_mode`, `think_budget` and `return_details`, plus `return_thought: true` when thinking is `auto` or `always`. OpenRouter profiles do not receive unsupported System One parameters. The app shows only thought text actually returned by the provider; thinking-used metadata or token counts are not substituted for text. With these JSON endpoints, text becomes available after a move completes, rather than streaming while the model runs.

Returned thought text is stored separately from metrics on private move events, bounded to 16,384 UTF-16 code units per move with a visible truncation indicator. It is not added to the next move's model context or written to logs. Live Army Chess views hide thoughts from the opposing seat and spectators; after the match ends, the owner can read them. Community publication always strips thought text from its replay artifact. Earlier moves for which text was not saved cannot be reconstructed.

Custom endpoint restrictions: public DNS hostname, HTTPS port 443, no user information, query string or fragment, no redirects, and public-address DNS validation at configuration/call time. DNS-over-HTTPS uses fixed Cloudflare, Google and Alibaba resolvers, with fallback only on transport failure; an answer containing a private address is rejected. Only the configured hostname is sent to these resolvers, never the API key. Custom network calls execute only inside workerd, including local development, rather than through the Node frontend. Workers have no bindings to the user's private network. For a local model, provide your own authenticated public HTTPS tunnel; `127.0.0.1` is not a cloud endpoint.

API keys are sent only to their selected provider. Never paste real keys into committed examples, URLs, screenshots, issue reports or CI logs. The repository contains no shared provider key. Connection testing makes a small real provider call and may consume the user's provider quota.

## Explicit local development endpoints

For a model reachable on the same computer as the local runner, an operator can opt in to an exact loopback URL in the gitignored `apps/runner/.dev.vars`:

```dotenv
LOCAL_DEV=true
ARENA_LOCAL_PROVIDER_ENDPOINTS='["http://127.0.0.1:18080/v1/systemone"]'
```

Restart `pnpm dev` after changing these bindings. In Model Connections, select **Custom · System One compatible**, use that exact URL and the actual model identifier (for example `startlux-decision-27b-autothink`), enter your existing key, test the connection, and save. The new form defaults to thinking off (`never`) and a budget of `4096`. Choose `auto` or `always` explicitly if wanted for chess; real-time games still force thinking off.

This exception applies only to custom providers when `LOCAL_DEV` is exactly `true`. The allowlist is server configuration, never a browser/profile parameter. Only canonical literal `http://127.0.0.1:<port>/<path>` addresses are accepted; alternate hosts, ports, paths, URL parameters, and redirects remain blocked. Endpoint validation, connection testing, and every chess/arcade inference recheck the policy. Keys retain the normal account-bound encrypted storage.

Keep the model service or its local SSH forward running. Do not add these bindings to production configuration: deployed Workers cannot reach your computer's loopback, and production rejects stored local profiles. Use an authenticated public HTTPS endpoint for cloud deployment.

## Tetris V8 visual decisions

`supportsDecisionImages` is shared by creation UI, Web service, Runner and transport. System One providers retain their top-level `images` contract. The OpenRouter, compatible OpenRouter and BambooNode Decisions providers support exact request-model IDs `typesafe/jev-1.13` and `typesafe/jev-1.14`; both V8 stages send `state` as an array containing the complete JSON-serialized structured observation followed by `{type: "image_url", image_url: {url: "data:image/png;base64,..."}}`. Top-level `images` is not sent to Jev. Requests without images keep their original shape. This follows the [OpenRouter multimodal Decisions guide](https://openrouter.ai/docs/guides/community/multimodal-decisions), not the different native TypeSafe assets/header protocol.

The current native-rendered observation is 384×576. Arena permits one inline PNG up to 2 MiB; Jev additionally requires each dimension to be 256–1568 and pixel area 78,400–2,458,624. System One's existing limits are unchanged. Unknown request models and invalid images fail before the paid POST. No silent text-only fallback, automatic retry or model substitution occurs. Compatible endpoints must support this protocol themselves.

Arcade freezes `thinkMode: never`; System One sends `think_mode: never`. Jev does not receive unsupported thinking controls. If it omits `thoughtUsed`, the UI reports that it was not returned. Separate runs keep independent goals, histories and budgets even when they use different protocols. Image bytes and raw requests are excluded from events and public replays. See the [live mixed-provider validation](experiments/tetris-v8-arena/jev-integration.md).
