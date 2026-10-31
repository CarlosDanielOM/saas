# File routes handoff

## Original source contract and pre-run authoring notes

Source: `utils/fs.ts`, `server/routes/file.route.ts`, `server/routes/admin-tools.route.ts`. The server mounts these at `/video` and `/admin`; the only caller of `readFile` is the admin route. Native `api_auth::AuthService` and `workspace_owner::protect_workspace_owner` supply the existing concrete middleware. No existing native helper provided the source's stat/UTF-8 replacement contract or bounded route stream, so this scope adds a small shared filesystem adapter and Tokio stream.

Suggested wiring, owned by the integrator: enable a new opt-in feature `api-file-routes = ["api-admin", "dep:futures-util", "tokio/fs", "tokio/io-util"]`; in `src/utils/mod.rs` gate `pub mod fs` under it; in `src/lib.rs` add `#[cfg(feature = "api-file-routes")] #[path = "server/routes/file.route.rs"] pub mod file_route;` and corresponding `admin_tools_route` path for `admin-tools.route.rs`. Existing dependencies provide serde/JSON and Axum through api-admin. Do not change defaults or worker profiles. Explicitly configure `FileRoute::from_module_dir` with the deployed route module directory, or `FileRoute::new` with its public directory; mount `mounted_router()` and `AdminToolsRoute::default().mounted_router(&auth)` in the eventual server composition. Constructors do no I/O. This scope does not integrate a production server.

The admin allowlist is intentionally the source's normalized *string prefix*, not canonical path containment. It accepts prefix siblings, `..`, and symlinks. The original path (including backslashes) is passed unchanged to the OS read and returned in JSON. Injection of allowed roots is only for private fixtures. This is source compatibility, not a security boundary. Tests must never target the production default roots.

For valid bounded byte ranges the native handler streams fixed-size chunks with Content-Range, Accept-Ranges and Content-Length. Dropping the response drops the file. Malformed ranges receive a native 400; reversed or beyond-end ranges receive native 416; source `parseInt` and `createReadStream` can instead throw or hang, particularly after headers. Unexpected EOF or an asynchronous read error terminates the response body with an error rather than crashing or hanging the server. Empty files and normal full responses are supported. Framework-specific Express sendFile headers and error pages are not identical. Native I/O messages reproduce common Linux Node error codes; uncommon OS errors carry a meaningful native diagnostic instead of claiming exact Node formatting. Node's pre-read stat has the same potential concurrent file growth race.

The oracle executes transpiled actual TypeScript with Express, fs and Node, substituting only route directory, allowed roots and middleware boundaries; auth is covered separately by the native composition fixture. It pins source and tool versions and emits its own hash. The driver must supply a canonical empty task-owned marked directory and independently hash the emitted fixture. This authoring pass did not execute the oracle or any test. The integration test uses the existing guarded private Mongo/Dragonfly auth support and loopback server; it requires a separate marked private test root. Authoring follow-up: 20 named source records are replayed through HTTP, including normal byte ranges, empty/full/missing clips, auth-protected admin success and error paths, replacement UTF-8, exact size limit, oversize, Unicode, empty file, directory, prefix sibling, symlink and traversal. The test checks an exact ordered case ID set, independent fixture digest, script and source hashes, and pinned versions; both fixture and test roots are marked private directories under `/tmp`. The native stream adapter has a gated `AsyncRead` HTTP fixture for cancellation, read failure and unexpected EOF; it checks server progress and reader drop with bounded timeouts. Production continues to pass a Tokio file into that same bounded adapter. Authentication tests use the concrete service with disposable Mongo/Redis and check 401/403. The Axum dependency disables default features, so the admin handler uses `RawQuery` and the existing reqwest URL form decoder instead of the gated `Query` extractor; unusual duplicate/object query shapes are not asserted. The source's prefix behavior remains intentional.

The instructions and pending-validation statements above describe the pre-run authoring state. They are superseded by the accepted integration record below; source behavior boundaries remain in force.


## Candidate preparation history — 2026-10-31 (SECOND Sol)

The v1 immutable job passed capped formatting, then its Node oracle failed:
source-local `const __dirname` collided with the Node CommonJS wrapper and
Node retried it as ESM (`exports is not defined`). The v2 oracle scopes the
transpiled source in a lexical block inside the original CommonJS module.
The original 20 source cases remain. v1 and its failed receipt are preserved.

The native fixture now checks full/empty clip headers as well as partial
headers, exact protected 401/403 bodies, both path constructors and the
no-I/O default allowlist. Cold auth activity keys and private user documents
exercise the concrete Mongo update and Redis throttle, with readback and
exact-key cleanup. Client deadlines and 20 replay counters make hangs and
missing cases visible; three controlled stream outcomes record reader drop
and continued server progress. The candidate adds whole-crate formatting
and strict all-feature/all-target Clippy after the scoped behavior checks.

Only the explicitly leased isolated driver executed this scope. Each prepared
job and failed state remains immutable. The final source freeze and private
verification receipts below determine acceptance. Root owns ledger/archive/source
retirement and the final commit.

## Accepted integration — 2026-10-31

The accepted local source commit is `46d90b8c` (eight files, including the
tested Cargo feature and library wiring). The immutable final source snapshot
contains 1,600 inputs and has tree SHA-256
`1073b81a0c98fb1fc928e7a20e1a458a0ecc129540ff629dedaed0516b588457`.
Its actual-TypeScript oracle contains 20 ordered cases and has SHA-256
`dba13ece94f65768d064c6637c231a93cd635771dcb3df7423c6ccf3595aa840`.

Two unique tests passed in separate capped isolated invocations: the controlled
stream test covered cancellation, read error, truncated input, reader drop and
continued server progress; the private HTTP fixture replayed all 20 source
cases, verified exact protected 401/403 responses, observed two Mongo activity
updates, and read back two Redis throttle updates. Formatting, scoped checks
and strict Clippy, plus all-feature/all-target strict Clippy, passed. The exact
receipts and independent proof are retained outside the checkout at
`/root/.local/state/dimabot-migration-teams-20261031/results/second-sol-file-routes-v3-verified.json`,
`/root/.local/state/rust-full-migration-20261028-integration-file-routes-v3/verification-result.json`,
and `/root/.local/state/rust-full-migration-20261028-integration-file-routes-v3/artifacts/parent-verified.json`.

The v1 CommonJS oracle collision (`exports is not defined in ES module scope`)
and v2 strict Clippy `cmp_owned` failure in the fixture remain failed-attempt
history; neither is an accepted result. Parent proof confirms
the 18 production containers were unchanged and task-owned containers/networks
were cleaned. No performance result was measured. The normalized string-prefix
allowlist (including prefix siblings, `..`, and symlinks), native 400/416
responses for malformed/reversed ranges, Linux-oriented I/O diagnostics, and
framework header/error differences remain documented contract boundaries.
Concrete `AuthService`, workspace-owner middleware, and private MongoDB/Redis
integration cover the required route dependencies. The source remains live;
server mount/caller adoption, production deployment, and total migration
completion are not claimed.
