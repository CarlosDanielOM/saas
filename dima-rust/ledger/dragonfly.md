# Dragonfly/Redis contract ledger

Generated 2026-11-11T18:21:12Z by `dima-rust/tools/ledger/dragonfly_ledger.py` (branch `rust-v2`). Machine-readable twin: [`dragonfly.json`](dragonfly.json) — every key record there carries every writer/reader/Lua call site as `file:line` with its process.

## Headline

| Item | Count |
|---|---|
| Key patterns (distinct templates) | 217 |
| … shared by more than one runtime process | 151 |
| Rust-library-only keys (not deployed) | 3 |
| Pub/Sub channels | 6 |
| Streams | 1 |
| Queues (list / zset based) | 15 |
| Lua scripts (records; several group identical inline copies) | 64 |
| MULTI/EXEC sites | 12 |
| TS/JS client call sites scanned | 1147 |
| Rust command sites scanned | 66 |
| Unmatched call sites | 0 |

**Coverage method.** scan_ts() finds every node-redis client method call (receiver-filtered for ambiguous names such as get/set/del) in dimabot/src, dima-analytics/src, dimadb/server, dimafx/server/src and dima-hoststats/src (tests excluded); scan_rs() finds every redis::cmd/.cmd/Script::invoke_async site in dima-rust/src (unit-test modules excluded). Every site is classified into a key pattern, a Lua script, a multi-key site, or a non-key operation; unmatched sites are listed. Re-run `python3 dima-rust/tools/ledger/dragonfly_ledger.py --check`. Classification of the 1213 sites: {'key': 945, 'nonkey': 96, 'lua': 77, 'multi': 29, 'rust': 55} ("multi" = one call site touching several patterns; "nonkey" = connection lifecycle, MULTI/EXEC wrappers, pub/sub, in-process Map caches). Reverse check: 13 files obtain a client without issuing commands — Files that obtain or type a Redis client but issue no command themselves; each was read and passes the client to helpers already covered (permissions/roles.ts, billing.ts isAiCreditsExhausted/getAiCredits, pets/tts_lane.ts) or only warms the connection. Process attribution is static import reachability from dimabot/src/server/index.ts (api), bot/index.ts (bot), workers/cron.index.ts and each cron worker entry: "can run in", an over-approximation. Call sites whose key comes from a variable were resolved by reading the code (file-scoped matchers and the TS_MULTI table in the generator). Dynamic keys built by Lua from ARGV do not exist (all scripts use KEYS). dimadb is a generic operator console: it can read/write any key; it is recorded once as dimadb.any.

## Key patterns

Type, TTL and sharing per pattern. `W/R/L` = writer, reader and Lua call-site counts (details in JSON). Processes: see legend at the end.


### `accounts`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `accounts:{platform}:{channelId}:data` | hash | Hash of strings (IUsersCache): id, name, email, plan_tier (free\|premium\|pro), plan_tier_until (JS Date.toDateString(), e.g. "Wed Nov 11 2026", or ""), polar_sh_customer_id, refresh_token / access_token (decrypted plaintext Twitch tokens), expires_at (unix se | none | 12/17/17 | api, bot, cron:*(15 workers), dima-analytics | yes |

### `twitch`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `twitch:accounts` | string | JSON array of VersionedAccount objects (each is an HGETALL object of accounts:twitch:{id}:data, so field order = server HGETALL order) — published by CHECK_PLAN_ACCOUNTS_SCRIPT | EX 3600 (set inside CHECK_PLAN_ACCOUNTS_SCRIPT) | 2/1/17 | api, bot, cron:*(15 workers) | yes |

### `streamers`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `streamers:by:id` | set | members = Twitch channel IDs (decimal strings) | none | 3/1/14 | api, bot, cron:*(15 workers) | yes |
| `streamers:by:name` | set | legacy: members = account names; no current SADD writer (only SREM/DEL) | none | 2/0/10 | api, bot, cron:*(15 workers) | yes |

### `locks`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `locks:refresh:{platform}:{channelId}` | string | lock owner = randomUUID() | PX 5000 (SET NX PX) | 3/5/4 | api, bot, cron:*(15 workers) | yes |
| `locks:polar-ingest:{channelId}` | string | lock owner randomUUID() | PX 8000 (SET NX PX) | 2/2/0 | api, bot, cron:*(15 workers) | yes |
| `locks:ai-usage-write:{sha256hex(JSON.stringify([channelId, customerId]))}` | string | lock owner (TS randomUUID(); Rust "{pid}-{ms}-{objectid}") | EX 120, renewed every 30 s | 2/2/4 | api, bot, cron:*(15 workers), rust:ai-usage-receipts | yes |

### `plan`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `twitch:{channelId}:ai:credits:plan-version` | string | plan version = String(polar_plan_event_at ms).padStart(13,"0") + ":" + polar_plan_event_key; compared with Lua string ">" | none (persistent monotonic fence) | 0/2/16 | api, bot, cron:*(15 workers) | yes |

### `app`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `app:{platform}:token` | string | Twitch app access token (plain) | EX expires_in from Twitch (Number(...)) | 4/3/0 | api, bot, cron:*(15 workers), rust:dashboard-activity | yes |
| `app:twitch:bot` | hash | field access_token = bot user access token | none | 1/0/4 | api, bot, cron:*(15 workers) | yes |

### `auth`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `token:{twitchUserAccessToken}` | hash | fields id, login, display_name, profile_image_url (Twitch /users) | EX 14000 (separate EXPIRE after HSET) | 2/5/0 | api, dima-analytics | yes |
| `twitch:{twitchUserId}:last_app_activity_touch` | string | "1" | EX 86400 (separate EXPIRE) | 2/1/0 | api | no |

### `ai`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `twitch:{channelId}:ai:credits` | string | JSON AiCreditsData {version:3, used, limit, balance, meterId, updatedAt (ISO), available, status ("available"\|"exhausted"\|"unavailable"), __polar_plan_version?}. Re-encoded by Lua cjson.encode in APPLY_AI_CREDIT_USAGE_SCRIPT (key order not preserved, "/" esc | EX 300 (ACCEPT_PLAN_CREDITS_SCRIPT, SYNC_CREDITS_SCRIPT, admin_site.route) or EX 2678400 (31 d, APPLY_AI_CREDIT_USAGE_SCRIPT rewrite) | 3/2/4 | api, bot, cron:*(15 workers) | yes |
| `twitch:{channelId}:ai:exhaust` | string | "true" | none | 4/2/3 | api, bot, cron:*(15 workers) | yes |
| `{channelId}:ai:exhaust` | string | "true" (legacy mirror kept in sync with twitch:{id}:ai:exhaust) | none | 4/2/3 | api, bot, cron:*(15 workers) | yes |
| `twitch:{channelId}:ai:usage-local:{sha256hex(externalId)\|"untracked"}` | string | "1" idempotency marker | EX 2678400 (SET NX EX in APPLY_AI_CREDIT_USAGE_SCRIPT) | 0/0/1 | api, bot, cron:*(15 workers) | yes |
| `twitch:{channelId}:ai:credits:polar-version` | string | String(occurredAt ms).padStart(13,"0") + ":" + eventKey; Lua string ">" ordering | none | 0/0/1 | api, cron:domain-events | yes |
| `twitch:{channelId}:ai:polarshevent` | list | elements = JSON Polar ingest events (legacy: a single JSON-array string, migrated on access via TYPE check) | none | 5/3/0 | api, bot, cron:*(15 workers) | yes |
| `twitch:{channelId}:ai:usage-receipts:generation` | string | integer counter (INCR), "0" assumed when absent | none | 2/1/0 | api, bot, cron:*(15 workers), rust:ai-usage-receipts | yes |
| `twitch:{channelId}:ai:usage-receipts:v2:{generation}:{sha256hex(customerId)[0:16]}:{sha256hex(timeZone)[0:12]}:{sha256hex(startISO\|endISO)[0:12]}:{from}:{to}` | string | JSON array of AI usage transactions | EX 120 | 1/1/0 | api, bot, cron:*(15 workers) | yes |
| `twitch:{channelId}:ai:emotes` | string | JSON string[] | EX 3600 | 1/1/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |

### `billing`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `billing:credit-packs:context:v1:{sha256hex(customerId)[0:20]}` | string | JSON {planTier, expiresAt, version:1} | EX max(1, min(120, seconds until expiresAt)) | 2/1/1 | api, bot, cron:*(15 workers) | yes |

### `q`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `cron:ai-usage-receipts:queue` | list | JSON AI usage receipt + enqueuedAt (ISO) appended last | none | 1/2/3 | api, bot, cron:*(15 workers), rust:ai-usage-receipts | yes |
| `cron:ai-usage-receipts:processing` | list | raw queue elements (byte-identical copies) | none | 0/1/4 | rust:ai-usage-receipts | no |
| `cron:ai-usage-receipts:queue:dead` | list | raw queue elements | none | 0/1/1 | rust:ai-usage-receipts | no |
| `cron:ai-usage-receipts:queue:attempts:{sha256hex(raw element)}` | string | integer attempt counter | EX 604800 (inside Lua) | 0/0/2 | rust:ai-usage-receipts | no |
| `cron:ai-usage-backfills:queue` | list | JSON AiUsageBackfillJob {id, channelID, customerId, planTier, coverageStart, requestedAt, reason, attempts, dedupeKey} | none | 0/2/4 | api, bot, cron:*(15 workers), rust:ai-usage-receipts | yes |
| `cron:ai-usage-backfills:processing` | list | raw queue elements | none | 0/1/4 | cron:ai-usage-backfill, rust:ai-usage-receipts | yes |
| `cron:ai-usage-backfills:dead` | list | raw queue elements | none | 0/1/1 | cron:ai-usage-backfill, rust:ai-usage-receipts | yes |
| `cron:ai-usage-backfills:queue:attempts:{sha256hex(raw element)}` | string | integer attempt counter | EX 604800 (inside Lua) | 0/0/2 | cron:ai-usage-backfill | no |
| `cron:ai-usage-backfills:dedupe:v{AI_USAGE_REPORT_VERSION}:{channelId}:{customerId}` | string | job.id (owner token, released by owner-checked Lua DEL) | EX AI_USAGE_BACKFILL_DEDUPE_SECONDS (default 172800, min 300) | 0/0/4 | api, bot, cron:*(15 workers) | yes |
| `cron:jobs:queue` | list | JSON CronQueueJob {id, job, requestedAt, requestedBy?, userID?, accountID?, channelID?, data?, dedupeKey?} (serializeCronQueueJob = JSON.stringify) | none | 5/2/2 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:follow-ledger, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:stream-memory, cron:temporary-roles, cron:timer, cron:vod-clip-recommender, cron:widgets | yes |
| `cron:jobs:dead-letter` | list | JSON CronQueueJob | none | 2/0/0 | cron:follow-ledger | no |
| `cron:stream-memory:queue` | list | JSON CronQueueJob (from Mongo intent payload when republished) | none | 3/2/2 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:follow-ledger, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:stream-memory, cron:temporary-roles, cron:timer, cron:vod-clip-recommender, cron:widgets | yes |
| `cron:stream-memory:processing` | list | raw queue elements | none | 3/0/1 | cron:stream-memory | no |
| `cron:stream-memory:dead-letter` | list | JSON CronQueueJob | none | 2/0/0 | cron:stream-memory | no |
| `cron:clip-recommendations:queue` | list | JSON CronQueueJob | none | 1/1/5 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:follow-ledger, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:stream-memory, cron:temporary-roles, cron:timer, cron:vod-clip-recommender, cron:widgets | yes |
| `cron:clip-recommendations:processing` | list | raw queue elements | none | 0/0/4 | cron:vod-clip-recommender | no |
| `cron:clip-recommendations:dead-letter` | list | JSON dead-letter payload | none | 1/0/4 | cron:vod-clip-recommender | no |

### `aiusage`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `ai-usage:queue-health:{receipts\|backfills}` | hash | fields processingSince (ms), failures (int, HINCRBY), pendingSince (ms), observedFailures (int). Rust writes pendingSince/observedFailures with f64 Display (integral → no ".0") | none | 2/4/4 | cron:ai-usage-backfill, rust:ai-usage-receipts | yes |
| `ai-usage:queue-health:{name}:snapshot` | string | JSON status {queue,pending,processing,dead,oldestAgeSeconds,processingAgeSeconds,failures,reasons,checkedAt} | EX 300 | 2/1/0 | cron:ai-usage-backfill, rust:ai-usage-receipts | yes |
| `ai-usage:queue-health:{name}:alert` | string | "1" | EX 300 (SET NX) | 2/2/0 | cron:ai-usage-backfill, rust:ai-usage-receipts | yes |

### `lock`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `worker:ai-usage-backfill:consumer` | string | owner "{pid}-{ms}" | EX 120, renewed 30 s | 1/1/2 | cron:ai-usage-backfill | no |
| `worker:ai-usage-backfill:daily-sweep` | string | owner "{pid}-{ms}" | EX AI_USAGE_BACKFILL_SWEEP_LOCK_SECONDS (default 86400) | 1/1/1 | cron:ai-usage-backfill | no |
| `worker:ai-usage-receipts:lock (env AI_USAGE_RECEIPTS_LOCK_KEY)` | string | owner "{pid}-{ms}-{objectid}" | EX lock_ttl_seconds (default 300), renewed | 1/1/2 | rust:ai-usage-receipts | no |
| `worker:stream-memory:lock (env STREAM_MEMORY_WORKER_LOCK_KEY)` | string | owner id | EX 900 default (min 120) | 3/3/1 | cron:stream-memory | no |
| `cron:stream-memory:running:{channelId} (prefix env STREAM_MEMORY_CHANNEL_LOCK_PREFIX)` | string | "{workerOwner}:{claimToken}" | EX 1200 default (min 60), renewed by Lua | 1/1/2 | cron:stream-memory | no |
| `worker:clip-recommendations:lock (env CLIP_RECOMMENDATIONS_WORKER_LOCK_KEY)` | string | owner id | EX 1800 default (min 120), renewed by Lua | 1/1/6 | cron:vod-clip-recommender | no |
| `worker:follow-ledger:daily:lock` | string | runId | EX FOLLOW_LEDGER_LOCK_TTL_SECONDS (default 86400) | 2/2/0 | cron:follow-ledger | no |
| `cron:follow-ledger:running:{channelId}` | string | JSON {reason, at(ISO)} | EX FOLLOW_LEDGER_CHANNEL_LOCK_SECONDS (default 3600, min 300) | 2/1/0 | cron:follow-ledger | no |
| `worker:activation-reminder:lock (env override)` | string | owner id | EX 3600 default (SET NX EX; refreshed by GET+EXPIRE or Lua) | 3/3/0 | cron:activation-reminder | no |
| `worker:eventsub-reconciliation:lock (env override)` | string | owner id | EX 10800 default (SET NX EX; refreshed by GET+EXPIRE or Lua) | 1/2/2 | cron:eventsub-reconciliation | no |
| `worker:follow-defense:lock (env override)` | string | owner id | EX 120 default (SET NX EX; refreshed by GET+EXPIRE or Lua) | 3/3/0 | cron:follow-defense | no |
| `worker:free-credit-reset:lock (env override)` | string | owner id | EX 1800 default (SET NX EX; refreshed by GET+EXPIRE or Lua) | 1/1/2 | cron:free-credit-reset | no |
| `worker:stream-analytics:lock (env override)` | string | owner id | EX 900 default (SET NX EX; refreshed by GET+EXPIRE or Lua) | 3/3/0 | cron:stream-analytics | no |
| `worker:temporary-roles:lock (env override)` | string | owner id | EX 900 default (SET NX EX; refreshed by GET+EXPIRE or Lua) | 3/3/0 | cron:temporary-roles | no |
| `worker:timer:lock (env override)` | string | owner id | EX 900 default (SET NX EX; refreshed by GET+EXPIRE or Lua) | 3/3/0 | cron:timer | no |

