# Named schema types: verification and retirement handoff

The four native named-type implementations passed source-bound checks at
commit `425b662cec154d4337f2bcc591c76b8b0f2a7335` against a 1,482-input frozen
source tree (`3c2937e2042719071e2ba02033de15ea23003c279ae276c1e9e1a64d371743aa`).
Their subsequent four-file retirement passed final Node, compiler, format,
source binding, archive verification and production readback at commit
`dec14f0afd4176816ab347493b4a9c443ed2a8be`. The local-feature rows are now
reviewed; caller adoption and deployment remain open.

The detailed implementation contract, test results, source hashes and
retirement status are in
[`schema-named-types.md`](schema-named-types.md). The immutable evidence and
lossless artifact index are in
[`evidence/2026-10-30-schema-named-types/README.md`](evidence/2026-10-30-schema-named-types/README.md).
The evidence package distinguishes the initial Clippy failure and corrected
type attempt from final post-retirement validation. It does not imply
application-caller adoption, deployment or total migration completion.
