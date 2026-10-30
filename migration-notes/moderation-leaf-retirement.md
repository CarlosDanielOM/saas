# Moderation leaf retirement

This batch moves three unchanged moderation leaf sources into the existing TypeScript archive and updates source-bound parity readers to resolve them from the archive. It does not introduce new Rust functionality: all three typed mappings were already counted as locally complete before retirement.

## Scope and mapping

| Archived source | Existing Rust mapping | Original source SHA-256 |
|---|---|---|
| `src/utils/moderation/normalize.ts` | `normalize.rs`, `JsString`, Unicode 17 normalization and compatibility helpers | `07822ff6efe5d707173b6b9e9415b16edfb0eb055c3a03416bf4b4c0c11740ab` |
| `src/utils/moderation/rules/links.rule.ts` | `links_rule.rs`, `LinksRule`, `evaluate_links_rule` | `802150266d30c163a4069dd434b723e0320aed50ed34bc2f5674ac267aa41ad0` |
| `src/utils/moderation/spam_categories.ts` | Native category/tag enums, settings, policy catalog and ordered wire compatibility | `29dd0951ea0b89567c55b5dce4d2795a74c78e6064b32cbd26a3ecafaa435088` |

The archive resolver accepts only these source IDs and requires one matching manifest entry with the expected source hash. Missing or duplicate entries, live/archive ambiguity and tampering fail closed. Logical source IDs remain stable while physical provenance points into the archive. The Rust test support composes this resolver with existing test resolvers, including seed-plan coverage. The parent owns the archive manifest and README integration; all original archive entries must remain byte-for-byte unchanged.

## Coverage and adoption

Local feature coverage remains **18 complete and 23 partial**; these three mappings were already included. Global migration percentage remains **not calculated**. The archive moves from 28 to 31 source entries. The post-batch baseline is 775 live TypeScript files and 806 total files, including six React Email templates.

Application callers remain on the TypeScript path: registries, schemas, handlers and classifiers have not adopted the native mappings. Deployment and caller adoption remain separate from this local typed-leaf accounting. No deployment or push is authorized by this migration note.

## Evidence and validation status

Final exact-candidate verification passed for commit `2280c62d` (51 changed Git paths, including three source moves), source-tree hash `3b74658dcbacf895501e4476cfc67e14ce73fcf8d7f43a602a93e9f1ea8d09ee`, and 1,470 frozen inputs. The source manifest is bound in [`source-final.json`](evidence/2026-10-30-moderation-leaf-retirement/artifacts/source-final.json); it includes the ten previously tracked PostHog SDK capture files, with no duplicate SDK tree. The archive move changes provenance across a transitive loader chain: advanced tests read normalize/category sources; variations and spam readers consume those loaders; decisions, semantic and semantic-worker readers consume the resulting sources. Final reader and loader hashes were captured from the integrated candidate.

The final comparison passed 11 principal and transitive corpus/workload checks: normalize cases (228 ordinary, 2 nullish), links (45,057), ordered category wires (752), and downstream source/workload corpora. The blacklist fixture was regenerated in attempt 6 and dispatcher in attempt 5; other principal inputs came from attempt 4. The generated Unicode Rust body was unchanged. Prepared benchmark inputs are preserved, but no new benchmark timings are claimed. Concrete variation adapter checks remain bounded to their recorded source cases and do not establish every application-specific fault path.

Node run `1793359025969874012` passed all final isolated source/fixture checks (41.015 seconds for its main phase; 42.277 seconds total). Capped native run `1793359068803754251` passed in 129.207 seconds total, with a minimum available memory of 8,753,049,600 bytes and cache peak 8,049,299,456 bytes. It recorded 69 passing test executions across 39 test commands, including 18 explicit source-parity replays, plus formatting, scoped Clippy, minimal profile checks, all-target/all-feature checks and strict Clippy. The earlier native run `1793358939977688040` passed ordinary checks and 18 exact replays, then failed formatting on one unsorted import; the import was corrected and all final phases rerun. Production readback confirms unchanged service records and zero task-owned containers, networks or volumes remain.

The private cache-maintenance receipt records that an inherited assertion expecting at least 700 MiB freed did not pass after eligible private debug binaries had already been removed. The exact per-file removal list was unavailable. The recorded maintenance was limited to private task-owned cache content, with no source, shared, release or production mutation. This shortfall is not a source verification failure, but it remains part of the evidence record.

The complete 1,470-input binding, final receipts, production readback and prepared corpora are in [`evidence/2026-10-30-moderation-leaf-retirement/`](evidence/2026-10-30-moderation-leaf-retirement/README.md). The source binding records commit `2280c62d`; the parent owns shared migration-matrix and archive metadata updates.
