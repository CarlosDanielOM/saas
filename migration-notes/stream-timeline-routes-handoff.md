# Stream timeline routes handoff — authored, not verified

This authoring wave created the three route modules and extended the source
oracle, injectable route data adapters, and loopback replay for all source
cases. Integration and execution are still required before adoption.

## Prerequisite central registrations

The checkout currently contains the slice-3 and slice-4a source files, but does
**not** contain the `follow-ledger-data` or `stream-timeline-data` feature
lines, nor the `utils::stream_timeline`, `schemas::channel_stream_summary`, or
`schemas::follow_relationship_ledger` registrations. The coordinator must
first integrate the central patches from `follow-ledger-data-handoff.md` and
`stream-timeline-data-handoff.md`. Without them, the feature below refers to
undefined features and the route modules cannot compile. These are blocking
integration dependencies, not evidence that the data-layer files are missing.

## Central patch reconciliation

Defer to the coordinator's current merged prerequisite patch (reported SHA-256
`860cc177b6b56b311644f165acd73683a7a70cb28304ad4c9b456a8e9f164d89`).
The current artifact was not available at the earlier coordinator path and
its digest and applicability were not checked here. Add this feature after
it is integrated; its Cargo anchor overlaps the slice-2a, slice-4a and slice-6
additions and must be merged, rather than
applying the earlier independently anchored hunk.
`bson-js-json` supplies the Node-reader projection and selects `base64`.
`follow-ledger-data` selects `twitch-streamers`.

```toml
stream-timeline-routes = ["http", "api-auth", "api-admin", "stream-timeline-data", "follow-ledger-data", "ordinary-application-schemas", "logger-redis", "bson-js-json", "axum/query", "dep:serde_json"]
```

Add these registrations to `dimabot/src/lib.rs` after the merged patch:

```rust
#[cfg(feature = "stream-timeline-routes")]
#[path = "server/routes/stream_timeline.route.rs"]
pub mod stream_timeline_route;

#[cfg(feature = "stream-timeline-routes")]
#[path = "server/routes/stream_summary.route.rs"]
pub mod stream_summary_route;

#[cfg(feature = "stream-timeline-routes")]
#[path = "server/routes/analytics.route.rs"]
pub mod analytics_route;
```

## Authored API and inventory

`StreamTimelineRouteService::new(database, admin, logger)`,
`StreamSummaryRouteService::new(database, admin, logger)` and
`AnalyticsRouteService::new(database, admin, streamers, logger)` each provide `router`,
`protected_router(&AuthService)` and `mounted_router`. Constructors retain
concrete application handles. Analytics merges the timeline router.
`StreamTimelineRouteService::with_data` and
`StreamSummaryRouteService::with_data` inject the corresponding `Arc` trait;
`AnalyticsRouteService::from_data` injects analytics data and a timeline
service. The default constructors instantiate the Mongo/admin/data-service
adapters and retain their existing query behavior.

The data seams align the route test with the exact boundaries replaced in the
source oracle, so route validation and response composition can be compared
without substituting the production data implementation into only one side.

| Source oracle boundary | Native injectable seam |
| --- | --- |
| timeline data service | `TimelineRouteData::{list,session,timeline}` |
| users owner lookup | `TimelineRouteData::owner` |
| activity aggregate | `TimelineRouteData::rows(People, ...)` |
| AI usage receipts | `TimelineRouteData::rows(Credits, ...)` |
| markers | `TimelineRouteData::rows(Moments, ...)`, `insert_marker`, `delete_marker` |
| admin decisions / access | `TimelineRouteData::permissions`, `SummaryRouteData::access`, `AnalyticsRouteData::access` |
| follow relationship ledger | `AnalyticsRouteData::{rows,count}` |

The source oracle also stubs summary data and streamer metadata; these are
`SummaryRouteData::{list,details}` and `AnalyticsRouteData::streamer`.

Timeline has GET `/streams/{channelID}`, GET
`/streams/{channelID}/{sessionID}`, GET `.../compare/{otherID}`, GET
`.../people`, GET `.../moments`, GET `.../credits`, and PUT and DELETE
`.../markers/{markerID}`. Summary has GET `/{channelID}` and GET
`/{channelID}/{summaryID}`. Analytics adds GET `/follows/{channelID}`.
The two marker methods share the same Axum path entry.

`TimelineContext` is a request-parts extractor. It checks identity, channel
shape, permission and owner in sequence, and carries annotation/tier/billing
context per request. `RouteError` selects source-specific field order:
timeline `error,status,message`, summary/analytics `error,message,status`.
Responses after a successful timeline gate carry `Cache-Control: no-store`.
The customer identifier is not logged or returned.

## Source oracle

The authored `tests/fixtures/stream_timeline_routes_reference.cjs` pins all
three route source hashes and transpiles the actual files into a real Express
application, installing `express.json()` before the routers. Its 28 cases are:
`missing-token`, `bad-channel`, `access-denied`, `bad-page`, `list`,
`invalid-stream`, `details-ok`, `missing-stream`, `compare-free`,
`compare-ok`, `people-ok`, `people-free`, `moments-ok`, `moments-invalid`,
`credits-ok`, `credits-free`, `marker-put-ok`, `marker-put-invalid`,
`marker-put-malformed`, `marker-delete-ok`, `marker-delete-invalid`,
`summary-list-ok`, `summary-forbidden`, `summary-detail-ok`,
`summary-invalid-id`, `follow-missing`, `follow-ok`, `follow-forbidden`.
It uses in-memory model, auth, access, streamer and data-service seams.
From `dimabot/`, with Node 24.22.1,
TypeScript 5.9.3 and the project's Express/Mongoose installed, use an existing
absolute directory outside the workspace:

