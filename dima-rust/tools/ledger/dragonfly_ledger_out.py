"""Output half of dragonfly_ledger.py: static contract sections and JSON/Markdown rendering."""
import collections, datetime, json, os, re

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
OUT_JSON = os.path.join(ROOT, 'dima-rust', 'ledger', 'dragonfly.json')
OUT_MD = os.path.join(ROOT, 'dima-rust', 'ledger', 'dragonfly.md')

# Records that describe an access path rather than a distinct key pattern.
PSEUDO = {'fd.zhelpers', 'dimadb.any', 'analytics.queue.scan'}
RUST_LIB_ONLY = {'rs.directory.revision', 'rs.directory.generation', 'rs.streamers.lease'}

CLIENTS = [
    dict(process='dimabot api / bot / every cron worker child (each worker is its own node process spawned by cron.index.ts)',
         connection='main command connection', source='dimabot/src/utils/databases/dragonfly.database.ts:35',
         count='1 per process (module singleton promise; failed init is retryable)',
         options='createClient({ url: redis://$DRAGONFLY_HOST:$DRAGONFLY_PORT }) — node-redis 5.12.1 defaults: RESP2, offline queue ON (commands queue while reconnecting), '
                 'default reconnect strategy (exponential back-off with jitter), no password/TLS/SELECT, no ping interval',
         used_for='all key commands, EVAL, MULTI, and the blocking BLPOP (cron:follow-ledger) / BLMOVE (cron:stream-memory, cron:vod-clip-recommender) — '
                  'a blocking call holds this single connection for up to 5 s, so every other command of that worker waits behind it',
         telemetry='Returned as a Proxy: get, set, hGet, hGetAll, hSet, exists, del, zAdd, zPopMin, zCard, lPush, rPush, lPop, rPop, eval are wrapped with '
                   'beginSpan("cache", method) and for get/hGet observe("cache_lookup", ..., hit|miss). Every other method (multi, sendCommand, blPop, '
                   'hIncrBy, ...) is passed through bound and is NOT measured. Errors are logged at most once per 30 s per (caller, code, message).'),
    dict(process='api, bot, cron workers that import PubSubManager', connection='PubSubManager publisher + subscriber',
         source='dimabot/src/classes/pubsub_manager.class.ts:13-27', count='2 per process, created lazily on first publish/subscribe (client.duplicate() of the main client)',
         options='same options as the main client; the subscriber is in subscribe mode; node-redis re-subscribes on reconnect',
         used_for='channels twitch:{c}:clip:request, tts:session-ended:v1, widget-feed, keywords:changed (subscribe side)',
         telemetry='not wrapped (duplicate() of the raw client)'),
    dict(process='every TS process that calls startTelemetry()', connection='telemetry flush client', source='dimabot/src/utils/observability/telemetry.ts:178-186',
         count='0–1 per process, recreated when not ready', options='disableOfflineQueue: true, socket.connectTimeout 1000, reconnectStrategy false; destroyed if a flush exceeds 1800 ms; '
         'DRAGONFLY_PORT defaults to 6379 here only', used_for='Lua telemetry ENQUEUE into observability:v1:inbox', telemetry='none (would recurse)'),
    dict(process='api (pets runtime + desktop activity subscribers, pet wake publisher), cron:domain-events (subscriber), any process calling utils/domain_events.ts (publisher)',
         connection='DomainEventWakeups hint client', source='dimabot/src/utils/domain_event_wakeups.ts:69-79',
         count='1 per DomainEventWakeups instance (domainEventWakeups singleton, PetWakeupPublisher, each subscribePetWakeups call, domain-events worker)',
         options='disableOfflineQueue, reconnectStrategy false, connectTimeout = timeoutMs, commandsQueueMaxLength 4, unref(); publisher closes after 30 s idle; '
                 'DOMAIN_EVENTS_WAKEUPS_ENABLED=false disables', used_for='PUBLISH/SUBSCRIBE domain-events:wakeup:v1 and pet:runtime:wake:v1', telemetry='none'),
    dict(process='dimabot scripts (manual, tsx)', connection='own getDragonflyClient / createClient', source='dimabot/src/scripts/*.script.ts',
         count='1 per run', options='as main client', used_for='one-off maintenance (invalidate_all_user_permissions, migrate_*, reconcile_stream_offline)', telemetry='as main client'),
    dict(process='Rust workers (ai-usage-receipts, follow-defense-baseline, raid-sessions, dashboard-activity)', connection='redis::aio::ConnectionManager',
         source='dima-rust/src/utils/redis.rs:100-140', count='1 per process (tokio OnceCell, cached after first successful connect + PING)',
         options='redis-rs 1.7.1 (features tokio-rustls-comp, script, connection-manager), RESP2, plain TCP, DB 0; 5 s bound on initial connect+PING; '
                 'response timeout unset (keeps blocking-command semantics); reconnects after I/O errors but the in-flight command fails and is not replayed',
         used_for='all Rust key commands and EVAL; cloned handles share one multiplexed socket (no blocking commands are issued by deployed workers)', telemetry='none'),
    dict(process='Rust cron-index supervisor', connection='telemetry flush connection', source='dima-rust/src/supervisor/telemetry.rs:496-525',
         count='fresh multiplexed connection per flush', options='connection timeout + response timeout; dropped on timeout', used_for='same Lua ENQUEUE as TS telemetry', telemetry='n/a'),
    dict(process='dima-analytics', connection='single client', source='dima-analytics/src/index.mjs:128-130', count='1',
         options='createClient({ url: REDIS_URL || redis://dragonfly:6379, disableOfflineQueue: true, socket.connectTimeout 3000 }); error events swallowed',
         used_for='observability inbox drain (LINDEX/LMOVE/LREM), INFO + queue SCAN collectors, token:{t} session lookup, identity/infra caches, accounts name lookup', telemetry='none'),
    dict(process='dimadb/server', connection='one client per configured connection id', source='dimadb/server/redis.mjs:17-30', count='1 per configured Redis connection, cached',
         options='createClient({ url }) defaults', used_for='operator console: SCAN/TYPE/TTL/GET/SET/HSET/... and raw sendCommand (dangerous commands need confirm)', telemetry='none'),
    dict(process='dimafx/server, dima-hoststats', connection='none', source='searched dimafx/server/src and dima-hoststats/src', count='0', options='-', used_for='no Redis use', telemetry='-'),
]

