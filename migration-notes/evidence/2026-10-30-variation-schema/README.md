# Moderation variation schema evidence

This bundle records the final source-bound validation for moderation variation cache/job schemas. The code was frozen at Git commit `3b5b92b6040e622f47467299db6eed76242951f8`; the accepted compiler-fixture run consumed the 1,406-input tree `ecf01f50421602aec6dba6f7ccf9811e47691816a1817fbca8185b3f7756af83`. `source-bindings.json` hashes every input against Git at that commit (1,396 inputs) and links the ten unchanged `verification/posthog-rs/` SDK inputs to the earlier verified source binding.

The attempt 4 Mongoose oracle reference contains exactly 42 cases (21 inputs against each model). Its full BSON wire bytes match the Rust compatibility result. Reference SHA-256: `6afcb081ec891116bc63cc3d1f8ce2e9e00876fc082c9533df07fe3e05f1d870`. Attempts 1–3 and the final readback are retained alongside the accepted oracle. Each run receipt/log in the requested interval is preserved raw and as deterministic gzip; `index.json` records both hashes and byte counts.

## Accepted validation

`compiler-fixtures-1793337057616332027` passed the focused and regression validation recorded in its receipt/log: scoped and all-feature/all-target strict Clippy, minimal and Mongo/Redis checks, two ordinary variation schema tests, three application schema regressions, two additional schema regressions, three composite-default regressions, actual-Mongoose 42-case replay, and private Mongo CRUD/index verification. The compiler phase took 103.2 seconds; total capped run time was 114.658 seconds. Limits were 6 CPUs, 4 GiB memory with swap disabled, 256 PIDs, and two Cargo jobs. Minimum available memory was 9,462,595,584 bytes; peak private cache was 6,449,954,816 bytes. The configured startup threshold was 5 GiB.

Two earlier failures are intentionally retained: `compiler-1793336430628464119` exposed the shared truthy-string cast mismatch for an empty document `_id`; `compiler-1793336637743889453` exposed nested Mixed-array minimization on an empty object. The accepted implementation applies opt-in Mixed minimization and the shared truthy-string document `_id` behavior.

The production readback records 18 production containers unchanged and zero remaining task-owned containers, networks, or volumes. No deployment, push, TypeScript retirement, caller adoption, or performance benchmark was performed.

## Contract boundaries

Raw BSON repositories preserve missing/null/Mixed document shapes. Typed `VariationCache` and `VariationJob` DTOs are strict complete views and are not substitutes for raw storage when arbitrary Mixed values or incomplete documents matter. The oracle covers ordinary serialized inputs and BSON bytes; it does not establish parity for arbitrary JavaScript prototypes, hooks/getters, `undefined`, or sparse arrays. The schema feature is local Rust coverage; total migration remains incomplete because global dependencies and application callers are not fully migrated/adopted.

## Files

- `source-bindings.json` — commit/source-tree binding and verification for all 1,406 inputs.
- `runs/` — all receipts/logs in the requested interval, with raw and gzip hashes.
- `artifacts/moderation-variation-schema/` — all four oracle attempts and final production readback.
- `tools/` — snapshot validator, formatter/readback helpers, schema oracle command, and directly related source-freeze chain.
- `verification-summary.json` — machine-readable accepted result and scope limits.
- `index.json` and `artifact-sha256.json` — file inventory and checksums.
