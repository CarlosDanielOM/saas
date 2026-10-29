# Native PostHog tracking handoff — baseline validated; adoption pending

## Parent validation update — initial baseline

The initial baseline passed capped all-target/all-feature checks and strict Clippy, minimal/no-default profile checks, formatting, five ordinary wrapper tests, two source replays, and the final Node source run. Overall parent compiler receipt: `compiler-1793264871810743273`; pinned Node receipt: `node-1793265499179357802`. Full five-zone fixture generation/replay and its later Clippy failure are recorded separately in the [combined migration note](posthog-receipt-2026-10-29.md); final UTC replay and all four oracle `--check` runs passed. The Node run covered 1,042 wrapper records, two SDK payloads in one case, and 18 lifecycle scenarios. Local baseline files are committed (`cf2bd757`, `77141415`); this does not mean caller adoption or strict transport equivalence. The separate payload optimization remains unverified. No push or deployment occurred.

This completion replaces the initial unverified draft in the four assigned
files. It is source work, not acceptance evidence. The author ran no Cargo,
rustfmt, Node, application, oracle, test, benchmark, Docker, container, or network
code. Only static file/source inspection, read-only SHA-256 calculation and diff
checks are authorized here. No dependency installation, cache operation, commit,
push, adoption, retirement, deployment or production change is included. Parent
must integrate and execute in an isolated capped snapshot. HEAD observed during
inspection: `9ed21b6512ae40951d5463dcf0a2cf7d0ff9a1c7`.

## Scope and reusable sources

The owning project is `dimabot`. Root `AGENTS.md`, project `AGENTS.md`,
`RUST_AGENTS.md`, `RUST.md` and `orchestrator-notes/README.md` were inspected.
This is an explicitly assigned implementation-subagent task with no further
delegation. Only these files are owned:

- `dimabot/src/utils/posthog_tracking.rs`
- `dimabot/tests/posthog_tracking.rs`
- `dimabot/tests/fixtures/posthog_tracking_reference.cjs`
- this handoff

The existing public `posthog_events.rs` foundation remains intact: project key,
US host, batching constants, SDK client/options, `identify_event` and
`StreamerIdentities`. The SDK runtime path still uses that identity helper.
`ai_usage.rs` supplies the schema constant, enums, native context DTO and context
constructor. Tracking neither copies classification/normalization policy nor
implements billing, receipts, dates, pricing, rounding or number formatting.
`JsString` and `lossless_json` supply UTF-16 and binary64 semantics; ASCII keys
now use `JsString::from` directly. `posthog_lossless.rs` is a separately owned
concrete transport; this code targets precisely the API agreed with the parent
and does not alter it, its tests, central wiring or locks. The concurrently
authored receipt parser and all committed evidence are outside this edit.

## All six source exports and call graph

The actual wrapper is `src/utils/posthog_events.ts`. Its runtime imports are
`PostHog` from `posthog-node` and `AI_USAGE_SCHEMA_VERSION` from
`ai_usage_event.js`; `AiUsageContext` is a type-only binding. The latter module's
runtime import is `randomUUID` from `node:crypto`. Its native counterpart is the
existing `ai_usage` module, not a callback stub.

| Source export | Source consumers and resulting contract |
| --- | --- |
| `identifyStreamer` | `classes/twitch_streamers.class.ts:151,442`; ignores empty ID/name, remembers last name per ID, emits first sight/rename; a fresh runtime identifies again. |
| `trackCommand` | `handlers/message.handler.ts:770`; command completion sends status, arguments and error with channel distinct ID. Caller has its own `unknown` fallback; the wrapper still applies user ID/name falsy fallback to channel ID/name. |
| `trackTts` | `utils/ast_parser/functions/tts.functions.ts:97,123,148,175,200`; AST TTS handlers use `resolveTrackingIdentity`, queue result, JS message length, mode/provider and error. The wrapper itself performs no synthesis or queue operation. |
| `trackAiUsageRecorded` | `utils/polarsh.ts:114,509`; accepted usage ingests and successful grants, inside catch blocks so analytics cannot interrupt billing/receipt enqueue. Entry ID becomes `$insert_id`; distinct ID is nonempty channel or `billing:${requestId}`. Every context/accounting/token property is retained. |
| `trackAiOperation` | `handlers/tts_queue.handler.ts:249,442,527,583`; queued, empty-after-fallback, synthesis failure and completion events. `$insert_id` is exactly `requestId:operation:lifecycle`; schema version comes from the native constant. All provider/fallback/error/resource/latency properties are retained. |
| `shutdownPosthog` | No application caller found. Source awaits `posthog.shutdown()`. A future native lifecycle owner must invoke shutdown on the shared runtime before ending its Tokio runtime. |