BYTE_SENSITIVE = [
    dict(item='Plan fence versions', where='dimabot/src/utils/plan_cache_fence.ts:4 planCacheVersion; domain_events/polar_billing_events.ts:233 polar version',
         keys=['plan.fence', 'ai.credits.polar', 'accounts.data (__polar_plan_version field)', 'ai.credits (__polar_plan_version)'],
         why='Lua compares with string ">" (lexicographic byte order).',
         rule='Produce exactly String(epochMs).padStart(13,"0") + ":" + eventKey (Rust: format!("{ms:013}:{key}"), ms ≥ 0); empty string when either part is missing.'),
    dict(item='Raw-value compare-and-set', where='ACCEPT_PLAN_CREDITS_SCRIPT read mode (billing.ts:1240), site_agent SET_IF_SAME (store.ts:205), keyword setIfRevision (keyword_cache.ts:22,59)',
         keys=['ai.credits', 'sa.session', 'kw.revision'], why='The script compares the current value with ARGV byte-for-byte.',
         rule='Pass back the exact bytes previously read (GET result, or "0" for a missing revision). Never re-serialize a parsed value.'),
    dict(item='Queue elements removed by value (LREM / LPOS)', where='stream_memory.worker.ts:381-399, CLIP_CLAIM_SCRIPTS, ai_usage_queue_health.ts complete/fail, '
         'dima-rust ai_usage_receipts/queue.rs complete/fail, dima-analytics index.mjs:147-153, durable_cron_jobs.ts PUBLISH_DURABLE_CRON_JOB (LPOS)',
         keys=['q.memory.processing', 'q.clips.processing', 'q.receipts.processing', 'q.backfills.processing', 'obs.processing', 'q.memory', 'q.clips'],
         why='LREM/LPOS match whole elements byte-for-byte; a re-encoded copy is never found (stuck processing entry or duplicate publish).',
         rule='Keep the raw popped string and use it for LREM/requeue. For PUBLISH_DURABLE_CRON_JOB, serialize the Mongo intent payload exactly like JSON.stringify of the '
              'mongoose lean document (BSON key order, undefined omitted, JS number formatting) or duplicates appear (fenced only by the Mongo claim).'),
    dict(item='CronQueueJob JSON', where='dimabot/src/utils/cron_jobs_queue.ts:77 serializeCronQueueJob; dima-rust/src/utils/cron_queue.rs (library port, own JS number formatter at :630-660)',
         keys=['q.cronjobs', 'q.cronjobs.dead', 'q.memory', 'q.clips', 'q.memory.dead'],
         why='Requeue/dead-letter copies and LPOS dedupe depend on identical bytes.',
         rule='Field order id, job, requestedAt, requestedBy?, userID?, accountID?, channelID?, data?, dedupeKey?; omit absent fields (serde skip_serializing_if); '
              'JS number formatting inside data (1 not 1.0, 1e21 style exponents).'),
    dict(item='Attempt-counter key hashes', where='ai_usage_queue_health.ts:21,27; dima-rust ai_usage_receipts/queue.rs:167,178',
         keys=['q.receipts.attempts', 'q.backfills.attempts'], why='Key = sha256 hex of the raw element.', rule='Hash the exact UTF-8 bytes of the raw element; lowercase hex.'),
    dict(item='Keys hashed from JSON arrays', where='ai_usage_lock.ts:5 (locks.aiusage), moderation/spam.ts:91 (mod.seen), ast_parser/effects.ts:83 (widget.signal.seen actionKey), '
         'ai/ast_catalog/index.ts:52 (ast.catalog.vectors)', keys=['locks.aiusage', 'mod.seen', 'widget.signal.seen', 'ast.catalog.vectors'],
         why='sha256(JSON.stringify([...])) is part of the key.',
         rule='Serialize the array exactly like JSON.stringify: no spaces, strings escaped with \\" \\\\ \\b \\f \\n \\r \\t and lowercase \\u00XX for other controls, non-ASCII '
              'kept as UTF-8 (serde_json::to_string matches for valid Unicode), integers without ".0" (LFM2_EMBEDDING_DIM, signalNext). Then lowercase hex sha256; '
              'ast catalog keeps the first 24 hex chars.'),
    dict(item='Other hashed key parts', where='billing.ts:362 (sha256hex(customerId)[0:20]), billing.ts:277 (sha256hex(externalId)), ai_usage_receipts.ts:837-842 '
         '(sha256hex[0:16|12|12]), follow_defense_summary.ts:12 (sha256hex(eventID)), docs/sections.ts:86 hashText (sha256hex[0:24] of "model|format|text"), '
         'overlay-token.ts:14 (pet:audio sha256 hex), dima-analytics index.mjs:29 (sha256 hex of bearer token)',
         keys=['billing.packctx', 'ai.usage.local', 'ai.receipts.cache', 'fd.suppressed', 'docs.vectors', 'pet.audio', 'obs.identity'],
         why='Hex digests in key names.', rule='sha256 of the UTF-8 string, lowercase hex, truncated to the stated length.'),
    dict(item='base64url digests', where='server/oauth/service.ts:15 hash(); utils/rate_limit.ts:16', keys=['oauth.request', 'oauth.code', 'oauth.access', 'oauth.rate', 'ratelimit'],
         why='createHash("sha256").digest("base64url") in key names.', rule='URL-safe base64 alphabet (-_), NO "=" padding (43 chars for sha256).'),
    dict(item='Raw secret in key name', where='middleware/auth.middleware.ts:122-173, server/routes/validation.route.ts:28, dima-analytics index.mjs:36',
         keys=['auth.token'], why='token:{rawTwitchAccessToken}', rule='Use the bearer token string exactly as received (after stripping "Bearer "); never log the key.'),
    dict(item='Lowercased logins in keys / members', where='utils/moderation/permit.ts:83 (login.toLowerCase()), commands/sumimetro.command.ts:46-78, utils/permissions/roles.ts:215-313 '
         '(editors/admins sets and adminName), utils/ast_parser/evaluator.ts:186 normalizeUserLogin (trim, strip leading "@", lowercase)',
         keys=['mod.permit', 'sumimetro.user', 'roles.editors', 'roles.admins', 'roles.admins.detail', 'ast.variable'],
         why='Members/keys are compared as bytes.',
         rule='Apply String(x).toLowerCase() semantics: full Unicode default lowercase (Rust str::to_lowercase matches JS, including final-sigma). For ast.variable also trim JS whitespace '
              'and strip leading "@"s before lowercasing. validation.route.ts:56 checks the admins set with the login from token:{t} unmodified.'),
    dict(item='Numbers formatted to strings', where='String(Date.now()), String(expiresAt) unix seconds, String(n) counters (siteanalytics.ts:103-111), usage.cost.toFixed(6) '
         '(docs_assistant.ts:186 cost_usd), Math.round(usd*1e5) (tts_usage.ts:112), Math.round(cost*1e6) (docs_assistant.ts:173, site_agent usage micro()), '
         'zAdd scores, Lua tostring(count)', keys=['accounts.data', 'site.analytics', 'docs.answer', 'tts.usage', 'clips.lastactivity', 'triggers.activity', 'tts.lastcleanup', 'follows.event'],
         why='Readers parse them back, but HINCRBY requires an integer string and some values are compared.',
         rule='Integers in plain decimal without exponent or ".0"; HINCRBY increments must be integers (JS non-integer would error — keep rounding where TS rounds); '
              'toFixed(6) → format!("{:.6}") (beware JS toFixed rounding of binary values, e.g. 1.0000005).'),
    dict(item='JSON number formatting of floats', where='follow_defense_baseline (TS utils/follow_defense_baseline.ts:54 vs Rust workers/follow_defense_baseline.rs:308), '
         'ai-usage queue-health snapshot (ai_usage_queue_health.ts:61 vs queue.rs:327)', keys=['fd.baseline', 'aiusage.health.snapshot', 'aiusage.health'],
         why='serde_json prints f64 3.0 as "3.0" and 0 as "0.0"; JS prints "3" / "0". Already divergent in production; readers JSON.parse so values agree.',
         rule='Byte equality is not required for these keys today; if any consumer starts comparing raw values, format f64 the JS way (shortest round-trip, integral without ".0").'),
    dict(item='Values re-encoded by Lua cjson', where='APPLY_AI_CREDIT_USAGE_SCRIPT, desktop activity scripts, tts ENQUEUE, follow_defense projectState / summary scripts',
         keys=['ai.credits', 'desk.slot', 'tts.queue.data', 'fd.state', 'fd.summary'],
         why='cjson.encode reorders object keys, escapes "/" as "\\/", formats numbers with %.14g (14 significant digits; larger values become exponent form) and encodes '
             'empty arrays as {}.',
         rule='Rust readers must accept any key order, "\\/" escapes, exponent numbers and {} where an empty array is expected; never byte-compare these values '
              '(except via the raw-value rule above).'),
    dict(item='HGETALL field order', where='TwitchStreamers.getTwitchAccountsFromCache (twitch_streamers.class.ts:99-107) → twitch:accounts JSON', keys=['twitch.accounts'],
         why='The published JSON array is built from node-redis HGETALL objects (server field order).',
         rule='If Rust publishes twitch:accounts, keep HGETALL order (Vec<(String,String)>/IndexMap, not HashMap). Readers only JSON.parse, so this is low risk.'),
    dict(item='Date/time strings', where='plan_tier_until = new Date(x).toDateString() (twitch_streamers.class.ts:134,428; Rust utils/twitch_streamers/mapping.rs), '
         'logger timestamp toLocaleString("en-US",{timeZone:"UTC"}) (logger.ts:33; Rust ai_usage_receipts/queue.rs:196 logger_timestamp), utcDay toISOString().slice(0,10), '
         'metrics minute bucket yyyyMMddHHmm UTC (bot_runtime_metrics.ts:123)', keys=['accounts.data', 'logger', 'sa.daily', 'sa.stats', 'docs.stats', 'metrics.family'],
         why='Part of key names (day, minute bucket) or stored values.',
         rule='toDateString uses the process time zone ("Wed Nov 11 2026"); ISO day UTC; logger timestamp "M/D/YYYY, h:mm:ss AM" — Node/ICU may emit U+202F before AM/PM '
              '(Rust emits ASCII space); verify on the production node:24-alpine image before relying on equality.'),
    dict(item='Composite members and ids', where='desktop_ai/service.ts:25 queue member "{clientId}:{requestId}", follow_defense_queue.ts:209 createEventID, '
         'site_agent stream ids "ms-seq"', keys=['desk.queue', 'fd.queue', 'sa.events'], why='Members are matched exactly by ZSCORE/ZREM.', rule='Same separator and component order.'),
    dict(item='Lua script source text', where='every EVAL in TS', keys=[], why='TS sends the full script text with EVAL each call (no SHA dependency). redis-rs Script hashes the text '
         'it sends; Dragonfly caches by SHA1 of the exact text.', rule='No cross-process dependency on script bytes today; if EVALSHA is shared across languages the text (including '
         'whitespace and the "-- DIMA032_*" header comments) must be identical.'),
]

