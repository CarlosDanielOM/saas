# Existing Rust crate inventory (`dima-rust/`) — input for the UTF-8 conversion and workspace split

Read-only audit, 2026-11-11, branch `rust-v2`. No cargo command was run; everything below comes from reading source.
Line numbers refer to the files as they are on this date. "Non-test" means code before a file's `#[cfg(test)] mod … {` block,
excluding `*/tests.rs` files.

## 0. Scope and coverage

| Area | How it was read |
|---|---|
| `src/utils/ast_syntax/*` (mod, source, types, grammar, lexer, scanner, parser, persistence) | read fully (except `tests.rs`) |
| `src/utils/ast_blocks/*` (mod, types, validate, normalize, from_ast, import_plan, writer) | read fully (except `tests.rs`) |
| `src/utils/ast_evaluator/*` (mod, value, storage, vm, context, host, registry, pure/{mod,casing,coercion,strings,user,eventsub}) | read fully (except `tests.rs`, `pure/tests.rs`); `pure/metadata.rs` (242 lines, static function metadata) only grepped |
| `src/utils/re2_compat.rs`, `src/utils/js_compat.rs`, `bson_compat.rs`, `utc_time.rs`, `worker_process.rs` | read fully |
| `src/utils/keywords.rs` | non-test lines 1–690 read fully; test module 691–1270 not read |
| `src/workers/dashboard_activity.rs`, `dashboard_insights.rs`, `dashboard_emote_catalog.rs`, `src/bin/dashboard_activity.rs` | read fully |
| `src/supervisor/mod.rs`, `registry.rs`, `src/bin/cron_index.rs` | read fully |
| `src/supervisor/process.rs` | lines 1–33, 296–460, 655–742 read; rest grepped |
| `src/supervisor/telemetry.rs` | lines 1–80, 471–600, 816–862 read; rest grepped |
| Other workers, other bins, other utils | grepped for every search term in the brief plus `trim`, `to_lowercase`, `chars().take`, number/JSON helpers; hits read with context. Not read end to end. |
| `tests/*.rs` | test functions counted, not read |
| `tests/fixtures/*.json` | parsed with a script (case counts, Unicode-sensitive case counts by category); generators (`*.mjs`) listed, not read |
| `Cargo.toml`, `Cargo.lock`, `README.md`, `AGENTS.md`, `STREAM_ACTIVITY.md` (headings), `examples/`, `benchmarks/` (file list) | read / listed |
| `ops/rust_build.sh`, `dimabot/dockerfile`, `dimabot/src/workers/cron_native_bridge.ts` | read fully |
| `ops/saas_ops.py` | Rust constants (lines 30–95) read; Rust functions (`rust_*`, `build_rust` 327–600) grepped |
| `dimabot/src/utils/observability/native_worker_metrics.ts` | lines 1–60 read, exports grepped |

Size: `src/` = 44,819 lines in 131 `.rs` files, of which 36,284 are non-test. `tests/` = 27 `.rs` integration files (12,435 lines incl. fixtures source) + 20 Node generators + 14 JSON corpora. Edition 2024, toolchain pinned `1.99.1` (`rust-toolchain.toml`), musl build image `rust@sha256:557a94c8…` (`ops/saas_ops.py:32`).

---

## 1. Module table

LOC = all lines of the module including its in-file tests (separate `tests.rs` lines in brackets). Tests = `#[test]`/`#[tokio::test]` functions inside the module + integration files in `tests/`. "Deployed" = compiled into one of the eight shipped binaries.

### 1a. Binaries and worker modules (deployed)

| Module | LOC | Purpose | TypeScript counterpart | Feature gate | External crates | Tests | Status |
|---|---|---|---|---|---|---|---|
| `bin/cron_index.rs` | 181 | CLI entry for the native supervisor; panic hook → exit 1 | `dimabot/src/workers/cron_native_bridge.ts` spawns it (no TS equivalent of the index itself) | `cron-supervisor` | tokio | 2 | deployed (8th binary) |
| `supervisor/{mod,registry,process,telemetry}.rs` | 3,265 | Spawns 7 worker processes, restarts, signals, stdout telemetry framing, `/proc` sampling, Redis telemetry export | `dimabot/src/utils/observability/native_worker_metrics.ts` (now **dead code**: only imported by its own test), Node-side parity corpus `tests/fixtures/native_telemetry_parity.json` (274 cases) | `cron-supervisor` | libc, redis, serde, serde_json, tokio(process,fs,io-util), uuid, dotenvy | 33 (mod 2, registry 3, process 12, telemetry 16) | deployed |
| `workers/stream_activity/{mod,projection}.rs` + `bin/stream_activity.rs` | 975 + 369 | Projects `stream_activities` into `stream_activity_aggregates` with a leased checkpoint | `dimabot/src/utils/stream_activity.ts` (shared helpers, still live); worker retired to `archives/typescript-workers/2026-10-21/dimabot/src/workers/stream_activity.worker.ts` | `mongo` | mongodb, futures-util, serde, serde_json, sha2, tokio | 8 + 5; Node scripts `tests/stream_activity_{cli,idle,parity}.mjs` | deployed worker |
| `workers/raid_analytics.rs` + bin | 1,320 + 321 | Raid follow-window analytics into `raid_analytics_histories`/`_summaries` | `utils/raid_analytics.ts`; worker archived (`…/raid_analytics.worker.ts`) | `mongo` | mongodb, futures-util, garde, serde, serde_json, sha2, tokio | 12 + 4 | deployed worker |
| `workers/follow_defense_baseline.rs` + bin | 668 + 447 | Per-channel follow baseline from ledgers, published to Redis | `utils/follow_defense_baseline.ts`; worker archived | `mongo`+`redis` | mongodb, redis, futures-util, garde, serde, serde_json, tokio | 10 + 6 | deployed worker |
| `workers/roulette_completion.rs` + bin | 1,112 + 285 | Settles due roulette draws with revision CAS | `dimabot/src/roulette/*`, `workers/roulette-actions.worker.ts` (live); completion worker archived (`…/roulette.worker.ts`) | `mongo` | mongodb, futures-util | 21 + 4 | deployed worker |
| `workers/ai_usage_receipts/{mod,queue,ledger,dashboard,values}.rs` + bin | 1,584 + 249 | Consumes Redis receipt queue → Mongo receipts, dailies, dashboards, queue health | `utils/ai_usage_receipts.ts`, `ai_usage_ledger.ts`, `ai_usage_dashboard.ts`, `ai_usage_queue_health.ts`; worker archived | `mongo`+`redis` | mongodb, redis, futures-util, serde_json, sha2, tokio | 14 + 2 | deployed worker |
| `workers/raid_sessions/{mod,moderation,values}.rs` + bin | 1,075 + 374 | Extends raid sessions, backfills follows, admits moderation requests | `utils/raid_sessions.ts`; worker archived | `mongo`+`redis` | mongodb, redis, futures-util, garde, serde, serde_json, sha2 | 8 + 4 | deployed worker |
| `workers/dashboard_activity.rs` (+ `dashboard_emote_catalog.rs` via `#[path]`) + bin | 1,307 + 371 | Projects activity into `dashboard_activity_dailies`, refreshes activity + insight summaries, Twitch emote catalog | `utils/dashboard_activity.ts` (API side live), emote catalog in TS shared helper; worker archived | `mongo`+`redis`+`http-client`+`unicode-collation` | mongodb, redis, reqwest, icu_collator (via insights), futures-util, garde, serde, serde_json, sha2, tokio | 3 + 1 + 4 | deployed worker |
| `workers/dashboard_insights.rs` | 727 | Weekday/game insight payloads (ICU tie order), refreshed by dashboard worker | `utils/dashboard_insights.ts` | `mongo`+`unicode-collation` | icu_collator, mongodb, futures-util, garde, serde, serde_json, tokio | 4 | used by deployed worker |

### 1b. Utilities used by deployed workers

| Module | LOC | Purpose | TS counterpart | Feature | Crates | Tests | Status |
|---|---|---|---|---|---|---|---|
| `utils/mongo.rs` | 142 | Lazy global `Client` (`OnceCell`), reads `MONGO_URI`, pings `admin` | `utils/databases/mongodb.database.ts` | `mongo` | mongodb, tokio | 4 + `tests/mongo_connection.rs` (1, ignored) | used by deployed workers |
| `utils/redis.rs` | 411 | Lazy global `ConnectionManager`, `DRAGONFLY_HOST/PORT`, 5 s init, **no response timeout** (line 121) | `utils/databases/dragonfly.database.ts` | `redis` | redis, tokio, rustls | 11 + `tests/redis_connection.rs` (1, ignored) | used by deployed workers |
| `utils/bson_compat.rs` | 131 | Node BSON number promotion (`js_number`, `normalize_document`) | Node BSON driver behaviour | `mongo` | mongodb | 2 | used by dashboard, roulette, receipts |
| `utils/utc_time.rs` | 59 | `Date.UTC` midnight / inclusive day ranges | inline TS date math | `mongo` | mongodb | 3 | used by dashboard, baseline |
| `utils/js_compat.rs` | 31 | ECMAScript whitespace set + `trim` | `String.prototype.trim` | 16 features (any of mongo, cron-supervisor, bot-utils, …; `utils/mod.rs:27-44`) | — | 1 | used by deployed workers + supervisor |
| `utils/worker_process.rs` | 107 | `--env-file` loading, SIGTERM→watch, `IdleBackoff` 1/2/4/5 s | — | `mongo` or `cron-supervisor` | dotenvy, tokio | 2 | used by all bins |

