# Dima Desktop OAuth Beta

This guide describes the current Dima OAuth beta contract for a native desktop client. The registered public client is `dima-desktop`. It has no client secret: native applications cannot keep a shared secret confidential. Dima OAuth credentials are separate from streaming identities in `users.accounts` and external accounts in `src/schemas/accounts.schema.ts`; the OAuth client registry, grants, sessions, and refresh-token records live in their own models.

## Hosts and browser consent

- Issuer and API: `https://api.domdimabot.com`
- Dima website and browser consent: `https://domdimabot.com`
- Authorization endpoint: `https://api.domdimabot.com/oauth/authorize`
- Token and refresh endpoint: `https://api.domdimabot.com/oauth/token`
- Revocation endpoint: `https://api.domdimabot.com/oauth/revoke`
- Authorization-server metadata: `https://api.domdimabot.com/.well-known/oauth-authorization-server`
- Browser connection management: `https://domdimabot.com/oauth/connections`

Token, revocation, and authorization-server metadata endpoints allow public CORS (`Access-Control-Allow-Origin: *`). Metadata advertises `client_id_metadata_document_supported: true`. See [MCP.md](./MCP.md) for the other audience.

Set `User-Agent: DimaDesktop/<app-version>` on HTTP requests and the WebSocket handshake. The web edge may treat generic automated-client user agents differently, so identify the native client explicitly.

Start a system-browser authorization-code flow. Bind a loopback listener before opening the browser, on an ephemeral, non-default port, and use exactly `/oauth/callback` as the path. The supported redirect hosts are `127.0.0.1` and `[::1]`; the URI must be plain HTTP and contain no user info, query, or fragment. Preserve the exact selected URI for the token exchange, including host and port. For example: `http://127.0.0.1:49152/oauth/callback`.

Generate a cryptographically random PKCE verifier (43–128 characters from `A-Z a-z 0-9 . _ ~ -`) and `code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))` without padding. A fresh random `state` is optional but recommended; it must contain 1–500 characters in `%x20-7E` and is echoed exactly. A 43-character base64url value is suitable. Send these authorization parameters:

```text
client_id=dima-desktop
response_type=code
redirect_uri=<exact loopback callback URI>
scope=profile:read credits:read desktop:connect
state=<optional, fresh random value>
code_challenge=<S256 challenge>
code_challenge_method=S256
device_name=<optional, up to 80 characters>
resource=<optional; defaults to https://api.domdimabot.com/v1>
```

The browser lands on the Dima site for consent. The user must sign in to a registered Dima account; approving redirects to the exact loopback URI with `code` and `iss=https://api.domdimabot.com`. Denial returns `error=access_denied` and `iss`. Both callbacks include `state` only if the client sent it. The desktop app must handle error callbacks, verify `iss` against the expected issuer, and, if it sent `state`, compare the returned value exactly before exchanging the code. Reject callbacks with missing or mismatched expected values. Authorization requests expire after 10 minutes; authorization codes are single-use and expire after 60 seconds.

Once `client_id` and `redirect_uri` are valid, authorization request errors redirect to the loopback callback with `error`, `error_description`, `iss`, and `state` if valid. Error codes include `invalid_request`, `unsupported_response_type`, `invalid_scope`, and `invalid_target`. An unknown or disabled client, invalid redirect URI, or duplicated `client_id` or `redirect_uri` instead returns JSON 400 `{ "error": "..." }` in the browser and never redirects. HTTP 429 and 503 responses also remain JSON.

Scopes belong to an audience and cannot be mixed across resources. Desktop access tokens do not work on MCP; MCP tokens do not work on `/v1`. The desktop consent decision must not send `channel_id`.

The browser `GET /oauth/browser-session` response includes `user_id`, `channel_id`, `name`, and `channels` (entries have `id`, `name`, `role`). `GET /oauth/connections` returns `sessions` with `client_name` and `resource` alongside the session, grant, channel, device, scope and time fields; legacy sessions default to the desktop resource and registry client name.

## Exchange, refresh, and sign-out

POST form-encoded fields to `/oauth/token` for the initial exchange:

```text
grant_type=authorization_code
client_id=dima-desktop
code=<callback code>
redirect_uri=<same exact callback URI>
code_verifier=<original verifier>
```

The successful response is standard top-level JSON fields, not a `{data: ...}` envelope:

```json
{
  "access_token": "dima_at_…",
  "token_type": "Bearer",
  "expires_in": 600,
  "refresh_token": "dima_rt_…",
  "scope": "profile:read credits:read desktop:connect",
  "session_id": "…",
  "refresh_expires_in": 2592000
}
```

Access tokens last 600 seconds. Refresh tokens have a rolling 30-day idle limit and a 90-day absolute session limit. Refresh rotates the refresh token on every successful call and returns the same response shape with a new access and refresh token. Serialize refresh operations per session: concurrent refreshes or replay of an old refresh token revoke the session. If a refresh response is lost, do not blindly retry the old token; require the user to authorize again if the new token was not safely received and persisted.

For refresh, POST these form-encoded fields to `/oauth/token`:

```text
grant_type=refresh_token
client_id=dima-desktop
refresh_token=<latest refresh token>
```