DIFFERENCES = [
    dict(topic='Protocol', detail='Both node-redis 5.12.1 (default) and redis-rs 1.7.1 (default) speak RESP2 to Dragonfly. Do not switch the Rust side to RESP3 without re-checking '
         'every reply type below (maps, doubles, nulls, push messages).', sites=['dimabot/src/utils/databases/dragonfly.database.ts:39', 'dima-rust/src/utils/redis.rs']),
    dict(topic='HGETALL', detail='node-redis returns a null-prototype object (field order = reply order); missing key → {} (code checks data.id / account.id). redis-rs → '
         'HashMap (order lost) or Vec of pairs; missing key → empty map. Code that serializes the result (twitch:accounts) must keep order.',
         sites=['dimabot/src/classes/twitch_streamers.class.ts:102,166', 'dimabot/src/middleware/auth.middleware.ts:139', 'dimabot/src/utils/ai_usage_queue_health.ts:47',
                'dima-rust/src/workers/ai_usage_receipts/queue.rs:272']),
    dict(topic='Null replies', detail='GET/HGET/LPOP/LINDEX/GETDEL of a missing key → null (TS) / Nil → Option::None (Rust). EVAL: Lua nil or false → null; a Lua table stops at the first nil '
         '(so {nil, x} returns []). Scripts returning nil: ast_timer CLAIM, aiusage.claim, CLIP recover. BLPOP/BLMOVE timeout → null.',
         sites=['dimabot/src/utils/ast_timer_runtime.ts:135', 'dimabot/src/utils/ai_usage_queue_health.ts:17', 'dimabot/src/workers/vod_clip_recommender.worker.ts:166',
                'dimabot/src/workers/follow_ledger.worker.ts:165', 'dimabot/src/workers/stream_memory.worker.ts:372']),
    dict(topic='Integer vs string replies', detail='EVAL turns Lua numbers into integer replies (fractions truncated) — TS gets a JS number, code wraps with Number(). Scripts mixing types: '
         'TAKE {allowed, used} integers; tts POP {id, payload, session} strings; desktop finish/retire/expire {revision integer, raw string}; follow-defense scripts {0|1, string}; '
         'desktop.readSlot {raw, revisionString}; rust BACKLOG_HEALTH {count, scoreString}. Rust must decode heterogeneous arrays (redis::Value or tuples). '
         'SISMEMBER/EXISTS/SETNX-style replies are integers in RESP2 (node-redis v5 returns numbers: code compares === 1).',
         sites=['dimabot/src/site_agent/limits.ts:32', 'dimabot/src/utils/tts/tts_session.util.ts:53', 'dimabot/src/desktop_ai/activity.ts:84-269', 'dimabot/src/utils/permissions/roles.ts:341,411,418']),
    dict(topic='SET with NX / GET options', detail='SET NX returns "OK" or null (TS compares === "OK" or truthiness; command_cooldown_write.ts:33 uses !await). Rust: Option<String>. '
         'node-redis option objects map to: {EX}, {PX}, {NX:true, EX|PX}, {KEEPTTL:true} (dimadb), PXAT only via Lua.',
         sites=['dimabot/src/classes/twitch_streamers.class.ts:211', 'dimabot/src/utils/command_cooldown_write.ts:33', 'dimabot/src/handlers/commands.handler.ts:167']),
    dict(topic='Argument encoding', detail='node-redis v5 stringifies number arguments with JS Number#toString (set(key, Date.now()), set(key, 0), zAdd scores, hIncrBy increments, EX values). '
         'eval({arguments}) must already be strings (code uses String()). A non-integer hIncrBy increment fails with ERR; JS integers above 2^53 lose precision. Rust: pass i64/u64 or '
         'pre-formatted strings.', sites=['dimabot/src/server/websocket.ts:94', 'dimabot/src/commands/only_emotes.command.ts:81', 'dimabot/src/utils/tts_usage.ts:99-125']),
    dict(topic='MULTI/EXEC', detail='node-redis multi().exec() returns the reply array (site_agent/store.ts:253 and docs_assistant.ts:158 consume results positionally); a command error rejects '
         'exec with a MultiErrorReply. Dragonfly executes MULTI atomically across shards. Rust: redis::pipe().atomic() and decode the tuple in the same order.',
         sites=['dimabot/src/site_agent/store.ts:249-253', 'dimabot/src/utils/ai/docs_assistant/docs_assistant.ts:158']),
    dict(topic='Lua under Dragonfly', detail='Dragonfly runs scripts atomically only over declared KEYS; undeclared key access fails unless --default_lua_flags=allow-undeclared-keys '
         '(TS comments: tts_session.util.ts:3, ast_timer_runtime.ts:127). All TS scripts declare their keys (optional KEYS[2]/[3] are passed or omitted). '
         'Rust library scripts IDS (SSCAN) and HASH_IDS (SCAN inside Lua) in twitch_streamers/adapters.rs need verification on Dragonfly before use. '
         'redis.call("TIME"), cjson, redis.pcall + redis.error_reply are used and supported.',
         sites=['dimabot/src/utils/tts/tts_session.util.ts:3', 'dima-rust/src/utils/twitch_streamers/adapters.rs:248-262', 'dimabot/src/utils/follow_defense_queue.ts:120']),
    dict(topic='EVAL vs EVALSHA', detail='TS always sends EVAL with the full text. redis-rs Script::invoke_async uses EVALSHA and falls back to EVAL on NOSCRIPT, but explicit '
         'pipe().cmd("EVALSHA") in the Rust library (plan_cache_fence.rs:535, twitch_streamers/adapters.rs:433) fails after a Dragonfly restart/SCRIPT FLUSH unless the scripts are loaded first.',
         sites=['dima-rust/src/utils/plan_cache_fence.rs:514-578', 'dima-rust/src/utils/twitch_streamers/adapters.rs:403-433']),
    dict(topic='Blocking commands', detail='BLPOP (follow-ledger) and BLMOVE via sendCommand (stream-memory LEFT→RIGHT, vod-clip RIGHT→LEFT) run on the shared node-redis connection. '
         'In Rust, a ConnectionManager clone shares one multiplexed socket: a blocking command would stall every task of that process; use a dedicated connection with no '
         'response timeout (as redis.rs documents).', sites=['dimabot/src/workers/follow_ledger.worker.ts:165', 'dimabot/src/workers/stream_memory.worker.ts:372',
                                                            'dimabot/src/workers/vod_clip_recommender.worker.ts:296', 'dima-rust/src/utils/cron_queue.rs:489']),
    dict(topic='Pub/Sub', detail='node-redis needs a duplicate connection in subscriber mode; the callback gets (message, channel) strings. redis-rs ConnectionManager cannot SUBSCRIBE under '
         'RESP2: use client.get_async_pubsub() on a dedicated connection and re-subscribe after reconnect (node-redis does it automatically).',
         sites=['dimabot/src/classes/pubsub_manager.class.ts:17-26', 'dimabot/src/utils/domain_event_wakeups.ts:85']),
    dict(topic='SCAN / KEYS', detail='KEYS is used on hot paths (TwitchStreamers cache read twitch_streamers.class.ts:99, roles.ts:251-320, tts_queue.handler.ts:1187,1288, speech.ts:21, '
         'clip_queue.handler.ts:290, cache.ts:58). scanIterator in node-redis v5 yields arrays of keys per page (site_agent/cleanup.ts:13 handles both). '
         'Dragonfly KEYS/SCAN glob semantics match Redis; SCAN COUNT is a hint.', sites=['dimabot/src/classes/twitch_streamers.class.ts:99', 'dimabot/src/site_agent/cleanup.ts:13']),
    dict(topic='DEL is not a glob', detail='clip_queue.handler.ts:317 calls DEL "twitch:*:clip:processing" — a literal key, so it deletes nothing. Keep or fix consciously; do not assume it clears locks.',
         sites=['dimabot/src/handlers/clip_queue.handler.ts:317']),
    dict(topic='Streams', detail='XADD with MAXLEN ~ 4000: node-redis TRIM option; Dragonfly may trim exactly. XRANGE replies → [{id, message:{e}}] in TS, Vec<StreamId> in redis-rs.',
         sites=['dimabot/src/site_agent/store.ts:329-353']),
    dict(topic='Sorted-set scores', detail='zRangeWithScores returns JS numbers parsed from score strings; redis-rs f64. ZADD LT (follow_defense_baseline.ts:34) needs Redis ≥ 6.2 semantics '
         '(supported by Dragonfly). zPopMin returns {value, score} or null.', sites=['dimabot/src/utils/follow_defense_baseline.ts:34', 'dimabot/src/handlers/clip_queue.handler.ts:104']),
    dict(topic='Non-atomic TTL writes', detail='Many TS writes do SET then EXPIRE (logger.ts:82-83, evaluator.ts:491-501, auth.middleware.ts:45-46,166-173, metrics). A crash between leaves a key '
         'without TTL. A Rust port may use SET EX (the Rust logger already does) — semantically compatible.', sites=['dimabot/src/utils/logger.ts:82', 'dima-rust/src/utils/logger/redis.rs:30']),
    dict(topic='INFO fields', detail='dima-analytics parses INFO (used_memory, used_memory_rss, maxmemory, evicted_keys, expired_keys, keyspace_hits, keyspace_misses, connected_clients, '
         'instantaneous_ops_per_sec); Dragonfly reports these names but values/semantics can differ from Redis.', sites=['dima-analytics/src/collectors.mjs:37-38']),
]

