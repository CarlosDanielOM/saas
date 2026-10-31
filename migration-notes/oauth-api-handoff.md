# OAuth desktop-beta HTTP API — native handoff

Authoring-only port of `dimabot/src/server/oauth/catalog.ts`, `service.ts`, `routes.ts`, and `desktop-websocket.ts`. Nothing in this slice was compiled, formatted, executed, or deployed. The integration team owns `cargo`, the feature flag, and the library module registration.

Owned files:

- `dimabot/src/server/oauth/mod.rs`
- `dimabot/src/server/oauth/catalog.rs`
- `dimabot/src/server/oauth/service.rs`
- `dimabot/src/server/oauth/routes.rs`
- `dimabot/src/server/oauth/desktop_websocket.rs`
- `dimabot/tests/oauth_api.rs`
- `dimabot/tests/oauth_desktop_ws.rs`
- `dimabot/tests/fixtures/oauth_api_reference.cjs`
- `dimabot/tests/support/oauth_support.rs` (helper from the HTTP port; not modified for the socket)
- `migration-notes/oauth-api-handoff.md`

`dimabot/Cargo.toml` and `dimabot/src/lib.rs` were not edited.

## 1. Central patches

Apply both hunks. The module path is `dima_rust::oauth_api`. It is not `dima_rust::server::oauth`.

`oauth-api` is wider than a bare `http` + `mongo` + `redis` line:

- `api-auth` makes `crate::api_auth::AuthService` exist for the opt-in `protected_router` / `protected_desktop_router` methods.
- `observability` makes `dima_rust::utils::observability` exist. `tests/support/api_auth_support.rs` names that module, and `tests/oauth_api.rs` includes that file.
- `dep:getrandom` is used directly by `catalog::secret`. `observability` also enables it.
- `dep:sha2` is used directly by `catalog::hash`. `mongo` also enables it.
- `dep:base64` is not pulled in by `api-auth`, `mongo`, or `observability`.
- `dep:serde_json` is used directly. `mongo` also enables it.

The Cargo anchor is the `api-validation-route` line. That anchor collides with slices 2a, 4a, 4b, and 6. Merge the feature line. Do not paste those slices' feature lines here. `http-ws = ["http", "axum/ws"]` already exists and is a different feature. `oauth-api` must list `axum/ws` itself. Axum 0.8.9 keeps `extract::ws` behind `feature = "ws"`. Without `axum/ws` the desktop socket module does not compile. That is expected until integration applies the snippet.

```diff
--- a/dimabot/Cargo.toml
+++ b/dimabot/Cargo.toml
@@ -26,6 +26,7 @@
 api-auth = ["http", "http-client", "redis", "application-schemas", "observability", "logger-redis"]
 api-admin = ["api-auth"]
 api-observability-route = ["http", "http-client", "dep:serde_json"]
 api-validation-route = ["api-auth", "dep:serde_json"]
+oauth-api = ["api-auth", "http", "http-client", "mongo", "redis", "logger-redis", "application-schemas", "observability", "dep:serde_json", "dep:sha2", "dep:base64", "dep:getrandom", "axum/ws"]
 # Native WebSockets use Axum's transport rather than a separate client crate.
 http-form = ["http", "axum/form"]
```

Register the module in one hunk with the other new modules, after `validation_route` and before `domain_event_runtime`. Do not apply the site-analytics, OAuth, and stream-timeline registrations as independent hunks.

```diff
--- a/dimabot/src/lib.rs
+++ b/dimabot/src/lib.rs
@@ -108,6 +108,22 @@
 #[cfg(feature = "api-validation-route")]
 #[path = "server/routes/validation.route.rs"]
 pub mod validation_route;
+#[cfg(feature = "site-analytics-api")]
+#[path = "server/routes/site.route.rs"]
+pub mod site_route;
+#[cfg(feature = "oauth-api")]
+#[path = "server/oauth/mod.rs"]
+pub mod oauth_api;
+#[cfg(feature = "stream-timeline-routes")]
+#[path = "server/routes/stream_timeline.route.rs"]
+pub mod stream_timeline_route;
+#[cfg(feature = "stream-timeline-routes")]
+#[path = "server/routes/stream_summary.route.rs"]
+pub mod stream_summary_route;
+#[cfg(feature = "stream-timeline-routes")]
+#[path = "server/routes/analytics.route.rs"]
+pub mod analytics_route;
 
 #[cfg(feature = "domain-event-runtime")]
 #[path = "domain_events/runtime/mod.rs"]
 pub mod domain_event_runtime;
```

