# dima-rust

`dima-rust` is a Rust library for incremental migrations of selected worker and server components. The current dual-supervisor cron release is `cron-be76d96c7a39` / image `sha256:f5ccef5ad569484a318da211718d5b903c061913944a9ac8345082fd0ef24c05`; Node PID 1 owns TypeScript workers and starts one Rust index for seven native workers in the same `dima-cron` container. Its build, eight exact-image supervisor checks, four production topology samples, telemetry readbacks, and cleanup passed. Rollback with `scripts/saas-ops rollback cron-be76d96c7a39` restores `cron-ea507552f33d` / image `sha256:46706ffeb3c55bfcaf67964675d3fc6404dc965a52b55009c787f1a8b1c328c5`. See [telemetry-counter-release.md](../migration-notes/telemetry-counter-release.md) for current release evidence and [dual-cron-supervisors.md](../migration-notes/dual-cron-supervisors.md) for lifecycle details.

Cargo defaults preserve `mongo`, `redis`, `postgres`, and `http` for library/manual consumers. The six prior cron binaries use existing Mongo-only or Mongo/Redis profiles. Dashboard uses `--no-default-features --features mongo,redis,http-client,unicode-collation`; reqwest 0.12.28 and ICU collation are isolated to it. Cargo declares `icu_collator` 2.3.0, and the lockfile resolves 2.3.1. SQLx/PostgreSQL and Axum remain excluded from worker profiles. The shared-utility release retained all three dependency graphs byte-identically; its build and tests passed, and production acceptance passed. See [worker-shared-utils.md](../migration-notes/worker-shared-utils.md) and [dashboard-activity.md](../migration-notes/dashboard-activity.md) for current and historical evidence.

## Opt-in consolidated utility foundations

The library also exposes `utils::{command_cooldown,keywords,chat_events,ai_usage,eventsub,domain_events}` behind independent features `command-utils`, `keywords`, `chat-events`, `ai-usage`, `eventsub`, and `domain-events`. `bot-utils` enables those six together. `utils::twitch` and `utils::polar` are separately gated by `twitch-client` and `polar-client`. All are opt-in, outside Cargo defaults and deployed worker profiles; TypeScript remains unchanged and no production caller is wired. These are reusable cores, not complete migrations. Existing worker utilities stay in place.

The stateful boundaries are injected: implement `CooldownStore` for command cooldown reads/leases, `KeywordStorage` for keyword persistence/cache coordination, and `TokenSource` for Twitch credentials and permission/expiry policy. Rust MongoDB/Redis adapters are not wired. Twitch and Polar provide real HTTP transport that can be tested against loopback servers; an OAuth adapter must persist rotated credentials before using them. EventSub canonicalization supports legal flat string conditions, and domain-event helpers project envelopes and build keys; with `mongo`, BSON projection preserves BSON values.

```rust
use dima_rust::utils::{eventsub, keywords};

let entries = [keywords::KeywordEntry {
    id: "greeting".into(), text: "hello".into(),
    match_mode: keywords::KeywordMatchMode::Anywhere,
}];
let index = keywords::compile_keyword_index(entries);
assert_eq!(keywords::match_keywords(&index, "hello world").len(), 1);
let condition = eventsub::Condition::from([("broadcaster_user_id", "123")]);
let key = eventsub::subscription_key("channel.follow", "2", &condition);
```

The source mappings, behavioral limits, and verification commands are in [ts-util-foundations.md](../migration-notes/ts-util-foundations.md).

## Opt-in policy, queue, and token utilities

Six additional modules are exposed behind independent features: `chat-message`, `timer-policy`, `credit-policy`, `cron-queue`, `credential-crypto`, and `twitch-tokens`. They are not in Cargo defaults or deployed worker profiles, and no production TypeScript caller is wired to them. `twitch-tokens` composes the existing `twitch-client`, MongoDB, Redis, and credential-crypto features. These are library APIs; enabling a feature does not add a worker or change the accepted [dual-supervisor release](../migration-notes/dual-cron-supervisors.md).

