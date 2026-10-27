# TypeScript util foundations in Rust

**Status: library only, not deployed.** On 2026-10-22 the user chose to port `dimabot/src/utils` helpers into the `dima-rust` library first. TypeScript keeps its own copies and nothing in production calls these modules yet. Each foundation is an opt-in Cargo feature. None is in `default` or in any deployed worker profile, and the seven worker dependency trees are unchanged.

## Crate choices

The user approved these crates. Each disables its crate defaults and uses rustls (the compiler image is Alpine/musl, so OpenSSL is avoided).

| Feature | Module | Replaces (TypeScript) | Crate |
| --- | --- | --- | --- |
| `email` | `utils::email` | `resend` in `email/email.service.ts` | `resend-rs` 0.35 (official) |
| `posthog` | `utils::posthog` | `posthog-node` in `posthog_events.ts` | `posthog-rs` 0.27 (official) |
| `qdrant` | `utils::qdrant` | `@qdrant/qdrant-js` in `databases/qdrant.database.ts` | `qdrant-client` ~1.17 (official, gRPC) |
| `s3` | `utils::s3` | `@aws-sdk/client-s3` in `s3.ts` | `aws-sdk-s3` 1.154 (official) |
| `otel` | `utils::otel` | `@opentelemetry/*` in `opentelemetry_posthog.ts` | `opentelemetry`/`_sdk`/`-otlp` 0.33 |
| `jwt` | `utils::jwt` | `jsonwebtoken` in `email/email-activation-token.ts` | `jsonwebtoken` 11 (`rust_crypto`) |
| `re2-compat` | `utils::re2_compat` | `re2` in `moderation/advanced.ts`, `variations.ts` | `regex` 1.13 |
| `http` | `utils::cors` | `cors()` in `server/server.ts` | `axum` 0.8 + `tower-http` 0.7 |
| `socketio` | `utils::socketio` | `socket.io` in `server/websocket.ts` | `socketioxide` 0.18 |
| `audio` | `utils::audio` | `mp3-duration` in `tts/tts_playback_timeout.util.ts` | `symphonia` 0.6 (`mp3`, `id3v2`) |

The Polar transport is now available behind `polar-client`; it is deliberately a generic JSON transport rather than a port of customer creation, event ingestion, webhook validation, or billing workflows. OpenRouter and Fish Audio wrappers remain to build. React Email templates have no Rust equivalent. `email` sends only HTML and text that were already rendered.

## Consolidated utility modules

**Status: opt-in library source integrated and verified.** These public library modules consolidate small helpers and shared cores. They do not replace TypeScript, wire production callers, or migrate a complete application feature. All listed features are opt-in, outside Cargo `default` and all worker profiles; existing worker utilities have not been moved or reimplemented. The Cargo feature names below were read from `dimabot/Cargo.toml`.

| Feature | Public module | Source references and scope |
| --- | --- | --- |
| `command-utils` | `utils::command_cooldown` | [`command_cooldown.ts`](../dimabot/src/utils/command_cooldown.ts), [`command_cooldown_write.ts`](../dimabot/src/utils/command_cooldown_write.ts); cooldown policy and command-write coordination via injected `CooldownStore` |
| `keywords` | `utils::keywords` | [`keywords.ts`](../dimabot/src/utils/keywords.ts), [`keyword_cache.ts`](../dimabot/src/utils/keyword_cache.ts); normalization, validation, matching, local cache and storage protocol via injected `KeywordStorage` |
| `chat-events` | `utils::chat_events` | [`chat_notification_defaults.ts`](../dimabot/src/utils/chat_notification_defaults.ts), [`chat_event_catalog.ts`](../dimabot/src/utils/chat_event_catalog.ts); message defaults and built-in event catalog helpers |
| `ai-usage` | `utils::ai_usage` | [`ai_usage_event.ts`](../dimabot/src/utils/ai_usage_event.ts), [`ai_usage_classification.ts`](../dimabot/src/utils/ai_usage_classification.ts); context and metadata projection/classification helpers |
| `eventsub` | `utils::eventsub` | [`eventsub_condition.ts`](../dimabot/src/utils/eventsub_condition.ts), [`raid_direction.ts`](../dimabot/src/utils/raid_direction.ts), [`eventsub_reconciliation_policy.ts`](../dimabot/src/utils/eventsub_reconciliation_policy.ts), and condition serialization/key helpers from [`eventsub.ts`](../dimabot/src/utils/eventsub.ts) and [`eventsub_reconciliation.ts`](../dimabot/src/utils/eventsub_reconciliation.ts) |
| `domain-events` | `utils::domain_events` | [`domain_events.ts`](../dimabot/src/utils/domain_events.ts), [`domain_event_consumer.ts`](../dimabot/src/utils/domain_event_consumer.ts); shared event-key and envelope projection core, not journal writes, delivery, leases, retries, or dispatch runtime |
| `twitch-client` | `utils::twitch` | [`tokens.ts`](../dimabot/src/utils/tokens.ts), [`header.ts`](../dimabot/src/utils/header.ts), [`links.ts`](../dimabot/src/utils/links.ts), [`twitch_helix_retry.ts`](../dimabot/src/utils/twitch_helix_retry.ts), [`oauth_debug_cache.ts`](../dimabot/src/utils/oauth_debug_cache.ts); transport and pure helpers, not the live token cache |
| `polar-client` | `utils::polar` | [`billing.ts`](../dimabot/src/utils/billing.ts)::`polarRequest`, [`credit_gift_provider.ts`](../dimabot/src/utils/credit_gift_provider.ts)::`giftPolarRequest`; policy-specific HTTP transport only |