RULES = [
    'Key names are an API: reuse the exact templates in `keys[]`, including legacy duplicates that are still read or deleted ({c}:ai:exhaust, {c}:follows:count, {c}:commands:{cmd}, '
    'twitch:{c}:commands:{cmd}, streamers:by:name, {c}:channel:editors, {c}:admins*). Never introduce a new key that a TS process must honour (the Rust library keys '
    'streamers:directory:*, locks:streamers:reconcile are unknown to TS).',
    'Use the same Lua script semantics (copy the source text verbatim, keep KEYS order and ARGV meaning); declare every key a script touches (Dragonfly).',
    'Every fenced write goes through the same fence: plan fence (WRITE/ACCEPT/SYNC/INVALIDATE scripts), owner-checked lock release/extend, site-agent CAS/lease, desktop slot fence, '
    'keyword revision. Never write a fenced key with a plain SET.',
    'Value encodings: JSON written by Rust must parse to the same shape TS expects (camelCase names, omit absent optionals, numbers as numbers, booleans as strings in hashes where TS uses "true"/"false").',
    'Byte-sensitive items (`byteSensitive[]`) must be produced bit-exact; values removed by value (LREM/LPOS) must be the raw bytes read, never re-serialized.',
    'Readers must tolerate Lua cjson re-encoding (key order, "\\/", exponent numbers, {} for empty arrays) and JS formatting (integral floats without ".0").',
    'TTL policy: keep the same TTL source (EX vs PX vs PXAT, refresh-on-write vs set-once) because other processes rely on expiry for lock recovery and cache freshness.',
    'Queues: keep producer/consumer direction (LPUSH+head-pop LIFO for cron:jobs and stream-memory, FIFO elsewhere), processing lists, dead-letter targets, attempt limits and '
    'the single-consumer worker locks; only one consumer implementation (TS or Rust) may run per queue at a time unless the lock is shared.',
    'Pub/Sub payloads are JSON strings; PubSubManager adds a numeric "timestamp" field. Subscribers in Rust need a dedicated pub/sub connection and must re-subscribe after reconnect.',
    'Connections: one multiplexed command connection per process; separate dedicated connections for blocking commands, pub/sub and telemetry (telemetry must not queue offline or retry).',
    'RESP2 only; decode EVAL replies as heterogeneous redis::Value where scripts mix integers and strings.',
    'When a TS function is ported, port all its call sites listed in `keys[].writers/readers/luaRefs` for that process; a key is migrated only when every writer and reader is accounted for.',
]