`chat_message` covers the JSON chat-origin, bits-text, and badge-formatting rules. `timer_policy` contains pure frequency conversion, parsing, and plan validation; timer cache, rendering, and AST parsing remain outside it. `credit_policy` contains pure reset decisions, allowlisted credit-pack offer calculations, recharge expiry, and TTS usage estimates. Dates enter as `JsDate` epoch milliseconds after caller-owned JavaScript `Date.parse`/`Date` conversion; the module does not implement full JavaScript timer cache or billing behavior, make Polar calls, or persist grants.

`cron_queue` exposes enqueue serialization and dedupe, raw `BLPOP`, `RPUSH`, and the shared attempt normalization/increment helpers. Its JSON compatibility is structural rather than byte-for-byte. Parsing returns `Result<Option<CronQueueJob>, CronQueueParseError>`: invalid syntax within the limit is `Ok(None)`, while more than 127 nested containers is an explicit error that every consumer must handle rather than silently discard. Queue consumers still own retry limits, future-due scheduling, and cleanup ordering. The clip worker's processing-list lease, acknowledgement, recovery, and dead-letter fencing protocol is not ported; do not use the shared queue primitives as a substitute for that protocol.

`credential_crypto` reads no environment variables and implements the legacy AES-256-CTR storage envelope. It preserves the existing unauthenticated format for compatibility; it is not a general-purpose encryption API. `twitch_tokens` accepts injected Mongo/Redis handles and OAuth/clock dependencies. Its conditional persistence and cache publication, account-list metadata preservation, and partial-hash behavior are documented in [policy-queue-token-utils.md](../migration-notes/policy-queue-token-utils.md). Those compare-and-set writes differ from TypeScript's current writers, so mixed TypeScript/Rust writers require review before wiring callers.

Final source-backed validation for these utility features passed on 2026-10-23: formatting, nine no-default/independent/combined feature checks, combined Clippy, 194 test executions across combined, independent Qdrant, and disposable service runs, and the recorded source-oracle suites. The count includes repeated Qdrant coverage, not 194 distinct tests. These remain opt-in library contracts with no production caller adoption, worker registration, or deployment. Source mappings, pacing rationale, boundaries, evidence, and remaining adoption limits are in [policy-queue-token-utils.md](../migration-notes/policy-queue-token-utils.md). The separately validated [Qdrant folder port](../migration-notes/qdrant-folder.md) records its verified library behavior and also has no runtime rollout.

## Opt-in permission core

The pure permission core is available with `--no-default-features --features permissions`. It uses the existing Serde dependencies and remains outside Cargo defaults, `bot-utils`, and worker profiles. Callers can compile stored policy once into an immutable, owned plan, avoiding repeated validation on each decision. Flat access plans stay separate from general Boolean expressions so named-account and specific-role precedence, plus order-sensitive source recognition, remain intact. Decisions include reasons, and validation errors include a code and path for diagnostics. There is no global cache or IO.

```rust
fn main() {
    use dima_rust::utils::permissions::{CompiledPermission, RoleTag, UserIdentity};
    use serde_json::json;

    let identity = UserIdentity::new(7.0, [RoleTag::Mod], Some("00123".into()), None);
    let policy = CompiledPermission::compile(Some(&json!({"role": "mod"})), None);
    assert!(policy.allowed(&identity));
}
```

See [permission-core.md](../migration-notes/permission-core.md) for parity scope, compatibility edges, and verification status. The compiled value is an immutable snapshot: replace it when configuration changes. This port has no live caller adoption, role-cache IO, resolver, admin middleware, or authentication responsibility.

## Opt-in AST syntax core

The independent opt-in `ast-syntax` feature exposes `dima_rust::utils::ast_syntax` as a pure parser, scanner, template-plan compiler, diagnostic, and AST-serialization core. TypeScript remains unchanged and no production caller is wired to it. Evaluation, `ast_blocks` conversion, runtime functions and action handlers, context, IO, live cache, worker integration, and deployment remain separate migrations.

