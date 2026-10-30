# Observability ingress route — functional native slice (2026-10-30)

**Status:** the opt-in native route is implemented and source-verified. The TypeScript route remains live; native app-server mount/bootstrap adoption, caller cutover, deployment, and total migration completion remain open.

The route is a concrete pooled-HTTP Axum proxy with a fixed private upstream, a literal path/method allowlist, a 12-second whole-request deadline, and cancellation when its handler future is dropped. It forwards the permitted query and headers, handles JSON and ordinary URL-encoded form bodies, preserves upstream status/body behavior, and applies the source cache-control rules. No authentication middleware is added; the analytics service retains ownership of authentication.

The actual Express 4.22.2, body-parser 1.20.6, qs 6.15.3, and Node fetch source oracle covered 24 cases. Across source replay and native tests, coverage includes indexed and repeated form fields, sparse-array compaction, redirects with or without `Location`, 204/304 responses, header/body deadlines, cancellation, and post-header body failure. Redirect statuses 301/302/303/307/308 fail even when `Location` is absent. A 304 passes with an empty body and no content type. A post-header body failure/deadline returns 503 while retaining `no-store`; pre-header and redirect failures return 503 without it.

Boundaries: ambiguous object/array collisions and prototype form keys return 400; malformed body errors use JSON rather than Express HTML; Express ETag/`req.fresh` behavior is not emulated. These are documented framework boundaries; normal typed ingress protocol behavior is verified, not universal npm-engine parity.

## Verification

Source commit `e48e5b830259f4c32229d223e91df71ac2aba230`, tree SHA-256 `a87bac408a3e90b762675b7998aa305fe6164eb8350d6306b1b65bbc6df81146` (1,561 inputs). Node receipt `1793399046894367840` and compiler receipt `1793398758977962286` passed. The compiler run passed 13 native tests (3 library, 10 integration), including the explicitly included actual-source replay. The fixture SHA-256 is `8cd8e28fa28920b44d8c2c03fa9736defb8d3d66fdecbe59de988270ce47dd77`.

Formatting, scoped all-target Clippy with warnings denied, minimal all-target checks, and all-feature all-target Clippy with warnings denied passed. Task-scoped production readback found 18 records unchanged; this task recorded zero owned resources. No benchmark, TypeScript retirement, deployment, or push occurred. See [`observability.route.rs`](../dimabot/src/server/routes/observability.route.rs) and [`observability_route` tests](../dimabot/tests/observability_route.rs).
