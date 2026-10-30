# Named application schema types evidence

This package holds the source-bound evidence for four named application
schema types and their subsequent TypeScript source retirement. Its
[artifact index](artifact-index.json) records each payload's origin, raw and
stored SHA-256 values, byte lengths, and compression method. Large artifacts
are gzip-compressed losslessly; raw test logs are copied without line-ending
or whitespace normalization. All payloads under `artifacts/`, `runs/`, and
`reproduction-tools/` must appear in the index.

## Immutable source epochs

- `artifacts/schema-named-types/` contains only the immutable accepted type
  wave: source bindings and complete input hash map for commit
  `425b662cec154d4337f2bcc591c76b8b0f2a7335`, the two named-type attempt
  fixtures, application fixture output, source semantic comparisons and
  attempt history. Its source tree hash is
  `3c2937e2042719071e2ba02033de15ea23003c279ae276c1e9e1a64d371743aa`.
- `artifacts/schema-named-retirement/` contains only the separate retirement
  wave's archive/hash verification, final-retirement source outputs, five
  timezone Mongoose date fixtures and repeat outputs, snapshot isolation and
  semantic comparisons. It confirms 40 archive entries, unchanged prior 36
  entries and top-level metadata, and four new files equal to their Git source
  bytes. Its final binding is commit
  `dec14f0afd4176816ab347493b4a9c443ed2a8be`, 1,482 inputs and source-tree
  SHA-256 `71ca4cf0d80a38f86f19ebe7291d52af4f852b09bdd93c4bde9abf03a3394997`.
  Do not replace these files with a later task snapshot.
- `artifacts/accepted-archive-manifest.json` is read from that immutable Git
  commit, not from the mutable checkout.
  `artifacts/schema-named-retirement/production-after-final.json` is the final
  readback: 18 production records unchanged and no owned resources.
- `artifacts/archive-git-proof.json` binds the 40-entry manifest to commit
  `dec14f0a` and independently checks the four newly archived blobs against
  their manifest hashes using immutable `git show` reads.
- Neither wave reads or packages mutable `STATE/snapshot.json`.

## Run history

`runs/type-attempt-1/` retains Node receipt `1793362449019157447` and compiler
receipt `1793362463134937029`. The source oracle passed. The ordinary named
tests, application-schema checks and exact source replay passed; the compiler
phase ended on a strict Clippy `type_complexity` finding in the test interface
table. The corrected attempt added only two aliases.

`runs/type-attempt-2/` retains Node receipt `1793362526601171654` and compiler
receipt `1793362541503862592`. Both passed. The native validation included
the named schema types, existing Mongoose application-schema comparisons,
source replay, formatting, scoped strict Clippy, minimal profile, Mongo+Redis
profile and all-feature checks.

`runs/type-implementation/` retains formatting receipt
`1793362424162883540`.

`runs/final-retirement/` retains formatting receipt `1793362849611128786` and
Node receipt `1793362880829965805`. The Node run passed after replaying five
Mongoose date zones twice: 80 cases per zone, with case and missing-value
outputs matching the prior fixtures and repeat generations byte-identical.
It also found 25 semantic comparisons equal against the pre-retirement named,
application-schema, and action-log reference outputs. The final compiler run
`1793362925365685891` passed in 147.829 seconds total (135.279 seconds of
compiler phase work), with 4 GiB memory/no swap, six CPUs, two Cargo jobs and a
256 PID limit. Minimum available memory was 8,996,634,624 bytes and private
cache peak was 8,208,592,896 bytes. Ordinary named-type (3), application-schema
(3), and action-log (2) tests and the ignored named/action source replays
passed, along with all date-zone replays, format, scoped Clippy, minimal and
all-feature strict checks. The run did not perform Mongo CRUD.

There was no new benchmark. This wave did not run fresh Mongo CRUD; the
moderation action-log model's separate CRUD/index evidence is not a test of
these four model flows. The final retirement snapshot excluded only the four
unwired DeleteTwitch draft files recorded in its snapshot-isolation proof.

## Reproduction tools

`reproduction-tools/` contains exact copies of the provided two type-wave Node
and compiler scripts, the final retirement Node and compiler scripts, the
source-snapshot validator, and final readback helper when present. These
scripts are evidence references; no validation was started by this
documentation task.