### 1c. Library-only modules (no deployed caller, no TS caller wired)

| Module | LOC | Purpose | TS counterpart(s) | Feature | Crates | Tests (in-src + integration; corpus cases) |
|---|---|---|---|---|---|---|
| `utils/ast_syntax/` (8 files) | 3,601 [998] | Command-language tokenizer/parser/template scanner, diagnostics with UTF-16 spans | `utils/ast_parser/tokenizer.ts`, `parser.ts`, `registry.ts`, `render.ts` | `ast-syntax` | serde, serde_json | 27 + `tests/ast_syntax_parity.rs` 10; corpus `ast_syntax_cases.json` **1,200** |
| `utils/ast_blocks/` (8 files) | 3,805 [625] | Visual block tree ↔ command text, limits in UTF-16 units | `utils/ast_blocks/{index,validate,normalize,from_ast,to_source,types}.ts` | `ast-blocks` | regex, serde, serde_json | 25 + `tests/ast_blocks_parity.rs` 12; corpus `ast_blocks_cases.json` **467** |
| `utils/ast_evaluator/` (core: mod, value, storage, vm, context, host, registry) | 4,685 incl. tests.rs 823 | Interpreter over `JsValue`/`JsString(Vec<u16>)`, host boundary for IO | `utils/ast_parser/evaluator.ts`, `effects.ts`, `timer.ts`, `registry.ts`, `functions/count.functions.ts` | `ast-evaluator` (= `ast-syntax` + `permissions`) | serde, serde_json | 20 + `tests/ast_evaluator_parity.rs` 13; corpus `ast_evaluator_cases.json` **3,563** |
| `utils/ast_evaluator/pure/` (7 files) | 2,148 incl. tests.rs 1,088 | 27 pure functions: upper/lower/title/capitalize/trim/length/slice/replace, user/touser, random, EventSub | `utils/ast_parser/functions/{string,user,random,eventsub}.functions.ts` | `ast-pure-functions` | regex | 25 + `tests/ast_pure_parity.rs` 10; corpus `ast_pure_cases.json` **4,694** |
| `utils/re2_compat.rs` | 365 | RE2/JS pattern → `regex` translation, UTF-16 offset converter | `utils/moderation/advanced.ts`, `variations.ts` (node `re2`) | `re2-compat` | regex | 6; corpus `tests/fixtures/re2_parity_cases.rs` **109** (generator `re2_parity.mjs`) |
| `utils/keywords.rs` | 1,270 | Keyword validation/normalization/matching, cache + storage trait | `utils/keywords.ts`, `keyword_cache.ts` | `keywords` | regex, serde, serde_json, tokio, unicode-normalization | 10 + `tests/bot_utils_parity.rs` (1 test, corpus `bot_utils_parity.json` 130 shared with 5 other modules) |
| `utils/permissions.rs` | 1,451 | Compiled permission policies, legacy level parse | `utils/permissions/{expression,roles,index}.ts`, `middleware/channel_permissions.ts` | `permissions` | serde, serde_json | 14 + `tests/permission_core_parity.rs` 3; corpus `permission_core_cases.json` **3,681** |
| `utils/command_cooldown.rs` | 401 | Cooldown decisions with injected store | `utils/command_cooldown.ts`, `command_cooldown_write.ts` | `command-utils` | serde_json, tokio, uuid | 2 (+ bot_utils corpus) |
| `utils/chat_events.rs` | 573 | Embedded chat-event catalog merge | `utils/chat_event_catalog.ts` | `chat-events` | serde_json | 2 (+ bot_utils corpus) |
| `utils/ai_usage.rs` | 601 | AI usage context/classification | `utils/ai_usage_event.ts`, `ai_usage_classification.ts` | `ai-usage` | serde, serde_json, uuid | 3 (+ bot_utils corpus) |
| `utils/eventsub.rs` | 311 | Condition canonical JSON, subscription keys | `utils/eventsub.ts`, `eventsub_reconciliation.ts` | `eventsub` | serde_json | `tests/eventsub_event_core.rs` 8 |
| `utils/domain_events.rs` | 374 | Envelope projection/keys | `utils/domain_events.ts` | `domain-events` | mongodb (opt), serde, serde_json | `tests/domain_events_event_core.rs` 13 |
| `utils/chat_message.rs` | 190 | Chat origin, bits text, badges | `utils/bits_message.ts`, `utils/badges.ts` | `chat-message` | serde, serde_json | via `tests/policy_utils_parity.rs` 3 tests; corpus `policy_utils_parity.json` **1,225** (shared) |
| `utils/timer_policy.rs` | 119 | Timer frequency/plan validation | `utils/timer_policy.ts` | `timer-policy` | serde | policy corpus |
| `utils/credit_policy.rs` | 585 | Free-credit reset, credit packs, TTS estimates | `utils/free_credit_reset.ts`, `credit_packs.ts` | `credit-policy` | serde, serde_json | policy corpus |
| `utils/cron_queue.rs` | 712 | Cron job queue enqueue/parse/BLPOP | `utils/cron_jobs_queue.ts` | `cron-queue` | redis, serde, serde_json, uuid | `tests/cron_queue_parity.rs` 3 (corpus 206) + `cron_queue_redis.rs` 1 ignored |
| `utils/credential_crypto.rs` | 166 | Legacy AES-256-CTR token envelope | `utils/crypto.ts` | `credential-crypto` | aes, ctr, getrandom, serde | `tests/token_storage_parity.rs` 2 (corpus 51) |
| `utils/twitch.rs` | 1,427 | Twitch HTTP transport, OAuth refresh classification, header sanitizing | `utils/tokens.ts`, `bot/*` Twitch helpers | `twitch-client` | reqwest, serde_json, tokio | 10 |
| `utils/twitch_tokens.rs` + `twitch_tokens/adapters.rs` | 1,351 | Token lifecycle with Mongo/Redis CAS | `utils/tokens.ts` | `twitch-tokens` | getrandom, mongodb, redis, tokio | `tests/token_storage_{lifecycle 26, adapters 1 ignored}`, `streamer_token_support.rs` 8 |
| `utils/twitch_streamers.rs` + 3 sub-files | 2,675 [730] | Streamer directory hydration/reconciliation | `classes/twitch_streamers.class.ts`, `utils/twitch_streamer_refresh*` | `twitch-streamers` (+`-posthog`) | futures-util, mongodb, posthog-rs (opt), redis, serde, serde_json, tokio, uuid | 17 + `tests/twitch_streamers_{behavior 1 (66 cases), adapters 1 ignored}` (+ parity corpus 16) |
| `utils/plan_cache_fence.rs` | 921 | Redis Lua plan-cache fence | `utils/plan_cache_fence.ts`, `domain_events/polar_billing_events.ts` | `plan-cache` | redis, tokio | 9 + `tests/plan_cache_fence_{parity 2, redis 1 ignored}` |
| `utils/polar.rs` | 737 | Polar billing HTTP transport | `utils/polarsh.ts`, `credit_gift_provider.ts` | `polar-client` | reqwest, serde, serde_json, tokio | 7 |
| `utils/logger.rs` + `logger/{redis,otel}.rs` | 1,802 [629] | Explicit logger; Dragonfly `logger:*` keys, OTEL adapter | `utils/logger.ts` | `logger`, `logger-redis`, `logger-otel` | futures-util, opentelemetry(+sdk), redis, serde, serde_json, tokio, uuid | 18 + `tests/logger_parity.rs` 1 (56 cases), `logger_adapters.rs` 1 ignored |
| `utils/qdrant.rs` + `qdrant/*` (6 files) | 1,951 | Qdrant gRPC client, chat/memory folders, point IDs | `utils/qdrant/*`, `config/qdrant/collections.ts`, `utils/databases/qdrant.database.ts` | `qdrant` | qdrant-client, md-5, regex, serde, serde_json, tokio | 5 + `tests/qdrant_utilities.rs` 22 (+ fixture 1 ignored, connection 1 ignored); corpus `qdrant_folder_reference.json` 90 |
| `utils/email.rs` | 230 | Resend email delivery | `utils/email/email.service.ts` | `email` | resend-rs, serde_json, tokio | 6 |
| `utils/posthog.rs` | 146 | PostHog capture | `utils/posthog_events.ts` | `posthog` | posthog-rs, serde_json, tokio | 2 |
| `utils/otel.rs` | 97 | OTLP log export | `utils/opentelemetry_posthog.ts` | `otel` | opentelemetry, -sdk, -otlp | 1 |
| `utils/s3.rs` | 301 | S3 upload/delete | `utils/s3.ts`, `functions/s3/*` | `s3` | aws-sdk-s3, tokio | 4 |
| `utils/jwt.rs` | 219 | Email activation JWT | `utils/email/email-activation-token.ts` | `jwt` | jsonwebtoken, base64, serde, serde_json | 6 |
| `utils/audio.rs` | 214 | MP3/WAV duration | TTS playback helpers (no single TS file found) | `audio` | symphonia | 5 |
| `utils/cors.rs` | 95 | tower-http CORS = npm `cors()` defaults | `server/server.ts` middleware | `http` | axum, tower-http, tokio | 2 |
| `utils/socketio.rs` | 115 | socketioxide with socket.io defaults | `server/websocket.ts` | `socketio` | socketioxide, axum, serde_json, tokio | 1 |
| `utils/test_http.rs` | 177 | Loopback HTTP recorder for tests | — | `cfg(test)` only | — | — |
| `lib.rs`, `utils/mod.rs`, `workers/mod.rs` | 90 / 160 / 30 | Module wiring, `install_default_tls_provider` (`utils/mod.rs:144-160`) | — | — | rustls | 1 (`lib.rs` TLS provider test) |