### `cronjobs`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `cron:jobs:dedupe:{dedupeToken}` | string | "1" | EX dedupeSeconds (default CRON_JOBS_DEDUPE_SECONDS=900, min 60) | 2/0/6 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:follow-ledger, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:stream-memory, cron:temporary-roles, cron:timer, cron:vod-clip-recommender, cron:widgets | yes |
| `cron:jobs:accepted:{job}:{channelId}:{sessionId}` | string | "1" permanent one-shot acceptance marker | none | 0/3/3 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:follow-ledger, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:stream-memory, cron:temporary-roles, cron:timer, cron:vod-clip-recommender, cron:widgets | yes |

### `obs`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `observability:v1:inbox` | list | JSON telemetry batch {version:1,id,service,instance,at,metrics[],spans[],logs[]} ≤256000 bytes | EXPIRE 3600 on every push; LTRIM 0 99 | 1/2/2 | api, bot, cron:*(19 workers), cron:supervisor, dima-analytics, rust:cron-index (supervisor telemetry) | yes |
| `observability:v1:overflow` | string | integer count of dropped batches (INCRBY) | none | 0/1/2 | api, bot, cron:*(19 workers), cron:supervisor, dima-analytics, rust:cron-index (supervisor telemetry) | yes |
| `observability:v1:processing` | list | raw inbox batch being ingested (one consumer) | none | 3/1/0 | dima-analytics | no |
| `observability:v1:identity:{sha256hex(bearer token)}` | string | JSON {id, login} | EX clamp(expires_in,1,60) | 1/1/0 | dima-analytics | no |
| `observability:v1:infra:latest` | string | JSON {receivedAt, snapshot} | EX 300 | 1/1/0 | dima-analytics | no |

### `logger`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `logger:{platform}:{channelId\|"global"}:{level}:{epochMs}-{suffix}` | string | JSON {data, timestamp (toLocaleString en-US UTC), level, platform, channelId?}; suffix: TS 4 base36 chars, Rust 24-hex ObjectId | EX 604800 (TS: separate EXPIRE after SET; Rust: SET EX) | 4/0/0 | api, bot, cron:*(19 workers), cron:supervisor, rust:ai-usage-receipts | yes |

### `metrics`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `{BOT_METRICS_PREFIX=metrics:bot}:runtime:latest` | string | JSON runtime snapshot | EX BOT_METRICS_TTL_SECONDS (default 172800) | 1/0/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:semantic-moderation, cron:stream-analytics, cron:stream-memory, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `metrics:bot:runtime:history` | list | JSON runtime snapshots, newest first | LTRIM 0 HISTORY_LIMIT-1 (default 5760); EX 172800 | 3/0/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:semantic-moderation, cron:stream-analytics, cron:stream-memory, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `metrics:bot:runtime:cumulative:eventsubByType` | hash | field = EventSub type, value = integer (HINCRBY) | EX 172800 | 2/0/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:semantic-moderation, cron:stream-analytics, cron:stream-memory, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `metrics:bot:runtime:cumulative` | hash | integer counters (HINCRBY) + updatedAt ISO + max* gauges as decimal strings | EX 172800 | 3/0/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:semantic-moderation, cron:stream-analytics, cron:stream-memory, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `metrics:bot:eventsub:minute:{yyyyMMddHHmm UTC}` | hash | total + per-type integer counters | EX 172800 | 3/0/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:semantic-moderation, cron:stream-analytics, cron:stream-memory, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `metrics:bot:runtime:minute:{yyyyMMddHHmm UTC}` | hash | integer counters (messageHandlersStarted, ..., redisOpsEstimated) | EX 172800 | 6/0/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:semantic-moderation, cron:stream-analytics, cron:stream-memory, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `metrics:bot:{semantic\|threading\|stream_memory:job\|stream_memory:action}:{minute:{bucket} \| channel:{channelId}:minute:{bucket} \| cumulative}` | hash | integer counters via HINCRBY (fields e.g. requests, errors, latencyMsTotal, pass:{n}, job:{type}, source:{s}, status:{s}, action:{a}); cumulative also updatedAt ISO | EX 86400 (SEMANTIC_METRICS_TTL_SECONDS) | 56/0/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:semantic-moderation, cron:stream-analytics, cron:stream-memory, cron:temporary-roles, cron:timer, cron:widgets | yes |

### `perf`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `performance:{operation}:metrics[:count\|:success\|:error\|:totalDuration\|:minDuration\|:maxDuration\|:lastUpdated]` | string | integers as decimal strings | EX 86400 | 17/13/0 | — | no |

### `oauth`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `oauth:failures:{api\|token_refresh}:{epochMs}` | string | JSON sanitized failure record | EX 86400 | 2/0/0 | api, bot, cron:*(15 workers) | yes |
| `oauth:rate:{sha256 base64url(bucket)}` | string | integer counter | EX 60 on first INCR | 0/0/1 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `oauth:request:{sha256 base64url(requestId)}` | string | JSON AuthorizationRequest | EX 600 | 2/2/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `oauth:code:{sha256 base64url(code)}` | string | JSON AuthorizationCode | EX 60 | 2/2/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `oauth:access:{sha256 base64url(accessToken)}` | string | JSON AccessIdentity {session_id, user_id, client_id, channel_id, scopes} | EX 600 | 2/3/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |

### `site`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `site:analytics:channels` | hash | fields registered_users, live_users, authorized_accounts, total_messages, total_commands, total_live_viewers, legacy registered/live/active: integers as decimal strings (HSET String(n) / HINCRBY) | none | 20/4/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `site:analytics:live:channels` | string | JSON array of live channel summaries | EX SITE_ANALYTICS_LIVE_CHANNELS_CACHE_TTL_SECONDS (default 60, min 30) | 2/1/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `site:analytics:profile:{channelId}` | string | profile image URL | EX 86400 | 1/1/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `site:analytics:start` | string | "1" (first-run marker) | none | 1/1/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets | yes |

### `cmd`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `{channelId}:commands:{cmd}` | string | JSON command document (lean Mongo doc, ObjectIds as hex strings) | EX 3600 | 18/4/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `{channelId}:commands` | string | legacy (DEL only) | - | 1/0/0 | api, cron:domain-events, cron:stream-analytics | yes |
| `twitch:{channelId}:commands:{cmd}` | string | legacy (DEL only) | - | 2/0/0 | api, bot | yes |
| `command:execution:cooldown:{channelId}:{executionName}` | string | "1" | PX ceil(cooldown*1000) (SET NX PX) | 1/1/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `command-cooldown-write:{channelId}` | string | lock token randomUUID() | EX 60 (SET NX) | 1/1/1 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |

### `kw`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `keywords:index:{channelId}` | string | JSON KeywordEntry[] {id, text, matchMode} | EX 86400 (revision-fenced Lua SET) | 1/1/2 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `keywords:revision:{channelId}` | string | integer counter (INCR); "0" when absent | none | 0/2/2 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `keywords:body:{channelId}:{commandId}` | string | JSON keyword command body | EX 30 (revision-fenced Lua SET) | 2/1/2 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |

### `chat`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `{platform}:{channelId}:chat:history` | list | JSON {username, message, timestamp, messageID, badges}, newest first | none; LTRIM 0 99 | 3/1/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets | yes |

### `ast`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `{platform}:{channelId}:variable:{name}[:id:{userId} \| :login:{lowercased login}]` | string | variable value as the evaluator's string (arrays as JSON) | EX 86400 (separate EXPIRE after SET) | 7/3/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `ast:timers:pending` | zset | member = timer job id (UUID), score = dueAt epoch ms | none | 2/1/2 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `ast:timers:job:{id}` | string | JSON AstTimerJob {version:1,id,dueAt,expiresAt,body,context} ≤64 KiB | PXAT expiresAt | 0/1/2 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `ast:timers:channel:{channelId}` | zset | member = job id, score = expiresAt ms | PEXPIREAT max score | 0/0/2 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `ast_catalog:vectors:v1:{sha256hex(JSON.stringify([model, dim, texts]))[0:24]}` | string | serialized Float32 vectors | EX 2592000 | 1/1/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |

### `timer`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `timer:active` | set | members = channel IDs with live timers | none | 7/6/0 | api, bot, cron:domain-events, cron:stream-analytics, cron:timer | yes |
| `timer:channel:{channelId}:timers` | hash | field = timer _id (hex), value = JSON timer document (timer.toObject()) | none | 14/3/0 | api, bot, cron:domain-events, cron:stream-analytics, cron:timer | yes |
| `timer:channel:{channelId}:heartbeat:{timerId}` | string | integer as decimal string | none | 17/2/0 | api, bot, cron:domain-events, cron:stream-analytics, cron:timer | yes |
| `timer:channel:{channelId}:heartbeat-unit:{timerId}` | string | TIMER_FREQUENCY_UNIT constant | none | 17/2/0 | api, bot, cron:domain-events, cron:stream-analytics, cron:timer | yes |

### `follows`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `{channelId}:follows:count` | string | integer counter (INCR; legacy follow.handler GET/SET) | none | 2/1/1 | api, bot, cron:domain-events, cron:stream-analytics | yes |
| `{channelId}:follows:event:{eventKey}` | string | assigned count (tostring) | EX 172800 | 0/0/1 | api, cron:domain-events | yes |

### `eventsub`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `twitch:eventsub:message:{messageId}` | string | ISO timestamp | EX TWITCH_EVENTSUB_MESSAGE_TTL_SECONDS (default 600, min 300) (SET NX) | 1/1/0 | bot | no |

### `stream`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `twitch:{channelId}:stream.online:{streamId}` | string | started_at ISO | EX STREAM_ONLINE_DEDUPE_TTL_SECONDS (default 86400) (SET NX) | 1/1/0 | api, bot | yes |

### `onlyemotes`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `{channelId}:chat:onlyemotes` | string | status value (number/bool as string) | EX 3600 | 3/1/0 | api, bot | yes |

### `sumimetro`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `{channelId}:sumimetro:{lowercased login}` | string | number as string | EX 72000 | 2/3/0 | api, bot, cron:domain-events, cron:stream-analytics | yes |
| `{channelId}:sumimetro:{dominant\|submissive}` | hash | fields user, value | none | 8/2/0 | api, bot | yes |

### `roulette`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `{channelId}:roulette:{userId}` | string | integer counter | none | 3/2/0 | api, bot | yes |
| `{channelId}:roulette:{userId}:died` | string | integer counter | EX 600 | 3/2/0 | api, bot | yes |

### `promo`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `{channelId}:clip:connected \| {channelId}:clips:queue \| {channelId}:clip:playing \| {channelId}:clips:queue:first` | mixed | legacy promo command keys: clip:connected read only, clips:queue list RPUSH (no consumer found), clip:playing "true", clips:queue:first login | none | 3/3/0 | api, bot | yes |

### `clips`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `twitch:{channelId}:clips:connected` | string | "true" | none | 5/1/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `twitch:{channelId}:clips:last_activity` | string | epoch ms (Date.now()) | none | 3/1/0 | api | no |
| `twitch:{channelId}:clips:queue:data:{clipId}` | string | JSON ClipRequestData | none | 4/3/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `twitch:{channelId}:clips:queue` | zset | member = clipID, score = enqueue time ms | none | 4/5/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `twitch:{channelId}:clip:processing` | string | "true" | none | 6/3/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `twitch:{channelId}:clips:timeouts:default` | string | timeout seconds from overlay query param | none | 2/1/0 | api | no |
| `twitch:{channelId}:clips` | string | JSON Twitch clips array | EX 18000 (CLIP_CACHE_TTL_HOURS=5) | 1/1/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `twitch:{channelId}:clips:shown` | set | shown clip IDs | EX 86400 | 5/2/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |

### `triggers`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `twitch:{channelId}:triggers:connected` | string | "true" | none | 3/0/0 | api | no |
| `twitch:{channelId}:triggers:last_activity` | string | epoch ms | none | 2/1/0 | api | no |

### `tts`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `twitch:{channelId}:tts:queue` | zset | member = speechID, score = item.timestamp (ms) | none | 9/12/3 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets, dima-analytics | yes |
| `twitch:{channelId}:tts:queue:data:{speechId}` | string | JSON TTS queue item + queueSession (re-encoded by Lua cjson in ENQUEUE) | none | 8/4/4 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `twitch:{channelId}:tts:processing` | string | speechID or "pending" | EX 150 (TTS_PROCESSING_TTL_SECONDS) | 13/5/1 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `twitch:{channelId}:tts:session` | string | session UUID | none | 0/5/3 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `twitch:{channelId}:tts:connected` | string | "true" | none | 4/1/1 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `twitch:{channelId}:tts:last_cleanup` | string | epoch ms | none | 2/1/1 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `{channelId}:tts:usage` | hash | fields {provider}_characters/_credits/_cost (cost = round(usd*1e5)), total_characters, total_credits (HINCRBY integers) | EXPIRE seconds to next month | 6/0/0 | api | no |
| `twitch:global:tts:emotes` | string | JSON string[] | EX 3600 (success) / 60 (failure) | 1/1/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `tts:preview:ticket:{ticket}` | string | channelID | EX 30 (GETDEL consumer) | 2/1/0 | api | no |
| `tts:preview:lock:{channelId}` | string | lock UUID | EX 120 | 1/1/2 | api | no |
| `tts:preview:cooldown:{channelId}` | string | "1" | EX 8 (SET NX) | 1/1/0 | api | no |

### `chatbot`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `{channelId}:chatbot:usage` | hash | total_tokens, prompt_tokens, completion_tokens (HINCRBY) | EXPIRE seconds to next month | 8/0/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `{channelId}:chatbot:response:last` | string | JSON {messageData:{content}, usageData, model, timestamp} | none | 2/0/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `twitch:{channelId}:chatbot:personality` | string | JSON personality document | EX 10800 (SETEX) | 5/2/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |

### `mods`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `twitch:{channelId}:moderators` | string | JSON moderators response | EX 7200 | 4/3/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `twitch:{channelId}:moderators:ids` | set | moderator user IDs | EX 7200 | 8/3/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `twitch:{channelId}:moderators:logins` | set | moderator logins | EX 7200 | 8/3/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `twitch:{channelId}:moderators:mapping` | hash | login → user ID | EX 7200 | 8/1/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |

### `channel`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `channel:data:{channelId}` | string | JSON Twitch channel information | EX 10800 | 1/1/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |

### `polls`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `twitch:{channelId}:polls` | string | JSON poll data | none | 3/1/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |

### `predictions`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `twitch:{channelId}:predictions` | string | JSON prediction data | none | 3/1/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |

### `roles`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `twitch:{channelId}:editors` | set | lowercased editor logins | EX 86400 | 3/2/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:semantic-moderation, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `twitch:{channelId}:editors:ids` | set | editor user IDs | EX 86400 | 3/1/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:semantic-moderation, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `{channelId}:channel:editors` | set | legacy (DEL only) | - | 1/0/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:semantic-moderation, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `twitch:{channelId}:admins` | set | lowercased admin logins | none | 4/2/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:semantic-moderation, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `twitch:{channelId}:admins:ids` | set | admin user IDs | none | 4/1/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:semantic-moderation, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `twitch:{channelId}:admins:{adminId}` | hash | fields adminID, adminName (lowercased), channelID, channelName, permissions (JSON array), actived ("true"\|"false") | none | 5/6/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:semantic-moderation, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets | yes |

