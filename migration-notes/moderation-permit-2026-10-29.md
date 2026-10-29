# Moderation permit Rust parity and isolated Redis acceptance (2026-10-29)

This record closes the bounded native port and fixture validation for `moderation/permit.ts`. It does not close the TypeScript callers or the wrapper's application telemetry dependencies. The final read-only source snapshot fingerprint covers 1,335 inputs; the frozen snapshot SHA-256 is `154399463d3773c5d12c06279333ad024fd604adcf173aafb65408b40147238f`. The initial port is commit `c962f437`; context propagation correction is `23355cca`.

## Source parity

The strict source oracle executes the complete, pinned TypeScript module with only its Redis boundary mocked. It compares the source exports and native implementation for parsing, keys and UTF-8 bytes, f64-preserving grant plans, command traces, null/empty behavior, and error/read cases. Independent readback matched all 395 parse, 39 login, 156 key, 78 grant, eight read, and two held-read cases. Native and TypeScript fingerprints matched the frozen inputs. The corrected final proof adds a real source `AsyncLocalStorage` case: both native concurrent read tasks inherited the parent trace/channel context, matching the source case. The combined final readback confirmed that addition while retaining the prior permit corpus unchanged.

One early compiler fixture run failed: `read_tasks_keep_parent_telemetry_context` showed that spawning the detached native read coordinator lost the parent context. The implementation was corrected to capture and restore the telemetry context around the coordinator. The final compiler and full fixture receipts passed, including the new context case. The earlier failure remains in the evidence bundle as a negative receipt and is not counted as final success.

## Isolated runtime behavior

The ignored Redis integration suite ran only with the task-owned private fixture. It uses unique channel/key names, acquires a unique `SET NX EX` ownership claim, checks that each exact key is initially absent before registering it, and performs bounded cleanup of only registered keys if the claim still matches. The fixture does not flush a database or touch shared telemetry keys. The successful run covered:

- Exact `SET key value EX seconds` grant payload and TTL, including expiration and the channel-wide key.
- User and channel `GET`, absent keys, and empty byte values (empty is still present).
- Wrong-type GET failures independently on the channel key and user key, propagated as errors.
- Zero-second `SET` failure, and 24 concurrent lookups through cloned `ConnectionManager`s.
- Explicit `with_telemetry` operation spans and GET hit/miss metrics using a mock-only telemetry endpoint.
- A loopback forwarding proxy that first lets Redis apply `SET` and only then holds or discards its reply. Cancelling the caller after application left the write applied; an applied write with a discarded reply returned an error, and the proxy observed exactly one SET for that call, proving there was no application retry.

The proxy's hold/reply controls and the fixture's bounded waits test transport outcomes without relying on production services. The code's default operation has no added deadline for `SET`/`GET`; the fixture adds explicit deadlines to prevent a test hang. The native shared Redis manager's five-second bound applies to initial connection/PING, not each permit command. Unknown write outcome is returned to the caller without retry.

## Scope and remaining work

`PermitStore::with_telemetry` instruments operation spans and GET hit/miss observations only when callers explicitly supply a native `Telemetry`. Default `connect` and exported functions do not bootstrap global process telemetry or reproduce the TypeScript wrapper's connection-event logging and suppression behavior. Those are required application-specific dependencies and remain open. The TypeScript source and current AST permit/moderation handlers remain live; no caller adoption or production cutover occurred. This is partial local permit feature coverage, not full moderation coverage or 100% migration completion. No performance measurement was performed.

The capped compiler, Node source-fixture, and compiler-fixture receipts passed under 6 CPU, 4 GiB memory with swap capped to memory, and 256 PIDs (Cargo builds used two jobs). The final readback reported 19 unchanged production records and zero remaining task-owned containers, networks, or volumes. No production services were modified, and no deployment or push was performed.

## Evidence

The raw files and receipts are retained in [`evidence/2026-10-29-moderation-permit-retirement/`](evidence/2026-10-29-moderation-permit-retirement/). Relevant items include the individual permit `independent-readback.json` and `final-readback.json`, the combined moderation-rule-retirement `independent-reference-readback.json` and `final-readback.json` (which carry the final context case), the 1,335-input source fingerprint, and capped phase receipts `compiler-1793309891342492944`, `node-1793309891350167771`, and `compiler-fixtures-1793309985004657594`. The context-negative compiler receipt `compiler-1793309518205057473` documents the corrected failure. The fixture code is frozen at `dimabot/tests/moderation_permit_redis.rs` and the source oracle at `dimabot/tests/fixtures/moderation_permit_reference.cjs` in the accepted source snapshot.