Notes on features: `postgres` (sqlx 0.9.0) is in `default` but **no module uses sqlx**; `http` is used only by `cors.rs`/`socketio.rs`. `tests/utility_feature_gates.rs` (8 tests) checks feature isolation. Examples: `stream_activity_fixture.rs` (needs `mongo`), four AST benchmark drivers (`ast_*_bench.rs`, each gated). Benchmarks directory holds 12 JSON/HTML result artifacts only (no code).

Total: **50 table rows** — 10 deployed binary/worker rows (8 binaries incl. `cron_index`, 9 worker modules, the supervisor), 6 runtime utilities, 34 library-only modules.

---

## 2. UTF-16 / JS-string inventory

Classes: **ST** storage, **LEN** length counting, **IDX** index/offset/span arithmetic, **SUR** surrogate handling, **ORD** ordering/comparison, **CASE** case mapping, **WS** whitespace/trim, **NUM** JS number→string, **JSON** JS-style JSON escaping, **RX** regex translation.
Observable: **M** stored in MongoDB, **R** stored in Dragonfly/Redis, **Q** stored in Qdrant, **API** API/socket payload or editor, **CHAT** chat output, **LOG** logs/telemetry only, **INT** internal only. "Deployed" marks sites compiled into a shipped binary today.

### 2a. AST evaluator (library-only; the bulk of the emulation)

| # | Site | Class | What it does | UTF-8-native replacement | Observable |
|---|---|---|---|---|---|
| E1 | `ast_evaluator/value.rs:7-28` | ST | `JsString(Vec<u16>)` with `from_units/units/len/push`; derives `Ord` on code units | `String` (or `Arc<str>`/`Rc<str>` for cheap clones); `len()` → `chars().count()` only where a user-visible length is needed | CHAT, R, M (all variable values) |
| E2 | `value.rs:61-75` | ST | `From<&str>` encodes to UTF-16 on every literal/key | removed | INT |
| E3 | `value.rs:16-19` | SUR | `to_utf8` fails on lone surrogate ("Unpaired UTF16 surrogate at UTF8 boundary") | removed (cannot occur) | INT |
| E4 | `value.rs:29-41`, `76-78` | WS | `trim()` over units using JS set | `js_compat::trim(&str)` | CHAT |
| E5 | `value.rs:42-59` | CASE+SUR | `lower()` per well-formed run, preserving lone surrogates | `str::to_lowercase` | CHAT, R (cache keys via E14) |
| E6 | `value.rs:88-89` | ST | `JsValue::String(JsString)`, object keys `Vec<(JsString, JsValue)>` | `String` keys; keep insertion-ordered `Vec`/`IndexMap` | INT |
| E7 | `value.rs:126-173` | SUR | `to_typed_json` emits `{"utf16":[…]}` for lone-surrogate strings/keys (oracle format) | drop the `utf16` branch | test oracle only |
| E8 | `value.rs:174-184` | ST | `get(&str)` compares by re-encoding key to UTF-16 | `==` on `&str` | INT |
| E9 | `value.rs:328-396` | LEN/IDX | `parse_float`/`parse_int` scan `u16` units (ASCII digits) | scan bytes of `&str` | CHAT |
| E10 | `value.rs:495-516` | IDX | `numeric_comparison_string` over units | bytes | CHAT |
| E11 | `value.rs:538-564` | ORD | `safe_compare` `>`,`<`,`>=`,`<=` on non-numeric strings use derived code-unit order | `str` `Ord` = code-point order. Differs only when one side has U+E000–U+FFFF and the other an astral char at the first difference | CHAT (`true`/`false`) |
| E12 | `value.rs:566-570` | IDX | `~=` substring via `windows()` on units | `str::contains` (identical for valid text) | CHAT |
| E13 | `value.rs:611-851` | ST+SUR | Hand-written `json_parse` over `&[u16]`, accepts `\uD800`-style lone escapes, keeps duplicate-key position | `serde_json` with an order-preserving map (or keep the hand parser on bytes). **`serde_json` rejects lone-surrogate escapes**: decide a lossy policy (U+FFFD) for stored arrays that contain them | R, M (stored variable arrays) |
| E14 | `ast_evaluator/storage.rs:18-22`, `23-70`, `71-96` | ST+CASE+WS | Cache/user keys built as `JsString` (`{platform}:{id}:variable:{name}:login:{lower(trim(login))}`) | `String` keys; same normalisation | R (key names unchanged for valid text) |
| E15 | `storage.rs:375-410` | LEN | `DecodeCache` memo bounded by `raw.len()` units (1,048,576) | bound by bytes | INT |
| E16 | `value.rs:855-962` | JSON+SUR | `json_stringify`/`quoted` into UTF-16; lone surrogates escaped `\udXXX` (line 956), pairs emitted raw | `serde_json` string escaping (identical to `JSON.stringify` for valid UTF-8) + custom number writer (see N1) | R, M (array variables), CHAT (`%(x[])`) |
| E17 | `ast_evaluator/host.rs:12-51` | ST | `HostRequest` cache keys/values/targets are `JsString` | `String` | R, M via host |
| E18 | `ast_evaluator/context.rs:65-89`, `151`, `193`, `216-217` | ST | `LoopVars`, `CommandReference.argument`, `argument`, `command_variables`, `user_command_variables: SharedMap<JsString,JsString>` | `String` | INT/CHAT |
| E19 | `context.rs:400-432` | SUR | Authorization identity decoded field-by-field "so lone surrogates in irrelevant fields cannot invalidate" | plain serde | INT |
| E20 | `ast_evaluator/mod.rs:61-65`, `144-163` | ST | `RenderResult.text: JsString` (final chat text) | `String` | CHAT |
| E21 | `ast_evaluator/vm.rs:474` | SUR+CASE+WS | Command-ref name `JsString::from(name).trim().lower().to_utf8()` with error path | `trim(name).to_lowercase()` | INT |
| E22 | `vm.rs:867-878` | IDX | `{...stringEventData}` spread: one object key per UTF-16 unit | one key per `char` (JS gives per-unit keys; astral chars now produce one entry instead of two) | API (command-reference event data) |
| E23 | `vm.rs:131-158` | ST | `join`/`iterable` build `JsString` | `String` | CHAT |
| E24 | `ast_evaluator/registry.rs:183-188` | IDX | `count` builtin filters `+` by unit (43) | filter `char` `'+'` | CHAT |
| E25 | `pure/mod.rs:80-82` | WS | `whitespace(u16)` | `js_compat::is_whitespace(char)` | CHAT |
| E26 | `pure/mod.rs:121-124` | ST | `push_char` encodes to `Vec<u16>` | `String::push` | INT |
| E27 | `pure/casing.rs:133-150` | CASE+SUR | `upper` per run, keeps lone surrogates | `str::to_uppercase` | CHAT |
| E28 | `pure/casing.rs:151-161` | IDX+CASE | `capitalize` uppercases **the first UTF-16 unit only** (an astral first letter is left unchanged, e.g. Deseret `𐐨`) | uppercase first `char` → **visible change** for astral first letters | CHAT |
| E29 | `pure/casing.rs:162-185` | CASE+SUR | `title` over decoded runs | iterate `chars()` | CHAT |
| E30 | `pure/coercion.rs:213-280` | ST | `checked_string`/`array_string` build units; `toString` key detection re-encodes | `String` | CHAT |
| E31 | `pure/strings.rs:289-295` | LEN | `$(length …)` = Σ UTF-16 lengths + separators | `chars().count()` → **visible change** for astral text | CHAT |
| E32 | `pure/strings.rs:321-338` | ST/IDX | `joined`, `numeric` over units | `String` | CHAT |
| E33 | `pure/strings.rs:383-437` | IDX+LEN | `$(slice start end …)` with negative indices over units; can split a surrogate pair | char indices (map char index → byte offset once); never splits → **visible change** for astral text | CHAT |
| E34 | `pure/strings.rs:439-476` | IDX | `replace` via KMP over units | `str::replace` (byte-identical results for valid UTF-8) | CHAT (no change) |
| E35 | `pure/user.rs:31-46`, `68-90` | SUR | `user ignore symbols/numbers` decodes units; keeps or drops lone surrogates; re-tests output because removing a digit can join two lone units | `chars()` filter; the join case disappears | CHAT |
| E36 | `pure/user.rs:116-125` | IDX | `touser` escapes `$ % *` per unit | per `char` | CHAT (no change) |
| E37 | `pure/user.rs:126-139`, `152-155` | CASE/WS | ASCII fold on units, split on JS whitespace units | `eq_ignore_ascii_case`, `split(is_whitespace)` | INT |
| E38 | `pure/eventsub.rs:250`, `259-268`, `283-300`, `312-341` | ST/WS/CASE | Field comparisons via `encode_utf16`, whitespace test per unit, `trim().lower()` | `&str` ops | CHAT |