The exchange and refresh may include `resource`; if present it must match the authorized resource or the server returns `invalid_target`. A disabled client makes existing access tokens fail with 401 `invalid_token`; authorization for an unknown or disabled client still returns JSON 400.

The optional `scope` field may be omitted or must exactly match the originally issued scope string; this beta rejects any other value. As a desktop storage recommendation, keep access tokens in memory and persist refresh credentials only in the platform credential store. This guide makes no Windows or Linux app changes.

To sign out this installation, send `DELETE https://api.domdimabot.com/v1/desktop/session` with `Authorization: Bearer <access_token>`. The app may also revoke a token using form-encoded `client_id=dima-desktop&token=<refresh_token>` at `/oauth/revoke`. Users can revoke one desktop connection or the whole Dima Desktop grant at the website connection-management page.

`pet:read` is also an active, optional scope for the pet configuration read resource. Request it explicitly in the authorization scope string if the application needs that resource; the original three-scope string above remains sufficient for the other desktop APIs.

## Active desktop API and WebSocket

The issuable scopes for `dima-desktop` are `profile:read`, `credits:read`, `desktop:connect`, `pet:read`, `pet:receive`, `pet:interact`, `pet:control`, `pet:playback:select`, and `ai:interact`. They apply to the account that approved the grant; these beta endpoints do not accept a client-selected channel/account. Current HTTP resources include `GET /v1/me` (`profile:read`), `GET /v1/me/credits` (`credits:read`), `GET /v1/me/pet` (`pet:read`), and `GET` or `DELETE /v1/desktop/session` (the read requires `desktop:connect`; deleting the current session accepts any valid access token), authenticated with `Authorization: Bearer <access_token>`. The pet resource is available only for Premium and Pro channels; a free-tier channel receives `403 plan_required`, even when its token includes `pet:read`. A user must authorize with `pet:read` before the pet resource is available. See [PET_CONFIGURATION.md](./PET_CONFIGURATION.md) for the pet settings contract and response shape.

The API also exposes `GET /v1/me/pet/runtime`, `PUT /v1/me/pet/playback`, `POST /v1/me/pet/requests/:requestId/cancel`, and AI turn routes under `/v1/me/ai/turns`. See [DESKTOP_AI_CONTRACT.md](./DESKTOP_AI_CONTRACT.md) for the AI turn contract. The session response sets `pet_available` according to whether the token has `pet:receive`.

For the native WebSocket, connect to `wss://api.domdimabot.com/v1/desktop/ws` with both `Authorization: Bearer <access_token>` and the WebSocket subprotocol `dima.desktop.v1`. Do not put credentials in the URL or query string. The server sends a `hello` message with `protocol_version: 1`, session/channel IDs, granted scopes, and `pet_available: false`. The only currently supported text message is `{"type":"ping","id":"optional-correlation-id"}`, answered by `{"type":"pong","id":"optional-correlation-id"}`. The connection is periodically checked against session validity and closes after expiry or revocation.

## Beta boundary

The inactive catalog scopes `usage:read` and `pet:write` are planned and cannot currently be requested or issued. Existing grants and sessions retain their original scopes; newly listed scopes require fresh consent. The native WebSocket described above does not provide pet messages.

## Bearer errors

A `/v1` HTTP 401 returns `{"error":"invalid_token"}`. Without Bearer credentials, its challenge is `WWW-Authenticate: Bearer realm="dima"`; when Bearer credentials were sent but rejected, it also includes `error="invalid_token"`. A 403 `insufficient_scope` includes `WWW-Authenticate: Bearer realm="dima", error="insufficient_scope", scope="<required scopes>"`, including for AI turn routes requiring `ai:interact` or `pet:interact`. Browser-route 401 `login_required` challenges use `realm="dima-browser"`; token-endpoint errors have no challenge. Use the HTTP status and body `error` for handling; do not depend on the header parameter order or set, since more parameters such as `resource_metadata` may be added.

## Rate limits

Per client IP, the limits per minute are 600 requests to `/oauth/*`, 1200 to `/v1/*`, and 120 native WebSocket handshakes. `/v1/*` also has a limit of 1200 per access token per minute. A rate-limited HTTP request returns 429 `{"error":"slow_down"}` with `Retry-After: 60`; a rate-limited WebSocket handshake currently receives HTTP 401. IPv6 clients are limited per /64; when forwarded addresses conflict, both are counted and each must have budget. For `/v1/*`, the per-IP limit is checked before the per-token limit.

## Client scope registry

First-party clients and their allowed scopes are listed in `src/server/oauth/clients.ts`; activating a catalog scope grants it to no client. At startup, listed scopes are added to existing clients, but boot never removes scopes: removing one cuts that client's live sessions with that scope. Previously stored scopes are retained. Name, redirect URIs, and `enabled` are set only on first creation. A listed inactive scope is not issuable.

## Verification

For the isolated API candidate behavior check, use the helper-generated API run ID and the disposable fixtures:

```bash
scripts/saas-ops verify api-<run-id> --dependency mongo --dependency redis --fixtures ops/checks/oauth-beta-fixtures --test-env ops/checks/oauth-beta-fixtures/test-env.json --check ops/checks/oauth-beta.mjs
```

This command documents the required verification path; it does not mean the candidate check or deployment has passed.
