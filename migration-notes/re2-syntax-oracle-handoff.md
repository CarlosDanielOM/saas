# Native RE2 syntax oracle handoff

The direct Node SDK generated all compilation and execution observations in
the 4,364-case syntax corpus; the cases do not prescribe expected results. Ten
categories cover literals/escapes, case folds, classes, properties, inline
flags, anchors/boundaries, groups/alternation, quantifiers, malformed
patterns, and surrogate patterns/ranges. Both `u` and `iu` paths use `d` to
observe UTF-16 indices. Raw cases contain UTF-16 units, flags, category, and
SDK outcome. Compile error text is intentionally excluded.

The corrected parser passed all 4,364 syntax cases, plus the original
740-case corpus (91 direct RE2, 604 regex behavior, and 45 wrapper cases).
The earlier parser scored 3,959/4,364 with 405 mismatches; those failures are
preserved as evidence and were not excluded from the corrected replay. These
finite corpora support bounded behavior claims; they do not prove all RE2
syntax, limits, or public SDK compatibility.

The syntax oracle artifact SHA-256 is
`d9df8e317cb0f16e304a14fd1bdd454bba30f4a6d5a04159a785da42cacbcfb3`, at
`/root/.local/state/rust-full-migration-20261028-lu443ytp/artifacts/moderation-advanced/syntax-attempt1/re2-native-syntax.json`.
Its initial replay and mismatch summary remain in that external evidence
directory. The original SDK corpus is at
`/root/.local/state/rust-full-migration-20261028-lu443ytp/artifacts/moderation-advanced/attempt1/reference/moderation-advanced-reference.json`,
SHA-256
`dbdc74c2127fdbe434de83bb4153521d4cc22b639bb7c08c10db375da2e0c78a`. It uses
Node 24.22.1 and node-re2 1.27.0; loaded fixture binary SHA-256 is
`94064b17d6110cd5e36fb0bee49fa267144155300e03160758478b3917e5ffbb`.

The oracle loader pins all 1,762 SDK source files, Node 24.22.1 ABI 137,
binary, manifest, and build provenance through five `DIMA_ADVANCED_*`
environment variables. The replay uses the separately built Node fixture,
source/build hashes, and independently supplied artifact digest. The Rust
syntax test reports mismatches and per-category totals. The 464 advanced
application cases need the separate application adapter and are not covered
by this utility oracle. See the [native RE2 handoff](re2-native-handoff.md)
and [integrated moderation evidence note](moderation-advanced.md) for
verification boundaries and remaining compatibility limits.
