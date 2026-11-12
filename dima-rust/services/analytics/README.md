# Analytics Rust candidate

This is an implementation candidate, **not yet certified as a drop-in replacement**. The Node
reference packages are absent at `/home/dom/Projects/saas/dima-analytics/node_modules` and in this
checkout. No packages were installed, reference captures fabricated, containers built, services
deployed, or branch pushed. Fast-forward baseline: `d883758a` on `rust-v2`.

## Shape and operation

`build(Config, Clock, Shutdown)` constructs the dima-web application. The binary alone reads the
reference environment variables. `src/schema.sql` and ingestion SQL are extracted verbatim from
the reference store (histogram SQL expansions are materialised). The workspace glob includes this
crate. The only new external dependency is `tokio-postgres`, for parameterised PostgreSQL without
an ORM; TLS to PostgreSQL is not configured (the reference deployment uses the private network).
The existing dima-web, dima-http, dima-store, dima-core and dima-text crates supply shared protocols.

Routes include health, sessions, overview, resources/infrastructure, trace list/detail, logs,
and owner grant list/upsert/revoke. Grants always constrain browser filters. Row JSON preserves
SQL projection order and timestamps are millisecond ISO strings. Hoststats fields are allowlisted.
A non-root Dockerfile and binary healthcheck are supplied, but not built. Existing Compose and ops
Node command/healthcheck overrides require a separate cutover change; changing them is outside this
package's owned paths. Existing 512 MiB, CPU/PID, network and read-only settings stay in Compose.

All telemetry stores use receipt + observations in one PostgreSQL transaction. The consumer owns
one processing list, checks its head before LMOVE RIGHT LEFT, and acknowledges with LREM against the
original bytes. Invalid JSON/envelopes are removed and counted; database errors leave the item for
retry and end the pass. A committed receipt makes a crash after commit/before acknowledgement safe
against double-counting, provided the receipt remains: retention removes receipts after two days.
This is the reference's single-consumer at-least-once delivery with transactionally deduplicated
storage, not unlimited exactly-once delivery. Replayed batches are still validated first, so retries
older than the one-hour timestamp window are rejected. The consumer never increments overflow:
producers own LPUSH/LTRIM and the one-hour overflow counter. No incompatible inbox encoding is added.

Intervals and bounds: drain every 1 s (10 batches/pass); collector immediately and every 30 s,
with a busy guard and containers on alternate samples; retention every hour. Rollup repair checks
48 completed hours when the hour changes. Resource ranges, partition retention, histogram bounds,
queue discovery (4 SCAN pages, 100 keys/page), remembered queues (1000, first 100 checked), name
cache (1000; found 60 s/miss 15 s), names (500; Redis chunks 50), rate limits (120/min, 2000 keys),
and infrastructure cache (201 entries before clearing; half list-slot TTL clamped 15 s–5 min)
follow the reference intent. The sampler, drain and retention tasks have shutdown ownership.

Timeouts: PostgreSQL connect 3 s, statement 8 s, outer ordinary operation 9 s, whole ingestion
35 s; Dragonfly connect 3 s and shared command deadline 5 s; Twitch and sidecar/Qdrant fetches
3 s; name fallback 1.5 s including Mongo maxTimeMS 1 s; Mongo stats overall 3 s. New caps:
Twitch response 16 KiB, Qdrant response 1 MiB, sidecar response 512000 **bytes** (stricter than Node's
UTF-16 count). HTTP bodies use dima-web's 16 KiB parser and shared decompression guards.

## Verification

From `dima-rust/`:

```sh
eval "$(tools/test-env)"
tools/check dima-analytics
```

The store-backed test creates `dima_test_analytics_<uuid>`, catches assertion panics, deletes only
its unique Redis prefix in logical DB4 and drops its database even on assertion failure. It creates and drops an equally named MongoDB fixture database, testing public-name fallback
without disclosing private account fields. It never writes to `domdimabot`. It exercises real SQL ingestion/replay/rollback, processing-list replay after a
commit, invalid JSON discard, all GET families, grants, investigator/viewer access, trace scope,
resource queries/trends and live Redis/PostgreSQL collection. Pure tests cover malformed batches,
histograms, grant predicates, UTF-8 limits, parser allowlists, sidecar sanitising and both committed
Rust telemetry fixtures. Fixtures also run through real PostgreSQL ingestion with rebased timestamps.

