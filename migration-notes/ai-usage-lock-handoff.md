# AI usage lock migration handoff — 2026-10-29

**Status: parent-verified local opt-in helper; dependency closure partial.**
The five-file native implementation (feature/module wiring, helper, tests and
oracle) was committed locally as `8061af69` and passed the
reported source-oracle, strict and isolated Redis checks. It is not wired into
TypeScript callers; no deployment, push or caller retirement occurred. The
existing Redis bootstrap's logging and telemetry proxy is not reproduced, so
this is not whole-feature or whole-migration completion.

The original authoring turn was documentation/source-only: no Cargo, rustfmt,
Node, application, test, benchmark, container, network or production command
was run by that author. The original static-only claims below describe that
turn, not the parent's later validation.

## Parent validation update — 2026-10-29

The native commit is `8061af69`, with final source-tree SHA-256
`1ad5b80e177dc24240fb4c1cc66b5f19f1c2720d66469f6302f27a26a2359fd4` and
1,272 source/provenance inputs. The feature is opt-in as
`ai-usage-lock = ["redis", "tts-utilities", "dep:sha2", "dep:uuid"]`; no new
dependency or Cargo.lock change was required, and defaults and worker profiles
are unchanged.

The first source oracle and strict run passed (`node-1793273101315751694`,
`compiler-1793273119989217718`). The first native runtime attempt
`compiler-fixtures-1793273325709715164` failed in its fixture: it treated the
source's own `release: undefined` value as an object. The native implementation
did not change. The parent added a five-line fixture fallback; only the test
hash changed, and retained prefixed test bytes were SHA-verified. The corrected
oracle write/check (`node-1793273457801069297`), formatting check
(`format-1793273431814418894`), final Node source/hash check
(`node-1793273748582165643`) and final runtime/strict phase
(`compiler-fixtures-1793273489423847194`) passed.

The final runtime phase reported ten executions across nine result groups:
one library result, two ordinary source/type/key test results, one native
protocol-matrix replay and six explicit real-Redis/default-bootstrap tests.
The matrix replay compared 290 of the 291 source scenarios; all 291 actual
source cases and outputs were independently byte-equal. The acquire-error
source case is covered in a separate child default-bootstrap category
assertion, not by exact exception-text comparison. The run took 185.35 seconds
for the script and 196.311 seconds for the phase. Under the 6 CPU, 4 GiB memory
and equal swap cap, 256 PID and two-job limits, peak cache was 8,117,489,664
bytes and minimum available memory was 10,639,482,880 bytes. Final readback
verified all 19 production records unchanged, no task-owned resources remaining,
and the 1,272 source/provenance inputs.

The evidence package at
[`evidence/2026-10-29-ai-usage-lock/README.md`](evidence/2026-10-29-ai-usage-lock/README.md)
was independently read back: 51 files, 50 indexed blob hashes and 18
decompressed artifact hash/length checks passed. Its
[verification summary](evidence/2026-10-29-ai-usage-lock/verification-summary.json),
[final source binding](evidence/2026-10-29-ai-usage-lock/source-binding.json),
[pre-fix source binding](evidence/2026-10-29-ai-usage-lock/pre-fix-source-binding.json)
and [final readback](evidence/2026-10-29-ai-usage-lock/artifacts/final-readback.json)
preserve the first fixture failure and exact source identity.

The feature's scope remains the opt-in request-time lock helper. Existing
TypeScript ledger and dashboard callers remain active; no caller adoption,
deployment or push occurred. The pre-existing native receipt-worker lock is a
separate helper and was not modified. The broader Rust migration remains
incomplete.

Owned additions are `dimabot/src/utils/ai_usage_lock.rs`,
`dimabot/tests/ai_usage_lock.rs`,
`dimabot/tests/fixtures/ai_usage_lock_reference.cjs`, and this note. Existing
PostHog/parser work, central files, defaults, worker profiles and dirty files
were protected. Those static checks did not establish formatting or compilation;
the parent's later validation results are recorded above.