Until both hunks are applied, `dima_rust::oauth_api` does not exist and `tests/oauth_api.rs` and `tests/oauth_desktop_ws.rs` compile to empty crates. That is expected. Do not add a dependency. `sha2` 0.10.9, `base64` 0.22.1, and `getrandom` 0.4.3 are already optional crates. `futures-util` is already enabled through `mongo`.

Suggested check, after the patches, from `dimabot/`:

```text
cargo test --features oauth-api --test oauth_api --test oauth_desktop_ws
cargo test --features oauth-api --test oauth_api -- --ignored --test-threads=1
```

The ignored Mongo/Redis test and the ignored source-oracle comparison stay ignored unless their fixture variables are set. The Mongo test must not be pointed at a production database or cache.

## 2. Public API

`dima_rust::oauth_api` re-exports the prelude below. `catalog`, `service`, and `routes` are public modules. Router builders are methods on the service. Route handler functions stay private.

Constructors do no I/O. `OAuthApiService::new` only checks that `validate_url` is an absolute `http:` or `https:` URL. `from_runtime` is the one constructor that calls `get_mongo_client` and `get_redis_client`. Indexes are installed only by `initialize`. `PUBLIC_API_URL`, `DASHBOARD_URL`, and `CLIENT_ID` are read when a request needs them.

```text
OAuthApiService::new(database, redis, http, logger, validate_url, credits, pet) -> Result<Self, ConfigError>
OAuthApiService::validate_http_client() -> Result<reqwest::Client, OAuthInitError>
OAuthApiService::from_runtime(logger, credits, pet) -> Result<Self, OAuthInitError>
OAuthApiService::initialize(&self) -> Result<(), OAuthFailure>
OAuthApiService::router / public_router / desktop_router(&self) -> Router
OAuthApiService::protected_router(&self, auth: &AuthService) -> Router
OAuthApiService::protected_desktop_router(&self, auth: &AuthService) -> Router
OAuthApiService::mounted_router(&self, mount: &str) -> Router
OAuthApiService::mounted_desktop_router(&self, mount: &str) -> Router
OAuthApiService::application_router(&self) -> Router   // nests /oauth and /v1
desktop_websocket_router(gate) -> Router               // relative /desktop/ws, no boundary
```

`desktop_router` is `http_desktop_router().merge(desktop_websocket_router(self.clone()))`. `http_desktop_router` is the private HTTP router passed through `gated`. Axum's `Router::layer` wraps only routes that already exist, so the merge leaves `GET /desktop/ws` outside `oauthBoundary`. Nesting at `DESKTOP_MOUNT` (`/v1`) yields `GET /v1/desktop/ws`. There is no second absolute `/v1/desktop/ws` route. `application_router` and `mounted_desktop_router` both pick the merged router up. Using `application_router` and `mounted_desktop_router` together still overlaps `/v1`, and the socket route follows that same overlap.

`protected_router` and `protected_desktop_router` are opt-in. The TypeScript server does not put `authMiddleware` in front of these routes. `AuthService::protect` would require a legacy API token and reject desktop and browser bearers. `protected_desktop_router` layers that gate on the HTTP desktop router only. Production mounting is `application_router()`, or `mounted_router("/oauth")` plus `mounted_desktop_router("/v1")`.

### Desktop WebSocket

`DesktopSocketGate` is `website`, `rate_limit`, and `authenticate`. `OAuthApiService` implements it by calling `oauth_website`, `OAuthApiService::rate_limit`, and `OAuthApiService::authenticate_access`. Loopback tests use an in-memory gate in `tests/oauth_desktop_ws.rs`. `tests/support/oauth_support.rs` stays a disposable MongoDB database plus a Redis `oauth:*` keyspace. The socket tests do not open that fixture.

Admission runs before `WebSocketUpgrade::from_request_parts`, inside a 5 second timeout. The order is: any query string (including `?`) is 403; a present non-empty `Origin` calls `website()` and a mismatch is 403; a throw from `website()` is 401; a missing or empty `Origin` does not call `website()`; the protocol list must include `dima.desktop.v1` or the status is 426; `ws:{peer}` limit 120 and `authenticate` failures are 401, including rate-limit `slow_down`; a missing `desktop:connect` scope is 403; a third live socket for the same `session_id` is 429. Those responses are empty. Axum's reason phrases are the standard ones (`Forbidden`, `Upgrade Required`, `Too Many Requests`, `Unauthorized`). The source writes the reason `Rejected`.

