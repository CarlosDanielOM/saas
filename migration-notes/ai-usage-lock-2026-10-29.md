# AI usage lock helper — 2026-10-29

Status: **verified local opt-in helper; partial dependency closure**. The
implementation is locally committed as `8061af69` (five files; source-tree SHA
`1ad5b80e177dc24240fb4c1cc66b5f19f1c2720d66469f6302f27a26a2359fd4`). The
feature is disabled by default, adds no dependency or lockfile change, and
leaves existing worker profiles unchanged. TypeScript callers remain active;
there was no deployment, push or retirement. The request-time helper is a
verified local slice, not whole AI ledger/lock migration completion.

## Reuse and native contract

`withAiUsageLock` in `dimabot/src/utils/ai_usage_lock.ts` imports the existing
`getDragonflyClient` bootstrap and Node's `createHash`/`randomUUID`. Its callers
remain in `ai_usage_ledger.ts` and `ai_usage_dashboard.ts`. The native feature
reuses existing components:

- `utils::redis::get_redis_client` and `redis::aio::ConnectionManager` for the
  default Redis client, with explicit manager construction for controlled
  callers/tests.
- `JsString::write_json_string` for the exact two-element
  `JSON.stringify([channelID, customerId])` key preimage, including lone UTF-16
  units, with existing `sha2::Sha256` for its digest.
- Existing `uuid::Uuid::new_v4`, `json_number::to_number`, and Tokio timers.

The generic callback is the caller's work passed to the lock; it is not a
missing application adapter. The helper is intentionally separate from
`ai_usage_receipts/queue.rs`: that deployed worker lock shares the key namespace
and basic Redis ownership protocol, but has a different owner format, error
contract, renewal script, command timeouts and spawned heartbeat. It also uses
Serde key serialization that cannot represent lone UTF-16 units. That worker
helper was not changed.

| Contract | Preserved behavior and boundary |
|---|---|
| Key and owner | `locks:ai-usage-write:` plus SHA-256 of the exact JSON pair bytes; one lowercase UUIDv4 owner per acquisition loop. No trim, Unicode normalization, replacement encoding or delimiter join. |
| Acquisition | `SET key owner NX EX 120`; on contention, wait 50 ms and check the ten-second deadline only after a failed SET. A successful reply after the deadline is accepted. The monotonic native deadline avoids wall-clock jumps. |
| Renewal | The existing owner-compare/`EXPIRE 120` Lua script runs first after 30 seconds. One heartbeat command may be in flight; missed ticks skip instead of accumulating. It continues on later intervals after observed lease loss until callback completion/cancellation. |
| Result and release | Callback runs once. Ordinary callback error is retained even if lease loss was observed; lease loss changes a successful callback to the source error. Compare-delete always runs after normal callback completion, and a release error supersedes callback error, lease-loss error or value. A zero release result does not delete a successor owner. |
| Cancellation and panic | Dropping or unwinding the native future stops renewal and retains the 120-second TTL. JavaScript promises have no caller-cancellation equivalent; a cancelled database write could still be in flight, so early release could permit overlapping writes. |

Known scheduling difference: JavaScript `setInterval` callbacks can overlap,
whereas the native heartbeat bounds renewal to one in-flight command and uses a
monotonic clock. This is deliberate bounded behavior, not perfect scheduling
parity. Exact Lua returns integer 0/1. The adapter reuses the existing Number
conversion for ordinary RESP2 scalar/array replies; arbitrary JavaScript
coercion hooks and RESP3 map/set/push semantics are outside the concrete
protocol boundary.

The default native Redis foundation validates plain TCP host/port, bounds
initialization, and disables command response timeouts, but it does not recreate
the TypeScript bootstrap's caller-specific logging and telemetry proxy. That
remaining application-specific bootstrap dependency keeps the matrix row
partial. Existing usage still exposes that gap even though the lock function
itself has no mock or trait boundary.

## Oracle, validation and failure history

The pinned source oracle extracts the complete TypeScript export rather than a
copied lock algorithm. Its 291 cases include 225 UTF-16 key pairs, callback
results/errors, contention and deadline paths, renewal/loss behavior, and
release precedence. The corrected source oracle confirms all 291 actual source
cases and outputs are byte-identical to the retained initial oracle. Numeric,
UUID, exact Lua and command assertions are covered by native tests.

The first source oracle and strict run passed (`node-1793273101315751694`,
`compiler-1793273119989217718`). The first native runtime attempt
`compiler-fixtures-1793273325709715164` failed in a fixture: it misread the
source's own `release: undefined` as an object. Native code did not change. A
five-line fixture fallback fixed the extraction expectation; only the test
hash changed, and the retained pre-fix test bytes were SHA-verified. Corrected
oracle write/check passed (`node-1793273457801069297`), as did the format check
(`format-1793273431814418894`), final Node check (`node-1793273748582165643`)
and final runtime/strict phase (`compiler-fixtures-1793273489423847194`).

The final runtime phase recorded ten executions across nine result groups: one
library result, two ordinary source/type/key test results, one native
protocol-matrix replay and six explicit real-Redis/default-bootstrap tests.
The native protocol matrix replayed 290 of 291 source scenarios; the remaining
acquire-error source case was covered separately by a child default-bootstrap
category assertion, not exact exception-text comparison. The regenerated Node oracle retained all 291 source
outputs byte-for-byte; native command/outcome comparison covers 290 protocol cases. The phase took 185.35 seconds for the script
and 196.311 seconds total. Under 6 CPU, 4 GiB memory/equal swap, 256 PID and
two-job caps, peak cache was 8,117,489,664 bytes and minimum available memory
was 10,639,482,880 bytes. Readback verified all 19 production records
unchanged, no owned containers/networks/volumes remaining, and all 1,272
source/provenance inputs.

The [evidence package](evidence/2026-10-29-ai-usage-lock/README.md) contains
the [verification summary](evidence/2026-10-29-ai-usage-lock/verification-summary.json),
[final source binding](evidence/2026-10-29-ai-usage-lock/source-binding.json),
[pre-fix source binding](evidence/2026-10-29-ai-usage-lock/pre-fix-source-binding.json)
and [final resource readback](evidence/2026-10-29-ai-usage-lock/artifacts/final-readback.json).
Its 51 files passed 50 indexed blob-hash checks and 18 decompressed
artifact-hash/length checks. It retains the first fixture failure. The source
bindings cover the 1,272-file frozen snapshot and preserve the exact pre-fix
test source.

No benchmark was run for lock performance. The 30-second heartbeat and
ten-second contention deadline are correctness policy values, not performance
measurements. No caller adoption, deployment or push occurred. Total Rust
migration completion remains open.
