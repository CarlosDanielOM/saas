# Lua scripts: bounds audit

Read-only audit by GPT-6.1 Sol on 2026-11-11, after a test showed that the Dragonfly in use
(df-v2.1) has no `SCRIPT KILL` and no Lua time limit, and that `TIME` is frozen inside a script. A
script whose work is not bounded occupies its shard until it finishes; one that never finishes hangs
the shard until the server is restarted. Client-side timeouts do not stop a running script.

Scope: the 64 inventory records in `dragonfly.json` (76 entries with grouped Rust records expanded).
No script was found that the inventory missed. Classes count control flow and call count; large
payloads still need byte limits.

| Class | Count |
|---|---|
| Constant | 51 |
| Bounded by arguments | 9 |
| Bounded by data | 14 |
| Loops until a condition (no cap) | 2 |

## Rules for the port

- A ported script keeps its text (data rule 7). Where this audit asks for a cap, the cap is added
  around the script: a limit at the caller, or the same script called repeatedly on a bounded batch.
  Changing a script's text needs a line in the package report and a fixture proving TypeScript and
  Rust still interoperate.
- No new script may loop on a condition without an iteration cap.

## Scripts that loop until a condition

| Source | What it does | Change in the port |
|---|---|---|
| `dimabot/src/workers/ai_usage_backfill.worker.ts:19` | `while true` moving items from a processing list back to the queue until `LPOP` returns nil. Ends when the list is empty; never ends if both keys are the same key | Reject identical keys at the caller; move at most 100 items per call and repeat from the host |
| `dima-rust/src/workers/ai_usage_receipts/queue.rs:160` (deployed Rust worker) | `RPOP`/`LPUSH` until the processing list is empty, no cap | Same: 100 items per call, continue from the host, reject identical keys |

## Bounded by data with no enforced size

| Source | Bound today | Change in the port |
|---|---|---|
| `dimabot/src/utils/ai_usage_queue_health.ts:22`, `:28` (and the Rust copies at `ai_usage_receipts/queue.rs:168`, `:179`) | `LREM` scans the whole processing list; normally one item | Keep one in-flight item per worker as an invariant, or bound the claim list |
| `dimabot/src/workers/stream_memory.worker.ts:399` | `LREM` over the processing list; recovery handles only 100 entries per pass | Bound processing membership |
| `dimabot/src/utils/ai/clip_recommendations/clip_recommendation_claims.ts:3`, `:9`, `:16` | `LPOS`/`LREM` over the processing list, normally one claim | Bound processing membership |
| `dimabot/src/utils/tts/tts_session.util.ts:20` | Full `ZRANGE` plus a delete per orphan key; the caller passes keys found with an uncapped `KEYS` (`dimabot/src/utils/speech.ts:21`) | Clean up in bounded batches across calls; make queue admission atomic |
| `dimabot/src/utils/ast_timer_runtime.ts:26` | Two range deletions capped at 10,000 global and 100 per channel | Prune in chunks to shorten shard occupancy |
| `dimabot/src/utils/plan_cache_fence.ts:18` | One `GET` per account passed in; the TypeScript caller passes every cached account with no cap (the Rust port rejects more than 4,096) | Keep the Rust limit; process in batches while preserving the atomic publication |
| `dima-rust/src/utils/twitch_streamers/adapters.rs:254` | Database-wide `SCAN` inside Lua | Not ported (that module is being redone); never `SCAN` inside a script |

Bounded and fine as they are: `dimabot/src/desktop_ai/service.ts:27` (at most 20 members),
`dimabot/src/utils/durable_cron_jobs.ts:14` (`LPOS` with `MAXLEN` 1000),
`dimabot/src/utils/observability/telemetry.ts:173` (list trimmed to 100, payload capped),
`dimabot/src/utils/tts/tts_session.util.ts:29` (caller slices to 128),
`dimabot/src/utils/plan_cache_fence.ts:8` (about 15 fields).

## Other notes

- `TIME` is read once (never used to end a loop) at `dimabot/src/utils/follow_defense_queue.ts:120`
  and `:322`, `dimabot/src/utils/follow_defense_summary.ts:14`, `:106`, `:148`, and
  `dimabot/src/utils/moderation/spam.ts:116`. No Lua random calls and no recursion were found.
- No script reads or writes a key that was not passed in `KEYS`.
- `dimadb/server/redis.mjs:182` lets an operator run arbitrary `EVAL`/`EVALSHA` from the DB console
  (with `confirm=true`). A script typed there has no bound at all.