`SyntaxEngine::default()` selects Improved semantics; `SyntaxEngine::typescript_compatible()` keeps TypeScript's permissive nested parse, legacy error-literal, and quote/array-scanning policies, subject to Rust resource limits. Improved mode corrects apostrophe, nested-quote, and escaped-array scanning and reports nested parser errors and unconsumed tokens instead of accepting truncated syntax. Grammar preparation rejects aliases colliding with reserved `%[` syntax. The whole-program `parse` grammar differs from chat `scan_template`/`compile_template`, which preserve ordinary text and compile only expression segments. Syntax errors are retained in segment order; aggregate resource-limit errors abort the plan. Defaults are 10,000 UTF-16 source units, 20,000 tokens, 4,000 nodes, and nesting 128 (clamped at 128). A separate persisted-AST JSON boundary limits a standalone AST to 127 nested JSON containers for the standard `serde_json::from_str` reader; any future caller envelope needs its own aggregate nesting budget.

Compiled templates are immutable and reusable only for exact source plus identical prepared grammar identity, profile, and limits. Runtime substitutions such as `&pN` and `&t` happen before matching/compiling. Grammar aliases select built-in syntax-handler kinds; they cannot register arbitrary callbacks or functions. AST JSON keeps the version 1 `AstTimerJob` body shape, omits absent optional fields, and excludes parser spans. Final source validation passed 1,200 corpus cases and 109 test executions across profiles (repeats included). The compilation-only microbenchmark was mixed: 10 of 11 medians were lower for Rust, while `dense100` was slower; this does not establish evaluation or production latency. See [the source and benchmark record](../migration-notes/ast-syntax-core.md) and the [raw benchmark artifact](benchmarks/ast-syntax-2026-10-25.json).

Use Serde to map BSON documents into explicit structs. Garde checks additional field and business constraints only when `validate()` is called. Future ports must explicitly preserve existing collection names, field types, defaults, and indexes.

## Opt-in AST blocks core

The independent `ast-blocks` Cargo feature exposes the pure command-block library at `dima_rust::utils::ast_blocks`. It reuses `ast_syntax` with an explicit TypeScript-compatible default profile; Improved syntax is available by constructing `BlocksEngine` with that profile. The library validates JSON block trees, normalizes and compares typed trees, compiles blocks to command text, imports command text with safe raw fallbacks, and creates the version 1 stored shape `{ "v": 1, "root": ... }`. The eight source files include `import_plan.rs`, which retains source boundaries through root-context normalization and applies eligibility to the final root fragments.

Limits are 7,500 validated nodes (root and accessor wrapper excluded; synthesized empty ternary children included), depth 48, and 10,000 JavaScript UTF-16 units for individual strings, source, and output. Each operation also has bounded aggregate syntax source/node/token work; a single syntax program is capped at 30,002 nodes, 40,000 tokens, 10,000 source units, and nesting 128. Its exact-source syntax cache is local to that operation; only immutable syntax results are cached, and work is charged on cache hits. The emitter starts with an empty `String`, grows requested capacity with `reserve_exact` up to 30,000 bytes, and stops retaining output after 10,000 UTF-16 units while continuing to count. Import checks final root-context fragments after normalization: unsupported or non-round-tripping expressions become exact-source raw pieces, while whole-operation source, token, or work exhaustion returns a structured error. Structured errors include a code, message, optional `blockId`, and JSON pointer; transient provenance follows normalization but is not stored.

Serde on public types is a wire convenience, not an untrusted-input validation boundary. Validate external JSON with `read_block_root` before using typed storage helpers. The TypeScript 4,000-node rule and current TypeScript API/caller paths remain unchanged. No evaluator, API, editor, runtime, or production caller is integrated. Frozen source corpus: 467 cases (read 281, normalize 28, compile 96, import 39, stored 7, equality 16); manifest hash `15753dca4773e836e4bc49bed453c1087d834c49938a4c8cfd3ede5f4be0bb91`; exact fixture JSON SHA-256 `6efd58734bd63d1c53acad063e30f7e5dc862a65b36c088507c339410a8bc34a`. Capped quality checks passed with 163 test executions across repeated profiles. The same 467-case oracle ran in each of two profiles; these counts do not mean 163 unique tests or 934 distinct cases. Rust had lower medians in 19 of 21 release benchmark operations; these synthetic results do not establish production latency or isolate one optimization. No deployment or caller migration occurred. See [the AST blocks migration record](../migration-notes/ast-blocks.md) and [the full benchmark artifact](benchmarks/ast-blocks-2026-10-25.json) for verification, all paired medians, and limitations.

