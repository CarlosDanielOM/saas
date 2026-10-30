# Twitch diagnostics and flat deletion response evidence — 2026-10-30

This package records the verified follow-up to the earlier partial delete-message adapter evidence in [`../2026-10-30-delete-twitch-message/README.md`](../2026-10-30-delete-twitch-message/README.md). Every payload under `artifacts/`, `runs/`, and `reproduction-tools/` is listed in [`artifact-index.json`](artifact-index.json) with its original path, raw/stored SHA-256, and raw/stored byte size. Gzip files preserve exact raw bytes.

## Source binding and scope

`artifacts/source-bindings.json` binds commit `c49f654206aa5a68331d0e57fa77ab2b983acb58` to tree SHA-256 `5d9cdc6ab77860e1fc0be8fb094f184dc37db8bc854cff68ff8bd55771feee0b`, covering 1,493 inputs (1,483 Git plus ten reused SDK inputs); every input hash matches. `artifacts/source-final.json.gz` preserves the immutable final source map. The package does not copy mutable task state or duplicate Node/SDK binaries.

`artifacts/tested-delta-paths.json` lists the native delete adapter, module wiring, token adapter, deletion tests, diagnostics tests, and both fixture generators. `artifacts/snapshot-isolation.json` records excluded JSON benchmark drafts and confirms working drafts were preserved. `artifacts/production-after-final.json` records the final production identity readback: all 18 records unchanged and zero task-owned resources. `artifacts/cache-maintenance.json` records removal of seven completed task-owned private debug executables and 115,077,120 freed allocated bytes; shared caches, source, release output, and production resources were untouched.

## Fixtures and corrected attempt

`artifacts/attempt1/` preserves the first deletion/diagnostics fixtures, digest record, and source snapshot. Its fixture compiler attempt `1793367320762131497` failed because the expected URL value incorrectly treated `../secret-url` as invalid. With the loopback base `/`, URL resolution normalizes it to `/secret-url`. Only that test-input literal was corrected; application behavior did not change.

`artifacts/attempt2/` preserves the corrected final deletion and diagnostics fixtures and their digest record. The final deletion oracle has 126 records: 125 exact source/native response wire matches and one explicitly synthetic source logger-throw case. The header oracle has four cases, including a synthetic class-throw boundary. The application directory class catches lookup errors, while the configured logging SDK handles asynchronous sink failures; these injected throws are not reported as normal SDK behavior. Exact response wires at nesting depths 129 and 256 pass. A separate native depth-4,096 check establishes native capability without claiming V8 serialization parity at that depth.

## Final checks

`runs/final/` contains exact logs and receipts for formatting `1793367274471263742`, Node-before-expectation-fix `1793367306739481771`, corrected Node `1793367385515642920`, final fixture compiler `1793367404207072126`, and supplemental compiler `1793367558103768384`. `runs/failed-attempt/` preserves the failed fixture compiler log and receipt for `1793367320762131497`.

Formatting and corrected Node/source replay passed. The final fixture compiler passed in 142.552 seconds total / 131.109 seconds compiler-step time, with 12,742,328,320 bytes minimum available memory and 8,465,207,296 bytes private-cache peak. The supplemental compiler passed in 15.869 seconds total / 6.042 seconds compiler-step time, covering 26 token lifecycle and two parity cases.

The final checks passed seven ordinary deletion tests, one diagnostics test, two existing Twitch-function regressions, strict scoped/minimal/Mongo+Redis/all-feature checks, exact source replays, and private Mongo/Redis missing-account, successful single-mirror, WRONGTYPE-to-403, and no-HTTP cases. Safe diagnostic categories redact credentials, raw URLs, and response bodies. No new benchmark was run.

## Remaining boundaries

The feature remains partial because strict native URL/header and redirect policies can differ outside the tested Twitch request contract; native error and Rust backtrace wording differ from JavaScript; and the source-only synthetic thrown-logger case has no concrete native equivalent. No TypeScript source retirement, caller adoption, production deployment, or push occurred.

## Reproduction tools

`reproduction-tools/` preserves the two Node fixture scripts, two quality scripts, token regression wrapper, cache maintenance script, and validators/readback helper. They are indexed for provenance and were not rerun during this documentation task.