def shared_info(k):
    procs = set()
    for p in k['_procs']:
        if p.startswith('script:') or p.startswith('unreachable') or p.startswith('rust-lib:'):
            continue
        procs.add(p)
    if any(p.startswith('cron:*') for p in procs):
        procs = {p for p in procs if not (p.startswith('cron:') and not p.startswith('cron:*') and p != 'cron:supervisor')}
        stars = sorted(p for p in procs if p.startswith('cron:*'))
        procs = (procs - set(stars)) | {stars[-1]}
    runtime = sorted(procs)
    many = len(runtime) > 1 or any(p.startswith('cron:*') for p in runtime)
    return runtime, many


def dedupe(entries):
    seen, out = set(), []
    for e in entries:
        key = (e['at'], e.get('script'), e['op'])
        if key not in seen:
            seen.add(key); out.append(e)
    return out


def write_outputs(pmap, ts_sites, rs_sites, unmatched, nonkey, counts, KEYS, LUA, PUBSUB, STREAMS, QUEUES, TRANSACTIONS):
    keys_out = []
    for k in KEYS:
        runtime, shared = shared_info(k)
        rec = dict(id=k['id'], pattern=k['pattern'], type=k['type'], value=k['value'], ttl=k['ttl'],
                   kind='access-path' if k['id'] in PSEUDO else ('rust-library-only' if k['id'] in RUST_LIB_ONLY else 'key'),
                   processes=runtime, shared=shared,
                   writers=dedupe(k['writers']), readers=dedupe(k['readers']), luaRefs=dedupe(k['luaRefs']))
        if k['notes']:
            rec['notes'] = k['notes']
        rec['byteSensitive'] = [b['item'] for b in BYTE_SENSITIVE if any(k['id'] == x.split(' ')[0] for x in b['keys'])]
        keys_out.append(rec)
    lua_out = []
    for l in LUA:
        lua_out.append(dict(id=l['id'], source=l['source'], keys=l['keys'], argv=l['argv'], returns=l['returns'], mode=l['mode'],
                            callSites=dedupe(l['callSites']), **({'notes': l['notes']} if l['notes'] else {})))
    real_keys = [k for k in keys_out if k['kind'] == 'key']
    coverage = dict(
        method='scan_ts() finds every node-redis client method call (receiver-filtered for ambiguous names such as get/set/del) in dimabot/src, dima-analytics/src, dimadb/server, '
               'dimafx/server/src and dima-hoststats/src (tests excluded); scan_rs() finds every redis::cmd/.cmd/Script::invoke_async site in dima-rust/src (unit-test modules excluded). '
               'Every site is classified into a key pattern, a Lua script, a multi-key site, or a non-key operation; unmatched sites are listed. Re-run '
               '`python3 dima-rust/tools/ledger/dragonfly_ledger.py --check`.',
        tsCallSites=len(ts_sites), rustCommandSites=len(rs_sites),
        classified={str(a): b for a, b in counts.items()}, unmatched=[f"{u['file']}:{u['line']} {u['method']}" for u in unmatched],
        filesWithRedisCalls=len({s['file'] for s in ts_sites} | {s['file'] for s in rs_sites}),
        luaScripts=len(lua_out), luaEvalCallSitesTs=sum(1 for s in ts_sites if s['method'] == 'eval'),
        delegatingFiles=dict(note='Files that obtain or type a Redis client but issue no command themselves; each was read and passes the client to helpers '
                                  'already covered (permissions/roles.ts, billing.ts isAiCreditsExhausted/getAiCredits, pets/tts_lane.ts) or only warms the connection.',
                             files=__import__('dragonfly_ledger').delegating_files(ts_sites)),
        caveats=['Process attribution is static import reachability from dimabot/src/server/index.ts (api), bot/index.ts (bot), workers/cron.index.ts and each cron worker entry: '
                 '"can run in", an over-approximation.',
                 'Call sites whose key comes from a variable were resolved by reading the code (file-scoped matchers and the TS_MULTI table in the generator).',
                 'Dynamic keys built by Lua from ARGV do not exist (all scripts use KEYS).',
                 'dimadb is a generic operator console: it can read/write any key; it is recorded once as dimadb.any.'])
    doc = dict(
        meta=dict(title='Dragonfly/Redis contract ledger', generatedAt=datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
                  generator='dima-rust/tools/ledger/dragonfly_ledger.py', branch='rust-v2',
                  scope=['dimabot/src', 'dima-rust/src', 'dimafx/server', 'dima-analytics', 'dimadb/server', 'dima-hoststats'],
                  libraries={'node-redis': '5.12.1 (dimabot/node_modules/redis); dima-analytics ^5.10.0; dimadb ^5.8.2', 'redis-rs': '1.7.1 (dima-rust/Cargo.toml)'},
                  headline=dict(keyPatterns=len(real_keys), accessPathRecords=len(PSEUDO), rustLibraryOnlyKeys=len(RUST_LIB_ONLY),
                                sharedKeyPatterns=sum(1 for k in real_keys if k['shared']), pubsubChannels=len(PUBSUB), streams=len(STREAMS), queues=len(QUEUES),
                                luaScripts=len(lua_out), transactions=len(TRANSACTIONS)),
                  processLabels={'api': 'dima-server (node dist/server/index.js)', 'bot': 'dima-bot (node dist/bot/index.js)',
                                 'cron:<worker>': 'TS worker child of dima-cron supervisor (dist/workers/<worker>.worker.js)', 'cron:*(N workers)': 'reachable from ≥15 cron workers',
                                 'rust:<worker>': 'native worker binary in dima-cron (dima-rust/src/supervisor/registry.rs)',
                                 'rust-lib:<module>': 'Rust library port not wired into any deployed binary', 'script:<name>': 'manual maintenance script',
                                 'dima-analytics': 'analytics service', 'dimadb': 'DB console'}),
        coverage=coverage, keys=keys_out, pubsub=PUBSUB, streams=STREAMS, queues=QUEUES, lua=lua_out,
        transactions=[dict(at=a, what=b) for a, b in TRANSACTIONS] + [dict(at='(none)', what='WATCH/UNWATCH/DISCARD are not used anywhere in scope')],
        clients=CLIENTS, byteSensitive=BYTE_SENSITIVE, redisDifferences=DIFFERENCES, rules=RULES, nonKeyCallSites=nonkey)
    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, 'w', encoding='utf8') as fh:
        json.dump(doc, fh, indent=1, ensure_ascii=False)
        fh.write('\n')
    write_md(doc)
    print(f'wrote {OUT_JSON} and {OUT_MD}')