The 5 second upgrade timer destroys the socket in the source and sends no status line. Axum has to return a response, so this port answers 408 with an empty body and does not open the socket.

The live-connection reserve increments under a mutex only when the count is below 2, and a `SessionSlot` decrements on drop, including when the upgrade extractor rejects. That is stricter than the source check-then-act race, which can briefly pass 2. The loopback test reads both hellos before the third connect, so both behaviours agree on that sequence.

`pet_available` on the hello frame is false. The pet runtime stays team4's adapter.

Hello JSON field order is `type`, `protocol_version`, `session_id`, `channel_id`, `scopes`, `pet_available`. Pong is `type`, then `id` only when the string is non-empty. The error frame is `{"type":"error","error":"unsupported_message"}`. Close codes are 4429 `Too many requests`, 4400 `Text messages required`, 4400 `Invalid JSON`, and 4401 `Session expired or revoked`.

A second text or binary frame while the first handler is still awaiting rate-limit or re-authentication closes 4429. Ping and pong do not trip that busy flag. A thrown error in the handler closes 4401. Binary and invalid JSON return the 4400 close directly.

The source heartbeat is one process-wide 15 second timer. This port runs one timer per connection. `alive` starts true, so the first real tick re-authenticates and sends an empty ping. A still-false `alive` on the next tick drops the socket with no close frame. That is `ws.terminate()`. The source does not use 4401 for silence. 4401 is the re-authentication failure and a thrown message-handler error. On process shutdown Axum drops the tasks. There is no separate `server.on('close')` hook.

Peer IP is `ConnectInfo<SocketAddr>` `IpAddr` display. A missing `ConnectInfo` uses the bucket suffix `unknown`. Message rate-limit buckets are `ws-message:{catalog::hash(token)}` with limit 60. Bearer parsing is `catalog::bearer_token`. A missing bearer does not call `authenticate`.

### Socket.IO

Do not port the process-wide upgrade listener and do not edit `dimabot/src/server/websocket.rs`. The source listener answers 404 for every path other than `/v1/desktop/ws`, except paths starting with `/socket.io/`, which it leaves untouched. `socket_io_builder` sets `req_path("/socket.io")` (no trailing slash). socketioxide's layer owns that path. This OAuth router does not register `/socket.io/`. An unparsable request line is hyper's parser. The process server mounts `application_router()` together with `socket_io_layer`. That mount is still an integration composition change.

Serve with `into_make_service_with_connect_info::<SocketAddr>()`. Without `ConnectInfo`, every caller shares the rate-limit bucket `unknown`.

Required adapter arguments are `OAuthCreditsReader` and `OAuthPetAccess`. `UnwiredCreditsReader` and `UnwiredPetAccess` are real sentinels. They return `NotWired`. They do not invent credit or pet documents.

Other public types: `OAuthError`, `ConfigError`, `RuntimeError`, `OAuthFailure`, `OAuthInitError`, `ExternalFailure`, `ExternalKind`, `FailureResponse`, `CreditsError`, `PetAccessError`, `ErrorBody`, `ErrorHeaders`, `AccessIdentity`, `AuthorizationRequest`, `AuthorizationView`, `BrowserUser`, `ConnectionSession`, `OAuthClient`, `TokenResponse`, `MetadataDocument`, `JsonString`.

Pure helpers used by tests and by the service live on `oauth_api::catalog` (and the ones listed in `mod.rs` are also at the crate root): `parse_scopes`, `validate_redirect`, `validate_redirect_str`, `secret`, `hash`, `constant_time_eq`, `request_key`, `code_key`, `access_key`, `rate_key`, `metadata_document`, `oauth_issuer`, `oauth_website`, `error_headers`, `active_scopes`, `inactive_scopes`.

Service operations with real MongoDB and Redis calls: `rate_limit`, `get_client`, `start_authorization`, `get_authorization`, `authorization_view`, `approve_authorization`, `exchange_code`, `refresh_access`, `authenticate_header`, `authenticate_access`, `revoke_token`, `revoke_session`, `revoke_user_oauth`, `browser_user`, `connections`, `revoke_connection`, `revoke_grant`, `profile`, `desktop_session`, `sign_out`, `describe_failure`. Credit and pet methods call the required adapters after the same scope and user checks as the source.

