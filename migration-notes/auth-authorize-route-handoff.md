# GET /auth/authorize — partial authoring handoff, 2026-10-31

**Authored, not verified or ready to integrate.** The previous flat-query approximation has been replaced with a handler-scoped model of the installed Express 4.22.2 / `qs` 6.15.3 query parser. Express sets `query parser` to `extended`; its `parseExtendedQueryString` supplies `allowPrototypes: true` and `arrayLimit: 1000`. The installed defaults include depth 5, parameter limit 1000, duplicate combination, sparse compaction, strict merge, UTF-8 decoding with whole-component fallback, no dots or comma parsing, and empty-array syntax containing an empty string. The model groups decoded full keys before segment parsing, applies the installed nested merge/overflow rules, then retains only the source-observed `state` and `action` properties and performs their JavaScript coercion. This is specialized to the handler, not an exported query framework. It requires source-oracle replay and compilation in the authorized isolated workflow before parity can be asserted. Index classification and overflow markers now use binary64, JavaScript `parseInt`-style prefix parsing, the existing `utils::json_number::number_string` formatter, and binary64 addition. Only canonical indices below 1000 allocate array slots; larger values remain sparse objects. The pinned source oracle includes 2^53, unsigned 64-bit limits, larger decimal and exponent spellings and merges; internal unit coverage inspects rounded overflow markers and no-panic paths. These are authored checks, not execution evidence. Numeric spelling parity depends on the shared formatter and its `serde_json/float_roundtrip` configuration; source-oracle replay remains required.

`auth.route.ts` source SHA-256: `05a6718d45f27365632ce7928a71a89d1b2e5a9e0e0e3a2a7dc919c8d17b806f`. The oracle pins Express and qs versions as well as the installed qs parser and utility source hashes, and extracts the actual pinned scope declaration and handler through the TypeScript AST, transpiles them, and mounts them in the installed Express with no provider calls. It covers malformed components, nested and mixed keys, indices, duplicates, limits, prototypes and shadowed `toString`. Its unhandled-rejection listener records the TypeError and destroys the request after a bounded timeout; Express 4's rejected async handler has no HTTP response. Native `location` reports `CoercionError`, while its HTTP router deliberately returns 500 to avoid an indefinitely pending connection. The replay checks that explicit difference rather than claiming response parity. The oracle accepts only an absolute canonical external directory (empty for `--write`); native replay requires `DIMA_AUTH_AUTHORIZE_FIXTURE_DIR` and `DIMA_AUTH_AUTHORIZE_FIXTURE_SHA256`. No fixture, tests, build, or formatter were run under the author's static-only constraint.

The source uses scopes in their original order, `URLSearchParams` form encoding, `CLIENT_ID` coercion (unset becomes `undefined`), state truthiness, exact scalar action equality, and `Host` with fallback `api.domdimabot.com`; protocol is http only when the case-sensitive host contains `localhost`. It ignores forwarded headers. Express negotiates redirect body using Accept, sets Location/Vary/content length, and handles HEAD. The existing native `email_auth.route.rs` feeds `state` and `action=activate` to this public route.

The email route's redirect functions are private and its file is outside this slice. For integration, extract **one** shared function with a contract equivalent to `express_redirect(location: &str, accept: Option<&str>) -> axum::response::Response`: apply Express `encodeurl` to the location, produce 302, `Location`, `Vary: Accept`, content negotiation for plain/html/none, escaped HTML and byte-accurate Content-Length; preserve HEAD handling at the router/server layer. Both routes should call it, passing the unencoded location exactly once; test against both pinned oracles, including malformed percent, Accept quality, and HEAD. Until then each owns a temporary copy and this is an integration debt, not shared behavior. The existing stream timeline query helper uses flat semantics and cannot represent this Express 4 extended parser.

Suggested central wiring **only after isolated compilation and source-oracle verification**:

```toml
# dimabot/Cargo.toml
# add alongside existing features
auth-authorize-route = ["http", "http-client", "lossless-json"]
```

```rust
// dimabot/src/lib.rs
#[cfg(feature = "auth-authorize-route")]
#[path = "server/routes/auth_authorize.route.rs"]
pub mod auth_authorize_route;

// host router: explicit config captured at startup, outside auth middleware
let authorize = dima_rust::auth_authorize_route::AuthorizeRoute::new(client_id);
let app = app.nest("/auth", authorize.router());
```

A host may need to merge this router with the future `/auth` router before nesting, to avoid overlapping Axum nests. `client_id` is `Option<String>`; pass `None` only for an absent environment variable. No import-time I/O or provider requests occur.

This is only the initial redirect, not auth migration completion. `/auth/register` and `/auth/reauthenticate` must still be implemented and mounted, including Twitch code exchange, token storage/encryption and user/account updates, cache seeding, EventSub cleanup and the rest of each callback's application dependencies. Other auth endpoints and their dependencies remain separately unported. Email activation also needs its token verifier, user storage and logging adapters wired. Deployment and caller adoption remain separate and unauthorized here.

Lead source-corpus constraint: the oracle writer requires Node 24.22.1, V8 13.6.233.17-node.58 and TypeScript 5.9.3, and its native reader checks the same provenance. No host Node was run. These pinned cases still need isolated replay.
