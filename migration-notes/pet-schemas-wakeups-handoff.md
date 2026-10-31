# Team 2 slice 9 authoring handoff

Authoring only, 2026-10-31. No code was compiled, executed, formatted or runtime verified. No deployment or caller adoption occurred. Local coverage is incomplete pending source comparison, isolated runtime checks and the gaps below; total dependency-complete migration is not claimed.

## Ownership and reuse

The claimed schemas describe `pet_requests`, `pet_runtimes`, and `pet_settings`. Existing `SchemaDefinition` supplies construction, casting, validation, explicit repositories and index creation; Mongo's driver supplies atomic conditional updates needed by pets consumers. The existing concrete `domain_events::runtime::wakeups` already owns Redis publisher and subscriber and is reused through a re-export rather than duplicating its transport or introducing a second publisher. The journal calls its publisher after Mongo acceptance. The TypeScript pets admission, queue, runtime, tokens, readiness and settings service use Mongo atomic operations, explicit index initialization and lean reads; their adapters and settings service remain outside this slice. Team 4 contract `team4-pets-runtime-schemas` also requires `pet_settings.service.ts`, which is not in this slice's claimed paths and remains a blocking dependency. Overlay token and the remaining pets runtime dependencies are also separate contracts.

## Central integration snippets (not applied)

In `Cargo.toml` features:

```toml
pet-schemas-wakeups = ["application-schemas", "domain-event-runtime"]
```

In the existing schemas module (same location/visibility convention as sibling schemas):

```rust
#[cfg(feature = "pet-schemas-wakeups")]
#[path = "pet_runtime.schema.rs"]
pub mod pet_runtime;
#[cfg(feature = "pet-schemas-wakeups")]
#[path = "pet_settings.schema.rs"]
pub mod pet_settings;
```

In the existing utils module:

```rust
#[cfg(feature = "pet-schemas-wakeups")]
pub mod domain_event_wakeups;
```

Names are proposals for the integrator; `domain-event-runtime` already brings Redis, Tokio and futures-util. Schemas additionally require `application-schemas` (Mongo and its date/string helpers). Oracle test support uses existing serde_json and sha2 through that feature. Resolve module placement against current central files before integration.

## Consumer and behavior boundaries

Call `install_indexes` before traffic, not at import; this is required for request identity, partial string token uniqueness and settings user uniqueness. TTL expiry is asynchronous Mongo background behavior. The schema has no automatic transactions, query casting, update validators or Mongoose middleware: consumers must use appropriate Mongo driver predicates and updates, preserve partial updates, and apply needed casts/defaults at their actual operation boundary. `construct` runs validators and is not equivalent to unvalidated Mongoose updates. The declared source interfaces are stricter than runtime schema: operation and MIME are not schema enums; only `ownerId` is required on a request. Inline nested objects differ from nullable single subdocuments. Settings use ObjectId user IDs; request/runtime IDs are strings. The schema framework's behavior on every nested/null/cast edge requires actual-source testing before parity can be claimed.

The Redis source has one pending bit, one in-flight command, lazy connection, 500 ms operation timeout, 1 s failure cooldown, 30 s publisher idle close, dedicated subscriber connection and background retry. Hints can be dropped during failure, cooldown, disconnect or before subscription; they are not durable events. Mongo polling must continue independently. A received hint between polling and waiting must be retained in the consumer's poll signal; the TypeScript `DomainEventPollSignal` does this, but this slice supplies no native poll-signal integration. Existing native transport must be reviewed for lifecycle and parity before use: its config snapshots enabled state at construction rather than reading the environment per call; its multiplexed connection timeout may not prove immediate cancellation of an underlying queued command; cooldown/pending races and reconnect/stop behavior require focused tests. Its listener requires an explicit `start`, and owners must call async `shutdown`. Source default singleton creates no connection at import. Native consumers must not assume Redis provides delivery or no lost messages.

## Authored verification and limitations

`pet_schemas_wakeups_reference.cjs` transpiles actual pinned TypeScript schemas with disconnected pinned Mongoose, emits selected default/cast observations, and requires an external canonical directory. It does not yet compare invalid cases, indexes, full nested/null behavior, update casts or the wakeup source/test. The ignored Rust oracle test checks only a subset. The ignored private Mongo test checks one unique index and declares TTL metadata; it does not yet inspect server indexes or test all unique/partial semantics. The ignored Redis test checks an eventual pub/sub exchange and shutdown on a dedicated disposable server, but does not yet cover reconnection, cancellation while blocked, coalescing, cooldown, idle disconnect, or source parity. All of those tests and an actual-source fake-client wakeup oracle remain required before accepting the slice; no tests were executed. The private suites require the existing isolated lease owner marker and explicitly supplied disposable URIs; use a task-owned database named `rust_pet_schemas_fixture_*`. Redis test assumes the entire Redis server is task-owned because the channel is fixed and global.