`describe_failure` logs configuration and runtime failures by `name()` only (`PublicApiUrl`, `DashboardUrl`, `Redis`, `Mongo`, `AdapterNotWired`, …) when a `Logger` was supplied. Protocol and external errors are not logged. The log line is `{ "message": "[OAuth] Request failed", "name": "<name>" }`. Driver text, request bodies, bearer tokens, codes, and provider payloads are not stored on the error.

## 3. Source parity and deliberate deviations

Preserved:

- Secret is 32 random bytes, base64url, no padding (43 characters). `hash` is SHA-256 over UTF-8, same alphabet. `hash("a")` is `ypeBEsobvcr6wjGzmiPcTaeG7_gUfE5yuYB3ha_uSLs`.
- Scope catalogue order and active flags match `catalog.ts`. Parsing rejects a non-string, a UTF-16 length above 500, an unknown scope, an inactive scope, and an empty token from `""` or a double space. Duplicates keep the first-seen order.
- Redirect rules match the source: `http:` only, host `127.0.0.1` or `[::1]`, explicit port `1..=65535`, no user, password, query, or fragment, registered origin-less callback, and the raw value must equal the parser href.
- TTLs: access and request 600 seconds, code 60 seconds, refresh idle `2_592_000_000` ms, session absolute `7_776_000_000` ms. Desktop client id `dima-desktop`.
- Redis keys are `oauth:{request|code|access|rate}:{base64url(sha256(raw))}`. The rate-limit script text is the source Lua. Count `>` limit is `slow_down` / 429. Equal to the limit is allowed.
- Issuer and website are origins of `PUBLIC_API_URL` and `DASHBOARD_URL`, read per call. Unset uses `https://api.domdimabot.com` and `https://domdimabot.com`. An empty string is not the default.
- Boundary headers on every response, including errors, 302, and 204: `Cache-Control: no-store`, `Pragma: no-cache`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`. A present `Origin` that is not the website is 403 `access_denied` with no CORS headers, before the rate limit. A matching `Origin` is echoed with `Vary`, allow-headers, and allow-methods. `OPTIONS` returns before the rate limit.
- Error envelope is only `{ "error": "<code>" }`. 401 adds `WWW-Authenticate: Bearer error="invalid_token"`. 429 adds `Retry-After: 60`. Any failure that is not an `OAuthError`, `PetError`, or `PetSettingsError` is 503 `temporarily_unavailable`.
- Body values must be strings or booleans for decision, token, and revoke. Arrays, including duplicate form keys, are rejected. `GET /authorize` uses the same duplicate-key rule. Desktop routes reject any non-empty query.
- Token, refresh, reuse, revoke, browser session, connections, grant revoke, `/me`, and `/desktop/session` follow the source control flow, including `GETDEL` order, PKCE before consume, grant `$addToSet` plus `revoked_at: null`, session rotation CAS, and RFC 7009 success for an unknown token.
- `initialize` installs the four OAuth collection indexes, upserts the desktop client, then `$addToSet`s the active scopes. Grants and sessions are not rewritten.

Deliberate deviations:

- `timingSafeEqual` throws `RangeError` on different lengths (HTTP 503). `constant_time_eq` returns `false` with no early byte return, and the exchange treats that as `invalid_grant`. All four checks (client, redirect, PKCE, scopes) always run.
- `OPTIONS` 204 has an empty body. Express `sendStatus(204)` may send `text/plain` `No Content`.
- `GET /authorize` 302 has `Location` and an empty body. Express may send an HTML redirect body.
- Malformed JSON or urlencoded bodies complete as 400 `invalid_request`. Express body-parser errors do not reach the OAuth error handler.
- Bodies above 100 KiB are 400 `invalid_request`. Express answers 413 before the handler.
- Bracket form keys (`[` or `]`) are 400 `invalid_request`.
- Only 24 hexadecimal characters are ObjectIds. Mongoose `ObjectId.isValid` also accepts any 12-character string. `revokeUserOAuth` returns immediately for any other id. Connection and grant deletes answer `invalid_request`.
- The validate client does not follow redirects (`Policy::none`). A 3xx is not 2xx, so it is `login_required`. The source `fetch` follows redirects.
- `expires_in` must be a positive finite JSON number. A numeric string such as `"10"` is `login_required`.
- `user_id` must be a non-empty JSON string. A numeric id is `login_required` here. The source would treat it as truthy and then fail the account lookup with `account_required`.
- Unset `CLIENT_ID` matches only a missing `client_id` field (`undefined === undefined`). JSON `null` and a present string do not match. `NotUnicode` never matches.
- The validate response is capped at 64 KiB (`VALIDATE_BODY_LIMIT` in `service.rs`). Oversize or bad JSON is `ValidateResponse` / 503. The source has no hard cap.
- Peer IP is `SocketAddr`'s `IpAddr` `Display` (IPv4 dotted, IPv6 without brackets). A missing `ConnectInfo` uses the bucket suffix `unknown`. An IPv4-mapped address may differ from Express `req.ip`.
- Unknown failures are logged by the typed name through the injected `Logger` only. There is no log line when `logger` is `None`. Names are not JavaScript `TypeError`.
- Index installation uses `tokio::try_join!` (same fan-out as `Promise.all`).
- A stored client missing `client_id`, `name`, `redirect_uris`, or `allowed_scopes` is `invalid_client`.
- Missing connection timestamps are omitted. JSON `null` stays `null`. Browser-session `name` follows JavaScript `||`.
- `GET /me/pet` turns `PetSettingsError` into `OAuthError::custom` before the handler returns, which is what the source route does. `PetError` stays an external failure with its own status. Both are known and are not logged. A successful pet configuration that is not a JSON object becomes 503 `Adapter`, because the source destructure throws.
- `refreshAccess` maps every `activeSession` failure, including Mongo and `invalid_client`, to `invalid_grant` and does not log it. The source `catch` does the same. `invalid_scope` is checked after that `catch`, so it stays `invalid_scope`.
- `getrandom` failure is 503 `Entropy`. A date overflow is 503 `Schema`. Neither panics.
- A non-UTF-8 `Content-Type` is treated as absent, so the body is `{}`.
- A `Location` that is not a legal header value is 503 `Schema`.
- `protected_desktop_router` has no TypeScript counterpart. It is opt-in, same as `protected_router`.
- Manual updates set `updatedAt` explicitly. `__v` is not incremented. `$addToSet` uses the driver because `upsert_equality` only supports `$set` / `$setOnInsert`.
- `activeSession` returns `invalid_token` when the grant or the user is missing before it reads `grant.scopes`, matching JavaScript `||` short-circuit. A corrupt scopes array on a present grant and present user is 503 `Schema`.
- Desktop socket details that differ from the TypeScript upgrade listener are in section 2: 408 for the 5 second timer, standard reason phrases, atomic connection reserve, one heartbeat task per socket, and `terminate` (no close code) when a pong is missed. 4401 stays the re-auth and handler-throw close.
- Protocol tokens are trimmed with ASCII whitespace. JavaScript `trim` also removes a few non-ASCII spaces.
- Tungstenite 0.30 has no per-message deflate setting on `WebSocketConfig`. The server does not advertise the extension, which matches `perMessageDeflate: false`.

## 4. Blocked cross-team endpoints

These five routes are not complete. The traits are required constructor arguments. `UnwiredCreditsReader` / `UnwiredPetAccess` make the route answer 503 `temporarily_unavailable` after the OAuth scope check. That 503 is an adapter-boundary convention, not source parity. The TypeScript source always calls `getAiCredits`, `getFreeAiCreditDisplay`, `getPetConfiguration`, `getPetRuntime`, `selectOwnPetPlayback`, or `cancelPetRequest`. Once the owning adapter is passed to `OAuthApiService::new`, the route returns that value and this 503 disappears. A missing scope is still 403 `insufficient_scope` and does not call the adapter.

This is separate from the source-parity 503. The source error handler returns 503 `temporarily_unavailable` for any throw that is not an `OAuthError`, `PetError`, or `PetSettingsError` (Redis, Mongo, or another unknown error). Native `Configuration` and `Runtime` errors use that same envelope and are source parity. `RuntimeError::AdapterNotWired` and `RuntimeError::Adapter` are the unwired-adapter convention. Do not treat the unwired sentinels as the billing or pet implementation.

| Route | Owner | Status |
| --- | --- | --- |
| `GET /v1/me/credits` | team1-billing-ai (`dimabot/src/utils/ai_credit_display.ts`) | Blocked |
| `GET /v1/me/pet` | team4-speech-media, with pet settings from team2-api-data | Blocked |
| `GET /v1/me/pet/runtime` | team4-speech-media | Blocked |
| `PUT /v1/me/pet/playback` | team4-speech-media | Blocked |
| `POST /v1/me/pet/requests/{requestId}/cancel` | team4-speech-media | Blocked |

`OAuthCreditsReader` (team1-billing-ai). `user` is the users document under the schema default projection (hidden fields excluded), matching Mongoose `findById` without `select('+...')`. `Ok` is the JSON object the route sends. Swallowing credit failures stays inside the adapter. `NotWired` is logged as `AdapterNotWired`. `Failed` is logged as `Adapter`. Neither carries a payload string.

```rust
fn credits_document<'a>(
    &'a self,
    user: &'a mongodb::bson::Document,
    channel_id: &'a str,
) -> impl Future<Output = Result<serde_json::Value, CreditsError>> + Send + 'a;

