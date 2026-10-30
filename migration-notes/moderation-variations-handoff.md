# Moderation variations native handoff

The bounded helper is implemented and verified; see [the migration note](moderation-variations.md) and [indexed evidence](evidence/2026-10-30-moderation-variations/index.json). Its matrix status is partial because the JavaScript object/typed boundary and native regex/resource compatibility limits remain. Callers are unadopted.

The implementation covers 15 runtime exports and four type exports across `variations.rs` and `variations_provider.rs`, reuses shared moderation types and `js_unicode::normalize_nfc`, and adds no Cargo packages or lockfile changes. Typed and lossless JSON APIs, independent FIFO caches, provider pooling/cancellation, and all remaining compatibility limits are summarized in the main note.

Final scoped validation passed in compiler phase `1793335018338289470`, including pure/provider source replay and full NFC replay. The prior shared-types/cache phase `1793334353011847518` also passed its unchanged related suites; see evidence for exact phase scope. Earlier Clippy/style findings are retained and corrected. The three-round benchmark retains its regressions and overlapping ranges; no production throughput or statistical claim is made. No source retirement, deployment, or push occurred.