The oracle also records AST declarations/signatures, both context interfaces,
import binding/type-only evidence, observed transpiled runtime imports and the
five caller files' import/call ASTs and hashes. It strictly checks the real two
TypeScript modules against installed dependency types (`skipLibCheck` excludes
third-party declaration internals only). It does not execute application callers.

## Contracts, conversion and acquisition

Four public pure builders retain all source payload property names. The
plain-value input contract is an owned JSON object, arbitrary UTF-16 strings and
binary64 numbers. Required fields must exist, except userID/username which may
be absent because the source explicitly uses falsy fallback. Distinct IDs and
string-template operands must be strings; AI usage also accepts falsy JSON
channel values for its billing fallback. Optional absent/undefined/null maps to
null. Other optional and required property values pass through as JSON,
including values outside their TypeScript declared type. Truthy nonstring
channel IDs, absent required fields, undefined required fields and nonstring
template operands are explicitly rejected by native builders. The source oracle
still executes and records these excluded casts; it does not describe those
rejections as source exceptions. Unknown objects/proxies, BigInt, Symbol,
functions and coercion via custom methods are outside the plain JSON contract.
Typed source literals such as lifecycle/status are not new runtime validators.

`native_context` visits each DTO field directly. `NativeUsageRecorded` is the
native typed entry point and `track_native_ai_usage_recorded` captures it. It
reuses an already-normalized context, never reclassifies or trims it. Even
manually assembled contexts retain empty option strings and raw quantity bits.
The native context factory remains responsible for its existing trim, enum,
finite quantity and UUID policy. Tests supply explicit IDs, so actual-source
fixtures stay deterministic without mocking crypto. The native DTO contains
Rust strings and cannot itself hold lone UTF-16 units; the plain-value path
covers those strings without substitution.

SDK conversion walks `JsonValue` directly into `serde_json::Value` and uses
`Event::insert_prop`; it never stringifies/reparses an entire event or native
context per capture. Raw -0 and nonfinite numbers survive preparation. At the
JSON wire boundary -0 becomes 0 and NaN/infinities become null. No copied
adjustment/date/number policy is introduced. SDK conversion explicitly rejects
unpaired UTF-16 in IDs, property names and nested values; there is no U+FFFD
replacement. Lossless capture preserves those units using the separate concrete
backend, including identity keys and names.

`PosthogTracking::new(Client)` keeps ordinary SDK compatibility.
`with_lossless_transport(PosthogLosslessTransport)` and `from_lossless_config`
provide concrete native runtime construction. Clones share one backend, queue,
identity map and lifecycle state. SDK identity state reuses `StreamerIdentities`;
lossless/pure replay uses `StreamerIdentityState`, backed by
`HashMap<JsString, JsString>`.
As in the source, dedup state is updated before enqueue, so failed analytics
submission does not undo that state.

`PosthogTrackingRuntime::new(config).get().await` is a configurable lazy concrete
factory. `get_posthog_tracking` lazily acquires one process default with the
public existing key/host, full `/batch/` URL and source batching constants.
`default_config()` is inert and inspectable; it creates no runtime/client/event.
The six snake_case convenience wrappers and their exact camelCase source-name
aliases use that lossless default. Lazy wrappers are async and return explicit
errors; methods on an acquired handle remain synchronous for capture. Use a
long-lived Tokio runtime, and do not reuse a cached instance after its transport
or originating runtime shuts down. There is no automatic reinitialization after
shutdown. No test invokes the production-key default; test constructors use
`phc_fixture_only` and explicit loopback endpoints.

