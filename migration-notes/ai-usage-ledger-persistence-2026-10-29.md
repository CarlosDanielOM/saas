# AI usage ledger persistence verification — 2026-10-29

## Verified candidate and scope

The parent verified the integrated persistence slice at code commit
`a872419d87d7a43672efb7fc9024c4d4963a7f97` (the category-policy change was
committed at `72d15962`; the earlier oracle-clock correction at `3e404d5a`).
The final immutable source tree is SHA-256
`390eb3029166aa393ba3d863997faa14a67cae5fc4bcd0309fffa91d9c1f1dda`, bound
to 1,289 source inputs. The completed evidence run receipts are under
`/root/.local/state/rust-full-migration-20261028-lu443ytp/artifacts/`. The
independent readback confirmed
`migration-notes/evidence/2026-10-29-ai-ledger-persistence/`: 204 files total,
203 indexed file hashes, 94 gzip raw-payload hashes/sizes, 10 reconstructed
failed-source bindings, and 29 run receipt/log pairs. The package binds the
1,289 inputs to `a872419d` plus 10 unchanged archive SDK references.

The opt-in `ai-usage-ledger-persistence` feature supplies a concrete request-
time Mongo/Redis adapter using an explicit Mongo `Database`, the shared Redis
`ConnectionManager`, and existing `AiUsageLock`. It persists a borrowed
producer DTO directly, without a JSON serialize/parse round trip. It maps
`persistAiUsageReceipt` and the private UTC daily rebuild path, including the
selected Mongoose receipt update/default/timestamp behavior and daily
`insertMany` validation behavior. Private `receiptDocument` and
`rebuildUtcDailyAggregates` source helpers are included in actual-source
coverage. The existing pure `usage`/`group_fields` builders are reused by the
receipt worker; the worker's schedule, I/O, and lifecycle were not changed.

The same code candidate passed the affected worker grouping test and the
worker-profile check. No new crate dependency, lockfile, default feature,
deployed profile, or worker schedule/I/O change was introduced.

## Verification receipts

All final receipts below bind source tree SHA-256
`390eb3029166aa393ba3d863997faa14a67cae5fc4bcd0309fffa91d9c1f1dda` and
record `production_unchanged: true`.

| Receipt | Result |
| --- | --- |
| `compiler-1793290925888826111` | Full strict compiler phase passed: ordinary persistence tests (8), category policy test (1), ledger query tests (8), producer tests (4), parser tests (9), retention tests (2), and the affected worker grouping test (1). No-feature check, worker-profile check, all-features check, and all-target Clippy with `-D warnings` passed. |
| `node-1793290980286199461` | Final 204 persistence actual-source fixture generated and checked. |
| `compiler-fixtures-1793291161151841227` | All 204 persistence source cases replayed; real private Mongo/Redis persistence suite passed in 2.42 seconds; corrected actual-source ledger query replay passed all 333 cases. |
| `compiler-fixtures-1793291257891114152` | Corrected actual-source retention replay passed all 34 cases. |
| `node-1793291412733747560` | All six final `--check` commands passed; the old-clock negative control failed as expected before writing goldens. |

The final full-strict receipt reports 156.890 seconds total (148.820 seconds
compiler step). The fixture replay receipts report 26.874 and 17.671 seconds
total respectively; the final Node receipt reports 25.793 seconds total.
Earlier exploratory or corrective attempts are not substitutes for these final
receipts; use the exact run IDs above for this final source binding.

## Evidence corrections and accepted boundary

The final fixture/replay incorporates and preserves these source-driven
corrections:

- The initial extended-year invalidity assumption was false. The actual source
  accepts the `+010000-01-01` prefix after its string-slice/date-reparse
  sequence; the final fixture asserts the accepted range instead of treating
  it as invalid.
- Daily document BSON field order was corrected to follow the native schema's
  field order, then selected version/timestamp middleware fields.
- The oracle clock fixture was changed to preserve an actual `Date` through
  Mongoose's clone. Its negative control proves the old clock implementation
  loses that schema Date and is rejected before it can write goldens.
- Raw `BSON.serialize` defaults to ignoring `undefined`, while the actual
  MongoDB driver command options use `ignoreUndefined: false`. The final oracle
  uses the actual driver options for command BSON and a separate `groupWire`
  representation for synthetic aggregate replies. Native Dates and
  filter-null behavior remain asserted.
- The query/retention constructor correction changed only four and three
  engine-error messages respectively; inputs, results, protocol, clocks,
  names, paths, and error codes stayed identical. The source-bound correction
  audit is in the private task artifacts at
  `ledger-persistence/attempt5/other-clock-correction-audit.json`.

One intentional unsupported legacy-data boundary remains. Before destructive
daily replacement, the native reducer rejects expiry arrays containing
`Date` or `RegExp` values (including nested arrays) and a top-level `RegExp`.
Top-level `Date` and ordinary supported values remain supported. Raw Mongo
sentinel checks establish that rejection precedes daily delete/insert, keeps
existing daily documents byte-identical, leaves a preceding dashboard-dirty
write and receipt upsert visible when those already occurred, and releases
the real lease. This is a deliberate partial-parity boundary, not exhaustive
malformed-legacy parity or whole-ledger parity.

An initial private cache attempt exceeded the 8 GiB guard and stopped. The
parent later removed only completed task-owned release artifacts with their
internal hardlinks. That failed attempt is retained as history; not every
historical attempt is claimed to have stayed under the cache limit.

## Status and remaining limits

This is verified **local feature coverage for the declared adapter boundary**.
The ledger source row remains **partial**: backfill draft work is unverified
and excluded; API/caller/bootstrap behavior, billing integration and the
worker's separate parser/adoption path remain open. TypeScript callers and
source files remain. No benchmark or performance result was produced for this
slice. The receipts do not establish full ledger parity, migration completion,
source retirement, caller adoption, deployment, or push.

Independent final readback confirmed all 19 acknowledged production
records unchanged from baseline `api-ee0635765a02`, with zero task-owned
containers, networks, or volumes remaining. The production-ack evidence records the user's
acknowledgment of two billing API releases at
`/root/.local/state/rust-full-migration-20261028-lu443ytp/artifacts/production-ack-api-ee0635765a02.json`;
that acknowledgment is context for the recorded baseline, not an additional
release authorization from this verification.
