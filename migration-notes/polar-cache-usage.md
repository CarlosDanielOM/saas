# Polar cache-mode usage adapter — 2026-10-30

## Scope and result

The `src/utils/polarsh.ts` inventory row is now **partial** for the bounded `mode: "cache"` branch of `ingestPolarSHEvent`. The native opt-in adapter prepares the source-shaped AI usage event, coordinates the channel queue, appends the event, projects accepted credits, queues the receipt, records analytics, and returns without a Polar HTTP ingestion call. This is not a Rust replacement for `polarsh.ts`: `getPolarShClient`, `grantPolarAiCredits`, immediate mode, batch flush/HTTP delivery, the wider billing wrapper, and semantic worker/caller adoption remain open.

Final code and evidence are pinned to commit `de0606ed9b8b2dbdc73f7ffd457090e7cc9404fa` and source-tree SHA-256 `c73089d01b8073f9aa8e0ddb4e8c87a05a19b8c448cf40df016f72ad87f96130`. The final Node run `node-1793351297978993028` and compiler/fixtures run `compiler-fixtures-1793351297978548916` used that same tree. A source-generated 32-record corpus was replayed, and the actual cache-mode test exercised normalized private Redis I/O, logger calls, receipt and analytics payloads, owner changes, and an applied Polar `RPUSH` response-loss case. There was one ordinary Rust test and four ignored fixture tests; scoped, minimal, Mongo/Redis, and all-feature strict validation passed.

The Node and compiler receipts bind 1,456 inputs (1,446 Git objects and ten SDK files reused from the prior archive-verified SDK binding). The compiler/fixtures step took 116.913 seconds; the complete phase took 127.794 seconds. Resource limits were six CPUs, 4 GiB memory with swap disabled, 256 PIDs, and two Cargo jobs. See the [indexed evidence package](evidence/2026-10-30-polar-cache-usage/README.md).

## Reuse and dependency boundary

The adapter reuses the native AI usage context/metadata helper for event attribution, existing pricing and source-compatible accounting projection, receipt construction/enqueue, PostHog tracking, the shared Redis client, and the concrete native logger. These sources are direct dependencies of the branch, not newly parallel implementations. The generic billing/application wrapper and the full transitive closure for `polarsh.ts` remain unreviewed outside this call path. The Polar SDK is not used by the cache-mode return path; immediate ingestion and batch flush still need their concrete application adapter.

The source event queue `twitch:{channel}:ai:polarshevent` is separate from `cron:ai-usage-receipts:queue`. Legacy string-JSON queue entries are parsed and migrated before the new event is pushed. Cache mode preserves queue-before-projection-before-receipt-before-analytics ordering and its best-effort behavior for projection, receipt, and analytics failures, as exercised by the source replay. It makes no external Polar HTTP request.

The source's 8-second NX/PX channel lease protects queue migration and flush coordination. Contenders use 350 ms future-contention polls while the 2.5-second nominal coordination budget remains, then continue by queueing/projecting without owning the lease, matching source behavior. The source’s final unconditional poll can overshoot that nominal budget; the native implementation caps its final poll to remaining monotonic time. This is not a hard end-to-end Redis operation timeout and the pause does not delay ready queue work. Source release uses GET then DEL; with the user's prior approval, the native branch uses the existing atomic owner-checked `ai_usage_lock` Lua release so an expired owner cannot delete its replacement. The atomic release is an accepted behavior improvement.

## Evidence boundaries

The complete Redis trace is not claimed byte-identical. The comparison normalizes generated UUIDs, clock fields, Redis driver-specific error text, and the approved GET/DEL-to-atomic-EVAL release. The response-loss fixture applies loss after Polar `RPUSH` and verifies one forwarded write and one atomic release attempt; it does not establish EVAL reply-loss replay safety. Higher-level pending-charge recovery with a stable ID is distinct from retrying an ambiguous in-call Redis mutation.

The concrete default logger is validated with cache and console sinks. Automatic attachment of the TypeScript `recordLog` telemetry/OpenTelemetry providers and lone UTF-16-surrogate diagnostic payloads are not demonstrated by this adapter. These are bounded differences, not claims of whole-logger or full application completion. No benchmark or production latency result was produced.

The matrix now records 17 locally complete and 23 partial mappings; total migration completion remains `null`. Local branch coverage is separate from dependency completeness, caller adoption, source retirement, and deployment. The evidence readback found all 18 production records unchanged and zero task-owned resources. No deployment, TypeScript retirement, or push occurred.

## Scheduling and pacing decisions

The retained 8-second lease is real cross-caller coordination; the 350 ms polls only wait for a future lease owner; the 2.5-second wait cap bounds coordination while preserving the source's queue-and-project behavior after contention. The final poll is capped against monotonic elapsed time. Retry delays for error recovery are handled separately and are not an end-to-end RPC deadline. Ready event processing is not deliberately delayed to create a cadence.
