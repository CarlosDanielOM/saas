# Concrete lossless PostHog transport handoff — baseline validated

## Parent validation update — initial baseline

The baseline transport passed 20 loopback tests and its feature/profile check and strict Clippy in capped compiler run `compiler-1793264871810743273`; formatting and final pinned Node/oracle checks also passed. The aggregate run limits and intermediate lint/cache failures are summarized in [the combined migration note](posthog-receipt-2026-10-29.md). This validates the recorded initial transport source only. Explicit differences from the SDK lifecycle, UUID metadata, redirects/proxy behavior, response-body bound and event-size preflight remain; strict `posthog-node` transport equivalence is not claimed. No callers adopted the backend and there was no push or deployment.

Implementation source is now authored in the three owned Rust/test/oracle files.
**Author-time execution was unverified; parent baseline validation is recorded
above.** This author ran no Cargo, rustfmt, Node,
oracle, tests, application, benchmark, Docker, network probe, install, cache
operation, commit, push, deployment or retirement. Only static source inspection,
file edits, hashing and whitespace checks were used. The parent owns integration,
formatting, capped isolated verification and acceptance. No completion percentage,
caller adoption, performance or deployment claim is made here.

## Owned delivery and integration proposal

- `dimabot/src/utils/posthog_lossless.rs`: concrete asynchronous reqwest POST
  transport, shared queue/pool/actor and lifecycle implementation. This is actual
  HTTP code, not a replacement trait, mock or SDK-internals fork.
- `dimabot/tests/posthog_lossless.rs`: 20 authored real-reqwest loopback tests,
  including required installed-oracle replay. These are not executed evidence.
- `dimabot/tests/fixtures/posthog_lossless_reference.cjs`: executable installed
  Node SDK oracle with exclusive `--write DIR` and exact `--check DIR` modes.
- This note supersedes the earlier investigation-only handoff, including its
  erroneous insistence on a 1,000-event queue default.

Parent wiring proposal only (not applied):

```toml
posthog-lossless = ["http-client", "tts-utilities", "credit-policy", "dep:uuid"]
```

Expose `utils::posthog_lossless` under that feature. The integration test has a
crate-level matching feature gate. No crate, feature, module, lock, default,
worker profile, wrapper, existing foundation, other author's files or production
resource was modified by this author. The public config, constructors, capture,
flush and shutdown signatures match the supplied contract. `endpoint` is the
**full batch URL**, never a base host. The application wrapper's old default
assumptions and existing posthog_events foundation are for the parent to reconcile.

## Reuse and source findings

The gap is the SDK's UTF-8 `String`/`serde_json::Value` event representation;
`posthog-rs` 0.27.0 cannot carry unpaired UTF-16 strings. The new module directly
reuses `JsString::write_json_string`, `JsonValue::write_json_string` (ECMAScript
number and object ordering, nested UTF-16 and nonfinite-to-null behavior),
`credit_policy::JsDate` ISO formatting, installed uuid 1.28 v4, Tokio and pooled
reqwest 0.12.28. It never converts events through serde Value. It does not port
unused SDK features such as flags, surveys, replay or error tracking.

Actual installed sources read: app `src/utils/posthog_events.ts`, Node SDK
`posthog-node/dist/client.js` and `dist/entrypoints/index.node.js`, core
`@posthog/core/dist/posthog-core-stateless.js` and PromiseQueue, and native SDK
`posthog-rs-0.27.0/src/event.rs`. Also read reqwest's response/chunk and retry
APIs. All these reads were static.

Defaults are app flush threshold 20 and interval 1,000 ms; Node wrapper **10,000
queue entries** (`client.js:95`), batch 100, request timeout 10 s, three retries
with 3 s delay, shutdown timeout 30 s. The core-only 1,000 queue default is
superseded by the actual Node wrapper. Overflow shifts the oldest entry.
Timestamp and UUID are assigned before queueing, and survive retries. The SDK
accepts 2xx/3xx; retryable HTTP responses are 408, 429 and 5xx. Exhausted network
errors retain events; HTTP errors dequeue the failed batch. A multi-event 413
halves the batch size and continues. Normal `_flushRoute` snapshots the initial
queue and drains bounded batches without interval sleeps.

Node's actual common properties add `$lib`, `$lib_version` and, by default,
`$is_server: true`; core adds `$geoip_disable: true`. Caller-provided values for
these are overwritten by this default path. The old foundation's claim that
Node does not add `$is_server` is not source-proven and is contradicted by this
installed source. It was left protected. Identify is `$identify` with `$set` and
`$set_once`; the app's identify/name dedup belongs to the independent wrapper.
The oracle uses **real SDK identify and capture**, not a copied normalizer.

## State, barriers and resource policy

One concrete Tokio actor holds the client; a separate owner holds its JoinHandle.
Clones share one mutex-protected bounded queue. Serialization happens outside the
queue mutex, and no mutex is held across await. The actor owns no public owner
Arc, preventing a reference cycle. It runs at most one HTTP attempt at a time.
Queue records contain a monotonic sequence and already serialized Arc string.
Retries reuse the complete batch body (including sent_at); a later flush or 413
split builds a new envelope but retains event bytes, timestamp and UUID.