enum CreditsError { NotWired, Failed }
```

`OAuthPetAccess` (team4-speech-media, including the pet-settings read team2 owns in TypeScript). `Settings` is the source `PetSettingsError`. `Pet` is the source `PetError`. Both keep `code` and `status`. `GET /me/pet` removes `profiles` and `voices` from an object returned by `configuration`; that strip stays in this route.

```rust
fn configuration<'a>(&'a self, user_id: &'a str, channel_id: &'a str)
    -> impl Future<Output = Result<serde_json::Value, PetAccessError>> + Send + 'a;
fn runtime<'a>(&'a self, user_id: &'a str, channel_id: &'a str)
    -> impl Future<Output = Result<serde_json::Value, PetAccessError>> + Send + 'a;
fn select_playback<'a>(&'a self, identity: &'a AccessIdentity, body: &'a serde_json::Value)
    -> impl Future<Output = Result<serde_json::Value, PetAccessError>> + Send + 'a;
fn ensure_configuration<'a>(&'a self, user_id: &'a str, channel_id: &'a str)
    -> impl Future<Output = Result<(), PetAccessError>> + Send + 'a;
fn cancel_request<'a>(&'a self, user_id: &'a str, request_id: &'a str, command_id: Option<&'a serde_json::Value>)
    -> impl Future<Output = Result<serde_json::Value, PetAccessError>> + Send + 'a;

