# Advanced moderation migration evidence — 2026-10-30

This note records verified local Rust coverage for advanced moderation and
native RE2. It does not mark the overall Rust migration complete. The source
tree and run receipts are indexed in the
[evidence package](evidence/2026-10-30-moderation-advanced/index.json); a
[verification summary](evidence/2026-10-30-moderation-advanced/verification-summary.json)
records compiler and replay runs. The original independent source binding
covered 1,392 frozen inputs, SHA-256
`8003cb735a0a5f4574b4856a1a13dcb0559070897de2606c47af149f23aa4923`. The
optimized candidate source tree
used for paired round two is SHA-256
`8a1e6a666a72d948f8d6459a62cf70722e46445bdbffca0b72e5dc81651e98ec`; the
value-adapter compiler then verified source tree
`bc682e616a34954b3280178e3339696106df611f27dfaa160998a61fd975f8c1` across
1,392 bound inputs. Parser and optimization implementation revisions are
`5c50d884` and `71a4ff8c` respectively.

## Implemented local coverage

The opt-in Rust `moderation-advanced` adapter now combines the semantic policy
layer, source-order parser, literal matching, regex wrapper and caches, native
RE2 parser/engine adapter, and lossless input-value adapter. It reuses
`normalize::fold_text`, `blacklist::compile_blacklist_pattern`,
`re2_native::Re2Native`, the existing `uuid` package, pinned Unicode facts,
and the JS UTF-16 string codec. No Cargo package was added for this feature.
The adapter has no TypeScript runtime dependency, but current application
callers still use TypeScript.

The owned-value path preserves tagged NaN, positive and negative infinity,
negative zero, UTF-16 strings, and root-null error behavior. It reads
last-key-wins own properties without serializing values or invoking getters.
The native value tree does not model undefined array elements, prototypes,
accessors, symbols, functions, or BigInt. The JSON-view adapter remains
available for callers with representable JSON values.

The parser runs patterns, semantic policy, then blacklist restriction, as the
source does. UUID generation remains a concrete v4 default with deterministic
and fallible seams for replay. The matcher supports source-order literal and
regex results with original text and UTF-16 spans. Regex and literal caches
are independent: up to 1,000 compiled regex entries and 128 literal entries,
each clearing at capacity; empty literal input bypasses its cache. Cache
compilation is serialized on misses, but execution occurs after releasing the
lock.

## Verification

The final isolated compiler receipt was run against source tree
`bc682e616a34954b3280178e3339696106df611f27dfaa160998a61fd975f8c1` with 1,392
bound inputs. It passed scoped and all-feature strict Clippy, minimal and
MongoDB+Redis feature checks, two cache unit tests, five advanced ordinary
tests, and four policy ordinary tests. Full external replay passed all 464
owned-value application cases plus all 233 representable JSON-view parse
checks; all 84 selected semantic cases passed, with 83 representable inputs
cross-checked through the view, along with 14 paid-tier cases and six
constants. The compiler phase took 105.327 seconds (114.409 seconds total); it
recorded 9,948,323,840 bytes minimum available memory and 5,764,816,896 bytes
private cache peak. Limits were six CPUs, 4 GiB memory, no swap, and two Cargo
jobs. See the
[value-adapter compiler receipt](evidence/2026-10-30-moderation-advanced/runs/compiler-1793332852205922537-receipt.json.gz)
and [value-adapter compiler log](evidence/2026-10-30-moderation-advanced/runs/compiler-1793332852205922537.log.gz).

The corrected native RE2 implementation passed the 4,364-case SDK syntax
oracle and original 740-case SDK corpus (91 direct RE2, 604 regex behavior,
and 45 wrapper cases). The application replay passed all 464 parse/match cases; the separate
740-case SDK replay covered the direct, behavior, and wrapper observations. These are finite fixture results, not proof of all RE2
grammar or whole-SDK parity. The prior syntax parser's 405 mismatches and
other failed attempts remain preserved in the evidence record.

The pinned Node fixture `--check` run `1793332963521106628` passed byte-exact
source, syntax, Unicode, and benchmark-input regeneration against the same
`bc682e616a34954b3280178e3339696106df611f27dfaa160998a61fd975f8c1` tree. It
took 12.506 seconds in the Node phase and 13.838 seconds total; the before and
after production readback found all 18 containers unchanged. See the
[Node regeneration receipt](evidence/2026-10-30-moderation-advanced/runs/node-1793332963521106628-receipt.json.gz)
and [log](evidence/2026-10-30-moderation-advanced/runs/node-1793332963521106628.log.gz).

## Benchmark scope and results

Two complete paired rounds each retained 70 fresh-process samples: seven
Node/Rust pairs for each of five workloads, with alternating actor order. Each
sample used 32 prepared items, 250 rounds (8,000 operations), and three full
pool warmups (24,000 warmup operations). Every timed sample was preceded by
full ordered output validation and followed by checksum validation. Exact
source and binary provenance and the second-round independent readback passed.
Reports are in the
[round-one paired report](evidence/2026-10-30-moderation-advanced/artifacts/paired-attempt1/advanced-paired-report.json.gz),
[round-two paired report](evidence/2026-10-30-moderation-advanced/artifacts/paired-attempt2/advanced-paired-report.json.gz),
and [standalone benchmark report](evidence/2026-10-30-moderation-advanced/artifacts/advanced-benchmarks.html).

Final optimized-source medians in nanoseconds per operation:

| Workload | Node | Rust |
| --- | ---: | ---: |
| ASCII | 12,583.771375 | 1,470.04225 |
| Long mixed UTF-16 | 107,164.998875 | 33,176.764125 |
| Unicode | 20,432.9065 | 3,505.389875 |
| Regex only | 11,898.85725 | 979.48975 |
| Many terms | 51,513.320375 | 4,098.377 |

The measured public hot matcher call includes matching, folding/cache lookup,
and output assembly. It excludes prepared-input construction, initial regex
compilation, serialization, checksum work, and destruction of retained
outputs; temporary destruction inside the call is included. Each round has its
own Node baseline. The first round's severe initial Rust regressions in ASCII,
long text, and many terms are preserved. These measurements do not establish
CPU, RSS, startup, database/network cost, or production throughput; the
[standalone report](evidence/2026-10-30-moderation-advanced/artifacts/advanced-benchmarks.html)
contains detail.

## Boundaries and migration status

The moderation matcher reports native compile failure for invalid regexes; it
does not reproduce node-re2's `SyntaxError` class or exact diagnostic message.
Arbitrary JavaScript object behavior and constructor-observer parity are not
part of the typed input contract. Rust regex compiled-size and nesting limits,
mixed byte/rune boundaries, and general resource behavior can differ from
native RE2. Finite corpora do not prove full SDK API compatibility.

This is local feature coverage for the adapter, policy, and native regex
boundary only. The total migration ledger remains 17 complete and 13 partial
of 806 rows; the TypeScript archive contains 26 files and 780 live
TypeScript files remain, including six React Email inputs. No TypeScript
retirement or caller cutover occurred. No deployment or push occurred. The
piper removal was previously acknowledged by the user; the Node 24 fixture
was privately rebuilt from the exact 1,762 SDK source files for ABI 137 and
did not change the installed ABI 147 binary. Production readbacks found all
18 containers unchanged and zero task-owned containers, networks, or volumes
remained. Cleanup and host/resource details are recorded in the evidence
package. Existing failures, including the 405 syntax mismatches, UUID queue,
Clippy, map-borrow, and incorrect surrogate expectation followed by a direct
SDK spot-check, remain retained rather than hidden.