`bot-utils` is an umbrella for `command-utils`, `keywords`, `chat-events`, `ai-usage`, `eventsub`, and `domain-events`; it is not enabled by default. The `utils::js_compat` module is shared by the independent text utilities and does not depend on keyword matching.

Integration boundaries and limitations:

- Implement `CooldownStore` for owner-plan lookup, zero-cooldown lease/existence operations, and lease release. The caller still owns the command write. The lease is not renewed; cancellation relies on its expiry.
- Implement `KeywordStorage` for MongoDB/Redis/Pub/Sub operations. The library defines the protocol and local cache coordination; no Rust MongoDB/Redis live adapters are wired. Callers own the subscription and pass decoded events to `apply_keyword_change`.
- Implement Twitch `TokenSource` to provide app/bot/streamer credentials and enforce identity, permission, and expiry policy. No production token source or Mongo/Redis persistence adapter is included. A successful OAuth rotation must be persisted by the future adapter before the new credentials are used.
- Twitch and Polar clients perform real HTTP requests and support loopback-testable endpoints. Constructors do not connect. Polar exposes generic JSON request transport; callers retain billing/gift business rules and mutation reconciliation.
- EventSub `Condition` models legal flat string-valued conditions. `canonical_condition_json` is not a general JSON canonicalizer. BSON domain-event projection is available only with `mongo`; it retains native BSON values. JSON envelope projection preserves selected fields and drops unknown fields.
- These are source-referenced helper consolidations, not complete migrations of the named TypeScript modules or their consuming features. APIs, workers, adapters, and live integrations remain in TypeScript.

Example public API use:

```rust
use dima_rust::utils::{ai_usage, eventsub, keywords};

let entries = [keywords::KeywordEntry {
    id: "greeting".into(), text: "hello".into(),
    match_mode: keywords::KeywordMatchMode::Anywhere,
}];
let index = keywords::compile_keyword_index(entries);
let matches = keywords::match_keywords(&index, "hello world");
let input = ai_usage::AiUsageContextInput { channel_id: Some("123".into()), ..Default::default() };
let usage = ai_usage::create_ai_usage_context("messages", input);
let condition = eventsub::Condition::from([("broadcaster_user_id", "123")]);
let stable_key = eventsub::subscription_key("channel.follow", "2", &condition);
```

### Verification status (2026-10-22)

The source-backed parity fixture was regenerated with the Node helper from 13 TypeScript files and matched all 130 cases. All eight independently enabled feature test runs passed, including public consumer API checks. The no-default-features run and public utility API doctest passed. After review fixes, all 11 keyword tests passed, including shared failures after invalidation and shared successor results with zero cache capacity/TTL. The Mongo-enabled domain-event suite passed all 13 tests.

Review found and corrected two behavioral gaps, each reproduced before its fix: a failed in-flight keyword load could return its error only to the leader while coalesced callers retried; invalidation now relays the shared error or successor result to all waiters. Domain-event completeness omitted channel identity for channel-topic events; the presence check now accounts for it. An initial round-trip test expectation was corrected because the existing projection behavior was already right. A source-backed fixture caught and corrected Rust's error-message capitalization. A later parallel test run exposed a refused-port fixture race: connection-error fixtures now keep a non-listening socket bound so another loopback recorder cannot reuse that port.

Formatting and all-features Clippy passed with warnings denied. The complete all-features suite passed 229 tests with four external-service fixture tests ignored. After the final Twitch fixture hardening, the all-features library suite passed again (168 tests, one ignored), the seven parallel Polar tests passed again, and the independent Twitch feature suite passed. Ignored service-backed tests were not run against production; live storage/token adapters remain outside this scope. Three existing worker dependency graphs (`mongo`, `mongo,redis`, and `mongo,redis,http-client,unicode-collation`) match the pre-change baseline; Cargo.lock retains all 534 existing package versions, with only `unicode-normalization` and `uuid` added as root dependencies that were already locked.

