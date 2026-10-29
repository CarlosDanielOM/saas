# AI usage ledger backfill: authoring handoff and verification status

This handoff records the adapter's source design and verification boundaries;
final focused acceptance evidence is in
[`ai-usage-ledger-backfill-2026-10-29.md`](ai-usage-ledger-backfill-2026-10-29.md).

## Source and reuse

The source is `backfillAiUsageLedger` in
`dimabot/src/utils/ai_usage_ledger.ts`. The concrete Rust adapter reuses
`MongoAiUsageLedgerPersistence` for collections and daily repair; `AiUsageLock`
for shared Redis ownership, cancellation and lease behavior; `ReceiptClock`,
the producer's structured receipt and `receipt_document`; and existing
classification, retention, lossless values, Date parsing and schema field
casting. It adds no crate, parallel schema, generic host trait or JS
interpreter. Its opt-in feature is wired through the existing persistence
feature. Callers have not adopted it.

The lock spans dirtying, filtering, source-sized batches, repair and state
update. Input account identity wins over receipt identity; retention uses the
inclusive `>=` floor. Batches are capped at 500 and cooperatively yield between
batches while ready work remains. Duplicate receipts still run repair;
mutable source fields use `$set`; coverage state uses `$min`. No new application
sleep, worker cadence or runtime owner was introduced.

## Evidence contract and constraints

The TypeScript oracle extracts and executes the actual source with the actual
schemas and pinned Mongoose middleware, preserving source byte ranges and
signatures. Only concrete collection calls and the proven lock callback are
substituted. It blocks network entry points and connection startup. The
command path resolves BSON options through the installed driver's
`ignoreUndefined:false` default; synthetic group responses keep direct BSON
defaults. The lock corpus is regenerated after source/feature wiring changes.

Focused checks passed against source tree SHA-256
`4e45a6406f4724a9f1a1500d795ae60fd1ec3fb2580c4fd61fb7e745276b4118` (1,294
inputs): capped format/scoped Clippy/static musl release compilation, the
341-case actual-source Node oracle, and private MongoDB 8.2.6 / Dragonfly
behavior checks. The private suite covers unordered partial writes and index
mapping, 500/500/1 actual writes, duplicate crash repair, all-invalid batches,
write concern, driver splitting above 48 MiB, phase failures, transport
uncertainty, cancellation/TTL, shared pools and panic cleanup. The expected
fixture panic was caught and the test passed. See the dated note for receipt
IDs and exact results. The broader no-feature/all-target and all-feature/all-target checks plus strict Clippy also passed (`compiler-1793298899575861137`). Code is committed locally as `68d02367`; the dated note links indexed repository evidence.

The MongoDB Rust driver's concrete `Client::bulk_write` requires MongoDB 8.0+;
no older-server compatibility is claimed. Existing persistence's explicit
unsupported legacy boundary for RegExp expiry values and expiry arrays
containing Date/RegExp remains. Plain input excludes prototypes, executable
hooks and BSON wrapper objects. Transport uncertainty is not blindly retried;
driver-level retryable-write protocol remains driver-owned.

## Status

This validates a local, opt-in native backfill adapter. It does not complete
all AI usage ledger responsibilities, achieve whole-project Rust migration
completion, establish caller adoption, retire TypeScript, or authorize
production cutover. The parent committed the verified code locally as `68d02367`. No deployment, push or production mutation occurred.