Final static inspection found only these four task-owned additions. Individual
`git diff --no-index --check -- /dev/null FILE` calls emitted no whitespace
diagnostics (exit 1 reflects each new-file diff). Repeated SHA-256 reads matched
the initial protected TypeScript lock/bootstrap, worker queue, `js_string.rs`
and `lossless_json.rs` bytes. This establishes file boundaries and whitespace,
not parsing, typechecking, formatting, runtime behavior or oracle execution.

## Source and reuse trace

The complete source export is
`withAiUsageLock<T>(channelID: string, customerId: string, run: () => Promise<T>): Promise<T>`
in `src/utils/ai_usage_lock.ts` (SHA-256
`c66763fc7ddc9ab1ab51f3d895c4ab20ef8b37ae62e59d799e960da972eda510`).
Its only imports are Node `createHash`/`randomUUID` and
`getDragonflyClient`. The callback is caller-supplied computation, rather than
a missing service adapter. Current callers remain in `ai_usage_ledger.ts`
(`persistAiUsageReceipt` and backfill/account rebuilding) and
`ai_usage_dashboard.ts`. No caller was migrated or adopted here.

`ai_usage_receipts/queue.rs` already has the same account key namespace,
NX/EX120 acquisition, 10-second contention window, 50 ms wait, 30-second
renewal, and compare-delete ownership. It is private to the deployed worker,
uses a PID/time/ObjectId owner, different public errors, a TTL argument in its
renewal Lua, per-command two-second timeouts, and a spawned abort-on-drop
heartbeat. Exposing/changing that helper would alter a protected worker; it is
left intact. Its `serde_json::to_string(&[&str,&str])` key construction cannot
represent lone UTF-16 units, so it is not copied into the request helper.

The new helper directly reuses:

| Source dependency | Concrete native replacement |
| --- | --- |
| `getDragonflyClient('AiUsageLedgerLock')` | Existing `utils::redis::get_redis_client` and `redis::aio::ConnectionManager`; explicit manager construction is also supported |
| `JSON.stringify([channelID, customerId])` | Existing `JsString::write_json_string` twice inside a two-element array; no new Unicode or JSON encoder |
| `createHash('sha256')` | Already pinned `sha2::Sha256` 0.10.9 |
| `randomUUID()` | Already pinned `uuid::Uuid::new_v4` 1.28.0; one lowercase, hyphenated UUIDv4 per acquisition loop |
| `Number(renewalReply)` | Existing `json_number::to_number`; ordinary Redis scalar/array projection, no parallel numeric parser |
| Promise, timeout, interval | Existing Tokio 1.54; owned futures and monotonic deadlines |

The Redis bootstrap already validates host/port, bounds initialization, uses
plain TCP database 0, and
disables response timeouts. It does not load `.env`, use a production URI, or
add a telemetry wrapper. The TypeScript bootstrap's logging and telemetry
proxy are infrastructure differences of the existing native foundation; this
helper does not recreate them. npm internals need no port.

No concrete lock-operation dependency is left as a trait or mock; the generic
callback is caller-supplied computation. The native default bootstrap still
omits the source bootstrap's caller-specific logging and telemetry proxy. At
handoff time wiring and execution awaited the parent; the dated update records
the later verified opt-in helper. This is **not** a 100% migration claim:
ledger/dashboard callers and remaining application features remain TypeScript.
Report helper acceptance, whole migration, caller adoption, and deployment
separately.

## Contract and retained waits

`AiUsageLock::new(ConnectionManager)` has no I/O. Its generic async `with`
accepts `FnOnce() -> Future<Output = Result<T,E>>` and returns the original `T`
or typed `AiUsageLockError<E>`. `with_ai_usage_lock` acquires the native default
manager first, in source order. Strings are `JsString`, including empty,
astral, combining, control, and unpaired UTF-16 inputs; no trimming,
normalization, replacement encoding, or delimiter join occurs in key hashing.