enum PetAccessError {
    NotWired,
    Settings { code: String, status: u16 },
    Pet { code: String, status: u16 },
    Failed,
}
```

`POST .../cancel` checks the body only after `ensure_configuration`. An unwired adapter therefore returns 503 before the `invalid_command` key check. The source calls `ensurePetConfiguration` first as well. The route accepts an object whose only key is `commandId` (the key may be absent) and an empty array. A non-empty array, an extra key, or a non-object is external `Pet` `invalid_command` / 400. Playback selection rules are not implemented here. `PUT /me/pet/playback` forwards the Express JSON value, including numbers and arrays.

## 5. Remaining gaps

`desktop-websocket.ts` is ported. Metadata still advertises `websocket_endpoint` and the `socket_io` block. `pet_available` on the socket hello stays false.

Still blocked:

- `dimabot/src/server/services/pet_settings.service.ts` (the brief's `dimabot/src/services/pet_settings.service.ts` path) stays behind `OAuthPetAccess`.
- The five routes in section 4 stay behind `UnwiredCreditsReader` and `UnwiredPetAccess`.
- Socket.IO namespace `/desktop` is team4's. This slice does not implement it.
- Mounting `application_router()` next to `socket_io_layer` on the process server is still an integration composition change.
- Replacing the unwired sentinels with the owning teams' adapters is still an integration change.

## 6. Tests

`dimabot/tests/oauth_api.rs` starts with `#![cfg(feature = "oauth-api")]`. Pure tests cover scope parsing, redirect rejection and the two loopback forms (plus ports 1 and 65535), secret shape, `hash("a")`, PKCE compare, TTL constants, Redis key builders, the Lua text, error envelopes, and the exact `/metadata` JSON string.

The ignored test `authorize_approve_token_refresh_reuse_revoke` runs authorize, approve, token, refresh, reuse detection, and revoke against a caller-supplied empty Mongo database and a Redis with no `oauth:*` keys. It does not call `get_mongo_client` or `get_redis_client`. Twitch validate is the loopback `Provider` from `api_auth_support`. Run it with `--test-threads=1`.