### `mod`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `moderation:{channelId}:settings` | string | JSON moderation settings doc or sentinel {"none":true} | EX 300 | 4/3/0 | api, bot | yes |
| `moderation:{channelId}:message:{messageId}` | string | "1" receipt | EX 86400 (SET NX) | 1/1/0 | api, bot | yes |
| `moderation:{channelId}:offenses:{ruleId}:{userId}` | string | integer counter | EXPIRE max(60, windowSeconds) on first increment | 2/0/1 | api, bot | yes |
| `moderation:offense-receipt:{decisionId}` | string | assigned count | EX 86400 | 0/0/1 | api, bot | yes |
| `moderation:{channelId}:permit:{user:{lowercased login} \| channel}` | string | expiry epoch ms as string | EX seconds | 1/2/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `moderation:{channelId}:notice:{userId}` | string | "1" | EX 60 (SET NX) | 1/1/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `moderation:seen:{sha256hex(JSON.stringify([channelId, userId]))}` | string | "1" | EX 86400 | 1/1/0 | api, bot, cron:semantic-moderation | yes |
| `moderation:spam-budget:{channel:{channelId} \| global}` | hash | fields window (unix minute), count | EX 120 | 0/0/1 | api, bot, cron:semantic-moderation | yes |
| `moderation:{channelId}:{variation-words\|variation-jobs}` | string | integer counters | EX 86400 on first increment | 0/0/1 | api, cron:semantic-moderation | yes |
| `twitch:moderation:banmod:restore:queue` | zset | member = jobId, score = due epoch ms | none | 3/1/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `twitch:moderation:banmod:restore:data:{jobId}` | string | JSON restore job payload | EX 691200 (MAX_TIMEOUT_SECONDS+86400) | 6/1/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |

### `fd`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `twitch:{channelId}:follow-defense:settings` | string | JSON FollowDefenseRuntimeSettings | none | 2/2/1 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `twitch:{channelId}:follow-defense:state` | string | JSON FollowDefenseState {mode, channelID, channelLogin, channelName, modeStartedAt, burstStartedAt, expiresAt, version, ...} (re-encoded by Lua cjson) | none | 1/3/3 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets, rust:raid-sessions | yes |
| `twitch:{channelId}:follow-defense:recent` | zset | member = follow eventID, score = followedAt ms | none (ZREMRANGEBYSCORE retention 300 s) | 2/1/0 | api, cron:domain-events, cron:follow-defense | yes |
| `(generic ZCOUNT / ZREMRANGEBYSCORE helpers via sendCommand; called with fd.recent and fd.tracked)` *(access path)* | zset | see fd.recent / fd.tracked | - | 2/2/0 | api, cron:domain-events, cron:follow-defense | yes |
| `twitch:{channelId}:follow-defense:tracked` | zset | member = eventID, score = ms | none | 3/2/1 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `twitch:{channelId}:follow-defense:follow:{eventId}` | string | JSON FollowDefenseFollowPayload | EX FOLLOW_DEFENSE_FOLLOW_DATA_TTL_SECONDS (default 86400) | 1/2/0 | api, cron:domain-events, cron:follow-defense | yes |
| `twitch:{channelId}:follow-defense:ban:{eventId}` | string | JSON BanCacheResult (read only; no current writer found) | unknown | 0/1/0 | api, cron:domain-events, cron:follow-defense | yes |
| `twitch:{channelId}:follow-defense:completed:{eventId}` | string | "1" receipt | EX 86400 | 1/1/0 | api, cron:domain-events, cron:follow-defense | yes |
| `twitch:{channelId}:follow-defense:summary` | string | JSON {id, count, notBefore, startedAt, lastAt, attack} (cjson) | EX 172800 | 1/0/4 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `twitch:{channelId}:follow-defense:summary-lock` | string | token UUID | EX 120 | 1/0/2 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `twitch:{channelId}:follow-defense:suppressed:{sha256hex(eventId)}` | string | "1" | EX 172800 | 0/0/1 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `twitch:{channelId}:follow-defense:raid` | string | JSON FollowDefenseRaidMarker | PXAT marker.expiresAt | 0/2/1 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `twitch:{channelId}:follow-defense:raid-projection` | string | last raidStartedAt (ms) as string | EX 259200 | 0/0/1 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `twitch:follow-defense:summaries` | zset | member = channelId, score = notBefore ms | none | 1/1/3 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `twitch:follow-defense:active-channels` | zset | member = channelId, score = state.expiresAt ms | none | 1/1/1 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `twitch:follow-defense:queue` | zset | member = eventID, score = due ms | none | 6/1/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `twitch:follow-defense:queue:data:{eventId}` | string | JSON FollowDefenseQueueEvent {type:"follow"\|"manual_attack", payload} | EX 86400 | 4/1/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `follow:defense:baseline:{channelId}` | string | JSON DefenseBaseline {calculatedAt, averageDaily, averageStream, sampleDays, streamCount, excludedDays, attackThreshold} | EX 604800 | 2/1/0 | api, cron:domain-events, cron:follow-defense, rust:follow-defense-baseline | yes |
| `follow:defense:baseline:{channelId}:requested` | string | "1" | EX 60 (SET NX) | 1/1/0 | api, cron:domain-events, cron:follow-defense | yes |
| `follow:defense:baseline:due` | zset | member = channelId, score = due epoch ms (ZADD LT on request) | none | 4/2/1 | api, cron:domain-events, cron:follow-defense, rust:follow-defense-baseline | yes |

### `emote`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `twitch:{channelId}:emote-catalog:v1` | string | JSON CachedCatalog {emotes:[{id,name}], checkedAt (ISO\|null), retryAt (ms)} | EX 86400 | 3/2/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets, rust:dashboard-activity | yes |

### `docs`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `site_agent:docs:vec:{lang}:{hashText(model\|format\|text, 24)}` | string | base64 of little-endian Float32Array (LFM2_EMBEDDING_DIM*4 bytes) | EX 2592000 | 1/1/0 | api | no |
| `docs_assistant:stats:{YYYY-MM-DD UTC}` | hash | HINCRBY integers asked, answered, tool_calls, input_tokens, cache_read_tokens, output_tokens, cost_micro_usd, failed, failed_{kind}, helpful, unhelpful | EX 10368000 (120 d) | 10/0/0 | api | no |
| `docs_assistant:answer:{uuid}` | hash | fields at, lang, page, turn, question, answer, sources (JSON), duration_ms, input_tokens, output_tokens, cost_usd (toFixed(6)), stop_reason, rounds, tool_calls (JSON), feedback (HSETNX) | EX 2592000 | 3/1/0 | api | no |
| `docs_assistant:recent` | list | answer IDs, newest first | none; LTRIM 0 999 | 2/0/0 | api | no |

### `thread`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `twitch:{channelId}:ai:threads:active` | zset | member = threadID, score = last activity ms | EX 86400 | 3/4/0 | api, bot | yes |
| `twitch:{channelId}:ai:user:{userId}:threads` | zset | member = threadID, score = ms | EX 86400 | 3/4/0 | api, bot | yes |
| `twitch:{channelId}:ai:thread:{threadId}:meta` | string | JSON thread meta | EX 86400 | 3/1/0 | api, bot | yes |
| `twitch:{channelId}:ai:thread:{threadId}:turns` | list | JSON turns, newest first | EX 86400; LTRIM maxTurnsStored | 4/1/0 | api, bot | yes |

### `sa`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `site_agent:s:{sessionId}` | string | JSON SessionMeta | EX 259200 | 6/4/1 | api | no |
| `site_agent:s:{sessionId}:items` | hash | field = itemId, value = JSON item | EX 259200 | 7/3/0 | api | no |
| `site_agent:s:{sessionId}:items:order` | list | item IDs in order | EX 259200 | 6/2/0 | api | no |
| `site_agent:s:{sessionId}:ctx` | string | JSON context array ("[]" initially) | EX 259200 | 7/2/1 | api | no |
| `site_agent:s:{sessionId}:queue` | list | JSON queued user inputs | EX 259200 | 8/4/0 | api | no |
| `site_agent:sessions:{channelId}:{userId}` | zset | member = sessionId, score = last activity ms | EX 259200 | 7/5/0 | api | no |
| `site_agent:t:{turnId}` | hash | fields rev (integer string), json (JSON TurnRecord) | EX 259200 | 2/1/1 | api | no |
| `site_agent:t:{turnId}:ev` | stream | entries with single field e = JSON AgentEvent | EX 7200 after each XADD; MAXLEN ~ 4000 | 2/3/0 | api | no |
| `site_agent:lease:{sessionId}` | string | fencing token | PX 60000 (SET NX PX; renewed by Lua PEXPIRE) | 1/2/4 | api | no |
| `site_agent:active` | set | active turn IDs | none | 2/1/0 | api | no |
| `site_agent:daily:{channelId}:{YYYY-MM-DD UTC}` | string | integer counter | EX 172800 (inside TAKE Lua) | 1/2/2 | api | no |
| `site_agent:stats:{YYYY-MM-DD UTC}` | hash | HINCRBY integers (steps, compactions, plan_{tier}_steps, *_tokens, cost_micro_usd, turns, turns_{status}, tool_calls, duration_ms_total, messages, helpful, unhelpful, ...) | EX 10368000 | 18/0/0 | api | no |
| `site_agent:feedback:{turnId}` | hash | fields rating (HSETNX), at | EX 2592000 | 3/0/0 | api | no |
| `site_agent:polar:retry` | list | JSON Polar events awaiting retry | EX 604800; LTRIM -5000 -1 | 4/1/0 | api | no |
| `site_agent:reconcile` | list | JSON reconcile items | EX 86400; LTRIM -5000 -1 | 7/1/0 | api | no |
| `site_agent:prefs:{channelId}:{userId}` | hash | field persona = "1"\|"0" | none | 2/2/0 | api | no |
| `site_agent:req:{userId}:{requestId}` | string | JSON {fingerprint, state:"pending"\|"done", result?} | EX 600 | 3/2/0 | api | no |

### `desk`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `desktop:speech:slot:{channelId}` | string | JSON Stored speech activity {channelId, playbackId, outputGeneration, source, expiresAt, fence, phase, retiredProof?} (re-encoded by Lua cjson) | PX duration+30000 (Lua) | 0/4/8 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `desktop:speech:revision:{channelId}` | string | integer counter | EXPIRE 86400 (Lua) | 0/0/8 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `desktop-ai:queue:{ownerUserId}` | zset | member = "{clientId}:{requestId}", score = expiry ms | PX 7200000 | 3/0/1 | api | no |
| `desktop-ai:owner:{ownerUserId}` | string | lease token UUID | PX RUN_TIMEOUT+30000 (330000) | 1/2/2 | api | no |
| `desktop-ai:ticket:{turnId}` | string | audio ticket (base64url 32 bytes) | PX 20000 | 4/1/0 | api | no |

### `pet`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `pet:audio:{sha256hex(ticket)}` | string | JSON {ownerId, peerId, requestId, generation, leaseId, tokenHash, sessionId, expiresAt} | EX 5 | 1/1/0 | api | no |

### `overlay`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `overlay:test:{channelId}` | string | owner UUID | EX 120 (SET NX), shortened to 3 s on release | 1/1/1 | api | no |

### `widget`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `widget-feed:demand:{channelId}` | string | "1" | EX 60 (DEMAND_TTL_SECONDS, overlays/live.ts:45) | 1/1/0 | api, bot | yes |
| `widget-signal:rate:{channelId}` | string | integer counter | EX 10 (repaired if TTL<0) | 0/0/1 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `widget-signal:skipped:{channelId}` | string | integer counter | EX 600 | 0/1/1 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |
| `widget-signal:seen:{actionKey = "signal:v1:" + sha256hex(JSON.stringify([originId, path, n]))}` | string | "1" | EX 86400 (SET NX) | 1/1/0 | api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets | yes |

### `duel`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `widgets:duel:{channelId}:connected` | string | JSON {hash (overlay token hash), at (ms)} | EX 5 | 5/1/0 | api, bot, cron:duel | yes |

### `ratelimit`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `ratelimit:{scope}:{sha256 base64url(subject)}` | string | integer counter | EX windowSeconds on first INCR | 0/0/1 | api | no |

### `temproles`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `twitch:temporary-roles:pending-announcements:{channelId}` | list | JSON pending announcement payloads | EX 1209600 | 3/1/0 | cron:temporary-roles | no |

### `dimadb`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `(any key — dimadb operator console)` *(access path)* | any | generic SCAN/TYPE/TTL/GET/SET/DEL/HGETALL/LRANGE/XRANGE and raw sendCommand (dangerous commands need confirm) | - | 23/16/0 | dimadb (operator console, arbitrary keys) | no |

### `analytics`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `twitch:{channelId}:{tts\|clips}:queue (SCAN MATCH twitch:*:*:queue)` *(access path)* | zset | read-only depth sampling | - | 0/1/0 | dima-analytics | no |

### `rs`

| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |
|---|---|---|---|---|---|---|
| `streamers:directory:revision` *(Rust library only)* | string | directory revision token (Rust library only; TS never writes or checks it) | none | 0/0/10 | — | no |
| `streamers:directory:generation:{channelId}` *(Rust library only)* | string | per-account generation fence (Rust library only; TS never maintains it) | none | 0/1/14 | — | no |
| `locks:streamers:reconcile` *(Rust library only)* | string | reconcile lease owner (Rust library only) | set by library | 0/0/10 | — | no |

## Cross-process flows

### Queues

- **cron:jobs:queue (+ cron:jobs:dead-letter, cron:jobs:dedupe:*, cron:jobs:accepted:*)** (list)
  - produce: api/bot/cron via utils/cron_jobs_queue.ts enqueueCronJob: Lua ENQUEUE_DEDUPLICATED_JOB (LPUSH) or plain LPUSH (:170)
  - produce: follow_ledger.worker.ts:158 RPUSH (requeue)
  - consume: cron:follow-ledger (workers/follow_ledger.worker.ts:165) BLPOP cron:jobs:queue 5 s on the shared command connection; only job "follow-ledger-sync" is processed, others RPUSHed to cron:jobs:dead-letter
  - semantics: LPUSH + BLPOP = LIFO for fresh jobs; requeues go to the tail (RPUSH). No processing list: a crash after BLPOP loses the job (dedupe marker expires). Channel lock cron:follow-ledger:running:{c}.
- **cron:stream-memory:queue → cron:stream-memory:processing (dead: cron:stream-memory:dead-letter)** (list + processing list + Mongo CronJobIntent)
  - produce: enqueueCronJob durable path → durable_cron_jobs.ts PUBLISH_DURABLE_CRON_JOB (LPUSH if LPOS miss)
  - produce: stream_memory.worker.ts:200 RPUSH requeue
  - consume: cron:stream-memory (workers/stream_memory.worker.ts:372) BLMOVE queue processing LEFT RIGHT 5 s via sendCommand on the shared connection, then LREM processing 1 raw on success
  - semantics: Head pop after LPUSH = LIFO. Recovery RPOPLPUSH processing → queue (≤100) between jobs while holding worker:stream-memory:lock. Mongo intent claim is authoritative; Redis is transport.
