# Decision providers

Supported protocols are typed Decisions, not chat completions:

- OpenRouter: `https://openrouter.ai/api/alpha/decisions`, model ID required (for example `typesafe/jev-1.13`).
- StartLux System One: `https://startlux-decision.com/v1/systemone`; default thinking `always`, budget 4096.
- Custom OpenRouter-compatible or System One-compatible public HTTPS endpoint.

Each seat has its own saved profile. Different Jev versions or thinking profiles can play one another. Availability is confirmed by the user's connection test; the app does not claim every OpenRouter chat model supports the Decisions API.

The provider request has `state` and a `questions.primary_move` choice question with short `m0`, `m1`, … keys. The response must contain `answers.primary_move.choice` matching one of those keys. Optional confidence must be finite in [0,1]; optional probabilities must cover all candidates and sum approximately to one. Omitted metrics display as unavailable.

System One profiles send `think_mode`, `think_budget` and `return_details`, plus `return_thought: true` when thinking is `auto` or `always`. OpenRouter profiles do not receive unsupported System One parameters. The app shows only thought text actually returned by the provider; thinking-used metadata or token counts are not substituted for text. With these JSON endpoints, text becomes available after a move completes, rather than streaming while the model runs.

Returned thought text is stored separately from metrics on private move events, bounded to 16,384 UTF-16 code units per move with a visible truncation indicator. It is not added to the next move's model context or written to logs. Live Army Chess views hide thoughts from the opposing seat and spectators; after the match ends, the owner can read them. Community publication always strips thought text from its replay artifact. Earlier moves for which text was not saved cannot be reconstructed.

Custom endpoint restrictions: public DNS hostname, HTTPS port 443, no user information, query string or fragment, no redirects, and public-address DNS validation at configuration/call time. DNS-over-HTTPS uses fixed Cloudflare, Google and Alibaba resolvers, with fallback only on transport failure; an answer containing a private address is rejected. Only the configured hostname is sent to these resolvers, never the API key. Custom network calls execute only inside workerd, including local development, rather than through the Node frontend. Workers have no bindings to the user's private network. For a local model, provide your own authenticated public HTTPS tunnel; `127.0.0.1` is not a cloud endpoint.

API keys are sent only to their selected provider. Never paste real keys into committed examples, URLs, screenshots, issue reports or CI logs. The repository contains no shared provider key. Connection testing makes a small real provider call and may consume the user's provider quota.