At most one active and one pending delivery pass exist. Concurrent flush waiters
share watch completion cells; pending requests coalesce rather than forming an
unbounded command queue. Each pass snapshots the pre-call sequence. An earlier
barrier may complete while later captured events are still held in HTTP. A
cancelled waiter does not cancel the pass. Enqueue success is distinct from
successful delivery: network/timeouts return errors and retain records. HTTP
failure and overflow are sticky loss evidence, so a later empty flush does not
silently certify that dropped events were delivered. Sticky loss does **not**
pace or prevent later ready work. HTTP failures stop their pass, matching the
SDK; later passes can deliver remaining records while still reporting prior loss.

Overflow still drops the oldest queue entry even if the actor holds an Arc to
that record. Successful dequeue uses sequence bounds rather than a stale count,
so overflow during an HTTP attempt cannot accidentally remove newer records.
A snapshot can still deliver an entry evicted meanwhile; overflow is reported
conservatively as loss risk. The test suite explicitly covers this concurrency
case. The bounded snapshot owns only Arc references, and evicted in-flight data
can add at most one bounded batch beyond the queue byte ceiling.

Shutdown's first poll closes admission and installs one shared absolute deadline.
Simultaneous, cancelled and repeated callers observe the same final result.
The actor drains the closed snapshot, or cancels its request/retry future and
returns bounded failure. Unlike the SDK's timeout race, it does not leave an
owned HTTP attempt continuing after the shutdown result. The SDK permits later
capture after shutdown; the native transport deliberately stays permanently
closed. Last-owner Drop marks closed and aborts the actor; Tokio drops its owned
request future on cancellation, with no detached retry or HTTP tasks. Synchronous
Drop requests cancellation rather than blocking a runtime thread to join it.

Explicit native limits/differences:

- UTF-16 preflight budget 256 KiB per event, including a 1,024-byte metadata
  reserve, at most 64 nested property levels; a conservative six bytes per string
  code unit can reject an ASCII-heavy event whose eventual wire is below 256 KiB.
  It bounds traversal, cloning and writer allocation before enqueue.
- Queue event wire bytes are at most 16 MiB, independently of count. Byte or count
  pressure evicts oldest entries; rejected oversized events are never enqueued.
  The max request wire is bounded by the queue plus bounded key/envelope overhead.
- Successful responses drain at most 64 KiB for pool reuse, under the request
  deadline. The SDK instead cancels the response body. An oversized or failed
  response-body read returns failure and retains the stable event IDs for retry.
- Positive explicit count settings are independent (no SDK-style upward clamp
  to flush_at), allowing small queues/batches. Queue/threshold ceilings are
  1,000,000 and batch ceiling 10,000. Nonzero request/shutdown durations and a
  366-day duration ceiling prevent invalid/deadline-overflow configurations;
  zero flush_interval disables autonomous timer flushing.
- Native library metadata is `$lib: "dima-rust-lossless"`, `$lib_version` from
  the native crate version, with UUIDv4. Node metadata is `posthog-node` 5.47.3
  and UUIDv7. These are valid explicit metadata differences, **not byte parity**.
- `new` disables redirects, implicit reqwest protocol retries and ambient proxy
  selection. `with_client` reuses the supplied pool and documents the caller's
  obligation to disable redirects/implicit retries; reqwest cannot inspect or
  mutate another client's builder settings. Errors expose only fixed variants
  and HTTP status, never URL/key/body/reqwest diagnostics.

## Every retained wait

| Wait | Protection / scheduling decision |
| --- | --- |
| First queued event's interval deadline | Future-due below-threshold batching, default 1 s; capture 20 requests immediate drain. Zero disables it. |
| Three 3-second retry waits | Actual network/request-deadline or 408/429/5xx failure; four attempts maximum; shutdown interrupts these waits. |
| Post-failure 3-second autonomous retry deadline | Prevents a hot loop on a retained failed queue; independent of the batching interval. A new explicit flush/threshold request can trigger a new pass. With interval disabled there is no automatic reflush. |
| Yield between successful bounded batches | Fair scheduling only; no wall-clock delay while snapshot backlog is ready. |
| Request deadline | Bounds DNS/connect/write/headers and successful response-body drain. |
| Shared shutdown deadline | Bounds all shutdown delivery/retry work; first caller sets it, cancellation/repetition never extends it. |
| Idle Notify | No queued or future-due work, no network. |

No per-item or per-batch interval sleep occurs in a normal ready drain. The
normal-mode 251-event backlog test expects 100/100/51 under a one-hour interval,
so explicit flush cannot accidentally hide an interval-paced implementation.

## Authored validation and parent-only execution