- **cron:clip-recommendations:queue → :processing (dead: :dead-letter)** (list + processing list + Mongo CronJobIntent)
  - produce: enqueueCronJob durable path → PUBLISH_DURABLE_CRON_JOB (LPUSH)
  - produce: CLIP_CLAIM_SCRIPTS.requeue (LPUSH)
  - consume: cron:vod-clip-recommender (workers/vod_clip_recommender.worker.ts:296) BLMOVE queue processing RIGHT LEFT (FIFO), ack/requeue/dead-letter via owner-fenced Lua (CLIP_CLAIM_SCRIPTS)
  - semantics: Every transition is fenced by worker:clip-recommendations:lock value; recover = RPOPLPUSH processing → queue.
- **cron:ai-usage-receipts:queue → :processing (dead: :queue:dead, attempts: :queue:attempts:{sha256})** (list + processing list)
  - produce: dimabot/src/utils/ai_usage_ledger.ts:115 RPUSH (api/bot/cron)
  - produce: fail Lua RPUSH requeue
  - consume: rust:ai-usage-receipts (dima-rust/src/workers/ai_usage_receipts/queue.rs:164 claim Lua LPOP→RPUSH processing; complete/fail Lua). TypeScript consumer code still exists in ai_usage_queue_health.ts helpers.
  - semantics: FIFO. Poll (no blocking op). Max 3 attempts (1 for invalid JSON). Startup reclaim RPOP processing → LPUSH queue. Single consumer guarded by worker:ai-usage-receipts:lock.
- **cron:ai-usage-backfills:queue → :processing (dead: :dead, dedupe: :dedupe:v{n}:{c}:{cust})** (list + processing list)
  - produce: utils/ai_usage_backfill_queue.ts ENQUEUE_SCRIPT (SET NX dedupe + RPUSH)
  - consume: cron:ai-usage-backfill (claimUsageJob → LPOP/RPUSH Lua, poll loop) guarded by worker:ai-usage-backfill:consumer
  - semantics: FIFO; startup RECLAIM LPOP processing → LPUSH queue; dedupe key released by owner-checked DEL with value job.id.
- **observability:v1:inbox → observability:v1:processing** (list)
  - produce: every TS process telemetry.ts flushTelemetry (Lua ENQUEUE: LPUSH, LTRIM 0 99, overflow INCRBY)
  - produce: rust cron-index supervisor telemetry (same Lua)
  - consume: dima-analytics/src/index.mjs:142 LINDEX processing 0 else LMOVE inbox processing RIGHT LEFT; LREM processing 1 raw after ingest
  - semantics: FIFO, bounded to 100 batches, single consumer.
- **twitch:follow-defense:queue (+ :queue:data:{eventId})** (zset delay queue)
  - produce: utils/follow_defense_queue.ts:232 ZADD score now (api/bot)
  - consume: cron:follow-defense processFollowDefenseQueue (utils/follow_defense.ts:497) ZRANGEBYSCORE 0 now, first 50; ZREM+DEL on success, ZADD now+5000 on failure
  - semantics: at-least-once; no lease (single worker lock worker:follow-defense:lock).
- **twitch:moderation:banmod:restore:queue (+ :data:{jobId})** (zset delay queue)
  - produce: utils/ast_parser/functions/moderation.functions.ts:86/168 ZADD
  - consume: same file :114 ZRANGEBYSCORE 0 now; claim by ZREM result == 1
  - semantics: ZREM-as-claim gives single delivery across processes.
- **follow:defense:baseline:due** (zset schedule)
  - produce: utils/follow_defense_baseline.ts:34 ZADD LT score now (request)
  - consume: rust:follow-defense-baseline (workers/follow_defense_baseline.rs:285 ZRANGE 0 0 WITHSCORES; rescore +60 s before work, +3600 s after)
  - semantics: TS processDefenseBaseline is dead code; Rust owns consumption.
- **ast:timers:pending (+ ast:timers:job:{id}, ast:timers:channel:{c})** (zset schedule)
  - produce: utils/ast_timer_runtime.ts ENQUEUE Lua
  - consume: AstTimerScheduler (bot) reconcile every 2 s + CLAIM Lua (at-most-once)
  - semantics: Claim deletes before execution.
- **twitch:{c}:tts:queue (+ :queue:data:{id}, :processing, :session)** (zset per channel)
  - produce: tts_queue.handler.ts:250 / pets/tts_lane.ts:43 → tts ENQUEUE Lua
  - consume: api TtsQueueHandler (POP Lua; processing marker SET EX 150)
  - semantics: Session-fenced; RESET from cron:domain-events then pub/sub tts:session-ended:v1.
- **twitch:{c}:clips:queue (+ :queue:data:{clipID})** (zset per channel)
  - produce: functions/clips/queue.clip.ts:76 (bot command) and clip_queue.handler.ts:67
  - consume: api ClipQueueHandler ZPOPMIN
  - semantics: Wake-up via pub/sub twitch:{c}:clip:request.
- **desktop-ai:queue:{owner}** (zset slot reservation)
  - produce: desktop_ai/service.ts reserveQueueScript
  - consume: same (ZREM on finish)
  - semantics: bounded outstanding requests (20) per owner.
- **site_agent:s:{id}:queue, site_agent:polar:retry, site_agent:reconcile** (list)
  - produce: site_agent/store.ts:297 RPUSH
  - produce: site_agent/usage.ts:139/262/325 RPUSH (MULTI with LTRIM, EXPIRE)
  - consume: site_agent/store.ts:307 LPOP / :313 MULTI LRANGE+DEL; usage.ts:198/289 LPOP count
  - semantics: api-internal.
- **twitch:temporary-roles:pending-announcements:{c}** (list)
  - produce: utils/temporary_roles_announcements.ts:53 RPUSH
  - consume: :93 LRANGE then DEL
  - semantics: read-all-then-delete (not atomic).

### Streams

- **site_agent:t:{turnId}:ev** — write: dimabot/src/site_agent/store.ts:329 (appendEvent, api); XADD: XADD key MAXLEN ~ 4000 * e <JSON AgentEvent> (node-redis TRIM {strategy:MAXLEN, strategyModifier:"~", threshold:4000}); EXPIRE 7200 after each add
  - read: dimabot/src/site_agent/store.ts:349,353 XRANGE (eventsAfter: cursor-exclusive replay, gap detection by first id)
  - read: dimabot/src/site_agent/store.ts:252 XREVRANGE + - COUNT 1 inside MULTI (snapshot last event id)
  - consumer groups: none (no XREADGROUP/XACK/XCLAIM anywhere); readers poll XRANGE plus an in-process EventEmitter bus; dead letter: none. Stream ids compared numerically by compareIds (ms-seq). Only stream in the system.

### Pub/Sub channels

- **twitch:{channelId}:clip:request** — payload: JSON ClipRequestData {clipID, streamerLogin, duration, clipUrl, title, game, streamer, profileImage, description, streamerColor, timestamp} + timestamp added by PubSubManager.publish
  - publish: dimabot/src/functions/clips/queue.clip.ts:81 (PubSubManager.publishClipRequest)
  - subscribe: dimabot/src/handlers/clip_queue.handler.ts:41 (PubSubManager.subscribeToClipRequests, per channel)
  - connection: PubSubManager dedicated publisher/subscriber connections (client.duplicate())
- **tts:session-ended:v1** — payload: JSON {channelID, session, timestamp}
  - publish: dimabot/src/utils/speech.ts:29 (clearSpeechFiles; called by domain_events/stream_operations_events.ts:143)
  - subscribe: dimabot/src/server/index.ts:99 (api; validates /^\d{1,30}$/ channelID, session ≤64 chars)
  - connection: PubSubManager
- **widget-feed** — payload: JSON WidgetFeedMessage {channel, type: "chat"|"chat.delete"|"chat.clear"|"signal"|session refresh types, data} + timestamp
  - publish: dimabot/src/widget_feed/publisher.ts:49/66 (chat events, gated by widget-feed:demand:{c})
  - publish: dimabot/src/widget_feed/signals.ts:64 (signals)
  - publish: dimabot/src/widget_feed/session-refresh.ts:9
  - subscribe: dimabot/src/overlays/live.ts:278 (api overlay sockets)
  - connection: PubSubManager
- **keywords:changed** — payload: JSON {channelID} (published raw on the shared command client — no timestamp field)
  - publish: dimabot/src/utils/keyword_cache.ts:47 (refreshKeywordIndex)
  - subscribe: dimabot/src/utils/keyword_cache.ts:32 (PubSubManager.subscribe; invalidates in-memory index)
  - connection: publish: getDragonflyClient main connection; subscribe: PubSubManager
- **domain-events:wakeup:v1** — payload: "1" (hint only; Mongo polling is the fallback)
  - publish: dimabot/src/utils/domain_event_wakeups.ts:100 (domainEventWakeups.publish(), called from utils/domain_events.ts:143)
  - subscribe: dimabot/src/workers/domain_events.worker.ts:117 (DomainEventWakeups with onWake)
  - connection: Dedicated short-lived client per DomainEventWakeups: disableOfflineQueue, reconnectStrategy false, commandsQueueMaxLength 4, idle close after 30 s; DOMAIN_EVENTS_WAKEUPS_ENABLED=false disables
- **pet:runtime:wake:v1** — payload: JSON array of owner ObjectId hex strings (≤64)
  - publish: dimabot/src/pets/wakeups.ts:24 (PetWakeupPublisher.notify)
  - subscribe: dimabot/src/pets/runtime.ts:420 (subscribePetWakeups)
  - subscribe: dimabot/src/desktop_ai/activity.ts:322 (subscribePetWakeups)
  - connection: DomainEventWakeups machinery with the PET_WAKE topic

### Shared keys by producer → consumer (highlights)