## Pinned SDK evidence and lifecycle limits

Read-only source location supplied by parent:
`/root/.local/state/rust-full-migration-20261028-lu443ytp/cargo/registry/src/index.crates.io-1949cf8c6b5b557f/posthog-rs-0.27.0`.
Actual SHA-256 values read here (the oracle asserts these byte hashes):

| SDK file | SHA-256 |
| --- | --- |
| `Cargo.toml` | `7c2898b66160da1b4d971d1ab62921c05817d9d7cb45c9366312a917728a7da7` |
| `src/event.rs` | `5a4112ea152b483a2dc25195bd56901ece4e6da363dd0904babe48776ceae312` |
| `src/client/async_client.rs` | `0c2bb5560eff1a281dd4b1986a40256a3fbb0c3eea3847751a06d6a3c00fbd72` |
| `src/client/transport.rs` | `2f1cbce6b0ac5bd33c76cfc43957f22651640ff626224c9e1753603a4caf059b` |
| `src/client/mod.rs` (options) | `e2dd52f1e691fb9cd1451fac307cc4a54e5c4632a621892283dedb91ec07a577` |
| `src/client/retry.rs` | `563cbf0a7979dcf9879af89bf2e2642eef6c543fcb5d506615c6a227c20802f0` |
| `src/client/v0_capture.rs` | `c4442aef3a7b67d790ec828c2c368d21fba0fe9fe4749d8f987b642ecfa7e5b4` |
| `src/client/common.rs` | `26b934e180e51f3b12b7ca6693feccee12edeceaa9f916934f6e875b71fb068d` |
| `src/lib.rs` | `bdd3347d2600557fbb05f15a06647f5495a54eba3f8f9579aefa084ff9883242` |

`Cargo.lock` records 0.27.0 with registry archive checksum
`e4bf3024d46115813aba6c8ca1aa95bb850a26cb7a36f6e03ca0c12c449c5925`.
The inspected cache has no `.cargo-checksum.json`; no claim is made that the
archive checksum alone authenticates this unpacked tree. The actual file hashes
above identify what was inspected.

`Event` stores IDs as `String` and properties as
`HashMap<String, serde_json::Value>`; `insert_prop` calls `serde_json::to_value`.
This SDK representation cannot encode a lone UTF-16 surrogate. Its V0 path adds
`$lib`, `$lib_version` and version component properties; capture defaults may
add geo-IP/person/platform metadata, and the envelope includes generated UUID,
timestamp and batch send metadata. Tests compare every application property and
allow only named SDK metadata extras. The source SDK-boundary oracle does not
claim byte-identical npm SDK envelopes, timestamps or retry internals. Native
crates replace npm internals rather than porting them.

SDK `capture` is fire-and-forget; disabled, full or closed clients drop events,
and transport failure is not returned to its caller. Therefore SDK-path
`Ok(())` proves conversion/enqueue invocation, not delivery. `flush` waits until
the worker has attempted earlier work, without surfacing HTTP errors; transient
failures remain queued. `shutdown` closes the shared transport, attempts a final
drain and joins the worker. Repeated external shutdown is safe; post-shutdown
SDK capture is dropped. Drain failures may discard events. Options and
transport source show that shutdown's drain deadline caps new requests started
during that drain, but does not preempt automatic work already underway. Such
work can include several batches and request timeouts. **No total wall-clock
shutdown bound is inferred from SDK documentation.** Test-level timeouts protect
the fixture test and are not a production SDK guarantee. The separate lossless
transport has its own explicit error/queue/shutdown contract and is validated by
its owner/parent too; HTTP/queue parity with posthog-node is not asserted.

## Authored verification and parent execution