### 2b. AST syntax and blocks (library-only)

| # | Site | Class | What it does | Replacement | Observable |
|---|---|---|---|---|---|
| A1 | `ast_syntax/types.rs:5-10` | IDX | `SourceSpan` documented as JS UTF-16 offsets | keep byte ranges internally; convert at the API edge (UTF-16 only if the dimasite editor contract needs JS indices, else char offsets) | API (diagnostics to the editor) |
| A2 | `ast_syntax/source.rs:10-21` | LEN | Source limit counted in UTF-16 units, error span end = unit count | `chars().count()` (or bytes) | API (error) |
| A3 | `source.rs:22-39` | IDX | Builds byte→UTF-16 map (`vec![0; len+1]`) and `span()` lookup | drop map; compute on demand at the edge | API |
| A4 | `ast_syntax/types.rs:250-273`, `mod.rs:8` | LEN | `Limits.source_utf16 = 10_000` | rename `source_chars` | API |
| A5 | `ast_syntax/types.rs:224-231` | IDX | `SourceSegment{span}` exported by `scan_template` | as A1 | API |
| A6 | `ast_syntax/lexer.rs:3,104-110,361,421,432`; `grammar.rs:132` | WS | JS whitespace for tokens/introducers | unchanged (`js_compat`) | — |
| B1 | `ast_blocks/validate.rs:6-8` | LEN | `units()` = `encode_utf16().count()` | `chars().count()` | API |
| B2 | `validate.rs:121` (via `string`, limits 80/60/64/32/10,000 at 292, 420, 433-441, 444, 459-467) | LEN | Field length limits | chars | API (accept/reject) |
| B3 | `ast_blocks/from_ast.rs:24` | LEN | Same limits on import | chars | API |
| B4 | `ast_blocks/mod.rs:58-66`, `264-268` | LEN | Syntax source limit and work charge in units | chars | API |
| B5 | `ast_blocks/writer.rs:8-9` | LEN | `MAX_OUTPUT_BYTES = MAX_COMMAND_TEXT * 3` assumes ≤3 bytes per UTF-16 unit | must become `* 4` if the limit is in chars | INT (allocation bound) |
| B6 | `writer.rs:55-97` | LEN+IDX | Output counted in units; culprit offset found by summing `len_utf16` (84-91) | chars | API (error position) |
| B7 | `writer.rs:496-498`, `import_plan.rs:183-190` | LEN | User message "This command is too long (N of 10000 characters)" — N is UTF-16 units | chars | API (text shown in editor) |
| B8 | `import_plan.rs:202`, `272`, `311` | LEN | Remaining-source / contribution accounting in units | chars | INT |
| B9 | `ast_blocks/types.rs:346-357` | LEN | `BlocksStats.{output_units, retained_output_units, syntax_source_units_charged}` serialized | rename/char counts | API (stats) |
| B10 | `validate.rs:680` | LEN | Unknown-type message truncates with `chars().take(24)` — **already scalar**, while TS uses `slice(0, 24)` | none (already UTF-8-native) | API |

### 2c. Deployed workers

| # | Site | Class | What it does | Replacement | Observable |
|---|---|---|---|---|---|
| D1 | `workers/dashboard_insights.rs:33-47` | ST+LEN+SUR | `JsText(Vec<u16>)`; `sliced(value, limit)` keeps first N **units** (can leave a lone high surrogate); `bson_text` = lossy | `String` truncated to N chars (never splits) | M (`dashboard_insights.payload.*.games[].game`, `bestGrowthGame`) |
| D2 | `dashboard_insights.rs:49-88` | JSON+SUR | `js_json_string(&[u16])`: exact `JSON.stringify` incl. `\udXXX` for lone units | `serde_json::to_string(&str)` (same bytes for valid text) | via D5/D7 |
| D3 | `dashboard_insights.rs:89-140` | JSON+SUR | `Serialize`/`Deserialize` for `JsText` through `RawValue`, accepting lone escapes | plain `String` serde; lossy U+FFFD on lone escapes in old cache | R |
| D4 | `dashboard_insights.rs:237` | LEN+WS | Game name `JsText::sliced(js_trim(name), 128)` → grouping identity | `trim` + 128 chars | M |
| D5 | `dashboard_insights.rs:402`, `415` | ORD | `collator.compare_utf16(&a.name.0, &b.name.0)` | `collator.compare(&a, &b)` (identical ICU result) | M (order of games) — no change |
| D6 | `workers/dashboard_activity.rs:142-162` | JSON+SUR+ST | `daily_id` = SHA-256 of `JSON.stringify([channel, iso, kind, key])` over **sliced UTF-16 key**; comment: hashing lossy text would change legacy split-surrogate command IDs | hash `serde_json::to_string(&[…])` of the char-truncated key. **IDs change** for command keys longer than 100 chars/units that contain astral characters, or whose 100-unit cut split a pair | **M `_id` of `dashboard_activity_dailies`** (upsert fence on `lastSeq`) |
| D7 | `dashboard_activity.rs:194-222` | LEN | `JsText::sliced(key,100)`, label 100, emote label 64, emote key unlimited | char truncation | M (`key`, `label` fields) |
| D8 | `workers/dashboard_emote_catalog.rs:21-25`, `174` | ST+LEN | `Emote.name: JsText`, `row.name.0.truncate(64)` units | `String`, 64 chars | **R `twitch:{channel}:emote-catalog:v1`** (JSON, TTL 86,400 s) |
| D9 | `dashboard_emote_catalog.rs:288-309` | SUR | `HashFields(RawValue)` so a cached lone-surrogate name still parses | not needed after cutover; tolerate old entries for ≤24 h (lossy) | R |
| D10 | `workers/ai_usage_receipts/values.rs:138-148` | LEN+SUR+WS | `text()` = `js_trim` then first 128 UTF-16 units, `from_utf16_lossy` | trim + 128 chars | **M** (receipt text fields in `ai_usage_receipts`) |
| D11 | `workers/roulette_completion.rs:338-341` | LEN+WS | Channel id: Rust `trim()` (not JS set) then ≤100 UTF-16 units | `js_trim` + 100 chars | INT (validation of numeric ids) |

### 2d. Other library utilities

| # | Site | Class | What it does | Replacement | Observable |
|---|---|---|---|---|---|
| U1 | `utils/re2_compat.rs:13-14`, `230-237` | IDX | `utf16_offset(text, byte)` — documented "use when an offset leaves Rust"; panics off a char boundary | keep as the single edge converter (or char offsets) | API (moderation match offsets, if exposed) |
| U2 | `re2_compat.rs:48-204` | RX | JS/RE2 syntax → `regex` (ASCII `\d\w\s\b`, literal `[` in classes, `\cX`, set operators) | unchanged (already UTF-8 `regex`) | — |
| U3 | `re2_compat.rs:226-228` | RX | Whole-word guard `[^\p{L}\p{N}]` | unchanged | — |
| U4 | `utils/keywords.rs:10-15` (doc), `107` | LEN | Keyword ≤60 UTF-16 units | ≤60 chars → **accept/reject change** for astral keywords | API |
| U5 | `keywords.rs:36-52`, `89-103`, `196-215` | CASE/WS/RX | NFC + `to_lowercase`, JS whitespace collapse, `\p{L}\p{N}\p{M}_` words, boundary checks on `char_indices` | unchanged (already UTF-8) | — |
| U6 | `utils/qdrant/parity.rs:2`, `118` | LEN | Semantic chat items require message ≥3 UTF-16 units | ≥3 chars → a 2-emoji message is dropped where JS kept it | INT (LLM prompt context) |
| U7 | `utils/credential_crypto.rs:5-8`, `68-69` | LEN | Key `padEnd(32)` by UTF-16 length, then byte copy (non-ASCII keys rejected by the byte check) | **keep** — this is the AES key contract with Node `crypto.ts` | M (encrypted tokens) |
| U8 | `utils/twitch.rs:680-688` | LEN | `Bearer <token_length:N>` with N in UTF-16 units | chars (tokens are ASCII; no change) | LOG |
| U9 | `utils/logger.rs:806-818` | LEN | `clean()` takes first 100/80 UTF-16 units, maps non-ASCII units to `_` (an astral char gives `__`) | 100 chars, one `_` per char | R (`logger:*` metadata names) |
| U10 | `utils/eventsub.rs:29-45`, `289-296` | ORD+JSON | `BTreeMap` code-point key order vs `localeCompare`; serde escaping vs `JSON.stringify` (doc notes lone surrogates) | unchanged (already UTF-8; keys are ASCII) | R (subscription keys) — no change |
| U11 | `utils/cron_queue.rs:10` (doc) | SUR | Lone surrogates declared outside API | — | — |
| U12 | `utils/plan_cache_fence.rs:720-779` (test) | ORD | Asserts Lua byte order ≠ numeric/UTF-16 order | already bytes | — |
| U13 | `ast_blocks/validate.rs:57-66` | RX | `\p{L}\p{N}` name rules (JS `/u` equivalents) | unchanged | — |
| U14 | `pure/mod.rs:84-100` | RX/CASE | `\p{L}`/`\p{M}`/`\p{N}` patched with Unicode 17 ranges to match Node 26.8.2/ICU 78.3 | keep or drop once `regex` tables reach Unicode 17 (decision, not UTF-16) | CHAT |