## Continued authoring, 2026-10-31

The earlier `crate::domain_events::runtime` re-export was incorrect for the current central layout and now points to `crate::domain_event_runtime::wakeups`. The proposed feature must also enable `tokio/io-util` for the task-owned RESP stub in the integration test; update the earlier snippet to:

```toml
pet-schemas-wakeups = ["application-schemas", "domain-event-runtime", "tokio/io-util"]
```

The expanded external actual-source oracle constructs the three real Mongoose models, exercises defaults, nested objects, explicit null, scalar casts, invalid required/enum/range/UTF-16 length/casts, and records all schema index keys, uniqueness, TTL and partial filters. The native replay compares whole normalized documents or validity and index descriptors. It deliberately compares validity rather than individual Mongoose error names/paths, so detailed error parity remains uncovered. The oracle runs the actual TypeScript wakeup class with fake clients patterned after `domain_event_wakeups.test.ts`, including gated connect/publication, cold scheduling, burst coalescing, timeout and cooldown, late completion, idle closure, listener reconnection and stop. It pins both wakeup source and source test hashes. It does not execute the original test file itself; the fake scenarios are an independent harness derived from it. Timings and compilation remain unverified. Source oracle data are external and digest-checked by the Rust harness.

Mongo test now reads back every declared server index (including TTL and partial filter) and exercises request/settings uniqueness and both included and excluded token hash types. It requires an initially empty named private database. A task-owned loopback RESP stub records actual native Redis commands and socket closure without touching Redis; its suites author coalescing, idle release, timed-out command closure/cooldown, background reconnect, stop and blocked-command cancellation checks. A separate ignored disposable-Redis test covers pub/sub's lack of replay for a late listener. The poll-signal test demonstrates a retained `Notify` permit and timeout only: it does not implement or wire the native worker. Consumer must keep polling Mongo and retain a hint arriving before a wait; pub/sub does not guarantee delivery and no durability has been added.

### Shared transport defects and owner handoff

The shared file is `dimabot/src/domain_events/runtime/wakeups.rs` (SHA-256 `a84359cecda65773b270284bac54dc7b8836f8301796d3e83948f60bb7b2e401`); it is outside team 2 slice 9. No owner for this exact existing shared file is named in the claims inspected: route the fix to the **central integration/domain-event-runtime owner**, not to team 4 or this slice, and establish ownership before changing it.

A concrete race exists in `publisher` failure handling: it clears `pending` and only then sets `cooldown`; a concurrent `publish()` can pass its cooldown check and set `pending` between those two operations (or check before cooldown and set afterward). When the cooldown ends, the loop observes the pending bit and sends a retained hint. TypeScript's synchronous `failed()` reset and retry assignment cannot interleave with `publish()` on the JS event loop, and drops calls during cooldown. The central owner must serialize the transition with publication or use an equivalent atomic state machine, and author a deterministic race check. The current loopback timing suite covers ordinary cooldown, not this narrow interleaving; the race is established by source inspection, not by an executed test.

The environment flag also differs: TS evaluates `DOMAIN_EVENTS_WAKEUPS_ENABLED` for each `start` and `publish`, while `WakeupConfig::default` snapshots it at construction. The shared API must either reproduce the dynamic behavior or explicitly coordinate an accepted contract change with its owners. The transport uses redis-rs 1.7.1 canonical `get_multiplexed_async_connection_with_config`: its source documents that dropping a request future alone does not cancel the sent command, while dropping all canonical connection clones aborts the associated driver task. This implementation drops its sole stored connection on timeout and aborts its owning task on shutdown; socket-close tests are authored to establish the actual runtime behavior, but no cancellation failure is asserted without that evidence. The listener has no subscribe-ready API; tests synchronize on the stub's received SUBSCRIBE and consumer startup must still tolerate the subscription gap. No path in scope was used to create a second publisher.

Remaining blockers: run/reconcile the full oracle including framework nested/null and update-query differences; extend comparison to detailed error paths and update/filter casting where required by consumers; execute isolated Mongo and Redis/stub cases and fix findings in their owning modules; deterministically test and fix the shared cooldown race and decide dynamic flag parity; integrate a native poll signal and settings service; and register the feature/modules centrally. Local feature coverage and dependency-complete migration remain unverified and incomplete. No production or deployment changes were made.

A second concrete source-level discrepancy affects cold-connect coalescing. The native publisher swaps `pending` to false **before** connecting; a burst while connect is still pending sets it again, causing a second publication after the initial one. The source leaves `pending` true until connection succeeds and starts publication, so a burst during connect produces one publication. The `cold_connect_burst_is_one_hint` stub test is authored as a regression check; it has not run. Its handshake gate assumes redis-rs issues `CLIENT` setup commands, which must be confirmed in the leased environment and replaced by a supported deterministic connect gate if it does not. The central integration/domain-event-runtime owner owns this fix along with the cooldown race.