- `accounts:{platform}:{channelId}:data`: written by api, bot, cron:*(15 workers), cron:domain-events; read by api, bot, cron:*(15 workers), dima-analytics
- `twitch:accounts`: written by api, bot, cron:*(15 workers), cron:domain-events; read by api, bot, cron:*(15 workers)
- `streamers:by:id`: written by api, bot, cron:*(15 workers); read by api, bot, cron:*(15 workers)
- `streamers:by:name`: written by api, bot, cron:*(15 workers); read by (only inside Lua)
- `locks:refresh:{platform}:{channelId}`: written by api, bot, cron:*(15 workers); read by api, bot, cron:*(15 workers)
- `twitch:{channelId}:ai:credits:plan-version`: written by api, bot, cron:*(15 workers), cron:domain-events; read by api, bot, cron:*(15 workers)
- `app:{platform}:token`: written by api, bot, cron:*(15 workers), rust:dashboard-activity; read by api, bot, cron:*(15 workers), rust:dashboard-activity
- `app:twitch:bot`: written by api, bot, cron:*(15 workers); read by (only inside Lua)
- `token:{twitchUserAccessToken}`: written by api; read by api, dima-analytics
- `twitch:{channelId}:ai:credits`: written by api, bot, cron:*(15 workers), cron:credit-gifts, cron:domain-events, cron:free-credit-reset; read by api, bot, cron:*(15 workers)
- `twitch:{channelId}:ai:exhaust`: written by api, bot, cron:*(15 workers), cron:domain-events, cron:free-credit-reset; read by api, bot, cron:*(15 workers)
- `{channelId}:ai:exhaust`: written by api, bot, cron:*(15 workers), cron:domain-events, cron:free-credit-reset; read by api, bot, cron:*(15 workers)
- `twitch:{channelId}:ai:usage-local:{sha256hex(externalId)|"untracked"}`: written by api, bot, cron:*(15 workers); read by (only inside Lua)
- `twitch:{channelId}:ai:credits:polar-version`: written by api, cron:domain-events; read by (only inside Lua)
- `billing:credit-packs:context:v1:{sha256hex(customerId)[0:20]}`: written by api, bot, cron:*(15 workers), cron:domain-events; read by api, bot, cron:*(15 workers)
- `twitch:{channelId}:ai:polarshevent`: written by api, bot, cron:*(15 workers); read by api, bot, cron:*(15 workers)
- `locks:polar-ingest:{channelId}`: written by api, bot, cron:*(15 workers); read by api, bot, cron:*(15 workers)
- `twitch:{channelId}:ai:usage-receipts:generation`: written by cron:ai-usage-backfill, rust:ai-usage-receipts; read by api, bot, cron:*(15 workers)
- `twitch:{channelId}:ai:usage-receipts:v2:{generation}:{sha256hex(customerId)[0:16]}:{sha256hex(timeZone)[0:12]}:{sha256hex(startISO|endISO)[0:12]}:{from}:{to}`: written by api, bot, cron:*(15 workers); read by api, bot, cron:*(15 workers)
- `locks:ai-usage-write:{sha256hex(JSON.stringify([channelId, customerId]))}`: written by api, bot, cron:*(15 workers), rust:ai-usage-receipts; read by api, bot, cron:*(15 workers), rust:ai-usage-receipts
- `cron:ai-usage-receipts:queue`: written by api, bot, cron:*(15 workers), rust:ai-usage-receipts; read by rust:ai-usage-receipts
- `cron:ai-usage-backfills:queue`: written by api, bot, cron:*(15 workers), cron:ai-usage-backfill; read by rust:ai-usage-receipts
- `cron:ai-usage-backfills:processing`: written by cron:ai-usage-backfill; read by rust:ai-usage-receipts
- `cron:ai-usage-backfills:dead`: written by cron:ai-usage-backfill; read by rust:ai-usage-receipts
- `cron:ai-usage-backfills:dedupe:v{AI_USAGE_REPORT_VERSION}:{channelId}:{customerId}`: written by api, bot, cron:*(15 workers), cron:ai-usage-backfill; read by (only inside Lua)
- `ai-usage:queue-health:{receipts|backfills}`: written by cron:ai-usage-backfill, rust:ai-usage-receipts; read by cron:ai-usage-backfill, rust:ai-usage-receipts
- `ai-usage:queue-health:{name}:snapshot`: written by cron:ai-usage-backfill, rust:ai-usage-receipts; read by cron:ai-usage-backfill
- `ai-usage:queue-health:{name}:alert`: written by cron:ai-usage-backfill, rust:ai-usage-receipts; read by cron:ai-usage-backfill, rust:ai-usage-receipts
- `cron:jobs:queue`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:follow-ledger, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:stream-memory, cron:temporary-roles, cron:timer, cron:vod-clip-recommender, cron:widgets; read by cron:follow-ledger
- `cron:jobs:dedupe:{dedupeToken}`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:follow-ledger, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:stream-memory, cron:temporary-roles, cron:timer, cron:vod-clip-recommender, cron:widgets; read by (only inside Lua)
- `cron:jobs:accepted:{job}:{channelId}:{sessionId}`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:follow-ledger, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:stream-memory, cron:temporary-roles, cron:timer, cron:vod-clip-recommender, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:follow-ledger, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:stream-memory, cron:temporary-roles, cron:timer, cron:vod-clip-recommender, cron:widgets
- `cron:stream-memory:queue`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:follow-ledger, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:stream-memory, cron:temporary-roles, cron:timer, cron:vod-clip-recommender, cron:widgets; read by cron:stream-memory
- `cron:clip-recommendations:queue`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:follow-ledger, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:stream-memory, cron:temporary-roles, cron:timer, cron:vod-clip-recommender, cron:widgets; read by cron:vod-clip-recommender
- `observability:v1:inbox`: written by api, bot, cron:*(19 workers), cron:supervisor, dima-analytics, rust:cron-index (supervisor telemetry); read by dima-analytics
- `observability:v1:overflow`: written by api, bot, cron:*(19 workers), cron:supervisor, rust:cron-index (supervisor telemetry); read by dima-analytics
- `logger:{platform}:{channelId|"global"}:{level}:{epochMs}-{suffix}`: written by api, bot, cron:*(19 workers), cron:supervisor, rust:ai-usage-receipts; read by (only inside Lua)
- `{BOT_METRICS_PREFIX=metrics:bot}:runtime:latest`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:semantic-moderation, cron:stream-analytics, cron:stream-memory, cron:temporary-roles, cron:timer, cron:widgets; read by (only inside Lua)
- `metrics:bot:runtime:history`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:semantic-moderation, cron:stream-analytics, cron:stream-memory, cron:temporary-roles, cron:timer, cron:widgets; read by (only inside Lua)
- `metrics:bot:runtime:cumulative:eventsubByType`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:semantic-moderation, cron:stream-analytics, cron:stream-memory, cron:temporary-roles, cron:timer, cron:widgets; read by (only inside Lua)
- `metrics:bot:runtime:cumulative`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:semantic-moderation, cron:stream-analytics, cron:stream-memory, cron:temporary-roles, cron:timer, cron:widgets; read by (only inside Lua)
- `metrics:bot:eventsub:minute:{yyyyMMddHHmm UTC}`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:semantic-moderation, cron:stream-analytics, cron:stream-memory, cron:temporary-roles, cron:timer, cron:widgets; read by (only inside Lua)
- `metrics:bot:runtime:minute:{yyyyMMddHHmm UTC}`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:semantic-moderation, cron:stream-analytics, cron:stream-memory, cron:temporary-roles, cron:timer, cron:widgets; read by (only inside Lua)
- `metrics:bot:{semantic|threading|stream_memory:job|stream_memory:action}:{minute:{bucket} | channel:{channelId}:minute:{bucket} | cumulative}`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:semantic-moderation, cron:stream-analytics, cron:stream-memory, cron:temporary-roles, cron:timer, cron:widgets; read by (only inside Lua)
- `oauth:failures:{api|token_refresh}:{epochMs}`: written by api, bot, cron:*(15 workers); read by (only inside Lua)
- `site:analytics:channels`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets
- `site:analytics:live:channels`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets
- `site:analytics:profile:{channelId}`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets
- `site:analytics:start`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets
- `{channelId}:commands:{cmd}`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `{channelId}:commands`: written by api, cron:domain-events, cron:stream-analytics; read by (only inside Lua)
- `twitch:{channelId}:commands:{cmd}`: written by api, bot; read by (only inside Lua)
- `command:execution:cooldown:{channelId}:{executionName}`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `command-cooldown-write:{channelId}`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `keywords:index:{channelId}`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `keywords:revision:{channelId}`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `keywords:body:{channelId}:{commandId}`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `{platform}:{channelId}:chat:history`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets
- `{platform}:{channelId}:variable:{name}[:id:{userId} | :login:{lowercased login}]`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `ast:timers:pending`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `ast:timers:job:{id}`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `ast:timers:channel:{channelId}`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by (only inside Lua)
- `timer:active`: written by api, bot, cron:domain-events, cron:stream-analytics; read by api, bot, cron:domain-events, cron:stream-analytics, cron:timer
- `timer:channel:{channelId}:timers`: written by api, bot, cron:domain-events, cron:stream-analytics; read by api, cron:domain-events, cron:stream-analytics, cron:timer
- `timer:channel:{channelId}:heartbeat:{timerId}`: written by api, bot, cron:domain-events, cron:stream-analytics, cron:timer; read by api, cron:domain-events, cron:stream-analytics, cron:timer
- `timer:channel:{channelId}:heartbeat-unit:{timerId}`: written by api, bot, cron:domain-events, cron:stream-analytics, cron:timer; read by api, cron:domain-events, cron:stream-analytics, cron:timer
- `{channelId}:follows:count`: written by api, bot, cron:domain-events, cron:stream-analytics; read by api, bot
- `{channelId}:follows:event:{eventKey}`: written by api, cron:domain-events; read by (only inside Lua)
- `twitch:{channelId}:stream.online:{streamId}`: written by api, bot; read by api, bot
- `{channelId}:chat:onlyemotes`: written by api, bot; read by api, bot
- `{channelId}:sumimetro:{lowercased login}`: written by api, bot, cron:domain-events, cron:stream-analytics; read by api, bot, cron:domain-events, cron:stream-analytics
- `{channelId}:sumimetro:{dominant|submissive}`: written by api, bot; read by api, bot
- `{channelId}:roulette:{userId}`: written by api, bot; read by api, bot
- `{channelId}:roulette:{userId}:died`: written by api, bot; read by api, bot
- `{channelId}:clip:connected | {channelId}:clips:queue | {channelId}:clip:playing | {channelId}:clips:queue:first`: written by api, bot; read by api, bot
- `twitch:{channelId}:clips:connected`: written by api; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `twitch:{channelId}:clips:queue:data:{clipId}`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api
- `twitch:{channelId}:clips:queue`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `twitch:{channelId}:clip:processing`: written by api; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `twitch:{channelId}:clips`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `twitch:{channelId}:clips:shown`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `twitch:{channelId}:tts:queue`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets, dima-analytics
- `twitch:{channelId}:tts:queue:data:{speechId}`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets
- `twitch:{channelId}:tts:processing`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets; read by api
- `twitch:{channelId}:tts:session`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets; read by api
- `twitch:{channelId}:tts:connected`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets; read by api
- `twitch:{channelId}:tts:last_cleanup`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets; read by api
- `{channelId}:chatbot:usage`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by (only inside Lua)
- `{channelId}:chatbot:response:last`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by (only inside Lua)
- `twitch:{channelId}:chatbot:personality`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `twitch:{channelId}:moderators`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `twitch:{channelId}:moderators:ids`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `twitch:{channelId}:moderators:logins`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `twitch:{channelId}:moderators:mapping`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `channel:data:{channelId}`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `twitch:{channelId}:polls`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `twitch:{channelId}:predictions`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `twitch:{channelId}:editors`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:semantic-moderation, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:semantic-moderation, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets
- `twitch:{channelId}:editors:ids`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:semantic-moderation, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:semantic-moderation, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets
- `{channelId}:channel:editors`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:semantic-moderation, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets; read by (only inside Lua)
- `twitch:{channelId}:admins`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:semantic-moderation, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:semantic-moderation, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets
- `twitch:{channelId}:admins:ids`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:semantic-moderation, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:semantic-moderation, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets
- `twitch:{channelId}:admins:{adminId}`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:semantic-moderation, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:semantic-moderation, cron:stream-analytics, cron:temporary-roles, cron:timer, cron:widgets
- `moderation:{channelId}:settings`: written by api, bot; read by api, bot
- `moderation:{channelId}:message:{messageId}`: written by api, bot; read by api, bot
- `moderation:{channelId}:offenses:{ruleId}:{userId}`: written by api, bot; read by (only inside Lua)
- `moderation:offense-receipt:{decisionId}`: written by api, bot; read by (only inside Lua)
- `moderation:{channelId}:permit:{user:{lowercased login} | channel}`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `moderation:{channelId}:notice:{userId}`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `moderation:seen:{sha256hex(JSON.stringify([channelId, userId]))}`: written by api, bot, cron:semantic-moderation; read by api, bot, cron:semantic-moderation
- `moderation:spam-budget:{channel:{channelId} | global}`: written by api, bot, cron:semantic-moderation; read by (only inside Lua)
- `moderation:{channelId}:{variation-words|variation-jobs}`: written by api, cron:semantic-moderation; read by (only inside Lua)
- `twitch:moderation:banmod:restore:queue`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `twitch:moderation:banmod:restore:data:{jobId}`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `twitch:{channelId}:follow-defense:settings`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `twitch:{channelId}:follow-defense:state`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets, rust:raid-sessions
- `twitch:{channelId}:follow-defense:recent`: written by api, cron:domain-events, cron:follow-defense; read by api, cron:domain-events, cron:follow-defense
- `twitch:{channelId}:follow-defense:tracked`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, cron:domain-events, cron:follow-defense
- `twitch:{channelId}:follow-defense:follow:{eventId}`: written by api, cron:domain-events, cron:follow-defense; read by api, cron:domain-events, cron:follow-defense
- `twitch:{channelId}:follow-defense:ban:{eventId}`: written by —; read by api, cron:domain-events, cron:follow-defense
- `twitch:{channelId}:follow-defense:completed:{eventId}`: written by api, cron:domain-events, cron:follow-defense; read by api, cron:domain-events, cron:follow-defense
- `twitch:{channelId}:follow-defense:summary`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by (only inside Lua)
- `twitch:{channelId}:follow-defense:summary-lock`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by (only inside Lua)
- `twitch:{channelId}:follow-defense:suppressed:{sha256hex(eventId)}`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by (only inside Lua)
- `twitch:{channelId}:follow-defense:raid`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, cron:domain-events, cron:follow-defense
- `twitch:{channelId}:follow-defense:raid-projection`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by (only inside Lua)
- `twitch:follow-defense:summaries`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `twitch:follow-defense:active-channels`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, cron:domain-events, cron:follow-defense
- `twitch:follow-defense:queue`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, cron:domain-events, cron:follow-defense
- `twitch:follow-defense:queue:data:{eventId}`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, cron:domain-events, cron:follow-defense
- `follow:defense:baseline:{channelId}`: written by api, cron:domain-events, cron:follow-defense, rust:follow-defense-baseline; read by api, cron:domain-events, cron:follow-defense
- `follow:defense:baseline:{channelId}:requested`: written by api, cron:domain-events, cron:follow-defense; read by api, cron:domain-events, cron:follow-defense
- `follow:defense:baseline:due`: written by api, cron:domain-events, cron:follow-defense, rust:follow-defense-baseline; read by api, cron:domain-events, cron:follow-defense, rust:follow-defense-baseline
- `twitch:{channelId}:ai:emotes`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `twitch:global:tts:emotes`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `twitch:{channelId}:emote-catalog:v1`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets, rust:dashboard-activity; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets, rust:dashboard-activity
- `ast_catalog:vectors:v1:{sha256hex(JSON.stringify([model, dim, texts]))[0:24]}`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `twitch:{channelId}:ai:threads:active`: written by api, bot; read by api, bot
- `twitch:{channelId}:ai:user:{userId}:threads`: written by api, bot; read by api, bot
- `twitch:{channelId}:ai:thread:{threadId}:meta`: written by api, bot; read by api, bot
- `twitch:{channelId}:ai:thread:{threadId}:turns`: written by api, bot; read by api, bot
- `desktop:speech:slot:{channelId}`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `desktop:speech:revision:{channelId}`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by (only inside Lua)
- `oauth:rate:{sha256 base64url(bucket)}`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by (only inside Lua)
- `oauth:request:{sha256 base64url(requestId)}`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `oauth:code:{sha256 base64url(code)}`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `oauth:access:{sha256 base64url(accessToken)}`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `widget-feed:demand:{channelId}`: written by api; read by api, bot
- `widget-signal:rate:{channelId}`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by (only inside Lua)
- `widget-signal:skipped:{channelId}`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `widget-signal:seen:{actionKey = "signal:v1:" + sha256hex(JSON.stringify([originId, path, n]))}`: written by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets; read by api, bot, cron:credit-gifts, cron:domain-events, cron:duel, cron:follow-defense, cron:follow-defense-actions, cron:goals, cron:roulette-actions, cron:temporary-roles, cron:timer, cron:widgets
- `widgets:duel:{channelId}:connected`: written by api, bot, cron:duel; read by api, bot, cron:duel

## Lua scripts