### 2e. Headline counts

| Class | Sites (rows above that carry the class) | Deployed today |
|---|---|---|
| ST storage | 16 (E1, E2, E6, E13, E14, E17, E18, E20, E23, E26, E30, E32, D1, D6, D8, + `JsText` serde D3) | 4 (D1, D3, D6, D8) |
| LEN length | 26 (E9, E15, E31, E33, A2, A4, B1–B9, D1, D4, D7, D8, D10, D11, U4, U6, U7, U8, U9) | 6 (D1, D4, D7, D8, D10, D11) |
| IDX index/span | 15 (E9, E10, E12, E22, E24, E28, E32, E33, E34, E36, A1, A3, A5, B6, U1) | 0 |
| SUR surrogate | 16 (E3, E5, E7, E13, E16, E19, E21, E27, E29, E35, D1, D2, D3, D6, D9, D10) | 6 |
| ORD ordering | 4 (E11, D5, U10, U12) | 1 (D5, no behaviour change) |
| CASE | 9 (E5, E14, E21, E27, E28, E29, E37, E38, U5) | 0 |
| WS trim | see §4 W-rows; UTF-16 variants: E4, E25, E37, E38 | — |
| NUM | see §4 (6 duplicate implementations) | 3 |
| JSON | 4 UTF-16-dependent (E16, D2, D3, D6) + 4 JS-matching via serde (§4 J-rows) | 3 |
| RX | 6 (U2, U3, U5, U13, U14, + qdrant `WORDS`) — none UTF-16-dependent except offsets U1 | 0 |

Roughly 85 % of the UTF-16 machinery is the evaluator's `JsString`, which is library-only. In deployed code the emulation is `JsText` in the dashboard trio plus two UTF-16 slices (receipts, roulette).

### 2f. Externally visible changes the conversion will cause

1. **`dashboard_activity_dailies._id`** (D6): new SHA-256 for affected command keys. On cutover day the same (channel, day, kind, key) can split into two documents; counts for that day are then split across them until both expire. Only keys >100 units with astral characters are affected.
2. **Mongo text fields truncated at 100/64/128** (D1, D4, D7, D10): new documents keep a whole character where Node/old Rust stored U+FFFD; strings with astral characters may keep more text (100 chars > 100 units).
3. **Redis emote catalog** (D8/D9): old entries may contain `\udXXX` escapes; reader must accept them lossily for one TTL (24 h).
4. **Chat output of the command language** (E11, E28, E31, E33, E35, E22): `length`, `slice`, `capitalize`, ordering comparisons and per-char spreads change for text with astral characters (emoji). These are the user-visible semantics to approve.
5. **Editor/API diagnostics** (A1–A5, B2–B9): spans, limits and the "N of 10000 characters" message. The dimasite editor is JavaScript, so if it highlights by span the API edge still needs UTF-16 offsets — the one place the rule's "outside edge" exception plausibly applies.
6. **Keyword validation** (U4): astral keywords between 31 and 60 chars become valid.
7. **JSON with lone-surrogate escapes in storage** (E13, D3, D9): `serde_json` refuses them; a lossy ingest policy is required for old Dragonfly/Mongo data.

---

## 3. Test corpora that encode JS/UTF-16 expectations

Generators (all run the TypeScript implementation under Node and freeze its output): `tests/fixtures/{ast_syntax,ast_blocks,ast_evaluator,ast_pure}_reference.mjs` (+ `*_benchmark.mjs`), `bot_utils_parity.mjs`, `cron_queue_parity.mjs`, `logger_reference.mjs`, `permission_core_reference.mjs`, `plan_cache_fence_reference.mjs`, `policy_utils_parity.mjs`, `qdrant_folder_reference.mjs`, `re2_parity.mjs`, `stream_activity.mjs`, `token_storage_parity.mjs`, `twitch_streamers_reference.mjs`, `twitch_streamers_behavior_reference.mjs`; plus `tests/stream_activity_{cli,idle,parity}.mjs`. `native_telemetry_parity.json` and `plan_cache_fence_source.rs` record source hashes. Regenerating from TypeScript will keep producing UTF-16 answers, so the conversion needs an "intentional difference" overlay per corpus rather than regeneration.

Counts below come from parsing each JSON: "astral" = case contains a character above U+FFFF; "utf16-tagged" = case uses the `{"utf16":[…]}` lone-surrogate encoding.

| Corpus / test | Cases | Unicode-sensitive | Expected to change | Unaffected |
|---|---|---|---|---|
| `ast_evaluator_cases.json` (`tests/ast_evaluator_parity.rs`, 13 tests) | 3,563 | 305 (269 astral, 42 utf16-tagged) | Categories built for UTF-16: `utf16-boundary` 20, `utf16-order` 36, `dbuser-utf16-selector` 21, `dbuser-utf16-memo-normalization` 2 = **79** to rewrite/remove; plus 10 utf16-tagged values in other categories (`storage-read` 5, `commandref-generic-eventdata` 4, `builtin-bits-typed` 1). ≈ **90–100** | `coercion` 1,428, `loop` 243, `permission` 36, `timer` 21 and the remaining astral cases in `storage-*` (astral text passes through unchanged) |
| `ast_pure_cases.json` (`tests/ast_pure_parity.rs`, 10 tests) | 4,694 | 526 (406 astral, 144 utf16-tagged) | All 144 utf16-tagged (lone surrogates: 12 each in upper/lower/title/trim/capitalize, 18 user-filter, 20 slice, 12 seeded-mixed, 7 touser, 16 event-*); astral cases whose output depends on units: `slice` 132, `slice-fold` 4, `slice-utf16` 9, `string-length` 15, `string-capitalize` 15. ≈ **300–320** | `event-*` (1,568, 16 tagged only), `random`/`seeded` (except tagged), `ordinary` 244, `permission` 108, `flags` 27, astral cases of upper/lower/title/trim/replace (same output under UTF-8) |
| `ast_syntax_cases.json` (`tests/ast_syntax_parity.rs`, 10 tests) | 1,200 | 48 non-ASCII, 3 astral | If spans become chars: 3; if bytes: 48; if UTF-16 kept at the edge: 0 | 1,152 ASCII cases |
| `ast_blocks_cases.json` (`tests/ast_blocks_parity.rs`, 12 tests) | 467 | 33 non-ASCII, 7 astral (`0134 id_invalid_astral`, `0144/0145/0151/0152 varname_astral_*`, `0398/0399 astral_output_100`) | **7** (limits counted in units) | 460 |
| `tests/fixtures/re2_parity_cases.rs` (in `re2_compat.rs` test) | 109 | 5 lines with astral text | 0 if offsets stay UTF-16 at the edge; ≤5 if offsets become chars | ≥104 |
| `bot_utils_parity.json` (`tests/bot_utils_parity.rs`, 1 test) | 130 | 3 astral (`validate_keyword` 2, `normalize_keyword` 1) | ≤2 (60-unit limit) | 128 |
| `policy_utils_parity.json` (`tests/policy_utils_parity.rs`, 3 tests) | 1,225 | 125 astral (`free_reset` 124, `bits_text` 1) | 0 expected (no length semantics found in those helpers; re-check `free_reset` ids) | 1,225 |
| `qdrant_folder_reference.json` (`tests/qdrant_utilities.rs` 22 tests) | 90 | 14 astral (`semantic_select` 9, `passive_relevant` 4, `point_id` 1) | ≤9 (`semantic_select` ≥3-unit rule, U6) | ≥81 |
| `logger_parity.json` (`tests/logger_parity.rs`, 1 test) | 56 | 5 astral | ≤3 (`payload-metadata-truncation`, `metadata-name-nested-array`, `unicode-options` via U9) | 53 |
| `token_storage_parity.json` (`tests/token_storage_parity.rs`, 2 tests) | 51 | 5 astral | 0 (padEnd UTF-16 is kept, U7) | 51 |
| `twitch_streamers_parity.json` / `_behavior.json` | 16 / 66 | 1 / 0 | 0 | all |
| `permission_core_cases.json` (3,681), `cron_queue_parity.json` (206), `native_telemetry_parity.json` (274) | 4,161 | 0 astral | 0 | all |

