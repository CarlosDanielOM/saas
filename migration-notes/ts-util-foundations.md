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

Still to build, as small wrappers over `reqwest`: Polar (`customers.create`, `events.ingest`, and webhook checks with the `standardwebhooks` crate; Polar base64-encodes the secret first), OpenRouter, and Fish Audio. React Email templates have no Rust equivalent. `email` sends only HTML and text that were already rendered.

## Behavior and known differences

- **Qdrant:** TypeScript uses REST on `QDRANT_PORT` (6333). The Rust client is gRPC-only, so it reads `QDRANT_GRPC_PORT`, which defaults to 6334, the production server's gRPC port. The crate is pinned to the server's 1.17 minor version.
- **JWT:** Tokens are byte-identical to Node `jsonwebtoken` for the same `iat`, and Node-signed HS384 tokens verify. Expiry, `nbf`, and audience handling match Node's `jwt.verify` defaults. A missing `exp` is rejected. There is no fallback secret.
- **RE2:** `translate` rewrites `\d \w \s \b` to ASCII forms and handles several class and escape differences. It also rejects stacked quantifiers (`a**`). All 109 cases in `dima-rust/tests/fixtures/re2_parity_cases.rs`, generated from node `re2`, match. Offsets convert to UTF-16 with `utf16_offset`.
- **MP3 duration:** On npm's own sample files, symphonia is 26–53 ms shorter because it skips the encoder's header frame. The playback timeout is at least 60 s, so this does not matter. WAV durations keep the exact TypeScript 44-byte header rule.
- **CORS:** Preflight responses return `200` instead of npm's `204`.
- **socket.io:** socket.io's defaults are set explicitly, including the 1 MB message limit. socketioxide has no `connectionStateRecovery`.
- **PostHog:** posthog-rs has no `identify`, so the module sends the same `$identify` event posthog-node builds. `$is_server` is disabled to keep the same event shape.
- **OpenTelemetry:** The Rust OTLP log exporter is still marked release-candidate upstream.
- **TLS providers:** `email`, `posthog`, `s3`, and `otel` compile rustls with both `ring` and `aws-lc-rs`, so rustls can't choose a process default. Their clients and the MongoDB driver select a provider explicitly. Binaries that enable these features should call `utils::install_default_tls_provider()` (`ring`) at startup. `get_redis_client` calls it when they are enabled, and that call is compiled out of the worker profiles.

## Validation (2026-10-22)

All Cargo work ran in a task-owned container from the pinned `saas-ops` Rust image (6 CPUs, 4 GiB with no swap, 256 PIDs, two jobs), with no `.env` files and no production data.

- `Cargo.lock` gained only new packages. Every existing package kept its version, and the `cargo tree` outputs for the `mongo`, `mongo,redis`, and dashboard profiles are identical to `HEAD`.
- rustfmt passed. Clippy (`-D warnings`) passed for default features, each new feature alone, and all features. Tests passed for all features and for all three worker profiles.
- Network clients were checked against a loopback HTTP recorder: Resend (body, auth, idempotency key, errors), PostHog (`/batch/` shape), S3 (SigV4, ACL, cache header, path), OTLP (protobuf, bearer token, service name), CORS, and the socket.io handshake plus a dynamic `/clip/{id}` namespace.
- `tests/qdrant_connection.rs` passed against a disposable `qdrant/qdrant:v1.17.0` on an internal Docker network: cache, create, upsert, search, delete, and a wrong-key failure. The fixture was removed afterwards.
