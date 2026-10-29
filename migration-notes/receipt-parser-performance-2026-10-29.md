# AI usage receipt parser benchmark baseline — 2026-10-29

Status: **verified baseline; four Rust time regressions remain open**. The
benchmark harness is committed as
`0389561e6004d3a8f7bc10ca73b3bc49a9016e5e`. A separate bounded lookup
optimization is in verification, but no candidate timing or performance
acceptance exists yet. This note reports only the initial matched baseline.

## Matched baseline

Source tree SHA-256:
`8dbce36238ca2323d795782d1dc7032f66a372df9053a9e6a56d11df4d7f428a`;
input SHA-256:
`2342386c3dde9f63206402cd7e82d83b88360f9cbab7d90ef69ee5a52e0e287e`.
The source binding covers 1,275 files and the six pools contain 192
prevalidated source wires. Each pool has 32 inputs and seven trials.

| Pool | Node median µs/op (range) | Rust median µs/op (range) | Rust/Node median time |
|---|---:|---:|---:|
| ascii | 6.4754 (6.2281–7.0369) | 58.8629 (57.2925–63.5998) | 9.09x |
| unicode | 8.8659 (8.6150–13.2711) | 70.0094 (67.6673–71.3212) | 7.90x |
| coercion-duplicates | 8.8327 (8.7014–10.2306) | 88.3840 (86.4125–102.1838) | 10.01x |
| rejected | 12.2683 (11.2813–13.5841) | 5.5008 (5.3075–6.3887) | 0.448x |
| deep-ignored | 21.1810 (20.8195–22.9414) | 57.7481 (53.6163–61.1509) | 2.73x |
| deep-coerced | 76.1945 (74.5679–78.9801) | 56.8779 (53.6262–62.6905) | 0.746x |

The four Rust regressions are ascii, unicode, coercion-duplicates and
deep-ignored. Rust has lower median time for rejected and deep-coerced. The
Node timing retains 42 trials from actual transpiled CommonJS source; an
isolated VM realm matched all 192 expected source wires before timing. Node and
Rust both matched every checksum.

Each operation parses a prepared JSON string, creates the ordered normalized
18-field receipt wire (or null for rejection), and adds each UTF-8 byte to a
wrapping checksum. Regular pools use 32,000 warmups; their timed operations are
32,000 for ascii and 16,000 for unicode, coercion-duplicates and rejected.
Deep pools use 2,048 warmups and 2,048 timed operations. Inputs and expected
wires are prepared outside timing. This covers parser work, ordered wire
encoding and checksum only; it excludes input setup, queueing, database and
network I/O, and measures neither CPU nor RSS nor whole-application latency.

## Verification and diagnostic

Strict checks passed (`compiler-1793274083369420275`), the Node
source/benchmark check passed (`node-1793274189948131358`), release plus
all-feature and no-default strict checks passed
(`compiler-1793274264064252684`), and final Node `--check` passed
(`node-1793274460403768280`). The final compiler phase took 149.233 seconds
for its script and 156.805 seconds total, with a 41.21-second timed test. It
ran under 6 CPU, 4 GiB memory/equal swap, 256 PID and two-job caps; peak cache
was 8,169,611,264 bytes and minimum available memory was 10,518,982,656 bytes.
Readback verified 19 production records unchanged and no task-owned resources
remaining.

The retained first lint failure (`compiler-1793274004764681420`) was a
constant profile assertion in the benchmark harness. An equivalent `if` guard
fixed that assertion without changing parser behavior, prepared inputs or
source wires.

A separate exact-release profile of one ASCII input
(`compiler-1793274681760889459`, seven trials of 3,200 operations) reported:

| Stage | Median µs/pass |
|---|---:|
| Validate and index | 0.958 |
| Twenty field lookups | 57.442 |
| Parse normalized DTO | 57.498 |
| Prepared DTO wire | 7.742 |
| Parse plus wire | 64.780 |

These diagnostic stages are separate, not additive end-to-end figures, and
have no Node comparison. The static source trace points to repeated decoding
of object keys in the parser's `get` path. Sol at xhigh authored a bounded
candidate using borrowed UTF-8 matching with an escaped UTF-16 fallback.
Formatting has been applied and its checks are running; there are no candidate
timings yet.

The [baseline evidence package](evidence/2026-10-29-receipt-parser-baseline/README.md)
contains the [comparison and raw trials](evidence/2026-10-29-receipt-parser-baseline/artifacts/initial-benchmark-comparison.json),
[verification summary](evidence/2026-10-29-receipt-parser-baseline/verification-summary.json),
[source binding](evidence/2026-10-29-receipt-parser-baseline/source-binding.json),
[lookup diagnostic source proof](evidence/2026-10-29-receipt-parser-baseline/artifacts/lookup-diagnostic/source-proof.json)
and [stage report](evidence/2026-10-29-receipt-parser-baseline/artifacts/lookup-diagnostic/report.jsonl).

No caller adoption, TypeScript retirement, deployment or push occurred. The
broader Rust migration remains incomplete.