In-source unit tests that assert UTF-16 behaviour directly (must be rewritten): `pure/casing.rs:191-204`, `dashboard_insights.rs:659-678`, `dashboard_activity.rs:804-827`, `dashboard_emote_catalog.rs:418-429`, `ai_usage_receipts/values.rs:386-395`, `re2_compat.rs:243-253`, `352-364`, `ast_blocks/writer.rs:511-541` (3-bytes-per-unit bound), plus unknown counts inside the unread `ast_evaluator/tests.rs` (20 tests), `pure/tests.rs` (24), `ast_syntax/tests.rs` (27), `ast_blocks/tests.rs` (24), `keywords.rs` tests (10).

Estimated total: **≈ 410–490 corpus cases** change (evaluator ~90–100, pure ~300–320, blocks 7, small corpora ≤15, syntax 0–48 depending on span policy), out of 15,828 corpus cases.

---

## 4. JS semantics that are not about UTF-16 (likely to stay — lead decides each)

| # | Site | Behaviour | Why it is visible |
|---|---|---|---|
| W1 | `utils/js_compat.rs:8-19` | ECMAScript whitespace set (BOM yes, NEL no) for `trim` | used by deployed workers (dashboard game names, receipts text) and the command language |
| W2 | `roulette_completion.rs:338` | Uses **Rust** `trim()` (NEL yes, BOM no) where TS uses JS trim — existing divergence | internal validation only |
| N1 | `ast_evaluator/value.rs:204-258` `number_string` | JS `Number#toString` (exponent at ≥1e21 / <1e-6, `-0`→`0`) | every number in chat output |
| N2 | `utils/logger.rs:845-859` | same, own copy | Dragonfly log metadata |
| N3 | `utils/permissions.rs:901-924` | same, own copy | permission messages |
| N4 | `workers/ai_usage_receipts/values.rs:50-66` | same, own copy (deployed) | Mongo receipt fields |
| N5 | `workers/raid_sessions/values.rs:189-228` | same, own copy (deployed) | `String()` of payload users → Mongo |
| N6 | `utils/qdrant/parity.rs:15-19`, `317` | same, own copy; feeds MD5 **Qdrant point IDs** | Q (IDs must not change) |
| N7 | `utils/bson_compat.rs:15-27`, `62-81` | Node BSON writer: integral values in i32 range → Int32, else Double; Long ≤ 2^53 promoted | M field types (deployed: dashboard, roulette, receipts) |
| N8 | `ast_evaluator/vm.rs:644-671` | `+ - * / %` coerce with `to_number_safe`, divide/modulo by 0 → 0, round to 6 decimals via `Math.round` | chat |
| N9 | `value.rs:574-583` `math_round`; `dashboard_insights.rs:186-190` `rounded` | `Math.round` (ties toward +∞; Rust `round` agrees only for non-negatives — comment says so) | chat; M payload |
| N10 | `value.rs:397-470` `to_number`, `471-479` `to_number_safe` | `Number()` coercion incl. `0x/0o/0b`, `Infinity`, empty → 0 | chat |
| N11 | `value.rs:318-327` `is_truthy`; `309-317` `js_truthy` | command-language truthiness (`"false"`, `"0"`, `""` falsy after trim/lower) | chat |
| N12 | `value.rs:480-494` `resolve_array_index` | `parseInt` index, negative from end | chat |
| N13 | `value.rs:585-606` `property_order` | JS object key order (integer keys first) | chat, stored JSON |
| N14 | `supervisor/mod.rs:83-113` `restart_delay` | `Number(value \|\| 5000)` incl. radix literals, min 1,000 ms | ops behaviour |
| N15 | `ai_usage_receipts/values.rs:~95-136` `number()` | `Number()` coercion with radix prefixes and JS whitespace | M |
| N16 | `permissions.rs:853-876` `parse_legacy_level` | `Number.parseInt(String(v ?? 0), 10)` | permission decisions |
| N17 | `utils/chat_message.rs:111-170`, `utils/twitch_tokens.rs:833-…` | `parseInt(info) \|\| 0` and parseInt with prefixes | chat (bits text), token expiry |
| N18 | `utils/timer_policy.rs:4-8`, `utils/credit_policy.rs` (`JsDate` epoch ms, `:128`, `:243`) | f64 timer math incl. NaN/−0; dates as JS epoch ms; `free-credit-reset-{user}-{YYYY-MM-DD}` key | M/R keys |
| S1 | `value.rs:260-308` `js_string`; `permissions.rs:880-899`; `utils/ai_usage.rs:283`; `qdrant/parity.rs:234`; `ai_usage_receipts/values.rs:68`; `raid_sessions/values.rs:166-187` | `String(value)` (arrays comma-joined, nulls empty, `[object Object]`) — **six copies** | chat, M |
| J1 | `raid_sessions/values.rs:11-15` | `_id = sha256(JSON.stringify(parts))` via `serde_json` | M `_id` (deployed) |
| J2 | `stream_activity/projection.rs:67-77` | aggregate `_id` hash over `serde_json` tuple ("integer buckets match JSON.stringify") | M `_id` (deployed) |
| J3 | `ai_usage_receipts/queue.rs:23-30` | Redis lock key `locks:ai-usage-write:{sha256(JSON.stringify([channel,customer]))}` | R (deployed) |
| J4 | `follow_defense_baseline.rs:306-316`, `dashboard_emote_catalog.rs:252-270` | Redis JSON written by `serde_json`: whole f64 values print as `3.0`, JS prints `3` (consumers parse, bytes differ) | R |
| D1 | `dashboard_emote_catalog.rs:332-365` `javascript_iso` | `Date#toISOString` incl. ±6-digit years | R/M (`checkedAt`, daily-id input) |
| D2 | `ai_usage_receipts/queue.rs:197-215` `logger_timestamp` | `M/D/YYYY, h:mm:ss AM` (en-US `toLocaleString` shape) | R logger keys/payloads |
| D3 | `utils/utc_time.rs:171-180`, `dashboard_insights.rs:285-287` | `Date.UTC` midnights, JS weekday numbering | M |
| D4 | `plan_cache_fence.rs:160-175` | Version = JS valid-Date ms with JS `padStart` sign quirk | R (fence values shared with TS) |
| D5 | `dashboard_emote_catalog.rs:280-287` | `Date.parse` accepts date-only ISO | R |
| C1 | `dashboard_insights.rs:289-295` | ICU root collator = Node en-US `localeCompare` (needs `icu_collator`) | M (game order) |
| C2 | `pure/mod.rs:84-100` | Unicode 17 category patches to match Node ICU | chat |
| C3 | `keywords.rs:36-52` | NFC before lowercase (`unicode-normalization` pinned `=0.1.26`) | API/keyword matching |

---

## 5. Process model of the current cron

### 5a. Topology

`dima-cron` container: Node PID 1 (`dimabot/src/workers/cron.index.ts`) runs TypeScript workers and starts **one** detached Rust `cron_index` through `NativeIndexBridge` (`cron_native_bridge.ts:52-152`). The bridge passes an env allowlist (`:8-17`), drops to uid/gid 65534 when root (`:46-47`), sends SIGTERM to the index only on shutdown, waits 28 s (`:4`), then SIGKILLs the whole process group (`:97-102`). An unexpected index exit makes Node shut the container down (`cron.index.ts:304-311`); there is no index restart.

`cron_index` spawns **seven OS processes**, one per worker binary in `/usr/local/bin` (`supervisor/registry.rs:68-160`, order: dashboard-activity, raid-analytics, stream-activity, roulette-completion, follow-defense-baseline, raid-sessions, ai-usage-receipts). Each binary builds its own 2-thread Tokio runtime and its own Mongo/Redis clients.

### 5b. `cron_index` (`bin/cron_index.rs`, `supervisor/*`)

- CLI: `--once`, `--dry-run`, `--events-json`, `--workers a,b`, repeatable `--env-file` (`supervisor/mod.rs:17-59`). Env files load before threads (`bin/cron_index.rs:246`).
- Panic hook prints `cron_index:{"event":"fatal","code":"SUPERVISOR_PANIC"}` and `process::exit(1)` (`bin/cron_index.rs:266-269`).
- Diagnostics: duplicated stdout fd (`unsafe fcntl F_DUPFD_CLOEXEC`, `process.rs:91-96`) written by a dedicated std thread through a bounded queue of 64 lines (`process.rs:34-43, 100-139`).
- Runtime: multi-thread, 2 workers (`bin/cron_index.rs:277-280`); `shutdown_background()` after run (`:213-221`).
- Per worker (`process.rs:457-600`): `Command::new(binary)` with `env_clear()` + per-worker allowlist (`registry.rs:30-65,181-190`), stdin null, stdout piped, stderr inherited, `kill_on_drop`, uid/gid 65534 if root (`process.rs:400-417`). Restart after `CRON_WORKER_RESTART_DELAY_MS` (default 5,000, min 1,000, `mod.rs:83-103`), counting restarts; no fallback to TypeScript. `AI_USAGE_RECEIPTS_ENABLED=false` (exact) disables that worker (`registry.rs:165-170`).
- Stdout protocol: newline frames ≤1,024 bytes, longer lines discarded (`process.rs:296-315`); each frame must start with the worker's prefix (`dashboard_activity:`, …) and match field allowlists (`telemetry.rs:59-75, 257-470`). Frames are validated into metrics; with `--events-json` they are echoed as `cron_index:` JSON.
- Signals: SIGTERM/SIGINT registered before spawning (`process.rs:632-653`); children get SIGTERM, 25 s grace, then SIGKILL + reap (`process.rs:419-450`); shared 27 s close/export deadline; stdout pipes closed after 2 s (`process.rs:39-41, 389-398`).
- Telemetry (`telemetry.rs`): reads `OBSERVABILITY_DISABLED`, `DRAGONFLY_HOST`, `DRAGONFLY_PORT` (`:119-125`); 10 s buckets, ≤2,000 metrics, ≤100 logs (`:30-38`); every 10 s a **fresh** Redis connection (1 s connect, 1.8 s flush) runs a Lua script that `LPUSH`es to `observability:v1:inbox`, trims to 100, counts overflow in `observability:v1:overflow`, `EXPIRE 3600` (`:39, 496-529`). Payload `{version:1, service:"cron", instance, metrics, spans:[], logs}` ≤256,000 bytes (`:544-551`). Metric names: `{prefix}.batch_*`, `.restarts`, `.health_query`, `.health_errors`, `.backlog_channels`, `.oldest_due_age_ms`, `.last_success_age_ms`, `.pending_work`, …, plus **per-PID** `{prefix}.rss_bytes` / `.cpu_cores` sampled from `/proc/{pid}/stat|status` every 10 s (`:788-862`), and `cron_index_rust.*` for itself (`:564-587`).

