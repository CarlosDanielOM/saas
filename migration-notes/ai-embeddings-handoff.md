# OpenRouter embeddings — functional native slice (2026-10-30)

**Status:** the opt-in `ai-embeddings` feature is wired and locally verified. TypeScript sources remain live; application caller adoption, API/bot integration and deployment remain open.

The native feature ports the OpenRouter embedding service, language detector, and fetch retry helper. It uses the existing reqwest/Tokio client, logger, AI constants/attribution, and JavaScript-compatible string helpers. The Cargo feature includes both `js-unicode17` and `js-strings`; the latter is required by the detector and source-compatible text handling.

The local behavior covers request attribution, channel validation, one-item and batch response order, optional usage and missing embedding values, retry count/backoff/status behavior, transport failures, cancellation, language detector state, and logging. The detector retains the source global regular-expression `lastIndex` behavior across words and calls. Bounded differences include typed retry options rather than pathological JavaScript numeric settings, platform-specific error/stack wording, and no arbitrary JavaScript prototypes or hooks.

## Verification

The final combined snapshot is `/root/.local/state/rust-full-migration-20261028-api-services-0irfzvg9`, tree SHA-256 `ae5abb14ba18c0e5c4a53c2933c2c5de3defddd08f1dba5d4f2830a6fb0be4f2`. Node source-oracle receipt `1793394887011718516` and compiler-fixtures receipt `1793394908023978034` passed. The compiler-fixtures run passed 30 native tests (7 embedding, 5 retry, 14 auth integration, 4 auth library), with no ignored tests; private MongoDB/Dragonfly and loopback HTTP fixtures were used. Formatting, scoped all-target Clippy with warnings denied, minimal all-target checks, and all-feature all-target Clippy with warnings denied passed. Production readback remained unchanged.

The embeddings source-oracle fixture SHA-256 is `bcaee2f03d1f2227b46ba5f5e0de00dbf879e311979d4ff28fd339ccaa40b238` (12 HTTP cases plus language checks). Its feature is `ai-embeddings`, wired through the crate’s utility modules and existing attribution selector. No new dependency, benchmark, or performance claim was added. Earlier retry/test-helper and HTTP fixture ordering failures were corrected before the combined run. No production mutation, deployment, or push occurred.
