# Permission error rate limiter — 2026-10-29

## Scope and result

The single TypeScript export `shouldLogPermissionError` from `dimabot/src/utils/permissions/error_rate_limit.ts` has a source-parity Rust implementation in `dimabot/src/utils/permissions/error_rate_limit.rs`. The verified source commit was `f3894821`; the frozen source snapshot was `5bbd8f709ca352d0621c69e3fa5a5613deda9622eb82a5dacd74535c2753b756`. The pinned actual-TypeScript oracle recorded source SHA-256 `4e840093ef500738588ea7990f4303ea18f9368abd4d9e898557af73e08e8d56` and binds 1,301 snapshot files. The artifact records 2,113 generated operations and a final 2,000-key state.

The 32-line source module exports one function, has no imports, and depends on its module-local 300,000 ms default interval, 2,000-key capacity, insertion-ordered `Map`, and `Date.now()`. The Rust port preserves that behavior with an expected-O(1) hash lookup and bounded linked arena, `Arc<JsString>` keys, a concrete process-wide `OnceLock<Mutex<_>>`, and `SystemTime` for the default clock. Calls denied by the interval do not refresh ordering; logged calls do. UTF-16 code-unit identity is retained, and numeric time/interval comparisons use `f64`, including exact boundary behavior and non-finite inputs. The public function uses `Option<f64>` for source defaults; callers that supply values are expected to honor the TypeScript declaration of string keys and numeric times/intervals. Runtime casts outside that declared contract are not covered.

## API and dependency closure

| Source contract | Rust counterpart | Coverage |
| --- | --- | --- |
| `shouldLogPermissionError(key, now = Date.now(), intervalMs = 300000)` | `should_log_permission_error(&JsString, Option<f64>, Option<f64>) -> bool` | Same omitted-argument defaults; singleton state is process-local. |
| Module-local JavaScript `Map<string, number>` | `PermissionErrorLimiter` with `HashMap<Arc<JsString>, usize>` and a linked `Vec<Entry>` arena | Retains at most 2,000 keys and preserves least-recently-logged eviction order. |
| Denied call returns `false` without changing insertion order | `should_log` returns before touching linked order | Parity validated. |
| Logged call stores current time and moves key to newest insertion position | `should_log` updates time, unlinks, and appends | Parity validated. |
| `Date.now()` | `SystemTime`/`UNIX_EPOCH` adapter | Concrete default clock; default-clock behavior was runtime-checked. |
| JavaScript string keys, including UTF-16 code units | Existing `JsString` compatibility type | Preserves exact key identity, including unpaired surrogates. |
| JavaScript numeric timing arithmetic | Rust `f64` arithmetic | Exact threshold comparison semantics retained. |

The function has no application-specific adapter, database, external cache, queue, network, or other external dependency. The limiter itself uses only the Rust standard library. Its key representation reuses the existing `JsString` compatibility utility and the permissions feature's already available compatibility serialization dependencies; there was no new Cargo crate, feature, or manifest/lockfile change. Integration exposes `error_rate_limit` from the existing permissions Rust module and enables `js_string` under the already-existing `permissions` feature as well as `tts-utilities`.

Coverage is 100% for this standalone exported function and its direct/transitive runtime dependencies. This does not mean the broader permissions module, handlers, or all TypeScript callers have migrated. Caller adoption remains outstanding: roles, moderation, and message paths plus the existing TypeScript barrel/caller routes remain on TypeScript. No TypeScript source retirement or production deployment occurred. The migration does not define any scheduler wait, polling, retry, or backoff; the interval is only the existing error-log suppression threshold.

## Verification evidence

Evidence is retained in the [indexed repository archive](evidence/2026-10-29-permission-error-rate-limit/README.md), including source/reference fixtures, independent provenance readback, source bindings, receipts/logs and final production/resource readback. All 30 indexed hashes and compressed raw payloads were independently checked. Oracle validation executes the entire actual TypeScript module and enforces the source AST/export shape, full typecheck, and pinned source, Node, TypeScript, package/lock, and Rust toolchain hashes. The independent provenance readback confirms all native and reader hashes; it records source SHA-256 `4e840093ef500738588ea7990f4303ea18f9368abd4d9e898557af73e08e8d56`, Node SHA-256 `569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108`, 2,113 operations, and 2,000 tracked keys. The oracle's external output validation requires an empty canonical external output directory, exclusive writes and exact subsequent checks.

- Node oracle run `1793301719976570795` passed write and check for 2,113 operations and the final ordered 2,000-key state.
- Compiler run `1793301719984530274` passed formatting, scoped Clippy, three new ordinary tests (global singleton concurrency with 32 threads and default-clock coverage included), and 19 existing permissions/`jsString` and related library tests.
- Compiler run `1793301823170643516` passed ignored 2,113-operation source replay and final-state comparison in 0.04 seconds, plus no-feature, Mongo/Redis worker-profile, and all-features/all-targets check and `Clippy -D warnings` coverage.
- All native verification used the same exact source snapshot, with 6 CPUs, 4 GiB memory and no swap, 256 PIDs, and two Cargo jobs. The recorded host minimum available memory was 8,840,032,256 bytes. The verification script took 105.856 seconds total; the full workflow took 112.335 seconds, with a 3,610,828,800-byte cache.
- Final readback recorded production state unchanged across 19 records and acknowledged API run `api-ee0635765a02`. Final cleanup readback showed zero remaining task-owned resources.

These are parity, compiler, and isolated-replay results. No limiter benchmark was run, so they do not support a CPU, RSS, throughput, or production-performance claim. Expected constant-time core operations and the 2,000-key bound describe the data structure, not measured gains. The count bound is not a hard total-memory bound for arbitrary-length keys.

## Adoption and release status

The native utility is not wired into TypeScript caller paths. Those paths and their consumers remain unadopted and may still use the TypeScript implementation. No TypeScript retirement, deployment, or push is recorded here. Any future caller migration or retirement is separate work and must be evaluated against the repository's full migration-completeness policy. See the concise [handoff](permission-error-rate-limit-handoff.md).