| Pause/deadline | Keep/change decision and protection |
| --- | --- |
| 50 ms after failed NX SET | Kept: genuine lock/lease contention, where another owner may still be writing. Never reached after a successful acquisition. |
| Ten-second acquisition deadline | Kept: reject continued contention with `AI usage ledger busy; retry later`. Checked only after a failed SET; a successful reply after the deadline is accepted. Uses monotonic time rather than `Date.now()` to avoid clock jumps. It does not bound a held command reply. |
| 30-second heartbeat | Kept: future-due lease maintenance; exact source compare-owner/EXPIRE120 Lua. First tick is after 30 seconds, not immediate. |
| 120-second TTL | Kept: finite ownership following a crash, disconnect, cancellation, panic, or unknown command outcome. Exact default asserted separately from fixture-only expiry changes. |
| Redis command response waiting | Existing manager policy retained; default has no command deadline. No application replay. A supplied manager may impose its own response timeout. |
| Fixture gates, readiness polling and bounded child waits | Test-owned in-flight event/deadline waits only. They add no application pacing. |

The owner-fenced Lua texts remain exact:

```lua
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], 120) end return 0
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0
```

Normal callback failure is preserved even after observed lease loss. Observed
lease loss converts only a successful callback into the source's exact
`AI usage ledger lease lost; retry required` error. Normal callback completion
or failure always awaits compare-delete. Release **failure supersedes** the
callback error, lease-loss error, or value, matching `finally`. A successful
release command returning 0 is ignored, as in the source; it must not delete a
successor owner.

Renewal is polled beside the callback without spawning any task. There is one
in-flight renewal; missed ticks skip rather than accumulating unbounded
interval calls. The source's `setInterval` can overlap held evaluations. That
overlap is deliberately bounded here, so this is **not perfect scheduling
parity**. The lost flag remains sticky but future normal heartbeat deadlines
still run until callback completion/cancellation. Callback completion wins a
simultaneous select poll; only replies already observed while it ran affect
the result. The source also permits an outstanding heartbeat to resolve after
callback completion. A multiplexed native connection preserves wire reply
order, so a held renewal can delay the release reply even when the callback
already completed. The source oracle records that abstract mock boundary;
native replay checks outcome/commands after releasing the held wire reply.

Dropping or panicking through the native future stops renewal and **retains
the TTL**. It does not promise immediate compare-delete cleanup. A cancelled
ledger/database operation may already have been sent; releasing ownership
early could permit overlapping writes. JavaScript promises have no equivalent
caller cancellation. Ordinary callback failures should use `Err(E)`; a Rust
panic unwinds and is not translated into a JavaScript exception/finally await.
Commands already sent may still finish in the driver/server. Both Lua scripts
remain owner-fenced, and uncertain acquisition also retains its TTL. This is
a lease, not a fencing token for downstream database writes; callers must
not spawn unowned callback work that outlives this future.

Exact Lua guarantees integer 0/1. Ordinary RESP2 nil/string/integer/array
coercion is additionally handled through the existing Number core; boolean
and finite floating scalar forms are accepted by the native adapter as well.
Arbitrary prototype/coercion hooks, Symbols, custom EVAL implementations,
RESP3 map/set/push semantics, and arbitrary-depth hostile reply trees are not
part of the source's concrete Redis protocol. Nonfinite mock replies are
projected to equivalent numeric strings on RESP2; their one/non-one decision
is compared, not an impossible native integer encoding.

## Authored oracle and validation coverage

The CommonJS oracle extracts the **entire actual export**, removes only the
two imports, typechecks it against signature-only dependency stubs, transpiles
the actual body, and runs it in a VM with intercepted Redis methods and a
virtual clock/timer fixture. No lock control flow, key hashing, Lua policy,
Unicode encoder, callback result algorithm, or Redis emulator is copied.
Crypto is real Node SHA-256 and UUIDv4. UUIDs are validated/checked for
uniqueness and normalized only in the artifact for deterministic checking.

It strictly pins Node **24.22.1**, V8 **13.6.233.17-node.58**, TypeScript
**5.9.3**, app source, bootstrap source, package/lock and installed TS files.
It emits runtime/oracle hashes, complete export/import/signature/type-parameter
and parameter inventory, declaration byte range/text/hash, extraction,
typecheck and compiled hashes, and dependency provenance. Eleven native file
hashes bind the final Cargo manifest/lock, library/module routing, lock module,
shared string/Number/whitespace/Redis readers, integration test and reused
fixture support; Rust replay checks each against the mounted frozen source.
Parent must mount
the actual Node binary and TS implementation/package files for independent
Rust hash validation, not merely supply metadata strings. The host's ambient
Node selection currently resolves to v26, so it must not be used for this
pinned oracle.

