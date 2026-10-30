# API auth middleware — functional native slice (2026-10-30)

**Status:** the opt-in `api-auth` feature is wired and locally verified. TypeScript middleware sources remain live; API route/bootstrap adoption, cutover, deployment, and total migration completion remain open.

The native module in [`auth.middleware.rs`](../dimabot/src/middleware/auth.middleware.rs) provides bearer-token extraction, an Axum middleware, and a concrete `AuthService` backed by the existing MongoDB, Redis, HTTP, logger and observability facilities. The native types in [`types.rs`](../dimabot/src/middleware/types.rs) cover the middleware request/response and Twitch token/user DTOs.

The local contract covers case-insensitive header-name lookup, exact `Bearer ` prefix handling, cache hit/miss and failure behavior, Twitch validate/user requests, first-user selection, token cache writes, activity throttling and Mongo touch, trace-channel binding, identity propagation and single handler invocation. The source and native oracle matched all 27 response cases. Documented boundaries include platform-specific error stack wording, rejection of malformed upstream DTOs, absent `CLIENT_ID` header behavior, and malformed cache hashes filling missing login/display-name fields with empty strings.

## Verification

The final combined snapshot is `/root/.local/state/rust-full-migration-20261028-api-services-0irfzvg9`, tree SHA-256 `ae5abb14ba18c0e5c4a53c2933c2c5de3defddd08f1dba5d4f2830a6fb0be4f2`. Node source-oracle receipt `1793394887011718516` and compiler-fixtures receipt `1793394908023978034` passed. The compiler-fixtures run passed 30 native tests (7 embedding, 5 retry, 14 auth integration, 4 auth library), with no ignored tests; private MongoDB/Dragonfly and loopback HTTP fixtures were used. Formatting, scoped all-target Clippy with warnings denied, minimal all-target checks, and all-feature all-target Clippy with warnings denied passed. Production readback remained unchanged.

The auth oracle SHA-256 is `e1599ac5baf29e551a5e6266dabb9722b50eae30f1130df1aee778c3773c9c99` (27 source cases); the API auth portion is summarized here as part of the combined verification epoch. Earlier standalone verification is superseded by that combined run. Earlier test-helper and fixture synchronization failures were corrected before the final run. No benchmark or performance claim was made.

The opt-in Cargo feature is `api-auth`; native wiring is in [`lib.rs`](../dimabot/src/lib.rs). Existing TypeScript routes, including admin routes, continue to own caller behavior until separately migrated. No new dependency, production mutation, deployment, or push occurred.
