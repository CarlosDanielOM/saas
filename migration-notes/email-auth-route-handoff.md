# Email activation route — authored handoff, 2026-10-31

Scope: `src/server/routes/email-auth.route.ts`, mounted publicly by `server.ts` at `/email`. The existing native `utils::jwt::ActivationTokenService` verifies tokens; `schemas::users::schema().native_collection` chooses the same `users` collection and the Mongo adapter casts IDs to ObjectId as Mongoose `findById` does. No service initialization, email or network call occurs at import or construction. Lookup errors and invalid IDs redirect to the invalid-link page; first Twitch account wins. The token is verified before any lookup. No producer, other auth endpoint, server, or deployment was changed.

## Central integration patches (not applied)

`dimabot/Cargo.toml`, in `[features]`:

```toml
email-auth-route = ["api-auth", "jwt"]
```

`api-auth` supplies http, http-client, redis and application-schemas; the latter includes Mongo. This broader test feature also supports the protected-mount test; a future separate dev test feature could narrow runtime dependencies.

`dimabot/src/lib.rs`, alongside other route modules:

```rust
#[cfg(feature = "email-auth-route")]
#[path = "server/routes/email_auth.route.rs"]
pub mod email_auth_route;
```

At the future native server composition point, after explicitly creating the application database and configured secret, mount outside the authenticated router (illustrative variables must be wired to the real host):

```rust
let email_tokens = dima_rust::utils::jwt::ActivationTokenService::from_env()?;
let email_auth = dima_rust::email_auth_route::EmailAuthRoute::new(database.clone(), email_tokens, logger.clone());
let app = axum::Router::new()
    .nest("/email", email_auth.router())
    .merge(auth.protect(protected_routes));
```

Do not wrap the merged root with `auth.protect`. Integrate the public router with existing `/email` endpoints without overlapping method/path conflicts. No central native server mount was located or edited; caller adoption is outstanding. `/auth/authorize?action=activate` and the rest of the login flow must remain available and actually adopted on the native host; this slice does not port them.

## Oracle and validation contract

The source oracle transpiles the actual route and archived actual verifier with both source hashes pinned. It uses synthetic signed tokens and a scripted lookup seam; generated output is confined to an absolute external directory. It authors fixed source comparisons for quality, wildcard, ties, explicit zero, unmatched media, parameters, HTML, HEAD, encoded hosts, duplicate tokens, verification failures, missing/malformed accounts, and scalar/array/object/ObjectId names. Replay pins the case list and compares status, Location, Content-Type, Content-Length, Vary, body and lookup count; the HTML body is escaped text rather than a link. The route uses `encodeurl`-style URL encoding and the existing `json_number::number_string` for JS numbers. The existing native logger is injected and records a fixed, redacted failure message for Mongo/cast or malformed-account exceptions; it intentionally omits user ID, token and driver error. A separate authored test inspects captured logging. Source logs its error, ID and timestamp, whereas native logger adds its own timestamp and structured envelope.

Private Mongo test covers real lookup, first Twitch account, a non-string array name, activation change, absent user and public mount next to the actual protected router. Configure `DIMA_EMAIL_AUTH_TEST_MONGO_URI` and a unique task-owned `DIMA_EMAIL_AUTH_TEST_DB` beginning `test_email_auth_`; never use production. The test inserts and removes a generated ObjectId; the fixture owner cleans up after interruptions. The external source fixture requires `DIMA_EMAIL_AUTH_FIXTURE_DIR` and `DIMA_EMAIL_AUTH_FIXTURE_SHA256`. Integration must perform actual execution in isolated resources under repository limits.

## Remaining blockers and limitations

- **Inherited verifier blocker:** native verifier requires `exp` while the archived TS verifier accepts correctly signed claims without it; native service deliberately rejects a missing/empty secret instead of the source's insecure development fallback. The accepted shared verifier was not changed. Full source parity cannot be claimed.
- The coercion implementation covers common BSON numbers, booleans, strings, arrays, plain documents and ObjectIds, but BSON-specific JS object methods (including Date, Binary, Decimal128, RegExp, Long outside JS safe integer range and DBRef) are not ported; these values currently take the logged invalid-link path or, for large Int64, numeric approximation. Exact behavior depends on the Node BSON driver's deserialization/promotion options. This remains a concrete unusual-stored-data parity gap.
- The negotiator implementation is authored from the locally installed Express/accepts/negotiator source, but exotic malformed quality floats, repeated parameter keys, non-ASCII header bytes and duplicate raw Accept/Host headers need further source comparisons. Host values received as non-UTF-8 bytes are not yet mapped with Node's HTTP header decoding. Header transport errors and Express's global `X-Powered-By` / host CORS middleware remain server-composition concerns.
- The oracle and tests are authored only, with no runtime confirmation, compilation, or formatting. No Cargo, Node, tests, Docker, network, production access, or deployment occurred. No readiness or caller-adoption claim is made.

## Authored file SHA-256

- `dimabot/src/server/routes/email_auth.route.rs`: `b90e5aad30ba0af2ec251d91b4cec7c8b78df93dd5ca3466186cd8d81be4733b`
- `dimabot/tests/email_auth_route.rs`: `d7dacc7eff40641d6f928be8a036b880de459d789c1fa8c3be97bfef1d443eaa`
- `dimabot/tests/support/email_auth_route_support.rs`: `0403c075ebb0db74320b74d02bc58d903023b1a2a204ec104cee225608b2f7b6`
- `dimabot/tests/fixtures/email_auth_route_reference.cjs`: `b6518d0a156a59d54c5b65d406991e4c83c09e6ea9250cf81e184cc5a37830c9`