The pinned oracle covers **291 source scenarios**; the parent's execution and
separate 290-case native protocol replay are summarized in the update above:

- 225 full two-string combinations, including delimiter/quote/control
  ambiguity, empty strings, composed/decomposed text, astral and lone/reversed
  UTF-16 units; original callback value identity survives.
- Sixteen return values, including undefined/null/booleans, signed zero,
  subnormal/extreme/nonfinite binary64, nested arrays/objects and UTF-16.
- Ordinary and non-Error callback rejection/synchronous JS throw values,
  acquisition/SET errors, exact uppercase OK, contention, ten-second deadline,
  and held SET success/failure after the deadline.
- Release 0/null/arbitrary values, errors after successful/failed callbacks,
  held release-error precedence, renewal Number coercions, sticky loss after
  a later successful renewal, renewal errors, callback-versus-loss and
  release-versus-both precedence, and pending renewal at callback completion.

`--write` requires a pre-created directory and refuses to overwrite artifacts.
`--check` reruns the source and checks every nonempty required artifact exactly.
Rust loaders fail on missing/empty/stale files/environment and require the
exact case count. There is no optional oracle skip. The Node binary is bound
by artifact hash to the parent-mounted executable and pinned version; this
author did not execute it to obtain a new binary hash.

Pure tests cover full provenance, source declaration binding, all 225 keys,
default constants and exact Lua. An ignored concrete ConnectionManager/local
RESP fixture replays **290** source cases; the default-acquisition error is
covered by the isolated bootstrap child. The replay preserves typed callback
values and errors, validates UUIDs/one-owner-per-loop, and compares all native
SET/EVAL calls. The virtual deadline's exact 201 attempt count is not imposed
on real clocks/network latency; native replay checks the deadline, uniform
owner/commands, no callback and repeated contention instead. Timer cases run
concurrently with real 30/60-second deadlines; no Tokio test-util feature,
production timing override, or hidden accelerated policy is introduced.

Ignored real Redis checks require an explicit allowlisted fixture URL,
`DIMA_RUST_TEST_RESOURCE_OWNER=dimabot-migration`, a task token, and matching
`test:ai-usage-lock:owner` marker. Every account key is derived from a fresh
UUID namespace. Coverage authored and exercised in the parent's final run:

- Twelve-way real NX races; one active callback; unique UUIDs; actual
  expiration/contention progress; callback failure and successor-owner safety.
- Ten-second busy deadline, unchanged owner, bounded remaining TTL.
- Cancellation and callback panic leave finite EX120 ownership; normal Err
  still releases. No 120-second sleep.
- Exact real renewal Lua restores EX120 after shortening only a test-owned key
  to 35 seconds; replaced owners and injected renewal failures report loss;
  callback/release precedence; no release of successor owners.
- A real forwarding proxy holds acquisition, renewal and release replies;
  request cancellation stops application renewal, verified through one further
  real heartbeat deadline; TTL decreases rather than being refreshed. Held
  SET never invokes the callback, held release's atomic DEL remains committed.
- Native default bootstrap success and pre-connect configuration failure run
  in child processes, leaving the parent process environment/OnceCell alone.

Fixtures reuse the existing bounded RESP endpoint/support code. Task guards
abort and await owned request tasks where appropriate. Gate teardown opens
held replies before endpoint socket shutdown/join. Redis cleanup checks the
ownership marker and compare-deletes only explicitly recorded keys/owners,
including unwinding test failure; it does not SCAN/FLUSHDB/prune/delete another
owner. Parent still removes its disposable infrastructure after execution.
The shared endpoint has a ten-second idle socket deadline; guarded fixture-only
PING keepalives preserve its transport across real 30-second lock timers.
There is at most one pending keepalive; a held reply stops that loop rather
than queuing more. These PINGs are excluded by the existing endpoint recorder
and add no production/request helper task or altered lock scheduling.

## Original proposed parent wiring and execution plan

At original handoff time, only the following opt-in feature and module wiring
were proposed; the parent has since added and validated them:

```toml
ai-usage-lock = ["redis", "tts-utilities", "dep:sha2", "dep:uuid"]
```