Normal test graph: five tests (one pure conversion/default test, three real SDK
loopback tests, one concrete lossless factory/native context/UTF-16 test). Tests
cover all four captures plus identify, clone dedup/rename, separate instances,
threshold batching, explicit flush, pending shutdown drain, 503 held retry, 400
terminal rejection, shutdown response ordering, repeated shutdown and closed
SDK/lossless behavior. Loopback listeners have bounded accept lifetime,
absolute read/size limits, bounded write/gate waits and panic-safe owned thread
cleanup. Teardown requests stop and waits with a deadline before joining a
completed worker. There are no ready-work sleeps or open-ended fixture joins.
The controlled response gate proves shutdown waits for its actual delivery
attempt, without claiming that attempt must succeed in general.

Two ignored tests require an explicit `POSTHOG_TRACKING_FIXTURES` directory:

1. Replay all source records and metadata. Missing/empty/truncated fixtures fail.
   Every record's source wire form is checked against raw tagged output, then
   native mapping/rejection is checked. Identity replay shares state across
   logical clone handles and separates process instances. Native cases compare
   real context factory output and direct public DTO conversion. Numeric bits
   are checked before wire normalization.
2. Replay supported source calls through the concrete lossless backend/factory
   against loopback, sharing clones and checking every emitted payload. Captures
   after shutdown test the transport's closed state; the SDK mock's forwarding
   behavior is explicitly separate from transport lifecycle behavior. Work is
   flushed in bounded groups, with no queue-draining sleeps.

The actual-source oracle is pinned to Node **24.22.1**, V8
**13.6.233.17-node.58**, TypeScript **5.9.3**, and installed/locked posthog-node
**5.47.3**. It executes real wrapper and context code, mocking only the analytics
SDK boundary. The SDK shutdown mock uses a controlled promise gate and asserts
the wrapper remains pending until it is released. The generated matrix has over
300 meaningful cases (the exact generated count is metadata, not an executed
claim): every property, optional absence/undefined/null/falsy variants, required
runtime casts and exclusions, astral/unpaired UTF-16, binary64 bit tags,
nonfinite/-0 source JSON output, context classification/trim/filter/enums,
manual native contexts, identity sessions and repeated lifecycle calls. The
fixture contains sources plus exact package/lock/source/reader/native dependency
hashes. Rust readback compares embedded sources byte-for-byte, avoiding a new
crypto dependency; the oracle verifies the hashes and `--check` verifies the
entire file byte-for-byte.

Parent feature proposal (not applied):

```toml
posthog-tracking = ["posthog", "ai-usage", "tts-utilities", "posthog-lossless"]
```

Wire both separately authored modules before compilation. Keep the feature out
of defaults and all worker profiles. The lossless feature supplies its existing
reqwest/Tokio dependencies. Parent must run formatting first, then freeze the
source snapshot and generate fixtures (formatting later would intentionally
invalidate source hashes). Within the prescribed isolated capped toolchain:

```text
node tests/fixtures/posthog_tracking_reference.cjs --write /task-owned/new-posthog-dir
node tests/fixtures/posthog_tracking_reference.cjs --check /task-owned/new-posthog-dir
cargo check --locked --no-default-features --features posthog-tracking --all-targets
cargo clippy --locked --no-default-features --features posthog-tracking --all-targets -- -D warnings
cargo test --locked --no-default-features --features posthog-tracking --test posthog_tracking
POSTHOG_TRACKING_FIXTURES=/task-owned/new-posthog-dir cargo test --locked --no-default-features --features posthog-tracking --test posthog_tracking -- --ignored
```

`--write` requires a **new nonexistent directory** and creates it exclusively;
`--check` requires that exact directory with only `posthog_tracking.json`. Mount
installed pinned packages and the SDK source read-only; override
`POSTHOG_RS_SOURCE` only to another copy with the same asserted hashes. Run Node
from the `dimabot` snapshot so strict type resolution uses its pinned packages.
The initial wrapper/transport baseline checks are recorded in the parent
validation update above and the combined migration note. This does not establish
total migration completion: billing/Polar/ledger integration and their concrete
application paths remain open, and the source/transport differences listed
above remain relevant. Application caller adoption and deployment are separate
status items and have not changed. No live worker release occurred.
