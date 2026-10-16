# BambooNode account login

The integration is implemented but **disabled by default** (`AUTH_MODE=local`). No real OAuth client has been registered by this project, and the example configuration does not contain credentials. Existing local login continues to work until an operator explicitly changes the mode.

## Register the client first

The proposed [local client registration](bamboonode-client-registration.json) is a reviewable registration checklist, not an executed request or evidence of an existing client. BambooNode's server operator must register it and provide the actual client ID and secret through a private channel.

The planned production origin is `https://arena.startlux-desicion.com` (the hostname supplied by the project owner). Use the separate [production client registration](bamboonode-production-client-registration.json), with client ID `decision-arena` and its own secret. Keep the development callbacks on `decision-arena-local`. These checklists do not register clients, configure DNS or deploy the site.

Register exact callback URLs for the environments being used:

```text
http://127.0.0.1:5091/api/auth/oauth2/callback/bamboonode
http://127.0.0.1:5093/api/auth/oauth2/callback/bamboonode
https://arena.startlux-desicion.com/api/auth/oauth2/callback/bamboonode
```

The callback belongs to Arena. The user-facing authorization page belongs to `https://bamboonode.dev`; token exchange and userinfo belong to `https://api.bamboonode.dev`. The adapter permits only these verified origins in their respective roles. It does not send users to the API domain's password form.

The current BambooNode fork implements an authorization-code flow with S256 PKCE. Although it publishes discovery metadata, its token response does not include an ID token and its userinfo response does not assert `email_verified`. The integration uses OAuth authorization codes and authenticated userinfo, without relying on an ID token or inventing a verified-email claim.

## Configure Arena

After client registration, put the real values in the ignored `apps/web/.env.development` for local development or in the main Worker's environment/secrets for production. Keep the client secret, `AUTH_SECRET`, and vault keys server-only; never use a `VITE_` prefix.

```dotenv
# Enable only after the actual client has been registered and tested.
AUTH_MODE=bamboonode
BAMBOONODE_ISSUER=https://api.bamboonode.dev
BAMBOONODE_AUTHORIZATION_URL=https://bamboonode.dev/oauth/authorize
BAMBOONODE_TOKEN_URL=https://api.bamboonode.dev/oauth/token
BAMBOONODE_USERINFO_URL=https://api.bamboonode.dev/oauth/userinfo
BAMBOONODE_CLIENT_ID=REPLACE_WITH_REGISTERED_CLIENT_ID
BAMBOONODE_CLIENT_SECRET=REPLACE_WITH_REGISTERED_CLIENT_SECRET
BAMBOONODE_SCOPES=openid profile email
BAMBOONODE_TOKEN_AUTH_METHOD=post
# Optional account-management link; use an operator-confirmed frontend page.
BAMBOONODE_ACCOUNT_URL=https://bamboonode.dev
```

For production, build with `VITE_APP_URL=https://arena.startlux-desicion.com`, set the same URL as `AUTH_URL` and `AUTH_TRUSTED_ORIGINS` in the main Worker, and use the production client's ID/secret. Register the callback exactly as written above, without a locale prefix or trailing slash. The local preview continues using its loopback origin and separate client.

`BAMBOONODE_TOKEN_AUTH_METHOD` supports `post` (`client_secret_post`, the default) and `basic` (`client_secret_basic`). Public clients without a client secret are not supported by this server-side adapter. Only `openid profile email` scopes are accepted; quota, model gateway and administrator permissions are not requested.

`pnpm dev:cloudflare` forwards the allowlisted auth settings to the local main Worker through its private generated `.dev.vars`; no extra manual copy is needed. The match runner does not receive OAuth credentials. Restart the corresponding application after changing environment configuration. Both `getAuth()` session checks and `getAuth(configs)` OAuth routes derive the mode and credentials from the server configuration. Database/admin public settings cannot override them.

The public config endpoint exposes `auth_mode`, a boolean `bamboonode_auth_ready`, and an optional validated `bamboonode_account_url`. It does not expose the OAuth client ID, client secret, token endpoint, or userinfo endpoint. If Bamboo mode is enabled but configuration is missing or invalid, login fails closed instead of silently restoring local registration.

## Session and data ownership

The browser starts Better Auth's `signIn.oauth2` flow with provider ID `bamboonode` and a validated same-site return path. The installed Better Auth 1.6.2 plugin stores state, checks the initiating browser's state cookie, and sends S256 PKCE. The server exchanges the one-time code and fetches userinfo over HTTPS, with redirects disabled, bounded responses and a request deadline. Tokens and provider error bodies are not returned to the browser or logged.

The provider's stable `sub` is stored as `account.accountId`; Arena keeps its own generated `user.id`. Model keys, matches, community ownership and encrypted vault associated data continue using that local ID. The access token is encrypted with Better Auth's `account.encryptOAuthTokens`; unused refresh and ID tokens are discarded. API keys for playing games remain separate BYOK credentials.

Bamboo mode disables Arena email/password signup and login, Google/GitHub/One Tap, password setup/reset/change, email changes/verification, manual account linking and OAuth-token retrieval endpoints. New Bamboo users receive an Arena profile/session without a local password. External `root`/role claims are ignored and do not grant Arena moderator or administrator privileges.

An absent `email_verified` stays false. Missing or malformed email fails closed. A different Bamboo `sub` with an existing email is rejected, even if the response claims the email is verified. Existing local users are not silently merged or migrated by matching email. If old local data must be preserved under a Bamboo account, an explicit account-link/migration policy is required before switching that user; changing `owner_id` directly would also invalidate vault encryption and match ownership. Switching modes does not delete old records or automatically revoke already-issued sessions. Local sign-out ends the Arena session; global Bamboo logout and immediate propagation of upstream account revocation require a separate provider-supported policy.

## Validation

```sh
pnpm exec vitest run apps/web/tests/arena/bamboonode.test.ts apps/web/tests/arena/auth-mode.test.ts
pnpm typecheck
```

The tests use the installed Better Auth plugin with an in-memory adapter and mocked token/userinfo responses. They cover state/cookie checks, PKCE, callback replay, encrypted token storage, separate local IDs, role isolation, missing email, duplicate-email subjects, preservation of existing local identities, disabled local auth endpoints, minimal scopes, restricted origins, private public-config output, server-only mode selection and auth-cache rebuilds. They do not register a remote client or claim a real BambooNode login succeeded.

Implementation follows the installed [Better Auth v1.6 Generic OAuth interface](https://better-auth.com/docs/1.6/plugins/generic-oauth). The latest documentation uses a different client interface; use `signIn.oauth2` and `/api/auth/oauth2/callback/bamboonode` for this repository's pinned version.