def md_escape(s):
    return str(s).replace('|', '\\|').replace('\n', ' ')


def short(at):
    return at.replace('dimabot/src/', '').replace('dima-rust/src/', 'rs/')


def write_md(doc):
    L = []
    h = doc['meta']['headline']
    c = doc['coverage']
    L.append('# Dragonfly/Redis contract ledger\n')
    L.append(f"Generated {doc['meta']['generatedAt']} by `{doc['meta']['generator']}` (branch `rust-v2`). Machine-readable twin: "
             "[`dragonfly.json`](dragonfly.json) — every key record there carries every writer/reader/Lua call site as `file:line` with its process.\n")
    L.append('## Headline\n')
    L.append('| Item | Count |\n|---|---|')
    for name, val in [('Key patterns (distinct templates)', h['keyPatterns']), ('… shared by more than one runtime process', h['sharedKeyPatterns']),
                      ('Rust-library-only keys (not deployed)', h['rustLibraryOnlyKeys']), ('Pub/Sub channels', h['pubsubChannels']), ('Streams', h['streams']),
                      ('Queues (list / zset based)', h['queues']), ('Lua scripts (records; several group identical inline copies)', h['luaScripts']),
                      ('MULTI/EXEC sites', h['transactions']), ('TS/JS client call sites scanned', c['tsCallSites']), ('Rust command sites scanned', c['rustCommandSites']),
                      ('Unmatched call sites', len(c['unmatched']))]:
        L.append(f'| {name} | {val} |')
    L.append('\n**Coverage method.** ' + c['method'] + f" Classification of the {c['tsCallSites'] + c['rustCommandSites']} sites: {c['classified']} "
             f"(\"multi\" = one call site touching several patterns; \"nonkey\" = connection lifecycle, MULTI/EXEC wrappers, pub/sub, in-process Map caches). "
             f"Reverse check: {len(c['delegatingFiles']['files'])} files obtain a client without issuing commands — {c['delegatingFiles']['note']} "
             + ' '.join(c['caveats']) + '\n')

    L.append('## Key patterns\n')
    L.append('Type, TTL and sharing per pattern. `W/R/L` = writer, reader and Lua call-site counts (details in JSON). Processes: see legend at the end.\n')
    groups = collections.OrderedDict()
    for k in doc['keys']:
        g = k['id'].split('.')[0]
        groups.setdefault(g, []).append(k)
    for g, ks in groups.items():
        L.append(f'\n### `{g}`\n')
        L.append('| Pattern | Type | Value | TTL | W/R/L | Processes | Shared |\n|---|---|---|---|---|---|---|')
        for k in ks:
            procs = ', '.join(k['processes']) or '—'
            flag = ' *(access path)*' if k['kind'] == 'access-path' else (' *(Rust library only)*' if k['kind'] == 'rust-library-only' else '')
            L.append(f"| `{md_escape(k['pattern'])}`{flag} | {k['type']} | {md_escape(k['value'])[:260]} | {md_escape(k['ttl'])} | "
                     f"{len(k['writers'])}/{len(k['readers'])}/{len(k['luaRefs'])} | {md_escape(procs)} | {'yes' if k['shared'] else 'no'} |")

    L.append('\n## Cross-process flows\n')
    L.append('### Queues\n')
    for q in doc['queues']:
        L.append(f"- **{q['name']}** ({q['kind']})")
        for p in q['producers']:
            L.append(f'  - produce: {p}')
        L.append(f"  - consume: {q['consumer']}")
        L.append(f"  - semantics: {q['semantics']}")
    L.append('\n### Streams\n')
    for s in doc['streams']:
        L.append(f"- **{s['stream']}** — write: {s['writer']}; XADD: {s['xadd']}")
        for r in s['readers']:
            L.append(f'  - read: {r}')
        L.append(f"  - consumer groups: {s['consumerGroups']}; dead letter: {s['deadLetter']}. {s['notes']}")
    L.append('\n### Pub/Sub channels\n')
    for p in doc['pubsub']:
        L.append(f"- **{p['channel']}** — payload: {p['payload']}")
        for x in p['publishers']:
            L.append(f'  - publish: {x}')
        for x in p['subscribers']:
            L.append(f'  - subscribe: {x}')
        L.append(f"  - connection: {p['client']}")
    L.append('\n### Shared keys by producer → consumer (highlights)\n')
    for k in doc['keys']:
        if k['shared'] and k['kind'] == 'key':
            wp = sorted({p for e in k['writers'] + [x for x in k['luaRefs']] for p in e['process'] if not p.startswith(('script:', 'rust-lib', 'unreach'))})
            rp = sorted({p for e in k['readers'] for p in e['process'] if not p.startswith(('script:', 'rust-lib', 'unreach'))})
            L.append(f"- `{k['pattern']}`: written by {', '.join(wp) or '—'}; read by {', '.join(rp) or '(only inside Lua)'}")

    L.append('\n## Lua scripts\n')
    L.append('| Script | Source | KEYS | Returns | Call sites | Mode |\n|---|---|---|---|---|---|')
    for l in doc['lua']:
        sites = ', '.join(sorted({short(x['at']) for x in l['callSites']})) or '—'
        L.append(f"| `{md_escape(l['id'])}` | {md_escape(l['source'])} | {md_escape(', '.join(l['keys']))} | {md_escape(l['returns'])} | {md_escape(sites)} | {md_escape(l['mode'])} |")

    L.append('\n## Transactions\n')
    for t in doc['transactions']:
        L.append(f"- `{short(t['at'])}` — {t['what']}")

    L.append('\n## Connections per process\n')
    L.append('| Process | Connection | Count | Options | Used for | Telemetry wrapper |\n|---|---|---|---|---|---|')
    for x in doc['clients']:
        L.append(f"| {md_escape(x['process'])} | {md_escape(x['connection'])} (`{md_escape(short(x['source']))}`) | {md_escape(x['count'])} | {md_escape(x['options'])} | "
                 f"{md_escape(x['used_for'])} | {md_escape(x['telemetry'])} |")

    L.append('\n## Byte-sensitive items\n')
    for b in doc['byteSensitive']:
        L.append(f"- **{b['item']}** — {b['where']}. Keys: {', '.join(b['keys']) or '—'}. Why: {b['why']} **Rule:** {b['rule']}")

    L.append('\n## Dragonfly / redis-rs vs Redis / node-redis differences\n')
    for d in doc['redisDifferences']:
        L.append(f"- **{d['topic']}** — {d['detail']} Sites: {', '.join(short(s) for s in d['sites'])}")

    L.append('\n## Rules a Rust implementation must follow\n')
    for i, r in enumerate(doc['rules'], 1):
        L.append(f'{i}. {r}')

    L.append('\n## Process legend\n')
    for k, v in doc['meta']['processLabels'].items():
        L.append(f'- `{k}`: {v}')
    with open(OUT_MD, 'w', encoding='utf8') as fh:
        fh.write('\n'.join(L) + '\n')
