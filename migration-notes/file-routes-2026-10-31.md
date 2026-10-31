# File routes local feature reconciliation — 2026-10-31

## Accepted source and verification

The file route feature is committed locally as `46d90b8c` across eight files,
including its tested Cargo feature and library wiring. The immutable source
snapshot contains 1,600 inputs and has tree SHA-256
`1073b81a0c98fb1fc928e7a20e1a458a0ecc129540ff629dedaed0516b588457`. The
actual-TypeScript oracle covered 20 exact ordered cases; its SHA-256 is
`dba13ece94f65768d064c6637c231a93cd635771dcb3df7423c6ccf3595aa840`.

Two unique tests passed in separate invocations. The controlled stream test
covered cancellation, a read error, truncated input, reader drop, and server
progress after cancellation/failure. The private HTTP test replayed all 20
source cases and verified protected 401/403 responses, two real Mongo activity
updates, and two Redis throttle readbacks. Formatting, scoped check and strict
Clippy, and all-feature/all-target strict Clippy passed. The immutable result,
phase receipts, logs, and independent parent proof are stored at:

- `/root/.local/state/dimabot-migration-teams-20261031/results/second-sol-file-routes-v3-verified.json`
- `/root/.local/state/rust-full-migration-20261028-integration-file-routes-v3/verification-result.json`
- `/root/.local/state/rust-full-migration-20261028-integration-file-routes-v3/artifacts/parent-verified.json`
- `/root/.local/state/rust-full-migration-20261028-integration-file-routes-v3/artifacts/`

The v1 CommonJS oracle collision (`exports is not defined in ES module scope`)
and v2 strict Clippy `cmp_owned` failure in the fixture remain recorded as
failed attempts. The v3 receipts record both separate test passes,
strict checks, all 18 production containers unchanged, and cleanup of
task-owned containers and networks. No benchmarks were run and no performance
claim is made.

## Feature and dependency boundary

The local feature closure covers `src/utils/fs.ts`,
`src/server/routes/file.route.ts`, and
`src/server/routes/admin-tools.route.ts`. The native filesystem adapter,
Tokio-backed route streaming, explicit module/public directory configuration,
concrete authentication service, workspace-owner protection, and private
MongoDB/Redis auth activity path were verified together. The existing
TypeScript sources remain live. Server composition, production caller
adoption, retirement, deployment, and total migration completion remain open.

Accepted differences are bounded and recorded in the handoff: the normalized
string-prefix allowlist keeps prefix siblings, traversal strings, and symlinks;
malformed and reversed ranges can receive native 400/416 responses where the
source can throw or hang; framework headers/error pages and uncommon I/O error
wording are not claimed identical. These do not block local feature completion.

The dependency matrix changes exactly these three source rows. Rollup moves
from 71 to **74 locally complete mappings**, with 24 partial rows, 60 archived
source snapshots, and 746 live baseline TypeScript files among the unchanged
806 rows. Total migration completion remains `null`.