## Opt-in AST evaluator

The opt-in `ast-evaluator` feature composes `ast-syntax` and `permissions` and exposes `dima_rust::utils::ast_evaluator`. It is not a default feature or worker-profile change; no TypeScript or production caller is wired to it. Final-source quality, release benchmark, bounded independent R2 review, and cleanup receipts are complete; the artifact records `acceptanceComplete: true`. No evaluator resources remain and there was no evaluator deployment. See the [migration record](../migration-notes/ast-evaluator.md) and [full benchmark artifact](benchmarks/ast-evaluator-2026-10-25.json).

The library uses reusable immutable plans for exact post-substitution source, a fresh execution context and decode memo per independent run, a local synchronous interpreter for pure nodes, and an injected asynchronous host for explicit effects. Context and values use `Rc<RefCell<...>>` and local-task `!Send` futures. Reusing an immutable `Engine` does not make contexts or futures cross-thread. Future HTTP or multithreaded callers need local evaluator executor/context integration; this feature provides no bridge and does not promise compatibility with arbitrary Axum futures. The host boundary includes function dispatch, cache and database operations, response saving, timers, and randomness. Only the optional `count`, `scount`, `bits`, `break`, and `continue` context builtins are in scope; Twitch functions and other handlers remain host-owned. Effect authority is an opaque capability that JSON cannot mint. Typed plain data preserves JavaScript-relevant values such as `undefined`, non-finite numbers, negative zero, and UTF-16 strings with unpaired surrogates. Callables, prototypes, and `BigInt` are outside the supported value domain.

Illustrative API shape (the host implementation and function registry are supplied by the embedding caller):

```rust
let engine = Engine::new(registry);
let plan = engine.compile_template(exact_post_substitution_source)?;
let context = ExecutionContext::default().into_context();
let result = engine.render(&plan, context, &mut host).await?;
```

The default syntax profile is TypeScript-compatible; `Engine::with_syntax` explicitly selects an existing Improved/custom engine while the default/new TypeScript-compatible guard remains in place. Preserve current source semantics, including error-as-output cases, array and argument semantics, command-reference pre-argument guards and post-argument budget check, post-argument function permission checks, timer body deferral, and the distinct root/template join rules. `scope_aliases` and `visited_commands` are shared `Rc<RefCell<...>>` vectors. `LoopVars` uses bounded copy-on-write map storage rather than linked binding history; actual mutation detaches are counted and there are no per-node futures. Array memo limits evict entries and cause uncached decoding, not command refusal. `OrderedMap<T, K = String>` / `SharedMap<T, K = String>` keeps String keys by default; only `user_command_variables` uses `SharedMap<JsString, JsString>`, so derived DB-user memo keys retain UTF-16 units without lossy conversion. Native identity strings retain the declared checked UTF-8 boundary.

The final source oracle has 3,563 cases: 3,554 supported cases and nine named source-only boundaries (eight function values and one unknown AST tag). Thirty-six cases were added (23 DB-user memo and 13 event-data spread); all 3,527 earlier source facts and 16 benchmark definitions are unchanged. Quality receipts record 188 test executions across profiles and repeats (`[59, 13, 2, 101, 13, 0]`), not 188 unique tests; the Rust module contains 17 local tests. All 149 project hashes and 23 TypeScript source/test hashes match current source. Four worker dependency graphs match. Fourteen of 15 prepared benchmark medians were lower for Rust; `array-write-invalidate` was 186.715 µs versus 172.356 µs for TypeScript, about 8.3% higher for Rust. The synthetic results do not establish production latency, throughput, or resource use and do not isolate any one optimization. Acceptance is complete; the bounded independent R2 review found no actionable findings. Caller adoption is a later scope. See the [evaluator migration record](../migration-notes/ast-evaluator.md) for hashes, the full table, methodology, and limits.

