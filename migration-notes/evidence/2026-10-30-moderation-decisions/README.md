# Moderation decision store evidence

This package records the bounded decision store and shared compiler at code commit `1575f7edc76b5e51639bc76c16d473ddb459aa3f` and frozen source tree SHA-256 `631224c9ae10bd9e8df7bbf5f7446dfc6b4c229a1990b4fd7d2d83c066c6bd8d`.

The accepted source replay matched 41 records (6 hash, 19 create, 16 await) and included the actual Mongoose query / Node BSON wire probe. Two normal Rust tests and eight ignored isolated tests passed. The regression run passed six variation-compiler checks, three provider checks, the 175-case compiler source replay, 38 variation-job source cases, four native job checks, and bootstrap coverage. Scoped, minimal, Mongo/Redis, and all-feature strict checks passed. Final production readback reports 18 records unchanged and zero task-owned resources remaining. No benchmark or performance claim was made.

## Package contents

- [Verification summary](verification-summary.json) records the two accepted runs, their limits and source tree, all 11 retained run outcomes, exact case counts, validation scope, cleanup/readback facts, and open boundaries.
- [Source bindings](source-bindings.json) binds all 1,432 Git inputs to the code commit and lists the ten reused SDK inputs from the prior verified `cache-and-types` binding. The packager checked every Git object with `git show <commit>:<path>` before writing the record.
- [Artifact hash index](artifact-sha256.json) gives the SHA-256 and byte count of every retained payload in both its uncompressed form and stored form. Large payloads and all run logs are gzip-compressed deterministically; compare the stored hash before decompressing and the raw hash after decompression.
- `runs/` retains every receipt and log in interval `1793344777438566339`–`1793346251694408763`, including failures and superseded successful attempts.
- `artifacts/moderation-decisions/attempt1/` and `attempt2/` retain both reference outputs, the 42-entry actual source/SDK provenance set and its manifest, plus the comparison showing the reader hash was the only changed part of the replay fixture.
- `artifacts/parent-final-facts.json` and `artifacts/final-production-readback.json` retain the accepted run facts and final readback.
- `reproduction-tools/` retains the source replay, fixture drivers, environment files, quality and wait scripts, shared regression/runtime helpers, and this static packager. The packager reads Git objects and immutable artifacts only; it does not run Node, Cargo, Docker, tests, services, or network operations.

The run history includes the initial compiler/Clippy failure, SDK read-not-found, the first BSON wire mismatch, and the earlier successful wait phase. The final accepted source replay and compiler-fixtures phase passed after the wire handling and reader binding were corrected. Parent facts record the final source hashes and count all prior 41 cases and the query probe unchanged.

## Reproduction artifact integrity

Check each retained payload against [the artifact hash index](artifact-sha256.json). To regenerate the evidence package from the local immutable task state, the static driver accepts the exact commit, readback, and state directory:

```sh
python3 reproduction-tools/package_moderation_decisions_evidence.py \
  --code-commit 1575f7edc76b5e51639bc76c16d473ddb459aa3f \
  --readback /root/.local/state/rust-full-migration-20261028-lu443ytp/artifacts/moderation-decisions/final/production-readback.json
```

The script refuses to overwrite a nonempty evidence package and verifies all Git and SDK bindings before writing. The shell scripts are preserved historical invocations, not commands run by this documentation/evidence packaging task.

## Boundaries

This is partial local coverage for the ID, atomic creation, and durable semantic-decision wait paths. The typed JSON/BSON boundary does not claim unrestricted JavaScript prototypes, getters, sparse arrays, proxies, arbitrary hooks, or exact engine/driver error wording. General Mongoose behavior, semantic-worker success orchestration, billing, moderation consequences, and caller adoption remain open. No deployment, TypeScript retirement, push, or total migration completion is claimed.
