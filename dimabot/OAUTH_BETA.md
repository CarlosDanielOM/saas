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

Start a system-browser authorization-code flow. Bind a loopback listener before opening the browser, on an ephemeral, non-default port, and use exactly `/oauth/callback` as the path. The supported redirect hosts are `127.0.0.1` and `[::1]`; the URI must be plain HTTP and contain no user info, query, or fragment. Preserve the exact selected URI for the token exchange, including host and port. For example: `http://127.0.0.1:49152/oauth/callback`.

Generate a cryptographically random PKCE verifier (43–128 characters from `A-Z a-z 0-9 . _ ~ -`), a fresh random `state` of 43 base64url characters, and `code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))` without padding. Send these authorization parameters:

```text
client_id=dima-desktop
response_type=code
redirect_uri=<exact loopback callback URI>
scope=profile:read credits:read desktop:connect
state=<fresh random value>
code_challenge=<S256 challenge>
code_challenge_method=S256
device_name=<optional, up to 80 characters>
```

The browser lands on the Dima site for consent. The user must sign in to a registered Dima account; approving redirects to the exact loopback URI with `code`, `state`, and `iss=https://api.domdimabot.com`. The desktop app must compare the returned state to the one it created and verify `iss` against the expected issuer before exchanging the code. Handle an OAuth `error` callback, and reject callbacks with missing or mismatched values. Authorization requests expire after 10 minutes; authorization codes are single-use and expire after 60 seconds.

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

To sign out this installation, send `DELETE https://api.domdimabot.com/v1/desktop/session` with `Authorization: Bearer <access_token>`. The app may also revoke a token using form-encoded `client_id=dima-desktop&token=<refresh_token>` at `/oauth/revoke`. Users can revoke one desktop connection or the whole Dima Desktop grant at the website connection-management page. The desktop application owns secure storage of access and refresh tokens in the platform’s credential store; this guide does not prescribe or change Windows/Linux app storage code.

## Active desktop API and WebSocket

The only issuable scopes are `profile:read`, `credits:read`, and `desktop:connect`. They apply to the account that approved the grant; these beta endpoints do not accept a client-selected channel/account. Current HTTP resources include `GET /v1/me`, `GET /v1/me/credits`, and `GET` or `DELETE /v1/desktop/session`, authenticated with `Authorization: Bearer <access_token>`.

For the native WebSocket, connect to `wss://api.domdimabot.com/v1/desktop/ws` with both `Authorization: Bearer <access_token>` and the WebSocket subprotocol `dima.desktop.v1`. Do not put credentials in the URL or query string. The server sends a `hello` message with `protocol_version: 1`, session/channel IDs, granted scopes, and `pet_available: false`. The only currently supported text message is `{"type":"ping","id":"optional-correlation-id"}`, answered by `{"type":"pong","id":"optional-correlation-id"}`. The connection is periodically checked against session validity and closes after expiry or revocation.

## Beta boundary

This release provides the scoped authentication and identity foundation only. Pet listing, configuration, interaction, control, and playback are not implemented. The pet-related scopes shown in metadata are planned and cannot currently be requested or issued. One-active-playback behavior is also planned; it is not part of this beta contract.

For the isolated API candidate behavior check, use the helper-generated API run ID and the disposable fixtures:

```bash
scripts/saas-ops verify api-<run-id> --fixtures ops/checks/oauth-beta-fixtures --check ops/checks/oauth-beta.mjs
```

This command documents the required verification path; it does not mean the candidate check or deployment has passed.