### 5c. The seven workers

All binaries: `--help`, `--dry-run`, `--once`, `--telemetry-json`, `--database NAME`, `--env-file PATH`; `MONGO_URI` must name a database or `--database` is required; `spawn_shutdown_signal` notifies a watch channel; current unit is never cancelled by a signal.

| Worker | Schedule and bounds | Leases / watchdog | Collections and keys touched | Env read |
|---|---|---|---|---|
| stream-activity (`bin/stream_activity.rs`, `workers/stream_activity`) | `--batch-size 500` (clamp 1–1,000); backlog runs back-to-back; idle backoff 1/2/4/5 s; health probe every 30 s (2 s timeout) between batches | checkpoint doc `stream_activity_states/_id=projector-v1`, lease 60 s; no watchdog | R/W `stream_activities`, `stream_activity_aggregates`, `stream_activity_states` | MONGO_URI |
| raid-analytics | one channel per pass, ≤25 follow windows, ≤5 concurrent query tasks; idle backoff 1–5 s; health 30 s | lease 60 s, repair 15 min, window 5 min (`raid_analytics.rs` consts) | read `domain_events`; R/W `raid_analytics_histories`, `raid_analytics_summaries` | MONGO_URI |
| follow-defense-baseline | one due channel per tick from Redis ZSET; bursts of 8 then 1 s cooldown; idle 1–5 s; health 30 s | claim = rescore +60 s; **30 s tokio timeout** → returns error → process exits nonzero (`bin:245-260`) | Redis `follow:defense:baseline:due` (ZSET), `SET follow:defense:baseline:{channel} EX 604800`; read-only aggregates on `follow_attack_logs`, `follow_relationship_ledgers`, `streamsessions` | MONGO_URI, DRAGONFLY_* |
| roulette-completion | ≤100 due rows per pass by `dueAt`; ready work immediately, else poll 1 s | revision CAS (≤20 attempts); **20 s pass watchdog** → exit nonzero (`bin:155-167`) | R/W `roulette_channels` | MONGO_URI |
| ai-usage-receipts | batch 200 (1–1,000), interval 1,000 ms (≥250); full clean batches continue immediately | global lock `worker:ai-usage-receipts:lock` TTL 300 s (configurable), per-account `locks:ai-usage-write:{sha}`; **20 s active-unit timeout** → exit nonzero | Redis lists `cron:ai-usage-receipts:{queue,processing,queue:dead}`, `cron:ai-usage-backfills:{queue,processing,dead}`, `INCR twitch:{channel}:ai:usage-receipts:generation`, `logger:twitch:global:{level}:…`; Mongo `ai_usage_receipts`, `ai_usage_dailies`, `ai_usage_dashboards`, `ai_usage_ledger_states`, `users` | `AI_USAGE_RECEIPTS_*`, `AI_USAGE_QUEUE_*`, `AI_USAGE_PROCESSING_MAX_AGE_SECONDS` (`ai_usage_receipts.rs:43-88`) |
| raid-sessions | tick = extend 1 session, backfill ≤200 events, admit ≤200 followers; ready → next tick, idle/failed → 1 s | 60 s leases; **20 s std-thread watchdog calls `std::process::exit(1)`** (`bin/raid_sessions.rs:70-135`) | Mongo `raid_sessions`, `raid_followers`, `raid_moderation_requests`, read `domain_events`, `follow_defense_{controls,actions,settings}`; Redis `twitch:{channel}:follow-defense:state` | MONGO_URI, DRAGONFLY_* |
| dashboard-activity | tick = project ≤500 activities, refresh 1 activity summary, refresh 1 insight summary; ready → `yield_now`, else 1 s | checkpoint `stream_activity_states/_id=dashboard-daily-v1`, lease 60 s, heartbeat every 10 s (`dashboard_activity.rs:708-754`); summary leases 60 s; **40 s std-thread watchdog calls `std::process::exit(1)`** (`bin/dashboard_activity.rs:67-134`) | Mongo `stream_activities` (sets `dashboardProcessed`), `stream_activity_states`, `dashboard_activity_dailies`, `dashboard_activity_summaries`, `dashboard_insights`, read `streamsessions`, `streamviewersnapshots`, `domain_events`; Redis `twitch:{channel}:emote-catalog:v1` (EX 86,400), `app:twitch:token`; HTTPS `id.twitch.tv/oauth2/token`, `api.twitch.tv/helix/chat/emotes` (3 s timeouts) | MONGO_URI, DRAGONFLY_*, CLIENT_ID, CLIENT_SECRET, proxy vars |

### 5d. Assumptions that break in one `dima-cron` process

1. **`process::exit` as recovery**: dashboard (40 s) and raid-sessions (20 s) watchdog threads, and the `cron_index` panic hook, kill the whole process. In one process a stalled dashboard tick would take down all workers. Needs per-task cancellation (`tokio::time::timeout` + abort) and a decision on what a truly hung (non-yielding) task does.
2. **"Exit nonzero, supervisor restarts the child"** (baseline, roulette, receipts timeouts; any `Err` from `run`) must become "task returns error → supervisor restarts the task" with the same restart delay and counters.
3. **Panic isolation**: today a panic kills one worker process. In-process, use `JoinSet`/`catch_unwind` per task; the global panic hook must not `exit(1)`.
4. **Telemetry by stdout parsing**: workers print `prefix:{json}` lines that the index parses and re-validates. In-process, workers should call a typed telemetry API; the 1,024-byte framing and field allowlists become types.
5. **Per-process metrics**: `{prefix}.rss_bytes` / `.cpu_cores` come from `/proc/{child_pid}`; per-worker RSS no longer exists. Dashboards fed from `observability:v1:inbox` need a decision (drop, or per-task CPU time via tokio metrics).
6. **Per-child env allowlist and uid drop** (`registry.rs:181-190`, `process.rs:400-417`): one process sees the union of variables (including `CLIENT_SECRET` for every worker). uid 65534 drop moves to the bridge (already done there).
7. **Shared global clients**: `mongo.rs` and `redis.rs` cache one client per process (`OnceCell`). Seven workers will share one Mongo pool and **one multiplexed Redis socket with no response timeout** (`redis.rs:121`); a hung Dragonfly command now stalls every worker. No deployed worker uses blocking Redis commands (only library `cron_queue.rs:489` `BLPOP`).
8. **Runtimes**: each binary builds a 2-worker-thread runtime; one process needs one runtime sized for all seven (dashboard insights follow scan and ICU sorts are CPU work on the async threads).
9. **Shutdown budget**: today 25 s child grace + 27 s close/export inside the bridge's 28 s. In-process: broadcast stop, let each task finish its current unit, then abort at the deadline.
10. **`--workers`, `--once`, `--dry-run` per binary** become subcommands/flags of one binary; `ops/rust_build.sh:108-116` dry-runs eight binaries and `dimabot/dockerfile:52-63` installs eight; `ops/saas_ops.py:33-34, 72-89` lists eight binaries and four feature profiles with per-profile forbidden-dependency guards (`:57-62`, `rust_build.sh:57-101`). One binary means one dependency graph containing reqwest + ICU + redis + mongodb.
11. `native_worker_metrics.ts` is already unused outside its test and can be retired with the TS side of the bridge.

---

## 6. Quality notes (non-test code, `src/`)

