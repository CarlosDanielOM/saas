# Unicode 17 core evidence

The shared lossless string core passed ordinary checks and exhaustive lowercase and actual-TypeScript fold comparisons over all 1,114,112 code-point values, including 2,048 lone surrogate values, plus 6,432 contextual goldens and 20 mixed/long UTF-16 cases. The pinned Node generator produced complete Unicode 17 mappings/properties and sparse NFD reference facts; independent Python readback checked all native table values, counts and hashes. The existing Unicode 18 normalization dependency is guarded by Unicode 17 assignment boundaries, then Unicode 17 marks are removed and UTF-16 re-decoded before lowering. No crate or lockfile change was added.

The exact 1,318-input source binding and successful capped fmt, scoped/strict Clippy, no-feature, Mongo/Redis and all-features/all-target checks are retained. Initial source guards and a missing output-directory preparation failed; raw failures and corrected source variants are retained, and no generated facts were silently overwritten. No performance benchmark or speed claim is made.

This is a reusable string core. The complete normalize.ts adapter, regexp escaping, AST adoption, wider application dependencies and caller adoption are separate work. No TypeScript retirement, deployment or push occurred. All 19 production records remained unchanged, and no owned resources remained after verification.