```sh
node tests/fixtures/stream_timeline_routes_reference.cjs --write <absolute-empty-dir>
node tests/fixtures/stream_timeline_routes_reference.cjs --check <absolute-dir>
```

The output is `stream-timeline-routes-reference.json`; the optional source-root
override is `DIMA_STREAM_TIMELINE_ROUTES_SOURCE_ROOT`. The support module reads
that file from `DIMA_STREAM_TIMELINE_ROUTES_FIXTURE_DIR` with the independent
lowercase digest `DIMA_STREAM_TIMELINE_ROUTES_FIXTURE_SHA256`. The ignored
`replay_timeline_source_cases` test authors replay of **28 of 28 cases**
against the native routers over loopback using a distinct case double, and
compares status, JSON body, content type and cache header. Every case uses
the protected builder, with a cached bearer token for authenticated cases.
The `missing-token` case omits Authorization and compares the production
protected path and exact 401 body on both sides. The source oracle's auth stub
implements the missing/empty token rejection from
`src/middleware/auth.middleware.ts:188-212`, and uses `x-user` as the cached
identity stand-in. The native envelope comes from
`src/middleware/auth.middleware.rs` and `ErrorResponse::no_token`: it has
fields in the order `error`, `message`, `status`, `type`. For this rejection,
the authored replay checks the JSON media type on each side: Express supplies
the charset parameter while Axum's `Json` rejection emits `application/json`.
Additional protected missing-token checks cover the summary and follows
routers. The route-level `Authentication required` branches are defensive
fallbacks unreachable after the real source middleware rejects a missing token;
the native gate-ordering pure test covers the timeline fallback separately.
The authenticated
malformed case compares source status and HTML content type to the native JSON
error and content type separately. The test uses loopback RESP/provider stubs
and an unused Mongo handle at loopback port 1; the injected adapters prevent
database operations. The fixture digest uses `tests/support/sha256.rs`.
These are authored coverage claims; no replay has been executed.
The fixture must be re-recorded with the updated auth stub before replay;
existing external fixture files contain the obsolete pass-through response.

## Remaining gaps and deliberate differences

- Error responses carry underlying error messages and source chains to native
  console logging, with route-specific summary text. The credential/URL
  heuristic matches the site-route policy and preserves ordinary numeric
  diagnostics. The request gate records channel, requester and customer IDs
  for explicit replacement before logging; summary and follows record channel
  and requester IDs. Arbitrary identifiers not available to those call sites
  or encoded differently remain a redaction boundary before real-data use.
  Some locally constructed 500 errors have no diagnostic to retain.
- The concrete default adapters and all replay cases remain unverified. The
  route replay exercises injected boundaries; slice 4a separately owns the
  data-service and disposable-Mongo verification.
- The source gate's owner lookup and admin calls lack a whole-request deadline;
  network error/cancellation behavior is not established. The source order of
  body parsing, Axum JSON rejection formatting and `no-store` on extractor
  rejections needs explicit verification.
- Query strings are parsed leniently; repeated values join as JavaScript
  arrays do under string/number coercion; bracketed object keys reach the root
  as `[object Object]`, and simple bracketed arrays are joined. Complex `qs`
  merges, sparse or reordered arrays and prototype-key rules are not fully
  reproduced. Page numbers use the shared JS
  numeric helper (including hexadecimal). Invalid summary pagination returns
  500. Summary fractional limits and unusual query parsing still need source
  checks. Search is sliced in UTF-16; a split surrogate becomes a replacement
  character at Rust's UTF-8 boundary. The marker malformed-body response is
  JSON 400 rather than Express's HTML 400. Axum's context extractor runs before
  the body extractor, unlike Express's app-level body parser, so a malformed
  body combined with an earlier gate failure can yield a different status:
  unauthenticated malformed requests get Express's 400 before auth but the
  protected native router can return 401 first. The authenticated malformed
  case compares the 400 status and appropriate differing content types in the
  authored replay.
- The moments default uses the current time when `ended_at` is missing or has
  epoch milliseconds zero, matching the source's JavaScript `||` behavior.
- Cursor parsing/serialization and marker time arithmetic need source-backed
  edge checks. `DateTime::try_to_rfc3339_string` may differ from JavaScript's
  exact millisecond `toISOString` text. The people cursor decoder is stricter
  than Node's Buffer base64url decoder on some inputs.
- Marker update uses a raw driver upsert without explicit schema defaults or
  Mongoose casting; summary and ledger rows also require exact Mongoose
  serialization and date-conversion verification. The follow query counts are
  sequential rather than `Promise.all`; very large page arithmetic, raw BSON
  field omissions, and missing streamer-cache behavior need review.
- `StreamTimelineService` itself has the unresolved boundaries in its data
  handoff. Native `TwitchStreamers` is injected; construction and concrete
  adapters belong to the application composition root.
- **NOT VERIFIED — nothing was compiled, formatted, executed or deployed.**
