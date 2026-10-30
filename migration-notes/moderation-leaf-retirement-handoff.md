# Moderation leaf retirement handoff

This scoped batch retires three unchanged TypeScript leaf sources by moving their byte-identical copies into the existing archive. The Rust migration for their typed behavior already existed and was already counted in local coverage. This batch changes source location and the test/reference path; it does not add a Rust feature or adopt the native implementation in live callers.

## Files and mapping

| Archived TypeScript source | Existing native mapping | Frozen source SHA-256 |
|---|---|---|
| `src/utils/moderation/normalize.ts` | `normalize.rs`, `JsString`, existing Unicode 17 normalization and compatibility helpers (`foldText`, `escapeRegExp`) | `07822ff6efe5d707173b6b9e9415b16edfb0eb055c3a03416bf4b4c0c11740ab` |
| `src/utils/moderation/rules/links.rule.ts` | `links_rule.rs`, `LinksRule`, `evaluate_links_rule` | `802150266d30c163a4069dd434b723e0320aed50ed34bc2f5674ac267aa41ad0` |
| `src/utils/moderation/spam_categories.ts` | existing spam category/tag enums, settings, policy catalog and ordered wire compatibility | `29dd0951ea0b89567c55b5dce4d2795a74c78e6064b32cbd26a3ecafaa435088` |

The SHA values above identify the original frozen TypeScript bytes; the archive copies must be byte-identical and the original 28 manifest entries must remain unchanged when the parent integrates the three-entry append. The parent owns the archive manifest/README, migration matrix, commit, and final integration verification.

## Coverage and caller status

All three mappings were already included in local migration coverage before this retirement batch. Local coverage therefore remains **18 complete and 23 partial**. A global migration percentage remains **not calculated**. With these additions the source archive contains 31 entries; the baseline has 775 live TypeScript files and 806 total files, including six React Email templates. No live TypeScript registry, schema, handler or classifier caller has adopted these native implementations. Caller adoption and production deployment remain separate and uncompleted.

## Reader and provenance changes

`moderation_leaf_source_resolver.cjs` and `tests/support/moderation_leaf_source.rs` resolve only the three allowlisted logical IDs. An archived source must have exactly one matching manifest entry and matching SHA-256; ambiguous live/archive paths, missing manifest entries and tampering fail closed. The source resolver keeps logical IDs stable and reports physical archive provenance. The Rust tests compose this check with the existing source resolver, including the seed-plan resolver.

The transitive readers consume these leaves through existing source paths: `moderation_advanced_source.cjs` reads normalize and category sources; variations and spam readers consume advanced/spam loaders; decisions, semantic and semantic-worker readers consume those sources in turn. Final loader and reader pins are bound to source commit `2280c62d` and the final 1,470-input source manifest, including the ten previously tracked PostHog SDK capture files. See `evidence/2026-10-30-moderation-leaf-retirement/artifacts/source-final.json`; the old pins in earlier pre-batch notes are not used. The standalone handoff and frozen snapshots are retained in the evidence directory for review.

## Verification status

Final verification passed for commit `2280c62d` and source tree `3b74658dcbacf895501e4476cfc67e14ce73fcf8d7f43a602a93e9f1ea8d09ee`. Node run `1793359025969874012` passed with 41.015 seconds for the main phase and 42.277 seconds total. Capped native run `1793359068803754251` passed in 129.207 seconds total, with 69 passing test executions across 39 test commands (including 18 explicit source-parity replays), formatting, scoped Clippy, minimal-profile checks, all-target/all-feature checks and strict Clippy. The pre-final native run `1793358939977688040` passed ordinary checks and 18 exact replays before finding one unsorted import; after correcting it, all final phases passed. Production before/after readback showed unchanged records and zero remaining task-owned containers, networks or volumes.

Eleven principal and transitive corpus comparisons passed against their recorded prior evidence, including 228 normal plus 2 nullish normalize cases, 45,057 links cases, 752 ordered category wires, and matching prepared workload pools. The generated Unicode Rust body remained unchanged. Final attempt 6 refreshed the blacklist corpus and attempt 5 refreshed the dispatcher corpus. No fresh benchmark timings were collected for this retirement. Existing benchmark inputs and generated source reports are evidence of prepared inputs only; they are not new measurements. Earlier semantic comparisons and concrete variation adapter checks remain scoped to their recorded sources and do not establish that every application-specific fault path was exercised.

The cache-maintenance receipt records a private-cache-only cleanup shortfall: an inherited assertion expected at least 700 MiB to be freed after eligible private debug binaries had already been removed. The exact per-file removal list was unavailable. No source, shared cache, release artifact or production resource was changed by that maintenance step; do not claim the expected cleanup threshold passed.

## Scope and release

Production before/after inspection confirms unchanged service records and zero remaining task-owned containers, networks or volumes. No deployment or push is authorized by migration completion. Caller adoption and deployment remain separate from local feature coverage.