| Script | Source | KEYS | Returns | Call sites | Mode |
|---|---|---|---|---|---|
| `WRITE_PLAN_ACCOUNT_SCRIPT` | dimabot/src/utils/plan_cache_fence.ts:8 (Rust copy dima-rust/src/utils/plan_cache_fence.rs:35) | plan.fence, accounts.data, twitch.accounts | 0 = stale (fence > version), 1 = written | classes/twitch_streamers.class.ts:37 | EVAL (node-redis client.eval, script text sent every call) |
| `CHECK_PLAN_ACCOUNTS_SCRIPT` | dimabot/src/utils/plan_cache_fence.ts:18 (Rust copy plan_cache_fence.rs:44) | plan.fence, twitch.accounts | 1 = all fresh (and published when ARGV[n] ≠ ""), 0 = stale | classes/twitch_streamers.class.ts:29 | EVAL (node-redis client.eval, script text sent every call) |
| `ACCEPT_PLAN_CREDITS_SCRIPT` | dimabot/src/utils/plan_cache_fence.ts:29 (Rust copy plan_cache_fence.rs:56) | ai.credits, ai.exhaust, ai.exhaust.legacy, plan.fence | 1 accepted / 0 stale or changed | utils/billing.ts:1240 | EVAL (node-redis client.eval, script text sent every call) |
| `APPLY_AI_CREDIT_USAGE_SCRIPT` | dimabot/src/utils/billing.ts:244 | ai.credits, ai.exhaust, ai.exhaust.legacy, ai.usage.local | 2 = duplicate marker, 1 = now exhausted, 0 = otherwise | utils/billing.ts:280 | EVAL (node-redis client.eval, script text sent every call) |
| `INVALIDATE_PLAN_SCRIPT` | dimabot/src/domain_events/polar_billing_events.ts:18 (Rust copy plan_cache_fence.rs:74) | plan.fence, ai.credits, accounts.data, twitch.accounts, billing.packctx | 1 applied / 0 older | domain_events/polar_billing_events.ts:150 | EVAL (node-redis client.eval, script text sent every call) |
| `SYNC_CREDITS_SCRIPT` | dimabot/src/domain_events/polar_billing_events.ts:25 (Rust copy plan_cache_fence.rs:83) | ai.credits, ai.exhaust, ai.exhaust.legacy, ai.credits.polar, plan.fence | 1 applied / 0 stale | domain_events/polar_billing_events.ts:226 | EVAL (node-redis client.eval, script text sent every call) |
| `INCREMENT_FOLLOW_COUNT_SCRIPT` | dimabot/src/domain_events/chat_announcement_events.ts:52 | follows.count, follows.event | assigned follow count (integer) | domain_events/chat_announcement_events.ts:122 | EVAL (node-redis client.eval, script text sent every call) |
| `desktop.reserveScript` | dimabot/src/desktop_ai/activity.ts:37 | desk.slot, desk.revision | revision or 0 | desktop_ai/activity.ts:185 | EVAL (node-redis client.eval, script text sent every call) |
| `desktop.startScript` | dimabot/src/desktop_ai/activity.ts:41 | desk.slot, desk.revision | revision, 0 or -1 | desktop_ai/activity.ts:220 | EVAL (node-redis client.eval, script text sent every call) |
| `desktop.finishScript` | dimabot/src/desktop_ai/activity.ts:49 | desk.slot, desk.revision | {revision, raw} or {0,""} | desktop_ai/activity.ts:244 | EVAL (node-redis client.eval, script text sent every call) |
| `desktop.extendScript` | dimabot/src/desktop_ai/activity.ts:53 | desk.slot, desk.revision | revision, 0 or -1 | desktop_ai/activity.ts:232 | EVAL (node-redis client.eval, script text sent every call) |
| `desktop.retireScript` | dimabot/src/desktop_ai/activity.ts:59 | desk.slot, desk.revision | {revision, raw} | desktop_ai/activity.ts:269 | EVAL (node-redis client.eval, script text sent every call) |
| `desktop.expireScript` | dimabot/src/desktop_ai/activity.ts:67 | desk.slot, desk.revision | {revision, raw} | desktop_ai/activity.ts:84 | EVAL (node-redis client.eval, script text sent every call) |
| `desktop.expireExpectedScript` | dimabot/src/desktop_ai/activity.ts:71 | desk.slot, desk.revision | {revision, raw} | desktop_ai/activity.ts:91 | EVAL (node-redis client.eval, script text sent every call) |
| `desktop.readSlot` | dimabot/src/desktop_ai/activity.ts:100 (inline) | desk.slot, desk.revision | {raw or "", revision or "0"} | desktop_ai/activity.ts:100 | EVAL (node-redis client.eval, script text sent every call) |
| `desktop.reserveQueueScript` | dimabot/src/desktop_ai/service.ts:27 | desk.queue | 2 existing / 1 reserved / 0 full | desktop_ai/service.ts:106 | EVAL (node-redis client.eval, script text sent every call) |
| `desktop.releaseLeaseScript` | dimabot/src/desktop_ai/service.ts:32 | desk.owner | DEL result or 0 | desktop_ai/service.ts:226 | EVAL (node-redis client.eval, script text sent every call) |
| `desktop.renewLeaseScript` | dimabot/src/desktop_ai/service.ts:33 | desk.owner | 1 / 0 | desktop_ai/service.ts:202 | EVAL (node-redis client.eval, script text sent every call) |
| `oauth.rateLimit` | dimabot/src/server/oauth/service.ts:47 (inline) | oauth.rate | count | server/oauth/service.ts:46 | EVAL (node-redis client.eval, script text sent every call) |
| `site_agent.CAS` | dimabot/src/site_agent/store.ts:86 | sa.turn, sa.lease | 1 / 0 conflict / -1 lease lost | site_agent/store.ts:125 | EVAL (node-redis client.eval, script text sent every call) |
| `site_agent.SET_IF_SAME` | dimabot/src/site_agent/store.ts:194 | sa.session | 1 / 0 | site_agent/store.ts:205 | EVAL (node-redis client.eval, script text sent every call) |
| `site_agent.SET_IF_LEASE` | dimabot/src/site_agent/store.ts:267 | sa.ctx, sa.lease | 1 / 0 | site_agent/store.ts:273 | EVAL (node-redis client.eval, script text sent every call) |
| `site_agent.RENEW` | dimabot/src/site_agent/store.ts:363 | sa.lease | 1 / 0 | site_agent/store.ts:374 | EVAL (node-redis client.eval, script text sent every call) |
| `site_agent.RELEASE` | dimabot/src/site_agent/store.ts:364 | sa.lease | 1 / 0 | site_agent/store.ts:378 | EVAL (node-redis client.eval, script text sent every call) |
| `site_agent.TAKE` | dimabot/src/site_agent/limits.ts:15 | sa.daily | {allowed 0\|1, used} | site_agent/limits.ts:32 | EVAL (node-redis client.eval, script text sent every call) |
| `site_agent.refund` | dimabot/src/site_agent/limits.ts:42 (inline) | sa.daily | new value or 0 | site_agent/limits.ts:42 | EVAL (node-redis client.eval, script text sent every call) |
| `ownerExpire` | inline "if GET==ARGV[1] then EXPIRE KEYS[1] <n\|ARGV[2]>": overlays/test-playback.ts:75, voice_preview.service.ts:96, ai_usage_lock.ts:14, ai_usage_backfill.worker.ts:87, stream_memory.worker.ts:289 | overlay.test, tts.preview.lock, locks.aiusage, lock.backfill.consumer, lock.memory.channel | EXPIRE result or 0 | overlays/test-playback.ts:75, server/services/tts/voice_preview.service.ts:96, utils/ai_usage_lock.ts:14, workers/ai_usage_backfill.worker.ts:87, workers/stream_memory.worker.ts:289 | EVAL (node-redis client.eval, script text sent every call) |
| `ownerDelete` | inline "if GET==ARGV[1] then DEL": voice_preview.service.ts:146, ai_usage_lock.ts:24, command_cooldown_write.ts:42, stream_memory.worker.ts:192, and RELEASE_LOCK_SCRIPT constants in workers/{eventsub_reconciliation:26, free_credit_reset:19, ai_usage_backfill:28, vod_clip_recommender:34}.worker.ts; Rust copies ai_usage_receipts/queue.rs:20, command_cooldown.rs:18, twitch_tokens/adapters.rs:205, twitch_streamers/adapters.rs RELEASE | tts.preview.lock, locks.aiusage, cmd.cooldown.write, lock.memory.channel, lock.eventsub-reconciliation, lock.free-credit-reset, lock.backfill.consumer, lock.backfill.sweep, q.backfills.dedupe, lock.clips, lock.receipts | DEL count or 0 | rs/workers/ai_usage_receipts/queue.rs:125, server/services/tts/voice_preview.service.ts:146, utils/ai_usage_lock.ts:24, utils/command_cooldown_write.ts:42, workers/ai_usage_backfill.worker.ts:129, workers/ai_usage_backfill.worker.ts:150, workers/ai_usage_backfill.worker.ts:156, workers/ai_usage_backfill.worker.ts:163, workers/ai_usage_backfill.worker.ts:93, workers/eventsub_reconciliation.worker.ts:83, workers/free_credit_reset.worker.ts:93, workers/stream_memory.worker.ts:192, workers/vod_clip_recommender.worker.ts:113 | EVAL (node-redis client.eval, script text sent every call) |
| `EXTEND_LOCK_SCRIPT` | workers/{eventsub_reconciliation:33, free_credit_reset:26, vod_clip_recommender:41}.worker.ts; Rust ai_usage_receipts/queue.rs:22 EXTEND | lock.eventsub-reconciliation, lock.free-credit-reset, lock.clips, lock.receipts | 1 / 0 | rs/workers/ai_usage_receipts/queue.rs:92, workers/eventsub_reconciliation.worker.ts:101, workers/free_credit_reset.worker.ts:111, workers/vod_clip_recommender.worker.ts:104 | EVAL (node-redis client.eval, script text sent every call) |
| `aiusage.claim` | dimabot/src/utils/ai_usage_queue_health.ts:9 (Rust copy ai_usage_receipts/queue.rs:164) | q.receipts\|q.backfills, q.*.processing, aiusage.health | element or nil (LPOP → RPUSH processing, HSET processingSince) | rs/workers/ai_usage_receipts/queue.rs:164, utils/ai_usage_queue_health.ts:17 | EVAL (node-redis client.eval, script text sent every call) |
| `aiusage.complete` | dimabot/src/utils/ai_usage_queue_health.ts:22 (Rust copy queue.rs:168) | q.*.processing, q.*.attempts | 1 | rs/workers/ai_usage_receipts/queue.rs:168, utils/ai_usage_queue_health.ts:22 | EVAL (node-redis client.eval, script text sent every call) |
| `aiusage.fail` | dimabot/src/utils/ai_usage_queue_health.ts:28 (Rust copy queue.rs:179) | q.*.processing, q.receipts\|q.backfills, q.*.dead, q.*.attempts, aiusage.health | 0 not in processing / 1 requeued (RPUSH) / 2 dead-lettered | rs/workers/ai_usage_receipts/queue.rs:179, utils/ai_usage_queue_health.ts:28 | EVAL (node-redis client.eval, script text sent every call) |
| `ai_usage_backfill.ENQUEUE_SCRIPT` | dimabot/src/utils/ai_usage_backfill_queue.ts:12 | q.backfills.dedupe, q.backfills | 1 enqueued / 0 duplicate | utils/ai_usage_backfill_queue.ts:104 | EVAL (node-redis client.eval, script text sent every call) |
| `ai_usage_backfill.RECLAIM_SCRIPT` | dimabot/src/workers/ai_usage_backfill.worker.ts:19 (Rust receipts variant queue.rs:160 uses RPOP) | q.backfills.processing, q.backfills | moved count (LPOP processing → LPUSH queue: reverses order; Rust RPOP→LPUSH keeps order) | workers/ai_usage_backfill.worker.ts:95 | EVAL (node-redis client.eval, script text sent every call) |
| `ENQUEUE_DEDUPLICATED_JOB` | dimabot/src/utils/cron_jobs_queue.ts:10 (Rust copy cron_queue.rs:45, library only) | cronjobs.dedupe, q.cronjobs, cronjobs.accepted | 1 pushed / 0 duplicate or already accepted; error reply on push failure (markers rolled back) | rs/utils/cron_queue.rs:413, utils/cron_jobs_queue.ts:158 | EVAL (node-redis client.eval, script text sent every call) |
| `PUBLISH_DURABLE_CRON_JOB` | dimabot/src/utils/durable_cron_jobs.ts:14 | q.memory\|q.clips, cronjobs.accepted | 1 pushed / 0 already present (LPOS exact-bytes match) | utils/durable_cron_jobs.ts:132 | EVAL (node-redis client.eval, script text sent every call) |
| `stream_memory.requeueIfOwner` | dimabot/src/workers/stream_memory.worker.ts:399 (inline) | lock.memory, q.memory.processing, q.memory | -1 lock lost / 0 / LPUSH length | workers/stream_memory.worker.ts:399 | EVAL (node-redis client.eval, script text sent every call) |
| `CLIP_CLAIM_SCRIPTS.acknowledge` | dimabot/src/utils/ai/clip_recommendations/clip_recommendation_claims.ts:3 | lock.clips, q.clips.processing, q.clips\|q.clips.dead, cronjobs.dedupe | -1 lock lost / LREM count | workers/vod_clip_recommender.worker.ts:118 | EVAL (node-redis client.eval, script text sent every call) |
| `CLIP_CLAIM_SCRIPTS.requeue` | dimabot/src/utils/ai/clip_recommendations/clip_recommendation_claims.ts:9 | lock.clips, q.clips.processing, q.clips\|q.clips.dead, cronjobs.dedupe | -1 / 0 / LREM count | workers/vod_clip_recommender.worker.ts:347 | EVAL (node-redis client.eval, script text sent every call) |
| `CLIP_CLAIM_SCRIPTS.deadLetter` | dimabot/src/utils/ai/clip_recommendations/clip_recommendation_claims.ts:16 | lock.clips, q.clips.processing, q.clips\|q.clips.dead, cronjobs.dedupe | -1 / 0 / 1 | workers/vod_clip_recommender.worker.ts:155 | EVAL (node-redis client.eval, script text sent every call) |
| `CLIP_CLAIM_SCRIPTS.recover` | dimabot/src/utils/ai/clip_recommendations/clip_recommendation_claims.ts:25 | lock.clips, q.clips.processing, q.clips\|q.clips.dead, cronjobs.dedupe | -1 / RPOPLPUSH element | workers/vod_clip_recommender.worker.ts:166 | EVAL (node-redis client.eval, script text sent every call) |
| `telemetry.ENQUEUE` | dimabot/src/utils/observability/telemetry.ts:173 (Rust copy supervisor/telemetry.rs ENQUEUE) | obs.inbox, obs.overflow | dropped count | rs/supervisor/telemetry.rs:517, utils/observability/telemetry.ts:201 | EVAL (node-redis client.eval, script text sent every call) |
| `tts.ENQUEUE` | dimabot/src/utils/tts/tts_session.util.ts:5 | tts.queue, tts.queue.data, tts.session | session or "" | utils/tts/tts_session.util.ts:42 | EVAL (node-redis client.eval, script text sent every call) |
| `tts.POP` | dimabot/src/utils/tts/tts_session.util.ts:12 | tts.queue, tts.session, tts.queue.data | {} \| {"retry"} \| {id, payload, session} | utils/tts/tts_session.util.ts:53 | EVAL (node-redis client.eval, script text sent every call) |
| `tts.RESET` | dimabot/src/utils/tts/tts_session.util.ts:20 | tts.session, tts.queue, tts.processing, tts.connected, tts.lastcleanup, tts.queue.data | {previousSession, ...waiting ids, processing} | utils/tts/tts_session.util.ts:60 | EVAL (node-redis client.eval, script text sent every call) |
| `tts.CLEAN_OLD` | dimabot/src/utils/tts/tts_session.util.ts:29 | tts.queue.data | 1 | utils/tts/tts_session.util.ts:67 | EVAL (node-redis client.eval, script text sent every call) |
| `follow_defense.projectState` | dimabot/src/utils/follow_defense_queue.ts:111 | fd.state, fd.active, fd.tracked, fd.raidprojection, fd.summary | {changed 0\|1, raw state JSON} | utils/follow_defense_queue.ts:111 | EVAL (node-redis client.eval, script text sent every call) |
| `follow_defense.raidMarker` | dimabot/src/utils/follow_defense_queue.ts:321 | fd.raid | 1 / 0 | utils/follow_defense_queue.ts:321 | EVAL (node-redis client.eval, script text sent every call) |
| `follow_defense.suppress` | dimabot/src/utils/follow_defense_summary.ts:13 | fd.state, fd.settings, fd.suppressed, fd.summary, fd.summaries | {suppressed 0\|1, ""} | utils/follow_defense_summary.ts:13 | EVAL (node-redis client.eval, script text sent every call) |
| `follow_defense.claimSummary` | dimabot/src/utils/follow_defense_summary.ts:105 | fd.summary, fd.state, fd.summaries, fd.summary.lock | {claimed 0\|1, summary JSON} | utils/follow_defense_summary.ts:105 | EVAL (node-redis client.eval, script text sent every call) |
| `follow_defense.finishSummary` | dimabot/src/utils/follow_defense_summary.ts:140 | fd.summary, fd.summaries, fd.summary.lock | {1, ""} / {0, ""} | utils/follow_defense_summary.ts:140 | EVAL (node-redis client.eval, script text sent every call) |
| `moderation.recordOffense` | dimabot/src/utils/moderation/offenses.ts:18 | mod.offenses, mod.offense.receipt | count | utils/moderation/offenses.ts:18 | EVAL (node-redis client.eval, script text sent every call) |
| `moderation.spamBudget` | dimabot/src/utils/moderation/spam.ts:115 | mod.spam.budget | 1 / 0 (uses redis TIME) | utils/moderation/spam.ts:115 | EVAL (node-redis client.eval, script text sent every call) |
| `moderation.variationBudget` | dimabot/src/utils/moderation/variation_jobs.ts:58 | mod.variation | 1 / 0 | utils/moderation/variation_jobs.ts:58 | EVAL (node-redis client.eval, script text sent every call) |
| `keywords.setIfRevision` | dimabot/src/utils/keyword_cache.ts:22 and :59 (Rust copy keywords.rs:34 SET_IF_REVISION_SCRIPT, library only) | kw.index\|kw.body, kw.revision | 1 saved / 0 raced | utils/keyword_cache.ts:22, utils/keyword_cache.ts:59 | EVAL (node-redis client.eval, script text sent every call) |
| `rateLimit.hit` | dimabot/src/utils/rate_limit.ts:18 (inline, text on :19) | ratelimit | {count, ttl} | utils/rate_limit.ts:18 | EVAL (node-redis client.eval, script text sent every call) |
| `widget.COUNT_SCRIPT` | dimabot/src/widget_feed/signals.ts:46 | widget.signal.rate, widget.signal.skipped | count | widget_feed/signals.ts:48 | EVAL (node-redis client.eval, script text sent every call) |
| `ast_timer.ENQUEUE` | dimabot/src/utils/ast_timer_runtime.ts:26 | ast.timer.job, ast.timer.index, ast.timer.channel | 1 accepted / 0 limit | utils/ast_timer_runtime.ts:62 | EVAL (node-redis client.eval, script text sent every call) |
| `ast_timer.CLAIM` | dimabot/src/utils/ast_timer_runtime.ts:39 | ast.timer.job, ast.timer.index, ast.timer.channel | raw job JSON or nil | utils/ast_timer_runtime.ts:135 | EVAL (node-redis client.eval, script text sent every call) |
| `rust.follow_defense_baseline.BACKLOG_HEALTH` | dima-rust/src/workers/follow_defense_baseline.rs:28 | fd.baseline.due | {count, oldest score string} | rs/workers/follow_defense_baseline.rs:98 | EVAL (redis::cmd("EVAL")) |
| `rust.ai_usage_receipts.reclaim` | dima-rust/src/workers/ai_usage_receipts/queue.rs:160 | q.receipts.processing, q.receipts | moved count | rs/workers/ai_usage_receipts/queue.rs:160 | EVAL (redis::cmd("EVAL")) |
| `rust-lib.READ_PLAN_ACCOUNT_SCRIPT` | dima-rust/src/utils/plan_cache_fence.rs:102 (library only) | accounts.data, plan.fence | {status, HGETALL array} | rs/utils/plan_cache_fence.rs:535 | EVALSHA via redis::Script::invoke_async (falls back to EVAL on NOSCRIPT) and explicit EVALSHA pipelines (plan_cache_fence.rs:535, twitch_streamers/adapters.rs:433) |
| `rust-lib.twitch_streamers.{OBSERVE,PUBLISH,EVICT,VALIDATE,VALIDATE_ACCOUNTS,VALIDATE_IDS,IDS,HASH_IDS,KICK,RELEASE}` | dima-rust/src/utils/twitch_streamers/adapters.rs:177-266 (library only) | accounts.data, plan.fence, rs.directory.revision, rs.directory.generation, streamers.by.id, twitch.accounts, streamers.by.name, rs.streamers.lease | see source | rs/utils/twitch_streamers/adapters.rs:382, rs/utils/twitch_streamers/adapters.rs:433, rs/utils/twitch_streamers/adapters.rs:511, rs/utils/twitch_streamers/adapters.rs:557, rs/utils/twitch_streamers/adapters.rs:636, rs/utils/twitch_streamers/adapters.rs:689, rs/utils/twitch_streamers/adapters.rs:719, rs/utils/twitch_streamers/adapters.rs:770, rs/utils/twitch_streamers/adapters.rs:788, rs/utils/twitch_streamers/adapters.rs:823 | EVALSHA via Script::invoke_async / EVALSHA pipeline |
| `rust-lib.twitch_tokens.{PUBLISH,INVALIDATE,RELEASE,PUBLISH_BOT}` | dima-rust/src/utils/twitch_tokens/adapters.rs:162-218 (library only) | accounts.data, streamers.by.id, twitch.accounts, app.bot, rs.directory.generation, locks.refresh | 1 / 0 | rs/utils/twitch_tokens/adapters.rs:297, rs/utils/twitch_tokens/adapters.rs:363, rs/utils/twitch_tokens/adapters.rs:440, rs/utils/twitch_tokens/adapters.rs:485 | EVAL (redis::cmd("EVAL")) |

