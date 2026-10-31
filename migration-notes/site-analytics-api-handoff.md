# Site analytics / Event API handoff — 2026-10-31

Root owns final acceptance and any commit. No deployment, caller adoption,
TypeScript retirement, push, or unrelated lane integration is performed here.
The final team result is
`/root/.local/state/dimabot-migration-teams-20261031/results/second-sol-site-completion-verified.json`;
it binds the exact accepted source tree, stage receipts, resource/production
proof, all prior failures and guarded owned-file copyback. A blocked result,
if present instead, does not establish completion. Historical v16 evidence is
`results/second-sol-site-analytics-verified.json` in the same teams directory.

## Source map and reuse

The immutable accepted v16 source (1616 inputs, tree
`1d1edb4334a2a90a4e2301ff3dec7fdb7de84151afaeebb65d18c64f12848fae`)
is the only base. All unowned inputs, including Cargo/lock/lib/schema-core and
module wiring, remain byte-exact. No central patch is needed. Reusable sources:
native Mongo/Redis clients, shared schema constructor casts, BSON/JS response
projection, Logger, TwitchClient and concrete token storage adapters, api_auth,
existing Site collector and Event route. The two gaps were Event
operator-aware query casting and refresh/persistence fixed future scheduling.

`siteanalytics.ts` maps to `SiteAnalyticsService`: counter operations/default
wrappers, live board/cache/live status, snapshot read/refresh/persist, startup,
and the explicit persistence worker starter. `event.schema.ts` maps to
`schemas::event::{schema,IEvent*}` and its bounded query update adapter.
`chat_event_catalog.ts` maps to the existing native builtin constants/helpers
(unchanged in this follow-up). `site.route.ts` maps to
`SiteRouteService::{router,protected_router,mounted_router}` and all five HTTP
methods. Composition supplies explicit native dependency handles/configuration;
no TypeScript executes in native runtime. Local EventSub aliases reuse shared
native constants. Other analytics routes and teams' WIP remain separate.

## Event updates and source oracle

PATCH canonicalizes only plain top-level type strings, as the source does,
then uses Mongo find-one-and-update returning the updated document. Query
updates run neither required/enum validators nor the save hook. Caller-provided
updatedAt is cast; no implicit updatedAt change is made. Valid `_id` and `__v`
updates are retained; Mongo enforces ID immutability. Unknown update paths are
stripped, and an empty strict update reads the existing record.

The bounded Event adapter reuses native string/number/date/boolean/ObjectId
casts. Array push/addToSet single values, arrays/$each and applicable
sort/slice/position modifiers materialize document defaults/IDs. `$pull`
casts logical/conditional field predicates without insert defaults/IDs and
retains unknown query keys under source strictQuery=false. Source `$pullAll`
actually casts complete subdocuments and materializes defaults/IDs; its oracle
proves that distinction. Numeric and `$`/`$[]` config paths, nested Mixed
assignments, inc/mul/min/max/bit, unset/rename/currentDate/pop and setOnInsert
are exercised. Mongo handles path conflicts, unmatched positional `$`, operator
applicability and storage constraints; source/native statuses are replayed.

The pinned Node24.22.1 / TypeScript5.9.3 / Mongoose8.24.2 / BSON6.10.4 oracle
runs the actual source route and records real Mongoose query casting. It
preserves the original 13 HTTP + nine constructor + six update probes, extends
to 51 update probes, and runs all 45 added update probes through the actual
source HTTP route, real findByIdAndUpdate and private Mongo persistence.
Native replay compares status, body, content type and independent Mongo
readback, including named failures. IDs/clocks alone are normalized. Exact
ordered inventories and a required independent fixture digest prevent empty
or silently shortened corpora. Mongoose helper source digests bind the oracle.
The original 13 route cases retain their documented model/auth/Redis doubles;
the added 45 update cases use real Mongo. Concrete protected auth, collector,
Redis, startup, token/Helix and backlog checks remain in the private suite.

## Pause inventory and decisions before source freeze

Keep 15-second future live deadlines and an immediate first live worker tick.
Keep hourly future persistence and a future first persistence-worker tick;
startup snapshot persistence remains separate. Tokio interval Skip executes
one overdue tick immediately after slow work and advances to the next future
deadline, with no extra full post-work delay or catch-up burst. Work remains
sequential/nonoverlapping; no exact JS setInterval overlap claim is made.

Keep bounded sequential batches of at most100, draining ready work immediately
(no per-item or batch cooldowns). The concrete ordinary 101-ID backlog check
asserts readiness and per-pass counts100/1. Keep profile TTL24h, board cache
minimum30s/default60s, and freshness minimum30s/default60s as validity windows.
Keep native Mongo/Redis12s operation deadlines and the supplied Twitch
retry/token backoffs. No other per-item sleep, ready-work cadence, or queue is
introduced. Tests cover immediate/future/idle scheduling, slow work without
an extra full delay, no catch-up burst and terminal orderly stop. Shutdown
wins over a simultaneously ready tick; an in-flight unit finishes before stop
returns, avoiding cancellation/retry of uncertain writes.

## Boundaries

Coverage is bounded ordinary JSON API behavior, not a universal Mongoose ODM
or JavaScript prototype emulation. Malformed operator structures, arbitrary
Mongo expression/query languages, and every possible conditional combination
are not exhaustively proven. No npm internals are ported wholesale. The
composition root remains responsible for constructing supplied native clients.

Earlier v16 boundaries outside these two gaps remain: i64 counters/viewer
counts and unsigned environment coercion; strict persisted snapshot restore;
per-service rather than process-global start flags;12s operation deadlines
with uncertain write outcomes; native sanitized error chains rather than JS
stacks; narrower provider/coercion diagnostics; native JSON error envelope
versus Express HTML for malformed JSON (both400). No new concrete Logger
Redis sink or adversarial lost-acknowledgement test is claimed. No migration
percentage, unrestricted Event query parity, production cutover or benchmark
result is asserted.