```text
OAUTH_API_FIXTURE_ACK=disposable
OAUTH_API_FIXTURE_MONGO_URI=mongodb://127.0.0.1:27017
OAUTH_API_FIXTURE_REDIS_URL=redis://127.0.0.1:6379
OAUTH_API_FIXTURE_DATABASE=oauth_api_fixture_<8 to 40 of [a-z0-9]>
CLIENT_ID=<already set; the test does not write the environment>
```

Allowed hosts: `127.0.0.1`, `localhost`, `[::1]`, `::1`, `oauth-api-mongo`, `oauth-api-redis`, `mongo-fixture`, `redis-fixture`. No username or password. `PUBLIC_API_URL` and `DASHBOARD_URL` must be unset or usable absolute http(s) URLs. Cleanup drops only that database and deletes only `oauth:*` keys. It never runs `FLUSHDB`.

`dimabot/tests/oauth_desktop_ws.rs` is `#![cfg(feature = "oauth-api")]`. It serves `desktop_websocket_router` nested at `/v1` with `into_make_service_with_connect_info::<SocketAddr>()` and a raw masked TCP client. It does not construct `OAuthApiService` and does not open Mongo, Redis, or Twitch. `DASHBOARD_URL` is not read. Covered cases: hello JSON, ping/pong with id, empty id omitted, a 64-character id, an extra field, a protocol list with spaces, and a matching origin; unsupported type, 65-character id, numeric id, null id, array, and JSON null; binary close 4400; invalid JSON close 4400; a second data frame while the message rate limit is held closes 4429, and a ping during that hold does not; query 403 before the protocol check; a bad origin 403 without a protocol header; missing and wrong protocol 426; missing and unknown bearer 401; scopes without `desktop:connect` 403; connect-rate `slow_down` is raw 401; a missing or empty origin does not call `website()`, and a present origin whose `website()` throws is 401; two live sockets for one session then 429, then a client close 1000 lets another upgrade complete. Buckets asserted are `ws:127.0.0.1` limit 120 and `ws-message:{hash(token)}` limit 60.

The ignored test `compares_oauth_api_source_oracle` reads `oauth-api-reference.json` from `DIMA_OAUTH_API_FIXTURE_DIR` and checks `DIMA_OAUTH_API_FIXTURE_SHA256` with `tests/support/sha256.rs`. It re-hashes the three TypeScript files against the pins in section 9. It does not boot `application_router`, because the HTTP boundary always calls Redis. Generate the fixture with the command in section 9. Do not point it at a production host.

## 7. Uncertainties for the integration compile

- `reqwest::Url` href equality versus Node's `URL` for an empty query (`?`), explicit `:80`, and IPv6 bracket spelling was written to the same rules as the unit table. The table was not executed.
- Express `req.ip` for an IPv4-mapped peer may differ from Rust `IpAddr` display.
- Axum 0.8.9 `Router::layer` / `Router::merge`, `WebSocketUpgrade::from_request_parts`, `protocols`, `max_message_size`, `max_frame_size`, and `on_upgrade` were read from the registry sources (`axum-0.8.9`, `tungstenite-0.30.0`). `ConnectInfo<SocketAddr>` is a tuple struct with a public field in that checkout. None of this was compiled or executed. `to_bytes` is already used in `observability.route.rs`.
- `url::Url::origin()` is not used. The `url` crate feature is not a direct dependency. Origins are built from scheme, host, and a non-default port.

## 8. oauth_debug_cache.ts reuse

`cacheOAuthAPIFailure` and `cacheOAuthTokenRefreshFailure` are not reimplemented in this slice. `dimabot/src/utils/twitch.rs` was not edited.

| Source | Native |
| --- | --- |
| `cacheOAuthAPIFailure` | `twitch::api_failure_diagnostic` (`twitch.rs` payload). Prefix `OAUTH_API_FAILURE_PREFIX` at `twitch.rs:28`. The concrete writer is `follow_ledger::cache_oauth_api_failure` (`follow_ledger.rs` `SET oauth:failures:api:{timestamp_ms}` `EX 86400`). |
| `cacheOAuthTokenRefreshFailure` | `twitch::refresh_failure_diagnostic`. Prefix `OAUTH_TOKEN_REFRESH_FAILURE_PREFIX` at `twitch.rs:29`. |
| `extractEndpointFromUrl` | `twitch::extract_endpoint` (helix suffix, else the path, else `unknown`). |

