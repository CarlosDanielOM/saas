# Moderation leaf retirement evidence

This directory preserves review material for moving three existing moderation leaf sources into the TypeScript archive and routing parity readers through the archive resolver. Final isolated verification passed for commit `2280c62d` and source tree `3b74658dcbacf895501e4476cfc67e14ce73fcf8d7f43a602a93e9f1ea8d09ee`.

## Contents

- `artifacts/frozen-snapshot.json` is the initial full state snapshot captured before later refreshes. `artifacts/pre-final-snapshot-after-import-sort.json` is the 1,470-input manifest after sorting the `moderation_blacklist.rs` test imports; its source tree hash is `3b74658dcbacf895501e4476cfc67e14ce73fcf8d7f43a602a93e9f1ea8d09ee`, which matches the committed candidate.
- `artifacts/moderation-leaf-retirement/` contains prepared reference outputs and benchmark inputs/source reports from attempts 1–6. JSON payloads above 1 MiB are deterministic gzip files; restore with `gzip -dc`. The final blacklist reference is attempt 6, dispatcher is attempt 5, and other principal inputs are attempt 4. These are oracle/input artifacts, not new benchmark timings.
- `artifacts/source-final.json` records the final 1,470-input source hash manifest; it binds commit `2280c62d` and includes ten previously tracked PostHog SDK capture files without duplicating the SDK tree. `artifacts/moderation-leaf-retirement/tested-delta-paths.json` records the candidate file list. `artifacts/final-semantic-comparison.json` records the final 11 input/workload comparisons.
- `artifacts/runs/` contains the final Node receipt/log for `1793359025969874012` and capped native receipt/log for `1793359068803754251`. The native run passed formatting, scoped Clippy, minimal profile checks, all-target/all-feature checks and strict Clippy, with 69 passing test executions across 39 commands (18 explicit replays). Earlier pre-final formatter failure `1793358939977688040` is also retained to make the correction trail reviewable.
- `artifacts/cache-maintenance.json` records the private debug-binary cache maintenance result and its unmet threshold; it explicitly does not claim cleanup success.
- `source-snapshot/` contains the frozen candidate files from the recorded delta list, including test readers, relevant archive sources, and changed fixtures.
- `reproduction-tools/` contains the exact Node, native and quality wrapper scripts plus the static evidence packager and cache helper available at packaging time. These are retained for reproducibility; this documentation task did not execute them.

## Recorded scope and caveats

The three moved TypeScript files retain source hashes `07822ff6efe5d707173b6b9e9415b16edfb0eb055c3a03416bf4b4c0c11740ab` (`normalize.ts`), `802150266d30c163a4069dd434b723e0320aed50ed34bc2f5674ac267aa41ad0` (`links.rule.ts`), and `29dd0951ea0b89567c55b5dce4d2795a74c78e6064b32cbd26a3ecafaa435088` (`spam_categories.ts`). Final comparison preserved 228 normal plus 2 nullish normalize cases, 45,057 links cases and 752 ordered category wire cases, along with eight downstream corpus/workload comparisons. Caller adoption remains uncompleted and production remains undeployed.

The frozen inventory reported 1,470 input paths. Archive count changes from 28 to 31 with all original entries preserved; after this batch the baseline is 775 live TypeScript files and 806 total files (including six React Email templates). These three mappings were already counted in local coverage, so the reported coverage remains 18 complete and 23 partial; global percentage is not calculated. Application callers remain unadopted and production remains undeployed.

No benchmark timing claim is made. Production before/after readback found no service changes and no remaining task-owned containers, networks or volumes. The private-cache cleanup assertion did not meet its expected 700 MiB freeing threshold, and the exact removed-file list is unavailable. This cache-maintenance shortfall is documented separately from the passing feature checks.

Two earlier logs with terminal whitespace are stored as deterministic `.log.gz` files to preserve their exact bytes. Their raw and stored hashes are indexed; decompress them into a disposable directory for inspection.