## Shared worker utilities

The `mongo` feature exposes small compatibility and process helpers in `utils::{bson_compat,js_compat,utc_time,worker_process}`. `bson_compat::js_number` and `normalize_document` preserve the Node BSON Number read/write boundary for selected payloads; callers decide which documents to normalize. `utc_time::utc_midnight` and `inclusive_day_start` provide UTC calendar arithmetic without choosing a worker's query endpoints or scheduling policy. `js_compat::trim` supplies JavaScript whitespace trimming and is shared with other opt-in helpers.

For example, normalize a document only at the same write boundary used by the source worker, or derive an inclusive 30-day calendar start:

```rust,no_run
use dima_rust::utils::{bson_compat, utc_time};
use mongodb::bson::{DateTime, doc};

let mut payload = doc! { "count": 4.0 };
bson_compat::normalize_document(&mut payload);
let start = utc_time::inclusive_day_start(30, DateTime::now());
```

`worker_process` provides `load_env_files(&[PathBuf])`, `spawn_shutdown_signal(watch::Sender<bool>)`, and `IdleBackoff`. Explicit environment files load synchronously before runtime threads; inherited variables win, then earlier files win over later files. The signal task only notifies a cooperative stop receiver, while the worker owns its current-unit drain and signal-task cleanup. `IdleBackoff` waits 1, 2, 4, then 5 seconds across empty batches and resets to no wait when a batch does work. These helpers are intended to preserve existing callers' behavior; they do not define a shared worker runtime or scheduling policy. The prior accepted run `cron-2056ce9d790c` included them across all seven native workers; see [worker-shared-utils.md](../migration-notes/worker-shared-utils.md).


Rust’s explicit `--env-file PATH` support is for manual executable invocations before runtime threads start; it does not load `.env` automatically or create a second production bootstrap.

`dima_rust::utils::mongo::get_mongo_client().await` returns `mongodb::error::Result<&'static Client>`. On first call it reads `MONGO_URI` directly from the process environment (it does not load dotenv files), creates a native MongoDB client, and pings `admin` before caching it in a Tokio `OnceCell`. Failed initialization can be retried. Use the cached client within the application's long-lived Tokio runtime and share it across tasks and threads. Static storage does not keep the driver's originating runtime alive, so do not reuse the client after that runtime or the client has been shut down. Clone the native handle when an owned handle is needed; clones share the same pool. Callers select their database explicitly. A URI database name is available through the driver's default-database behavior, but the utility adds no implicit fallback.

`dima_rust::utils::redis::get_redis_client().await` returns `redis::RedisResult<redis::aio::ConnectionManager>`. It reads `DRAGONFLY_HOST` and `DRAGONFLY_PORT` directly from the process environment, matching [`dimabot/src/utils/databases/dragonfly.database.ts`](../dimabot/src/utils/databases/dragonfly.database.ts). It connects over plain TCP to database 0; it does not add a URI, password, TLS, or database-selection option. It does not load dotenv files. The manager is cached in a Tokio `OnceCell` only after connection and `PING` succeed, so failed or cancelled initialization can be retried. The initial connection and ping have a five-second timeout. Returned managers are owned, cheap clones that share one multiplexed TCP socket. The response timeout is unset to preserve blocking command semantics; blocking commands and Pub/Sub should use separate dedicated connections when implemented. Keep using the cached manager within the application's long-lived Tokio runtime; static storage does not keep that runtime alive, and the manager must not be reused after runtime shutdown. The driver reconnects after an I/O disconnect, but a command that encounters the disconnect is returned as an error and is not replayed. Configuration errors do not include raw environment values.