The 20 integration tests use fixture-only keys and random 127.0.0.1 listeners.
They cover nested lone/astral UTF-16 and nonfinite numbers, metadata normalization,
threshold 20, a genuinely future timer, empty calls, explicit causal flush,
normal backlog, the default 10,000 and smaller overflow queues, overflow during
HTTP, byte/event limits, stable ordered retries, terminal HTTP and single/multi
413, exhausted network/request-timeout retention, held headers/body, shutdown
interrupting both requests and retry waits, injected pool and clone reuse,
redacted errors, cancelled flush/shutdown, concurrent/repeated shutdown and
last-clone cancellation/no retry. Recorder gates, read/write deadlines, stop
flags, socket shutdown and joined threads bound teardown even on test panic.
Future-deadline and absence-of-network observations intentionally use timed
negative assertions; positive ready-work checks use receipt/gate barriers.

The real installed SDK oracle rejects unexpected URLs and intercepts all SDK
fetches at a fixture-only `.invalid` host. Global fetch and http/https fallthrough
are disabled. No production key/default is imported or executed. The app
constructor's literal configuration is read by the actual TypeScript AST parser.
Node 24.22.1, V8 13.6.233.17-node.58 and TypeScript 5.9.3 are strict assertions.
Provenance includes app/package/lock hashes, complete shipped JS/JSON SDK tree
hashes, native SDK Event source, JSON/date/number/string readers, test and oracle
reader hashes. Real UUIDv7/time are checked for validity and normalized only in
the artifact; SDK-generated bytes remain intact for retry identity assertions.
There is no copied UUID/normalization algorithm. Gzip uses built-in zlib solely
for reading actual intercepted batches; no measurement is performed.

Oracle lifecycle cases exercise defaults/empty calls, threshold/timer, ready
backlog, drop-oldest, all retryable status classes, terminal/exhausted HTTP,
413 splitting, exhausted network retention, request abort, shared/repeated and
timed shutdown, and SDK capture after shutdown. Error cases explicitly shorten
only the SDK fixture retry delay; defaults are independently asserted as 3 s.
Overflow cases hold only the SDK automatic-flush scheduler boundary while
filling the actual SDK queue; real SDK queue/eviction/flush logic remains active.
The Rust tests retain real 3-second retry delays. `--check` reruns the real SDK
and compares the exact deterministic artifact and exact directory contents.
Missing/empty fixture files/cases/replay environment cause failure, never a skip.

Parent execution sequence, **only inside the parent's read-only snapshot and
6 CPU / 4 GiB / no-swap / 256 PID / two-Cargo-job workflow**:

1. Integrate the proposed module/feature; run formatting and regenerate the
   snapshot so the oracle's reader hashes correspond to the final files.
2. Run `node tests/fixtures/posthog_lossless_reference.cjs --write NEW_DIR`,
   then `--check NEW_DIR`, with strict pinned runtime and installed package tree.
   Provide `POSTHOG_RS_SOURCE` if the read-only registry mount has another path.
3. Set `POSTHOG_LOSSLESS_REFERENCE_DIR=NEW_DIR` for
   `cargo test --locked --no-default-features --features posthog-lossless --test posthog_lossless`.
   The crate-level test gate means the feature must actually be enabled; a zero
   test run is not acceptance. Test retries deliberately take real seconds.
4. Parent performs the relevant check/Clippy/wrapper integration suites and
   source identity checks within its existing cache/resource limits. Do not
   widen workers/defaults or interpret these instructions as a live release.

## Static installed-source hashes

These are static read evidence, **not executed oracle provenance**. The oracle
asserts these pins and emits further full-tree/reader hashes when the parent runs it.

| Source | SHA-256 |
| --- | --- |
| `dimabot/src/utils/posthog_events.ts` | `19a330a48e8f013f753b1a38d5e03b7d36fb2838e7de69426cd229c78c81086d` |
| `dimabot/node_modules/@posthog/core/dist/posthog-core-stateless.js` | `bfe3cf1ad982bb2a6a98f4f603e2e6dff5e740ee1b7428b59c56d055845354b7` |
| `dimabot/node_modules/posthog-node/dist/client.js` | `d4e0d4c6e7e1595bd323dac2d92807354df99e486584903b0134bd320e97b42b` |
| `dimabot/node_modules/posthog-node/dist/entrypoints/index.node.js` | `1565d78edad825a52a9efb84742033c5141d2d42065a2577e0e200c1f9ff1792` |
| `dimabot/node_modules/posthog-node/package.json` | `d0d1da472434119faf932ce53d2a4e374d5044c5f75e8e6c63e5c657194e63a1` |
| `dimabot/node_modules/@posthog/core/package.json` | `7102a87a3c23e38c628e1f761262c50a5a7c4dd2b4fb912678e977938dbeca86` |
| `dimabot/node_modules/typescript/package.json` | `822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6` |
| `dimabot/package-lock.json` | `abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7` |
| `dimabot/Cargo.lock` | `787333fa269752a606040d7393767040ef749ce1e01c2512386bf305bcd7a2c3` |
| `posthog-rs-0.27.0/src/event.rs` | `5a4112ea152b483a2dc25195bd56901ece4e6da363dd0904babe48776ceae312` |
