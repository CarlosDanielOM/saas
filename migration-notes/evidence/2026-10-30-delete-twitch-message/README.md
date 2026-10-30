# Delete Twitch message adapter evidence

This package records the verified **partial** native implementation of
`deleteMessage`. The [artifact index](artifact-index.json) covers every
payload under `artifacts/`, `runs/`, and `reproduction-tools/`, with origin,
raw/stored SHA-256 and byte length. Large artifacts are gzip-compressed
losslessly. Run logs retain their original whitespace. Only the named
immutable `artifacts/delete-twitch-message/` wave and the exact run IDs listed
in the migration note were used; no mutable state snapshot was read.

## Frozen source artifacts

`artifacts/` preserves the wave's source bindings and input hash maps, tested
delta paths, three oracle fixtures, attempt history, semantic comparisons,
before-fix native/test snapshots, cache-maintenance audit, snapshot-isolation
record, and final production readback. The source binding is commit
`df3223f28769060202a216b1c8baf68a6cdadf31`, 1,486 inputs, tree SHA-256
`a6593f95a349e58ccc0c9e44915b3e77f46bf9bc6c2351b71b1c4e3c15f74390` (1,476
Git inputs plus ten reused SDK inputs). The oracle comparison distinguishes
110 matched records, two parser-depth probes and one source-only logger throw.

The cache audit records 11 completed task-owned debug executables removed and
288,460,800 allocated bytes freed, from 8,490,323,968 to 8,201,863,168 bytes.
No shared cache, source, release artifacts or production resources were
modified. The final readback records 18 production records unchanged and no
task-owned resources.

## Exact validation history

- `runs/attempt-1/` retains Node `1793363208494138234` and compiler
  `1793363247635540434`, including the initial native source snapshot. The
  functional tests/replay passed; strict Clippy found `collapsible_if` in the
  parser branch.
- `runs/attempt-2/` retains Node `1793363403386552448` and compiler
  `1793363432102471050`, including the test snapshot before the lock-scope
  correction. Functional tests/replay passed; strict Clippy found
  `await_holding_lock` in test code. The corrected test uses a lexical scope.
- `runs/final/` retains format `1793363155077388484`, final Node
  `1793363652526234079`, and final compiler `1793363673351846309` receipts and
  raw logs. The final Node fixture generated/check passed. The compiler passed
  seven deletion tests, two existing Twitch-function regressions, ignored
  source replay, format, strict scoped/minimal/Mongo+Redis/all-feature checks.
  It explicitly tests two known depth divergences and records one
  source-only logger throw; the 113 total records are not described as 113
  native parity matches.

The runtime uses isolated fixtures from the parent's source-only workflow. No
fresh MongoDB or Redis I/O was needed for this adapter. The separate general
deep parser work remains unverified and is not included in this feature.

## Reproduction tools

The exact three Node and three compiler scripts, cache-trim auditor, source
snapshot validator, and final readback helper are under
`reproduction-tools/`. They document the completed isolated checks. No runtime,
Node, Cargo, container, network, production or staging operation was run by
this documentation/evidence task.