```rust
#[cfg(feature = "ai-usage-lock")]
pub mod ai_usage_lock;
```

No new dependency declaration, Cargo.lock change, worker/default/profile
change, or umbrella-feature addition is required. Existing `tts-utilities`
already exposes `JsString`, `json_number`, serde_json and Tokio. Cargo's
integration test discovery plus the crate-level feature gate is sufficient;
no new `[[test]]` entry is required. Preserve both existing worker graphs.

All commands below are **parent-only inside its read-only source snapshot and
single task-owned capped validation workflow**, never host Cargo/Node/app or
production execution. Apply formatting only to these owned new Rust files in
a writable staging copy, review it, and freeze the final snapshot first. Use
the repository's 6 CPU, selected 4/6 GiB cap, equal memory/swap cap, 256 PID,
two-job, 4 GiB host-headroom and 8 GiB cache limits. No live deployment follows.

With the pinned Node/installed TS tree and a new writable mounted oracle
directory `AI_LOCK_ORACLE_DIR`:

```bash
node tests/fixtures/ai_usage_lock_reference.cjs --write "$AI_LOCK_ORACLE_DIR"
node tests/fixtures/ai_usage_lock_reference.cjs --check "$AI_LOCK_ORACLE_DIR"
```

Provide `DIMA_AI_LOCK_REFERENCE_DIR`, `DIMA_AI_LOCK_NODE_BINARY`,
`DIMA_AI_LOCK_TYPESCRIPT_IMPLEMENTATION`, and
`DIMA_AI_LOCK_TYPESCRIPT_PACKAGE` as read-only paths visible to the compiler
container, binding those exact oracle artifacts/readers. From `dimabot/`:

```bash
cargo check --locked --no-default-features --features ai-usage-lock --all-targets
cargo clippy --locked --no-default-features --features ai-usage-lock --all-targets -- -D warnings
cargo test --locked --no-default-features --features ai-usage-lock --lib utils::ai_usage_lock
cargo test --locked --no-default-features --features ai-usage-lock --test ai_usage_lock
cargo test --locked --no-default-features --features ai-usage-lock --test ai_usage_lock native_source_protocol_matrix -- --ignored --exact --test-threads=1
```

The parent provisions only fresh private Redis/Dragonfly resources under the
existing ownership/network/CPU/memory rules. Set its task token marker before
running tests, and provide `DIMA_TEST_REDIS_URL`,
`DIMA_RUST_TEST_RESOURCE_OWNER=dimabot-migration`, and
`DIMA_AI_LOCK_FIXTURE_TOKEN` (24+ ASCII letters/digits/hyphens). No implicit
default endpoint is accepted. Run each named real test through the same capped
compiler/runtime container:

```bash
cargo test --locked --no-default-features --features ai-usage-lock --test ai_usage_lock real_redis_race_contention_and_owner_safety -- --ignored --exact --test-threads=1
cargo test --locked --no-default-features --features ai-usage-lock --test ai_usage_lock real_redis_busy_deadline -- --ignored --exact --test-threads=1
cargo test --locked --no-default-features --features ai-usage-lock --test ai_usage_lock real_redis_cancel_panic_and_finally -- --ignored --exact --test-threads=1
cargo test --locked --no-default-features --features ai-usage-lock --test ai_usage_lock real_redis_renewal_loss_and_error_precedence -- --ignored --exact --test-threads=1
cargo test --locked --no-default-features --features ai-usage-lock --test ai_usage_lock real_redis_held_reply_cancellation_has_no_background_renewal -- --ignored --exact --test-threads=1
cargo test --locked --no-default-features --features ai-usage-lock --test ai_usage_lock native_default_bootstrap -- --ignored --exact --test-threads=1
```

Do not invoke the child-only `native_default_child` directly or run all ignored
tests indiscriminately; the bootstrap test supplies its required isolated
child mode/environment. Confirm nonzero expected tests, artifact reader
identity, both unchanged worker dependency graphs, fixture cleanup, and stable
production identities via the parent's read-only before/after inspection.
The author did not run these commands or scenarios. The parent's actual results,
including the fixture failure and corrected passing run, are recorded in the
dated update above and evidence package.