Source file sha256 `cac17e19879d3cf8d9985495b3d10ba849d9edfeb495784365199c652a04df1d`. The HTTP oracle does not load this file.

Two observable differences are deliberate stricter redaction. Keep them.

1. `refreshTokenPrefix`. The source stores `failure.refreshTokenPrefix.slice(0, 8)`. Native `refresh_failure_diagnostic` stores the literal `<redacted>`. An 8-character refresh-token prefix is still a credential fragment. Debug-cache readers that expected the prefix will not see it.
2. `sanitizeAuthorizationHeader`. The source returns a non-`Bearer ` Authorization header unchanged, and rewrites a Bearer header to `Bearer <token_length:${headerValue.slice(7).length}>` (UTF-16 length). Native `sanitize_authorization` returns `<redacted>` for a non-Bearer header and uses `encode_utf16().count()` for the Bearer length. Native `sanitize_headers` also redacts cookie, set-cookie, client secret, access token, refresh token, and similar keys that the source leaves unchanged. The comments in `twitch.rs` already state both differences.

## 9. Source oracle

`dimabot/tests/fixtures/oauth_api_reference.cjs` pins and transpiles the actual TypeScript with `transpileModule` (ES2022, CommonJS, `esModuleInterop`, `reportDiagnostics`). It asserts Node 24.22.1 and TypeScript 5.9.3. Express is the workspace Express 4. Mongoose is not loaded. It deletes `PUBLIC_API_URL`, `DASHBOARD_URL`, and `CLIENT_ID` inside the fixture process so the issuer is `https://api.domdimabot.com` and the website is `https://domdimabot.com`. It does not read `.env`.

Pinned sha256 values, checked again while authoring:

- `dimabot/src/server/oauth/catalog.ts` = `4608d6cc655bb101b2d871923f7b06432edde6e8b1de5ca197b364641061456a`
- `dimabot/src/server/oauth/service.ts` = `525e04c8b7b78b849165ffb07233fefe1f3f4421a379d14a049386dbc2405726`
- `dimabot/src/server/oauth/routes.ts` = `a387e88a604a263de03324005f001208731de1c6b718f735d818a7bd4ed493a7`
- `dimabot/src/server/oauth/desktop-websocket.ts` = `a956f3e0e7a7e983fea53bbe8b25adf4e3384943db41062d96ccc23008f6c7a3` (not loaded by the HTTP oracle; the socket tests are native loopback)

The fixture runs a real Express app with `express.json()` before `/oauth` and `/v1`. Redis `eval` records the rate-limit script and can force count 601 or throw. Mongo models are thenables that satisfy `authenticateAccess` for two `dima_at_` tokens and return null for code and refresh lookups. `UsersSchema.findById` throws so a case that goes past the ordering checks fails the generator. `fetch` throws. The output is pretty JSON plus a trailing newline, with insertion-order keys and no timestamps. `--write` uses flag `wx` and refuses a directory inside the repository.

```text
node dimabot/tests/fixtures/oauth_api_reference.cjs --write <absolute-empty-dir-outside-the-repo>
DIMA_OAUTH_API_FIXTURE_DIR=<that directory>
DIMA_OAUTH_API_FIXTURE_SHA256=<sha256 printed by --write>
```

Covered comparisons: exact `/metadata` JSON, error envelopes, `/token` grant dispatch (`authorization_code`, `refresh_token`, `unsupported_grant_type`, and the `invalid_client` / `invalid_request` returns that happen before dispatch), scope-before-query and auth-before-query ordering, the `not_found` fallback, OPTIONS 204, a forced HTTP 429, and a Redis throw that is the source-parity 503. OPTIONS body text and the Express HTML parse error are recorded as documented native deviations. Form-duplicate coverage is not claimed: `express.urlencoded` is not mounted.

Flows that are not source-comparable without a real Mongo or Redis are the `notComparable` array: full authorize/approve/token/refresh/reuse/revoke, browser-session and decision, connections and grants, `GET /v1/me` success, `GET /v1/desktop/session`, credits and the four pet routes, the desktop websocket, and the 5 second / 15 second socket timers. The existing ignored test `authorize_approve_token_refresh_reuse_revoke` remains the only disposable Mongo/Redis flow.
