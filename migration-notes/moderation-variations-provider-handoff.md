# Moderation variations provider handoff

The two provider exports, `museVariationRequest` and `generateMuseVariations`, are implemented in `variations_provider.rs` behind `moderation-variations-provider`. The pure feature supplies shared logic; the provider uses `http-client` and the existing attribution path. No Cargo dependency or lockfile changes were added.

`MuseVariationsProvider` reuses a pooled HTTP client. `from_env()` refreshes `OPENROUTER_API_KEY` on each generation call while retaining that pool. It has no implicit deadline. A true watch signal cancels pending headers/body; dropping the request future cancels I/O, while dropping the watch sender alone does not. Explicit endpoint/key/client injection supports disposable loopback fixtures. The configured endpoint must be trusted because the bearer credential is sent to it.

Three ordinary loopback tests and the source replay of two request cases plus 15 mocked transport observations passed in final compiler phase `1793335018338289470`. Coverage includes request wire/body/headers, pool reuse, preconditions, response/spelling errors, connection failure, and cancellation. Fetch and JSON wording differences are checked by category/outcome where engine diagnostics differ. No live provider request was made. Exact evidence and phase records are in [the evidence index](evidence/2026-10-30-moderation-variations/index.json).
