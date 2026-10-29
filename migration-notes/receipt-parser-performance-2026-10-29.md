# AI usage receipt parser performance — 2026-10-29

Status: **verified local parser result**. The final Rust source is bound to
`5afe5d1e16992dc8cf4d71f89084096bf4a5e513bfcd34f461672dba07914a2e`. The
original benchmark harness and 42 Node trials are retained. All six final Rust
medians are below their matched Node medians; this is a narrow parser benchmark,
not an application-wide performance claim.

## Matched benchmark

The comparison reuses the original 192 prepared inputs and expected wires
(six pools, 32 inputs per pool), harness, warmups, trial counts and Node
measurements. Three audited native-source rebinds track the lookup, borrowed
wire and borrowed scalar changes. The independently checked input SHA-256 is
`755bb61882c3d5a171fa21142ae799a00d86ea35f675b02e3155f467567648da`.

| Pool | Node median µs/op | Initial Rust | Lookup Rust | Wire Rust | Final scalar Rust median (range) |
|---|---:|---:|---:|---:|---:|
| ascii | 6.4754 | 58.8629 | 11.2499 | 8.9767 | 4.7953 (4.7083–5.1830) |
| unicode | 8.8659 | 70.0094 | 16.3876 | 14.8817 | 7.3380 (7.2079–7.5224) |
| coercion-duplicates | 8.8327 | 88.3840 | 14.0488 | 13.0848 | 7.5399 (7.2534–8.1223) |
| rejected | 12.2683 | 5.5008 | 1.6298 | 1.6251 | 0.8389 (0.7666–1.0998) |
| deep-ignored | 21.1810 | 57.7481 | 14.5885 | 14.1514 | 8.8309 (8.5841–9.9814) |
| deep-coerced | 76.1945 | 56.8779 | 17.2280 | 14.1977 | 11.5947 (11.4050–11.9558) |

The initial candidate regressed in ascii, unicode, coercion-duplicates and
deep-ignored; rejected and deep-coerced were already faster. The key lookup,
wire serialization, then scalar changes reduced the first four in successive
matched measurements. The final run also measured every previously faster
pool. The retained actual-transpiled-CommonJS Node run used 42 trials total;
its isolated VM realm matched all 192 expected wires before timing. Each Rust
pool used seven trials over 32 inputs. Regular pools used 32,000 warmups;
timed operations were 32,000 for ascii and 16,000 for unicode,
coercion-duplicates and rejected. Deep pools used 2,048 warmups and 2,048
timed operations. The operation parses a prepared
JSON string, creates the ordered normalized 18-field receipt wire (or null on
rejection), then adds each UTF-8 byte to a wrapping checksum. It excludes
input setup, queues, databases, network, and whole-application work; it reports
neither CPU nor RSS, and makes no statistical or production latency claim.

The final benchmark phase (`compiler-1793280560652256002`) completed its
release benchmark, matched all 192 wires/checksums and passed the five-TZ
replay, but the overall phase **failed** its broad-manifest guard because the
parent had added `attempt4/comparison-data.json` inside the monitored directory.
Evidence shows only that new report path was added; no existing file changed.
The corrected guarded replay (`compiler-1793280942006666851`) then passed all
1,362 source cases plus 64 producer/BSON recipes in each of five time zones,
with parser and benchmark files protected byte-for-byte. It did not rerun the
timings. Final actual-source/benchmark `--check`
`node-1793280993094123148` passed against the same source fingerprint.

## Verification and implementation notes

Pinned compiler run `compiler-1793280370053397498` passed formatting,
all-feature/all-target check and Clippy with warnings denied, no-default check,
and ordinary tests (2 core-library, 2 new view-library, 9 parser and 14 view
tests). The actual-source oracle `node-1793280499896669546` passed: all 1,362
cases, producer recipes, wires, BSON and five-time-zone results were byte
identical to the prior oracle; only the two native source file hashes differed.
Final Node validation passed; the parent’s final readback/evidence packaging
is documented in the [performance evidence package](evidence/2026-10-29-receipt-parser-performance/README.md).

The final scalar implementation is local commit
`4bc0b1fc648cd074d8ed67e3805dfd1acb962871` (two source/test files). The changes
reuse validated borrowed spans: unescaped object keys compare
without decoding; borrowed receipt fields write the ordered wire without an
intermediate owned JSON tree; and validated unescaped string leaves avoid
decoding for truthiness and return directly for string coercion. Escaped names
and strings retain the established decoder, including exact UTF-16 behavior.
The separate ASCII scalar diagnostic fell from 1,485.83 ns to 12.658 ns for
three truthiness checks, from 2,478.11 ns to 661.677 ns for four decodes, from
2,769.82 ns to 680.588 ns for four coercions, and from 7,556.32 ns to
3,205.808 ns for DTO parse. These separate stage measurements are not additive
or an application comparison.

Validation used the established limits: 6 CPU, 4 GiB memory with equal swap
(no swap), 256 PIDs, two build jobs and an 8 GiB task cache. Final strict,
replay and Node checks observed production records unchanged (19 records).
No deployment, push, caller adoption or TypeScript retirement occurred. This
result does not make the broader Rust migration complete.

The [baseline evidence package](evidence/2026-10-29-receipt-parser-baseline/README.md)
retains the original benchmark, oracle and source-binding records. Lookup,
wire and scalar author handoffs below document each bounded change and the
parent’s corresponding validation:
[lookup handoff](borrowed-json-lookup-performance-handoff.md),
[wire handoff](receipt-wire-performance-handoff.md),
[scalar handoff](borrowed-json-scalar-performance-handoff.md).
