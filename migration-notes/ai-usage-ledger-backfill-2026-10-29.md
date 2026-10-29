# AI usage ledger backfill: verified native adapter

2026-10-29 — The opt-in Rust adapter for `backfillAiUsageLedger` is integrated
and passed focused source-parity, compile, and private-service checks. This
validates the local backfill feature only. Caller adoption, deployment,
TypeScript retirement, and whole-project migration completion remain separate
and have not occurred.

## Frozen candidate and checks

All completed checks below used exact source tree SHA-256
`4e45a6406f4724a9f1a1500d795ae60fd1ec3fb2580c4fd61fb7e745276b4118`, covering
1,294 inputs. Code commit: `68d02367`. Evidence is retained in the [indexed repository archive](evidence/2026-10-29-ai-ledger-backfill/README.md), with source bindings, fixtures, run receipts/logs, failed candidates and reproduction scripts.

- Capped compiler receipt `compiler-1793298764759098752-receipt.json` passed
  formatting, scoped Clippy/static musl release compilation and the adapter's
  compiler checks. It ran with 6 CPUs, 4 GiB memory and swap caps, 256 PIDs,
  and two Cargo jobs. The produced test executable is statically linked for
  `x86_64-unknown-linux-musl`.
- Node receipt `node-1793298764783132911-receipt.json` passed the actual
  TypeScript source oracle write/check: 341 source-derived cases, including
  behavior from the actual source and schemas.
- Private fixture receipt `node-fixtures-1793298844986452413-receipt.json`
  passed six ordinary cases and two ignored integration cases were handled by
  separate invocations. The source oracle replay and private MongoDB 8.2.6 /
  Dragonfly checks passed. The runtime suite took 3.32 seconds.
- The private adapter check exercised the 500/500/1 command sequence, actual
  unordered partial writes and index mapping, duplicate crash repair, all
  invalid operations, write concern, driver splitting above 48 MiB, failures
  in each phase, transport uncertainty, cancellation and lease TTL, shared
  pools, and panic cleanup. Its deliberate fixture callback panic was caught;
  the test completed `ok` (1 passed, 0 failed). The broader six-case ordinary
  unit test result also passed.
- The compiler, oracle, and fixture receipts report production unchanged.
  Production baseline acknowledgement `api-ee0635765a02` records all 19
  checked production container identities/configuration as unchanged.

Compiler `1793298899575861137` also passed no-feature/all-target checks, all-feature/all-target checks and strict Clippy. Its script took 317.795 seconds (324.868 seconds including bootstrap/cleanup); the private Cargo/target peak was 2,469,974,016 bytes and minimum available host memory was 8,764,702,720 bytes. Final readback confirmed 19 unchanged production records and zero task-owned containers, networks or volumes. Earlier retained
attempts include failed source snapshots; attempt 4 is the frozen passing
candidate and does not erase that history.

## Reuse and behavior

The adapter reuses `MongoAiUsageLedgerPersistence` for the actual collections
and daily repair, `AiUsageLock` for the shared Redis manager, owner fencing and
cancellation behavior, `ReceiptClock` and the producer's structured receipt,
`receipt_document` for ordinary receipt mapping, and existing classification,
retention, lossless values, Date parsing and schema field casting. The bulk
path uses selected existing schema field descriptors without save-time
validators/defaults; it adds no parallel schema or JS interpreter and no
crate.

The account lock spans dirtying, filtering, all source-sized batches, daily
repair and state update. Input account identity wins over receipt identity.
Retention uses the inclusive `>=` floor with the source clock semantics.
Batches contain at most 500 filtered receipts and yield between bounded
batches while ready work remains. Mutable `source` and `adjustmentType` fields
are `$set` values, duplicates still trigger repair, and state uses
`find_one_and_update` with `$min` coverage and report version 3. There are no
new application sleeps; existing lock contention (50 ms), lease deadline
(10 s), heartbeat (30 s) and TTL (120 s) are preserved. No worker cadence or
runtime owner changed. No throughput benchmark was run or is claimed.

Bulk policy samples operation clocks before validation, omits cast-invalid
operations under unordered semantics, and resolves an entirely invalid batch
before repair/state. Missing nullable fields remain missing. Bulk version and
timestamp insertion order follows the source's update semantics. The TypeScript
oracle extracts the actual source declarations, validates AST kind identity,
records source byte spans and signatures, typechecks and executes the extracted
source with real schemas/Mongoose middleware, while replacing only concrete
collection calls and the proven lock callback boundary. Network entry points
and Mongoose connection startup are blocked. Command snapshots use the actual
Mongo driver's `ignoreUndefined:false` option; synthetic aggregation responses
retain direct BSON defaults. The lock proof was regenerated after its stale
Cargo-bound proof was correctly rejected.

`MongoAiUsageLedgerBackfill::new` and `with_clocks` perform no I/O and install
no indexes. The concrete `Client::bulk_write` API in the pinned MongoDB Rust
driver 3.9.1 requires MongoDB 8.0 or newer; the tested disposable fixture used
8.2.6. No compatibility claim is made for older MongoDB servers. The driver
owns BSON/message size splitting and retryable-write protocol. Application
code does not blindly retry uncertain transport failures. Bulk failures retain
the driver error, partial result, batch offset, invalid indices, and mapping
from operation index to original transaction index.

## Failure history and remaining boundaries

Earlier attempts exposed issues that were corrected before the accepted
attempt: oversized bulk errors needed boxing without losing detail; unused
imports stopped compilation; a stale lock proof was rejected and regenerated;
and an oracle protocol check initially observed its own `count_documents`
readback. That check was corrected to assert the command window before
verification readback; no parity assertion was removed. Fixture Date identity
and the source oracle's driver `undefined` policy are guarded explicitly.

The existing daily-repair boundary rejects legacy RegExp expiry values and
expiry arrays containing Date/RegExp before deletion. Plain input excludes
prototypes, executable hooks and BSON wrapper objects. Exact query operator
object compatibility for malformed receipt IDs is not claimed; valid declared
string IDs and plain scalar cast cases are covered. The source-oracle driver
undefined policy and Date identity guards are part of the evidence contract.

Focused adapter coverage passed for the implemented bounded backfill
contract. Total AI usage ledger migration remains incomplete because exact malformed legacy expiry coercion and application bootstrap/telemetry dependencies remain open. Existing caller/queue/worker adoption is reported separately; it has not occurred. No TypeScript source was
retired. Local code commit `68d02367` is verified. No deployment, push, or production mutation occurred.