## Transactions

- `handlers/tts_queue.handler.ts:1152` — MULTI ZREM tts:queue <waiting ids> + DEL tts:queue:data:{id}... EXEC
- `site_agent/store.ts:101` — MULTI HSET site_agent:t:{id} rev json, EXPIRE, SADD site_agent:active EXEC
- `site_agent/store.ts:153` — MULTI EXPIRE session keys + ZADD/EXPIRE site_agent:sessions:{c}:{u} EXEC
- `site_agent/store.ts:164` — MULTI SET session EX, SET ctx "[]" EX EXEC
- `site_agent/store.ts:225` — MULTI DEL session keys, ZREM user sessions EXEC
- `site_agent/store.ts:234` — MULTI HSET items, EXPIRE, [RPUSH :order, EXPIRE] EXEC
- `site_agent/store.ts:249` — MULTI LRANGE :order, HGETALL items, [XREVRANGE ev + - COUNT 1] EXEC — results consumed positionally
- `site_agent/store.ts:313` — MULTI LRANGE queue 0 -1, DEL queue EXEC (atomic drain)
- `site_agent/usage.ts:139,155,225,248,262,325` — MULTI HINCRBY.../RPUSH+LTRIM+EXPIRE EXEC
- `utils/ai/docs_assistant/docs_assistant.ts:158,167,202,219` — MULTI HINCRBY + EXPIRE (+HSET answer, LPUSH/LTRIM recent) EXEC; :158 reads HINCRBY result [0]
- `utils/keyword_cache.ts:43` — MULTI INCR keywords:revision:{c}, DEL keywords:index:{c}, [DEL keywords:body:{c}:{id}] EXEC
- `dima-analytics/src/channel-names.mjs:26` — MULTI of up to 50 HGET accounts:twitch:{id}:data name (used as a pipeline)
- `(none)` — WATCH/UNWATCH/DISCARD are not used anywhere in scope

## Connections per process