| Item | Count | Examples / notes |
|---|---|---|
| `unsafe` | 6 | `supervisor/process.rs:91` (fcntl dup), `:96` (`File::from_raw_fd`), `:217` (getuid/getgid), `:413` (getuid), `:432` (`kill(pid, SIGTERM)`); `supervisor/telemetry.rs:821` (sysconf). All libc FFI with SAFETY comments; all disappear or shrink without child processes. Test-only: `process.rs:856`. |
| `.unwrap()` | 0 | (all 0 in non-test code) |
| `.expect(…)` | 61 in 27 files | `dashboard_insights.rs:77,82` (`char::from_u32(..).expect` on surrogate paths — removed by UTF-8), `ast_evaluator/vm.rs:1084,1136,1448,1481`, `ast_blocks/writer.rs:387-393`, `validate.rs:26,61-65,235,503`, `keywords.rs:93,98,404,419`, `credit_policy.rs:167,255,267,484,525`, `raid_sessions/values.rs:13`, `stream_activity/projection.rs:70`. Mostly invariant-backed (constant regexes, validated shapes). |
| `panic!`/`unreachable!` | 5 | `permissions.rs:567`, `ast_blocks/writer.rs:140`, `ast_evaluator/vm.rs:1374`, `pure/strings.rs:35`, `pure/eventsub.rs:68` (all `unreachable!` after exhaustive dispatch) |
| Byte-index string slicing | ~94 slice expressions matched; reviewed string ones | Safe by ASCII guard: `supervisor/mod.rs:90-94`, `ai_usage_receipts/values.rs:115`, `chat_message.rs:116-117,158`, `credit_policy.rs:243`, `follow_defense_baseline.rs:224`, `ai_usage_receipts/queue.rs:209`, `permissions.rs:870`, `raid_sessions/values.rs:219,225`. Safe by construction but not by type: lexer/parser token ranges (`ast_syntax/lexer.rs:78,103,186,318,356…`, `parser.rs:28,37,41,594`), `keywords.rs:203-209`, `ast_blocks/mod.rs:186`. Documented panic: `re2_compat.rs:236` (`utf16_offset` off a boundary). `logger.rs:877` `String::truncate(100)` safe only because `clean()` outputs ASCII. The conversion should add one `floor_char_boundary`/char-index helper and route all truncation through it. |
| Blocking in async | 0 found | No `std::thread::sleep`/`std::fs` in async paths. Watchdogs and diagnostics deliberately use std threads (`bin/dashboard_activity.rs:72-104`, `bin/raid_sessions.rs:70-121`, `process.rs:100-125`). CPU-heavy synchronous work on async threads: ICU sort + 100k-follow scan in `dashboard_insights.rs:398-416, 556-579`; AST evaluator is `!Send` (`Rc<RefCell>`), so an API caller needs a `LocalSet`/dedicated thread. |
| Global statics | 17 `static` + 29 `OnceLock/OnceCell/LazyLock` uses | Process-wide clients: `mongo.rs:39`, `redis.rs:74`, `qdrant.rs:54`, `posthog.rs:31`, `email.rs:30`; `process.rs:43` DIAGNOSTICS; compiled regexes `keywords.rs:90,97`, `ast_blocks/validate.rs:88`, `pure/mod.rs:92-98`, `qdrant/parity.rs:37`; `ast_blocks/mod.rs:368` default engine; `chat_events.rs:77` catalog; `registry.rs:68` WORKERS. |
| Unbounded channels/collections | 3 `mpsc::channel()` | `bin/dashboard_activity.rs:73`, `bin/raid_sessions.rs:75` (watchdog commands, one in flight), `test_http.rs:68`. Collections are bounded (keyword cache capacity 2,000; DecodeCache 64 entries/1 Mi units; diagnostics queue 64; telemetry 2,000 metrics). `json_parse` has no depth/size cap by design (`value.rs:608-610`), but is iterative. `OrderedMap` lookups are linear (`context.rs:15-46`). |
| Missing network timeouts | 5 modules | No explicit request timeout in `email.rs`, `posthog.rs`, `s3.rs`, `otel.rs`, `qdrant.rs`/`qdrant/backend.rs` (crate defaults only). `redis.rs:121` sets response timeout `None` on purpose. `mongo.rs` sets no server-selection timeout (driver default 30 s); deployed workers bound queries with `max_time`. Twitch/Polar/dashboard HTTP have timeouts. |
| Dependency pins | 6 exact pins | `aes =0.8.4`, `ctr =0.9.2`, `getrandom =0.4.3`, `libc =0.2.191`, `unicode-normalization =0.1.26`, `uuid =1.28.0` (`Cargo.toml:117-157`). Yanked/age status **not verified** (no network, no cargo). |
| Duplicate versions in `Cargo.lock` (538 packages) | — | `reqwest` 0.12.28 + 0.13.5, `axum` 0.7.9 (via qdrant/tonic 0.12) + 0.8.9, `prost` 0.13/0.14, `rand` 0.8/0.9/0.10, `sha2`/`digest` 0.10/0.11, `getrandom` ×3, `hashbrown` ×4, `base64` 0.22/0.23. `ring` and `aws-lc-rs` both compile when email/posthog/s3/otel are on, hence `install_default_tls_provider` (`utils/mod.rs:144-160`). |
| Unused features | 2 | `postgres` (sqlx 0.9.0) is in `default` with no code using it; `http` only backs `cors.rs`/`socketio.rs`. |
| Duplicated logic | 6 Number→String, 6 `String()` coercers, 2 JS-JSON string encoders, 3 radix-number parsers | see §4 N1–N6, S1, E16/D2, N10/N14/N15. One shared text crate removes ~400 lines. |

---

## 7. Proposed workspace split (proposal only)

Goal: heavy dependencies (aws-sdk-s3, qdrant-client/tonic/prost/axum 0.7, opentelemetry, icu_collator, symphonia, resend, posthog) live only in leaf crates that need them.

| Crate | Path | Modules moved in | Dependencies |
|---|---|---|---|
| `dima-text` | `crates/text` | `js_compat`; one `number_to_js_string` (replaces N1–N6); one `js_string_of(json)` (S1); ISO date (`javascript_iso`), `Date.UTC` helpers (`utc_time` minus BSON types); char-safe truncate/slice helpers; the single UTF-16 edge converter (`re2_compat::utf16_offset`, span conversion) | none (serde_json optional) |
| `dima-store` | `crates/store` | `mongo`, `redis`, `bson_compat`, BSON-side of `utc_time` | mongodb, redis, rustls(ring), tokio |
| `dima-ast` | `crates/ast` | `ast_syntax`, `ast_blocks`, `ast_evaluator` (+`pure` behind a feature) | serde, serde_json, regex, `dima-text`, `dima-policy` (permissions) |
| `dima-policy` | `crates/policy` | `permissions`, `keywords` (pure parts), `re2_compat`, `eventsub`, `domain_events`, `chat_message`, `chat_events`, `timer_policy`, `credit_policy`, `ai_usage`, `command_cooldown` | serde, serde_json, regex, unicode-normalization, `dima-text` |
| `dima-telemetry` | `crates/telemetry` | supervisor `telemetry.rs` (inbox exporter, metric aggregation), `logger` core; `logger/redis` behind feature; `logger/otel` behind feature | redis (opt), serde_json, uuid, tokio; opentelemetry only behind `otel` |
| `dima-queue` | `crates/queue` | `cron_queue`, `plan_cache_fence` | redis, serde_json, uuid |
| `twitch` | `services/twitch` | `twitch`, `twitch_tokens`, `twitch_streamers`, `credential_crypto`, dashboard emote catalog provider | reqwest (one version), aes, ctr, getrandom, `dima-store` |
| `polar` | `services/polar` | `polar` | reqwest |
| `qdrant` | `services/qdrant` | `qdrant/*` | qdrant-client (pulls tonic/prost/axum 0.7), md-5 |
| `s3` | `services/s3` | `s3` | aws-sdk-s3 |
| `notify` (or three tiny crates) | `services/{email,posthog,otel}` | `email`, `posthog`, `otel` | resend-rs / posthog-rs / opentelemetry-otlp (each brings aws-lc-rs; keep apart) |
| `audio` | `services/audio` | `audio` | symphonia |
| `dima-cron` | `cron` | all `workers/*`, new in-process supervisor (from `supervisor/process.rs` + `registry.rs` minus process spawning), one `main` | `dima-store`, `dima-text`, `dima-telemetry`, `twitch` (emote catalog), icu_collator (dashboard insights only), garde, sha2, futures-util |
| `dima-api` | `api` | `cors`, `socketio`, `jwt`, future routes; sqlx when actually used | axum 0.8, tower-http, socketioxide, jsonwebtoken |
| `dima-bot` | `bot` | future bot port; consumes `dima-ast`, `dima-policy`, `twitch` | — |

Notes:
- `icu_collator` is used in exactly one function (`dashboard_insights.rs:292-295`); it can stay in `dima-cron` or move to a 20-line `dima-collation` crate if the API also needs `localeCompare` ties.
- The four per-profile forbidden-dependency guards (`ops/rust_build.sh:57-101`, `ops/saas_ops.py:57-62`) assume four separate binaries. With one cron binary they turn into crate-level `cargo tree -p <crate>` guards (for example "`dima-store` must not depend on reqwest").
- Drop `postgres` from defaults until a crate uses sqlx.
- Converting `JsString` to `String` touches `ast_evaluator` (value, storage, vm, context, host, registry, pure: ~4.9k non-test lines) and all its corpora; it is independent of the cron reorganisation and has no deployed caller, so it can land as a separate step.