The optional `tests/schema_compare.mjs` compares tables, columns, types, defaults, indexes and
constraints after invoking Node's actual migration and Rust's `--migrate-only` startup path against
two fresh databases. It cleans both databases in `finally` and requires the reference's installed
packages. This is the migration path rather than starting Node's timers. Invocation:

```sh
node services/analytics/tests/schema_compare.mjs "$PWD/target/debug/dima-analytics"
```

Observed result here: `NOT RUN: reference node_modules absent; no catalogue comparison recorded`.
No live Node route/storage comparisons or Node/release-Rust RSS/CPU comparison could be performed
for the same reason. No resource numbers are claimed. The Dockerfile was not built.

Rig target/scenarios cover unauthenticated access, route successes, grant validation, permission
failures and each telemetry kind through inbox/replay. They are **unrecorded and not run**. The rig
needs PostgreSQL provisioning per side/per scenario, URI injection, schema/catalogue and typed-row
capture/comparison, and cleanup on every exit. Until then, its target requires explicit
`reference_postgres_uri` and `candidate_postgres_uri` variables supplied as disposable databases;
run only with `--dragonfly-dbs 4-5`. The rig itself was not modified. Its current target is insufficient
to guarantee PostgreSQL isolation by itself. Full 30-day rollup/performance, Mongo name-cache failure,
rate-limit saturation and outbound timeout/size differential tests remain outstanding.

## Differences and integration blockers

- Text limits/truncation on user text use Unicode scalar values, as required by the charter. ASCII
  identifiers remain ASCII. No monetary/identity UTF-16 counts are introduced. Snapshot errors use
  character-safe truncation. Date input accepts the shared ISO/HTTP parser, not V8 legacy forms.
- PostgreSQL uses a bounded five-connection pool, reconnecting closed connections. Idle expiry is
  checked on checkout after 30 s rather than using a background idle-connection reaper.
- Collectors query providers sequentially rather than concurrently to bound simultaneous resource
  work; cadence under provider failures still needs comparison. Mongo name/stat clients are separate,
  lazy and retryable, with the reference pool/selection/connect limits.
- Routes accept Express-style case-insensitive static segments and an optional trailing slash.
  Repeated query fields take their first value (an inventory-permitted difference); objects coerce
  to `[object Object]`. Encoded path-parameter parity remains unverified.
- Four-significant-digit rounding uses Rust scientific formatting; tie cases need Node comparison.
  Some aggregation/queue ordering is unspecified by the SQL or uses HashMap iteration; complete
  differential recordings must settle visible row order before acceptance.
- Exact sidecar size/error behavior, complete reference test porting, a release RSS/CPU comparison,
  and the Node catalogue/route/ingestion comparisons are still acceptance blockers. Do not call
  a passed Rust gate proof of Node parity.

Reference quirks retained/reportable: envelope UUID regex accepts non-UUID strings, which PostgreSQL
then rejects and the consumer retries; absent span `partial` passes validation but fails NOT NULL;
log `fields` accepts arrays; DELETE does not validate the subject ID and revoke/audit are separate
statements; the rate-map's `>2000` sweep cannot ordinarily fire because new entries are refused at
2000, potentially locking out new tokens for the process lifetime. No silent security fixes were
made. Names expose only the public account name for IDs obtained from authorised results.

Shared Dragonfly has no readiness accessor: health uses a read-only PING capped at 200 ms instead
of Node's local `isReady` flag.

Shared-crate gaps: no PostgreSQL adapter exists, so `store.rs` is local. `mongo.rs` adds lazy,
retryable startup around the eager shared MongoStore constructor. Shared
MongoConfig has no socket-timeout knob, so overall timeouts wrap Mongo operations. No shared crate
was changed. Open question for the lead: reference dependencies must be provisioned independently
before parity/resource verification can finish; the agent was explicitly forbidden to install them.