| Process | Connection | Count | Options | Used for | Telemetry wrapper |
|---|---|---|---|---|---|
| dimabot api / bot / every cron worker child (each worker is its own node process spawned by cron.index.ts) | main command connection (`utils/databases/dragonfly.database.ts:35`) | 1 per process (module singleton promise; failed init is retryable) | createClient({ url: redis://$DRAGONFLY_HOST:$DRAGONFLY_PORT }) — node-redis 5.12.1 defaults: RESP2, offline queue ON (commands queue while reconnecting), default reconnect strategy (exponential back-off with jitter), no password/TLS/SELECT, no ping interval | all key commands, EVAL, MULTI, and the blocking BLPOP (cron:follow-ledger) / BLMOVE (cron:stream-memory, cron:vod-clip-recommender) — a blocking call holds this single connection for up to 5 s, so every other command of that worker waits behind it | Returned as a Proxy: get, set, hGet, hGetAll, hSet, exists, del, zAdd, zPopMin, zCard, lPush, rPush, lPop, rPop, eval are wrapped with beginSpan("cache", method) and for get/hGet observe("cache_lookup", ..., hit\|miss). Every other method (multi, sendCommand, blPop, hIncrBy, ...) is passed through bound and is NOT measured. Errors are logged at most once per 30 s per (caller, code, message). |
| api, bot, cron workers that import PubSubManager | PubSubManager publisher + subscriber (`classes/pubsub_manager.class.ts:13-27`) | 2 per process, created lazily on first publish/subscribe (client.duplicate() of the main client) | same options as the main client; the subscriber is in subscribe mode; node-redis re-subscribes on reconnect | channels twitch:{c}:clip:request, tts:session-ended:v1, widget-feed, keywords:changed (subscribe side) | not wrapped (duplicate() of the raw client) |
| every TS process that calls startTelemetry() | telemetry flush client (`utils/observability/telemetry.ts:178-186`) | 0–1 per process, recreated when not ready | disableOfflineQueue: true, socket.connectTimeout 1000, reconnectStrategy false; destroyed if a flush exceeds 1800 ms; DRAGONFLY_PORT defaults to 6379 here only | Lua telemetry ENQUEUE into observability:v1:inbox | none (would recurse) |
| api (pets runtime + desktop activity subscribers, pet wake publisher), cron:domain-events (subscriber), any process calling utils/domain_events.ts (publisher) | DomainEventWakeups hint client (`utils/domain_event_wakeups.ts:69-79`) | 1 per DomainEventWakeups instance (domainEventWakeups singleton, PetWakeupPublisher, each subscribePetWakeups call, domain-events worker) | disableOfflineQueue, reconnectStrategy false, connectTimeout = timeoutMs, commandsQueueMaxLength 4, unref(); publisher closes after 30 s idle; DOMAIN_EVENTS_WAKEUPS_ENABLED=false disables | PUBLISH/SUBSCRIBE domain-events:wakeup:v1 and pet:runtime:wake:v1 | none |
| dimabot scripts (manual, tsx) | own getDragonflyClient / createClient (`scripts/*.script.ts`) | 1 per run | as main client | one-off maintenance (invalidate_all_user_permissions, migrate_*, reconcile_stream_offline) | as main client |
| Rust workers (ai-usage-receipts, follow-defense-baseline, raid-sessions, dashboard-activity) | redis::aio::ConnectionManager (`rs/utils/redis.rs:100-140`) | 1 per process (tokio OnceCell, cached after first successful connect + PING) | redis-rs 1.7.1 (features tokio-rustls-comp, script, connection-manager), RESP2, plain TCP, DB 0; 5 s bound on initial connect+PING; response timeout unset (keeps blocking-command semantics); reconnects after I/O errors but the in-flight command fails and is not replayed | all Rust key commands and EVAL; cloned handles share one multiplexed socket (no blocking commands are issued by deployed workers) | none |
| Rust cron-index supervisor | telemetry flush connection (`rs/supervisor/telemetry.rs:496-525`) | fresh multiplexed connection per flush | connection timeout + response timeout; dropped on timeout | same Lua ENQUEUE as TS telemetry | n/a |
| dima-analytics | single client (`dima-analytics/src/index.mjs:128-130`) | 1 | createClient({ url: REDIS_URL \|\| redis://dragonfly:6379, disableOfflineQueue: true, socket.connectTimeout 3000 }); error events swallowed | observability inbox drain (LINDEX/LMOVE/LREM), INFO + queue SCAN collectors, token:{t} session lookup, identity/infra caches, accounts name lookup | none |
| dimadb/server | one client per configured connection id (`dimadb/server/redis.mjs:17-30`) | 1 per configured Redis connection, cached | createClient({ url }) defaults | operator console: SCAN/TYPE/TTL/GET/SET/HSET/... and raw sendCommand (dangerous commands need confirm) | none |
| dimafx/server, dima-hoststats | none (`searched dimafx/server/src and dima-hoststats/src`) | 0 | - | no Redis use | - |

## Byte-sensitive items

- **Plan fence versions** — dimabot/src/utils/plan_cache_fence.ts:4 planCacheVersion; domain_events/polar_billing_events.ts:233 polar version. Keys: plan.fence, ai.credits.polar, accounts.data (__polar_plan_version field), ai.credits (__polar_plan_version). Why: Lua compares with string ">" (lexicographic byte order). **Rule:** Produce exactly String(epochMs).padStart(13,"0") + ":" + eventKey (Rust: format!("{ms:013}:{key}"), ms ≥ 0); empty string when either part is missing.
- **Raw-value compare-and-set** — ACCEPT_PLAN_CREDITS_SCRIPT read mode (billing.ts:1240), site_agent SET_IF_SAME (store.ts:205), keyword setIfRevision (keyword_cache.ts:22,59). Keys: ai.credits, sa.session, kw.revision. Why: The script compares the current value with ARGV byte-for-byte. **Rule:** Pass back the exact bytes previously read (GET result, or "0" for a missing revision). Never re-serialize a parsed value.
- **Queue elements removed by value (LREM / LPOS)** — stream_memory.worker.ts:381-399, CLIP_CLAIM_SCRIPTS, ai_usage_queue_health.ts complete/fail, dima-rust ai_usage_receipts/queue.rs complete/fail, dima-analytics index.mjs:147-153, durable_cron_jobs.ts PUBLISH_DURABLE_CRON_JOB (LPOS). Keys: q.memory.processing, q.clips.processing, q.receipts.processing, q.backfills.processing, obs.processing, q.memory, q.clips. Why: LREM/LPOS match whole elements byte-for-byte; a re-encoded copy is never found (stuck processing entry or duplicate publish). **Rule:** Keep the raw popped string and use it for LREM/requeue. For PUBLISH_DURABLE_CRON_JOB, serialize the Mongo intent payload exactly like JSON.stringify of the mongoose lean document (BSON key order, undefined omitted, JS number formatting) or duplicates appear (fenced only by the Mongo claim).
- **CronQueueJob JSON** — dimabot/src/utils/cron_jobs_queue.ts:77 serializeCronQueueJob; dima-rust/src/utils/cron_queue.rs (library port, own JS number formatter at :630-660). Keys: q.cronjobs, q.cronjobs.dead, q.memory, q.clips, q.memory.dead. Why: Requeue/dead-letter copies and LPOS dedupe depend on identical bytes. **Rule:** Field order id, job, requestedAt, requestedBy?, userID?, accountID?, channelID?, data?, dedupeKey?; omit absent fields (serde skip_serializing_if); JS number formatting inside data (1 not 1.0, 1e21 style exponents).
- **Attempt-counter key hashes** — ai_usage_queue_health.ts:21,27; dima-rust ai_usage_receipts/queue.rs:167,178. Keys: q.receipts.attempts, q.backfills.attempts. Why: Key = sha256 hex of the raw element. **Rule:** Hash the exact UTF-8 bytes of the raw element; lowercase hex.
- **Keys hashed from JSON arrays** — ai_usage_lock.ts:5 (locks.aiusage), moderation/spam.ts:91 (mod.seen), ast_parser/effects.ts:83 (widget.signal.seen actionKey), ai/ast_catalog/index.ts:52 (ast.catalog.vectors). Keys: locks.aiusage, mod.seen, widget.signal.seen, ast.catalog.vectors. Why: sha256(JSON.stringify([...])) is part of the key. **Rule:** Serialize the array exactly like JSON.stringify: no spaces, strings escaped with \" \\ \b \f \n \r \t and lowercase \u00XX for other controls, non-ASCII kept as UTF-8 (serde_json::to_string matches for valid Unicode), integers without ".0" (LFM2_EMBEDDING_DIM, signalNext). Then lowercase hex sha256; ast catalog keeps the first 24 hex chars.
- **Other hashed key parts** — billing.ts:362 (sha256hex(customerId)[0:20]), billing.ts:277 (sha256hex(externalId)), ai_usage_receipts.ts:837-842 (sha256hex[0:16|12|12]), follow_defense_summary.ts:12 (sha256hex(eventID)), docs/sections.ts:86 hashText (sha256hex[0:24] of "model|format|text"), overlay-token.ts:14 (pet:audio sha256 hex), dima-analytics index.mjs:29 (sha256 hex of bearer token). Keys: billing.packctx, ai.usage.local, ai.receipts.cache, fd.suppressed, docs.vectors, pet.audio, obs.identity. Why: Hex digests in key names. **Rule:** sha256 of the UTF-8 string, lowercase hex, truncated to the stated length.
- **base64url digests** — server/oauth/service.ts:15 hash(); utils/rate_limit.ts:16. Keys: oauth.request, oauth.code, oauth.access, oauth.rate, ratelimit. Why: createHash("sha256").digest("base64url") in key names. **Rule:** URL-safe base64 alphabet (-_), NO "=" padding (43 chars for sha256).
- **Raw secret in key name** — middleware/auth.middleware.ts:122-173, server/routes/validation.route.ts:28, dima-analytics index.mjs:36. Keys: auth.token. Why: token:{rawTwitchAccessToken} **Rule:** Use the bearer token string exactly as received (after stripping "Bearer "); never log the key.
- **Lowercased logins in keys / members** — utils/moderation/permit.ts:83 (login.toLowerCase()), commands/sumimetro.command.ts:46-78, utils/permissions/roles.ts:215-313 (editors/admins sets and adminName), utils/ast_parser/evaluator.ts:186 normalizeUserLogin (trim, strip leading "@", lowercase). Keys: mod.permit, sumimetro.user, roles.editors, roles.admins, roles.admins.detail, ast.variable. Why: Members/keys are compared as bytes. **Rule:** Apply String(x).toLowerCase() semantics: full Unicode default lowercase (Rust str::to_lowercase matches JS, including final-sigma). For ast.variable also trim JS whitespace and strip leading "@"s before lowercasing. validation.route.ts:56 checks the admins set with the login from token:{t} unmodified.
- **Numbers formatted to strings** — String(Date.now()), String(expiresAt) unix seconds, String(n) counters (siteanalytics.ts:103-111), usage.cost.toFixed(6) (docs_assistant.ts:186 cost_usd), Math.round(usd*1e5) (tts_usage.ts:112), Math.round(cost*1e6) (docs_assistant.ts:173, site_agent usage micro()), zAdd scores, Lua tostring(count). Keys: accounts.data, site.analytics, docs.answer, tts.usage, clips.lastactivity, triggers.activity, tts.lastcleanup, follows.event. Why: Readers parse them back, but HINCRBY requires an integer string and some values are compared. **Rule:** Integers in plain decimal without exponent or ".0"; HINCRBY increments must be integers (JS non-integer would error — keep rounding where TS rounds); toFixed(6) → format!("{:.6}") (beware JS toFixed rounding of binary values, e.g. 1.0000005).
- **JSON number formatting of floats** — follow_defense_baseline (TS utils/follow_defense_baseline.ts:54 vs Rust workers/follow_defense_baseline.rs:308), ai-usage queue-health snapshot (ai_usage_queue_health.ts:61 vs queue.rs:327). Keys: fd.baseline, aiusage.health.snapshot, aiusage.health. Why: serde_json prints f64 3.0 as "3.0" and 0 as "0.0"; JS prints "3" / "0". Already divergent in production; readers JSON.parse so values agree. **Rule:** Byte equality is not required for these keys today; if any consumer starts comparing raw values, format f64 the JS way (shortest round-trip, integral without ".0").
- **Values re-encoded by Lua cjson** — APPLY_AI_CREDIT_USAGE_SCRIPT, desktop activity scripts, tts ENQUEUE, follow_defense projectState / summary scripts. Keys: ai.credits, desk.slot, tts.queue.data, fd.state, fd.summary. Why: cjson.encode reorders object keys, escapes "/" as "\/", formats numbers with %.14g (14 significant digits; larger values become exponent form) and encodes empty arrays as {}. **Rule:** Rust readers must accept any key order, "\/" escapes, exponent numbers and {} where an empty array is expected; never byte-compare these values (except via the raw-value rule above).
- **HGETALL field order** — TwitchStreamers.getTwitchAccountsFromCache (twitch_streamers.class.ts:99-107) → twitch:accounts JSON. Keys: twitch.accounts. Why: The published JSON array is built from node-redis HGETALL objects (server field order). **Rule:** If Rust publishes twitch:accounts, keep HGETALL order (Vec<(String,String)>/IndexMap, not HashMap). Readers only JSON.parse, so this is low risk.
- **Date/time strings** — plan_tier_until = new Date(x).toDateString() (twitch_streamers.class.ts:134,428; Rust utils/twitch_streamers/mapping.rs), logger timestamp toLocaleString("en-US",{timeZone:"UTC"}) (logger.ts:33; Rust ai_usage_receipts/queue.rs:196 logger_timestamp), utcDay toISOString().slice(0,10), metrics minute bucket yyyyMMddHHmm UTC (bot_runtime_metrics.ts:123). Keys: accounts.data, logger, sa.daily, sa.stats, docs.stats, metrics.family. Why: Part of key names (day, minute bucket) or stored values. **Rule:** toDateString uses the process time zone ("Wed Nov 11 2026"); ISO day UTC; logger timestamp "M/D/YYYY, h:mm:ss AM" — Node/ICU may emit U+202F before AM/PM (Rust emits ASCII space); verify on the production node:24-alpine image before relying on equality.
- **Composite members and ids** — desktop_ai/service.ts:25 queue member "{clientId}:{requestId}", follow_defense_queue.ts:209 createEventID, site_agent stream ids "ms-seq". Keys: desk.queue, fd.queue, sa.events. Why: Members are matched exactly by ZSCORE/ZREM. **Rule:** Same separator and component order.
- **Lua script source text** — every EVAL in TS. Keys: —. Why: TS sends the full script text with EVAL each call (no SHA dependency). redis-rs Script hashes the text it sends; Dragonfly caches by SHA1 of the exact text. **Rule:** No cross-process dependency on script bytes today; if EVALSHA is shared across languages the text (including whitespace and the "-- DIMA032_*" header comments) must be identical.

## Dragonfly / redis-rs vs Redis / node-redis differences

- **Protocol** — Both node-redis 5.12.1 (default) and redis-rs 1.7.1 (default) speak RESP2 to Dragonfly. Do not switch the Rust side to RESP3 without re-checking every reply type below (maps, doubles, nulls, push messages). Sites: utils/databases/dragonfly.database.ts:39, rs/utils/redis.rs
- **HGETALL** — node-redis returns a null-prototype object (field order = reply order); missing key → {} (code checks data.id / account.id). redis-rs → HashMap (order lost) or Vec of pairs; missing key → empty map. Code that serializes the result (twitch:accounts) must keep order. Sites: classes/twitch_streamers.class.ts:102,166, middleware/auth.middleware.ts:139, utils/ai_usage_queue_health.ts:47, rs/workers/ai_usage_receipts/queue.rs:272
- **Null replies** — GET/HGET/LPOP/LINDEX/GETDEL of a missing key → null (TS) / Nil → Option::None (Rust). EVAL: Lua nil or false → null; a Lua table stops at the first nil (so {nil, x} returns []). Scripts returning nil: ast_timer CLAIM, aiusage.claim, CLIP recover. BLPOP/BLMOVE timeout → null. Sites: utils/ast_timer_runtime.ts:135, utils/ai_usage_queue_health.ts:17, workers/vod_clip_recommender.worker.ts:166, workers/follow_ledger.worker.ts:165, workers/stream_memory.worker.ts:372
- **Integer vs string replies** — EVAL turns Lua numbers into integer replies (fractions truncated) — TS gets a JS number, code wraps with Number(). Scripts mixing types: TAKE {allowed, used} integers; tts POP {id, payload, session} strings; desktop finish/retire/expire {revision integer, raw string}; follow-defense scripts {0|1, string}; desktop.readSlot {raw, revisionString}; rust BACKLOG_HEALTH {count, scoreString}. Rust must decode heterogeneous arrays (redis::Value or tuples). SISMEMBER/EXISTS/SETNX-style replies are integers in RESP2 (node-redis v5 returns numbers: code compares === 1). Sites: site_agent/limits.ts:32, utils/tts/tts_session.util.ts:53, desktop_ai/activity.ts:84-269, utils/permissions/roles.ts:341,411,418
- **SET with NX / GET options** — SET NX returns "OK" or null (TS compares === "OK" or truthiness; command_cooldown_write.ts:33 uses !await). Rust: Option<String>. node-redis option objects map to: {EX}, {PX}, {NX:true, EX|PX}, {KEEPTTL:true} (dimadb), PXAT only via Lua. Sites: classes/twitch_streamers.class.ts:211, utils/command_cooldown_write.ts:33, handlers/commands.handler.ts:167
- **Argument encoding** — node-redis v5 stringifies number arguments with JS Number#toString (set(key, Date.now()), set(key, 0), zAdd scores, hIncrBy increments, EX values). eval({arguments}) must already be strings (code uses String()). A non-integer hIncrBy increment fails with ERR; JS integers above 2^53 lose precision. Rust: pass i64/u64 or pre-formatted strings. Sites: server/websocket.ts:94, commands/only_emotes.command.ts:81, utils/tts_usage.ts:99-125
- **MULTI/EXEC** — node-redis multi().exec() returns the reply array (site_agent/store.ts:253 and docs_assistant.ts:158 consume results positionally); a command error rejects exec with a MultiErrorReply. Dragonfly executes MULTI atomically across shards. Rust: redis::pipe().atomic() and decode the tuple in the same order. Sites: site_agent/store.ts:249-253, utils/ai/docs_assistant/docs_assistant.ts:158
- **Lua under Dragonfly** — Dragonfly runs scripts atomically only over declared KEYS; undeclared key access fails unless --default_lua_flags=allow-undeclared-keys (TS comments: tts_session.util.ts:3, ast_timer_runtime.ts:127). All TS scripts declare their keys (optional KEYS[2]/[3] are passed or omitted). Rust library scripts IDS (SSCAN) and HASH_IDS (SCAN inside Lua) in twitch_streamers/adapters.rs need verification on Dragonfly before use. redis.call("TIME"), cjson, redis.pcall + redis.error_reply are used and supported. Sites: utils/tts/tts_session.util.ts:3, rs/utils/twitch_streamers/adapters.rs:248-262, utils/follow_defense_queue.ts:120
- **EVAL vs EVALSHA** — TS always sends EVAL with the full text. redis-rs Script::invoke_async uses EVALSHA and falls back to EVAL on NOSCRIPT, but explicit pipe().cmd("EVALSHA") in the Rust library (plan_cache_fence.rs:535, twitch_streamers/adapters.rs:433) fails after a Dragonfly restart/SCRIPT FLUSH unless the scripts are loaded first. Sites: rs/utils/plan_cache_fence.rs:514-578, rs/utils/twitch_streamers/adapters.rs:403-433
- **Blocking commands** — BLPOP (follow-ledger) and BLMOVE via sendCommand (stream-memory LEFT→RIGHT, vod-clip RIGHT→LEFT) run on the shared node-redis connection. In Rust, a ConnectionManager clone shares one multiplexed socket: a blocking command would stall every task of that process; use a dedicated connection with no response timeout (as redis.rs documents). Sites: workers/follow_ledger.worker.ts:165, workers/stream_memory.worker.ts:372, workers/vod_clip_recommender.worker.ts:296, rs/utils/cron_queue.rs:489
- **Pub/Sub** — node-redis needs a duplicate connection in subscriber mode; the callback gets (message, channel) strings. redis-rs ConnectionManager cannot SUBSCRIBE under RESP2: use client.get_async_pubsub() on a dedicated connection and re-subscribe after reconnect (node-redis does it automatically). Sites: classes/pubsub_manager.class.ts:17-26, utils/domain_event_wakeups.ts:85
- **SCAN / KEYS** — KEYS is used on hot paths (TwitchStreamers cache read twitch_streamers.class.ts:99, roles.ts:251-320, tts_queue.handler.ts:1187,1288, speech.ts:21, clip_queue.handler.ts:290, cache.ts:58). scanIterator in node-redis v5 yields arrays of keys per page (site_agent/cleanup.ts:13 handles both). Dragonfly KEYS/SCAN glob semantics match Redis; SCAN COUNT is a hint. Sites: classes/twitch_streamers.class.ts:99, site_agent/cleanup.ts:13
- **DEL is not a glob** — clip_queue.handler.ts:317 calls DEL "twitch:*:clip:processing" — a literal key, so it deletes nothing. Keep or fix consciously; do not assume it clears locks. Sites: handlers/clip_queue.handler.ts:317
- **Streams** — XADD with MAXLEN ~ 4000: node-redis TRIM option; Dragonfly may trim exactly. XRANGE replies → [{id, message:{e}}] in TS, Vec<StreamId> in redis-rs. Sites: site_agent/store.ts:329-353
- **Sorted-set scores** — zRangeWithScores returns JS numbers parsed from score strings; redis-rs f64. ZADD LT (follow_defense_baseline.ts:34) needs Redis ≥ 6.2 semantics (supported by Dragonfly). zPopMin returns {value, score} or null. Sites: utils/follow_defense_baseline.ts:34, handlers/clip_queue.handler.ts:104
- **Non-atomic TTL writes** — Many TS writes do SET then EXPIRE (logger.ts:82-83, evaluator.ts:491-501, auth.middleware.ts:45-46,166-173, metrics). A crash between leaves a key without TTL. A Rust port may use SET EX (the Rust logger already does) — semantically compatible. Sites: utils/logger.ts:82, rs/utils/logger/redis.rs:30
- **INFO fields** — dima-analytics parses INFO (used_memory, used_memory_rss, maxmemory, evicted_keys, expired_keys, keyspace_hits, keyspace_misses, connected_clients, instantaneous_ops_per_sec); Dragonfly reports these names but values/semantics can differ from Redis. Sites: dima-analytics/src/collectors.mjs:37-38

## Rules a Rust implementation must follow

1. Key names are an API: reuse the exact templates in `keys[]`, including legacy duplicates that are still read or deleted ({c}:ai:exhaust, {c}:follows:count, {c}:commands:{cmd}, twitch:{c}:commands:{cmd}, streamers:by:name, {c}:channel:editors, {c}:admins*). Never introduce a new key that a TS process must honour (the Rust library keys streamers:directory:*, locks:streamers:reconcile are unknown to TS).
2. Use the same Lua script semantics (copy the source text verbatim, keep KEYS order and ARGV meaning); declare every key a script touches (Dragonfly).
3. Every fenced write goes through the same fence: plan fence (WRITE/ACCEPT/SYNC/INVALIDATE scripts), owner-checked lock release/extend, site-agent CAS/lease, desktop slot fence, keyword revision. Never write a fenced key with a plain SET.
4. Value encodings: JSON written by Rust must parse to the same shape TS expects (camelCase names, omit absent optionals, numbers as numbers, booleans as strings in hashes where TS uses "true"/"false").
5. Byte-sensitive items (`byteSensitive[]`) must be produced bit-exact; values removed by value (LREM/LPOS) must be the raw bytes read, never re-serialized.
6. Readers must tolerate Lua cjson re-encoding (key order, "\/", exponent numbers, {} for empty arrays) and JS formatting (integral floats without ".0").
7. TTL policy: keep the same TTL source (EX vs PX vs PXAT, refresh-on-write vs set-once) because other processes rely on expiry for lock recovery and cache freshness.
8. Queues: keep producer/consumer direction (LPUSH+head-pop LIFO for cron:jobs and stream-memory, FIFO elsewhere), processing lists, dead-letter targets, attempt limits and the single-consumer worker locks; only one consumer implementation (TS or Rust) may run per queue at a time unless the lock is shared.
9. Pub/Sub payloads are JSON strings; PubSubManager adds a numeric "timestamp" field. Subscribers in Rust need a dedicated pub/sub connection and must re-subscribe after reconnect.
10. Connections: one multiplexed command connection per process; separate dedicated connections for blocking commands, pub/sub and telemetry (telemetry must not queue offline or retry).
11. RESP2 only; decode EVAL replies as heterogeneous redis::Value where scripts mix integers and strings.
12. When a TS function is ported, port all its call sites listed in `keys[].writers/readers/luaRefs` for that process; a key is migrated only when every writer and reader is accounted for.

## Process legend

- `api`: dima-server (node dist/server/index.js)
- `bot`: dima-bot (node dist/bot/index.js)
- `cron:<worker>`: TS worker child of dima-cron supervisor (dist/workers/<worker>.worker.js)
- `cron:*(N workers)`: reachable from ≥15 cron workers
- `rust:<worker>`: native worker binary in dima-cron (dima-rust/src/supervisor/registry.rs)
- `rust-lib:<module>`: Rust library port not wired into any deployed binary
- `script:<name>`: manual maintenance script
- `dima-analytics`: analytics service
- `dimadb`: DB console