Opt-in service foundations mirror `dimabot/src/utils` helpers for future ports: `email` (Resend), `posthog`, `qdrant` (gRPC on `QDRANT_GRPC_PORT`, default 6334), `s3`, `otel` (OTLP logs to PostHog), `jwt` (Node-identical activation tokens), `re2-compat` (RE2 semantics on `regex`), `socketio` (socketioxide with socket.io defaults), and `audio` (MP3/WAV durations). `http` also provides the legacy permissive CORS layer. None is in `default` or a worker profile, and nothing in production uses them yet. Crate choices, parity evidence, and known differences are in [migration-notes/ts-util-foundations.md](../migration-notes/ts-util-foundations.md).

For example, Redis commands use the driver's `AsyncCommands` API:

```rust,no_run
async fn read_cache_value() -> Result<Option<String>, Box<dyn std::error::Error>> {
    use redis::AsyncCommands;

    let mut cache = dima_rust::utils::redis::get_redis_client().await?;
    let value: Option<String> = cache.get("example:key").await?;
    Ok(value)
}
```

Adding `dotenvy` does not load files automatically. The manual `stream_activity` executable accepts repeatable `--env-file PATH` arguments and loads those files synchronously before building its two-thread Tokio runtime. Existing process variables take precedence, and earlier files take precedence over later files. The MongoDB and Redis library utilities never load dotenv files. For custom executables, load explicitly selected files before creating Tokio and calling either client utility. For example:

```rust,no_run
async fn run_application() -> Result<(), Box<dyn std::error::Error>> {
    // Start the application and use get_mongo_client() here.
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::from_path("path/to/.env.local")?;
    dotenvy::from_path("path/to/.env")?;

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(run_application())?;
    Ok(())
}
```

Replace the example paths with the files the executable is configured to load. The library itself does not load environment files.

Seven scheduled responsibilities have accepted Rust implementations. Former TypeScript selectors are retired where they existed; dashboard API/request-time behavior, queue producers, and shared TypeScript helpers remain active. Failed native children restart without runtime fallback.

Check the library from this directory using the commands below. On the production VPS, every Cargo command listed is subject to the [production-host Rust build and test policy](AGENTS.md#production-host-rust-build-and-test-policy); do not run these commands directly on the host:

```sh
cargo fmt --all -- --check
cargo check --locked --all-targets
cargo clippy --locked --all-targets -- -D warnings
cargo build --locked
cargo test --locked
```

Build checks and default Rust tests do not require database or cache services; MongoDB and Redis integration tests use external fixtures and are ignored by default. The stream, raid, baseline, roulette, AI receipts, raid-sessions, and dashboard checks are documented in the migration notes and [`ops/README.md`](../ops/README.md). Run service-backed checks only against isolated disposable data. Production artifacts are built and staged through `scripts/saas-ops`; `Cargo.lock` is tracked and `--locked` ensures the checked graph matches it. The dashboard binary declares `--help`, `--dry-run`, `--once`, `--telemetry-json`, `--database NAME`, and repeatable `--env-file PATH`; this interface was verified in prior accepted releases.

The helper keeps Cargo registry and dependency artifacts in a private persistent cache outside the checkout. The deployed candidate adds the Rust index as an eighth binary under the existing capped build policy; see [dual-cron-supervisors.md](../migration-notes/dual-cron-supervisors.md) for accepted release evidence and [worker-shared-utils.md](../migration-notes/worker-shared-utils.md) for the prior accepted build. The stream fixture remains a manual parity/benchmark tool and is not staged in routine cron candidates. Cache reuse reduces compile work only and does not establish Rust worker RAM or CPU savings.


## Raid change-driven release notice

Raid change-driven release `cron-2ddd455fdd1f` remains accepted historical evidence: its then-current four worker suites and 124.802-second production watch passed. The historical five-worker image was `cron-7b8a6c88303d`; see [migration-notes/raid-change-driven.md](../migration-notes/raid-change-driven.md) and [migration-notes/ai-usage-receipts.md](../migration-notes/ai-usage-receipts.md) for those releases. The [scheduling release record](../migration-notes/worker-backlog-scheduling.md) documents its historical image and rollback pointer; current cron status is in [dual-cron-supervisors.md](../migration-notes/dual-cron-supervisors.md).
