# Validation route — verified native feature (2026-10-31)

**Status:** local handler, dependency, source-oracle, and composed integration coverage passed. Commit `60e8fd29bcc9928542412992e95e330ad1e23725` includes the route feature and library-module wiring; the TypeScript route remains live. Application server mounting/caller adoption, TypeScript retirement, deployment, and total migration completion remain open. No performance benchmark was run.

The native feature `api-validation-route` exposes `validation_route` and `ValidationRouteService` with `router`, `protected_router`, `mounted_router`, and an explicit runtime constructor. Its typed API also includes `ValidationBody`, `ROUTE_PATH`/`ROUTE_PARAM`, token/admin key helpers, raw authorization parsing, and ISO timestamps. It uses the existing native `AuthService`, Redis connection manager/helper, logger, Axum, and Twitch provider dependencies; no new crate or lockfile change was needed.

The route preserves `POST /:channelID`, raw `Authorization` lookup without stripping `Bearer `, two ordered token `HGET`s, then the source's owner/admin checks and response shapes. The source oracle covers 19 cases. A separate raw-socket probe confirmed Node's singleton-header behavior: for duplicate `Authorization` lines the first value wins, while ordinary duplicate headers join. The oracle sends one combined header line, which the native replay preserves; a separate native test covers two actual header lines. In the composed authenticated stack, auth middleware answers `401` before the handler's own `400 Missing token` branch.

## Verification

The parent-verified frozen snapshot contains 1,594 inputs, tree SHA-256 `4c4aa7e90b113e97d42ff6803ae0b0409ad66e3b191a436d621c9e90ccb81e40`, and 5 owned workspace files byte-equal to the tested snapshot. Route oracle SHA-256 is `45aa768d465db8e27f1c61a72c2b3bad5b652b25d7eeb027b5b26116f5b04fd7`. Final receipts: compiler `1793408406515048528`, fixtures `1793408583747869016`, and Node duplicate-header probe `1793408346782800362`. The compiler phase passed formatting, feature-gated all-target check/strict Clippy, four library tests, and all-feature/all-target strict Clippy. The fixture phase passed 20/20 integration tests, including the 19-case source mapping (18 HTTP replay comparisons plus the explicit acquisition boundary) and composed real-auth/Redis/Mongo/Twitch-provider fixtures. Existing API-auth regression tests were not rerun because that source was unchanged. Parent verification confirms 18 production containers unchanged, no task-owned resources remaining, and `Cargo.lock` unchanged.

## Boundaries

Express 4 leaves rejected async-handler Redis failures without a completed response; the native handler returns a completed `500` with a diagnostic log. The source also acquires Redis per request, while the native service owns a concrete manager. Express framework headers and malformed-path error wording are not reproduced. `server.ts` does not mount the route today; the native router's mount path is supplied by a future composition root.

See the [Rust route](../dimabot/src/server/routes/validation.route.rs), [native integration tests](../dimabot/tests/validation_route.rs), and the source-bound [oracle fixture](../dimabot/tests/fixtures/validation_route_reference.cjs).
