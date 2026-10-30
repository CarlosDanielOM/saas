# API admin and workspace authorization — functional native slice (2026-10-30)

**Status:** native `api-admin` wiring and local feature behavior are verified. The mapped TypeScript source modules remain live. Route/bootstrap adoption, API cutover, deployment, and total migration completion remain open.

The opt-in feature provides native admin authentication/authorization, channel permission helpers, workspace-owner middleware, and typed request/response contracts. It composes with existing `api-auth` identity and existing admin schema, MongoDB, logger, and JavaScript-compatible trimming helpers. It does not duplicate the command/tag permission evaluator; channel grants retain their distinct flat-list wildcard and implication rules.

Verified local behavior includes active-admin lookup, creator/super role decisions, creator ownership access, ordered/deduplicated permission expansion, bounded permission-list parsing, channel-grant implications, and workspace-owner enforcement. The final integration exercised `AUTH → ADMIN → WORKSPACE` with private MongoDB/Redis and loopback Axum services. Normal typed inputs and outputs are covered; arbitrary Express request objects, JavaScript-only object prototypes/hooks, and platform-specific error-stack wording are not reproduced.

## Verification

The frozen admin source commit is `d4461f68b1c63ba7f5946a04b6a68eda9e960669`; the final combined state is `/root/.local/state/rust-full-migration-20261028-api-admin-p4i7peps`, tree SHA-256 `437744d66965468b8931c8cf308a3322e9e7a0d2988a40801591255d15ac5fc4`. Node receipt `1793396711073461854` and compiler-fixtures receipt `1793396775697900134` passed. The compiler-fixtures run passed 27 native tests (9 admin library, 6 grant library, 2 workspace, 10 integration), with no ignored tests. The source oracle covers 98 cases: 14 middleware, 31 helper, 28 pure, 21 grant and 4 workspace cases; fixture SHA-256 is `a2f3687851668b9697daacf85c48b44c0130a6235194b4b42ab3c46156a8893f`.

Formatting, scoped all-target Clippy with warnings denied, minimal all-target checks, and all-feature all-target Clippy with warnings denied passed. Production readback found 18 records unchanged and zero task-owned containers, networks, or volumes. No benchmark was run. Reviewer corrections to fixture ownership, JSON/Serialize support, a Clippy suggestion, and an expectation about existing wildcard grants were incorporated before the final run; earlier failures are not final-run failures.

The implementation is under [`middleware`](../dimabot/src/middleware/admin.middleware.rs) and gated by `api-admin`. Existing TypeScript admin/auth routes remain in place; `optional.middleware.ts` and `middleware/index.ts` were outside this batch. No TypeScript retirement, new dependency, deployment, or push occurred.