These results came from the capped, task-owned Rust environment described in [`dimabot/RUST_AGENTS.md`](../dimabot/RUST_AGENTS.md). Optional features remain library-only and have no production consumer; no runtime deployment was performed. The results do not establish performance characteristics or a complete TypeScript feature migration.

Cleanup auditing found that the first auxiliary monitor had exited on a disappearing temporary Cargo file; Docker's hard limits remained enforced. The final affected-feature run repeated formatting, Clippy, all 66 combined utility checks, all eight isolated feature suites, and the no-feature suite with a corrected continuous monitor. All passed. Its 132 monitoring samples recorded at least 12.7 GiB host memory available and less than 2.8 GiB task cache usage. Temporary compiler containers, source copies, and caches were removed; all 18 production container identities and images remained unchanged.

Regenerate the pure source fixture from the repository root:

```sh
node --import ./dimabot/node_modules/tsx/dist/loader.mjs dimabot/tests/fixtures/bot_utils_parity.mjs
```

Run Rust checks from the isolated crate copy inside the capped compiler, never directly on this production host:

```sh
cargo fmt --all -- --check
cargo clippy --locked --all-features --all-targets -- -D warnings
cargo test --locked --all-features
cargo test --locked --no-default-features
# Repeat for each independently selectable feature listed above:
cargo test --locked --no-default-features --features keywords
```

## Behavior and known differences

- **Qdrant:** TypeScript uses REST on `QDRANT_PORT` (6333). The Rust client is gRPC-only, so it reads `QDRANT_GRPC_PORT`, which defaults to 6334, the production server's gRPC port. The crate is pinned to the server's 1.17 minor version.
- **JWT:** Tokens are byte-identical to Node `jsonwebtoken` for the same `iat`, and Node-signed HS384 tokens verify. Expiry, `nbf`, and audience handling match Node's `jwt.verify` defaults. A missing `exp` is rejected. There is no fallback secret.
- **RE2:** `translate` rewrites `\d \w \s \b` to ASCII forms and handles several class and escape differences. It also rejects stacked quantifiers (`a**`). All 109 cases in `dimabot/tests/fixtures/re2_parity_cases.rs`, generated from node `re2`, match. Offsets convert to UTF-16 with `utf16_offset`.
- **MP3 duration:** On npm's own sample files, symphonia is 26–53 ms shorter because it skips the encoder's header frame. The playback timeout is at least 60 s, so this does not matter. WAV durations keep the exact TypeScript 44-byte header rule.
- **CORS:** Preflight responses return `200` instead of npm's `204`.
- **socket.io:** socket.io's defaults are set explicitly, including the 1 MB message limit. socketioxide has no `connectionStateRecovery`.
- **PostHog:** posthog-rs has no `identify`, so the module sends the same `$identify` event posthog-node builds. `$is_server` is disabled to keep the same event shape.
- **OpenTelemetry:** The Rust OTLP log exporter is still marked release-candidate upstream.
- **TLS providers:** `email`, `posthog`, `s3`, and `otel` compile rustls with both `ring` and `aws-lc-rs`, so rustls can't choose a process default. Their clients and the MongoDB driver select a provider explicitly. Binaries that enable these features should call `utils::install_default_tls_provider()` (`ring`) at startup. `get_redis_client` calls it when they are enabled, and that call is compiled out of the worker profiles.

## Existing service-foundation validation (2026-10-22)

All Cargo work ran in a task-owned container from the pinned `saas-ops` Rust image (6 CPUs, 4 GiB with no swap, 256 PIDs, two jobs), with no `.env` files and no production data.

- `Cargo.lock` gained only new packages. Every existing package kept its version, and the `cargo tree` outputs for the `mongo`, `mongo,redis`, and dashboard profiles are identical to `HEAD`.
- rustfmt passed. Clippy (`-D warnings`) passed for default features, each new feature alone, and all features. Tests passed for all features and for all three worker profiles.
- Network clients were checked against a loopback HTTP recorder: Resend (body, auth, idempotency key, errors), PostHog (`/batch/` shape), S3 (SigV4, ACL, cache header, path), OTLP (protobuf, bearer token, service name), CORS, and the socket.io handshake plus a dynamic `/clip/{id}` namespace.
- `tests/qdrant_connection.rs` passed against a disposable `qdrant/qdrant:v1.17.0` on an internal Docker network: cache, create, upsert, search, delete, and a wrong-key failure. The fixture was removed afterwards.
