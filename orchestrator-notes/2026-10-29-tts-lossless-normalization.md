# Lossless TTS normalization routing observation — 2026-10-29

**Task:** Bounded UTF-16 TTS utility parity and pet speech text composition,
including actual-TypeScript corpus expansion, a prepared paired benchmark, and
source-backed documentation. The implementation/review sequence and model
details below are from the task handoff; this documentation assignment did not
independently measure model capability or throughput.

**Routing:** GPT-6.1 Terra at xhigh produced the initial implementation and
test/benchmark draft. Review found a fidelity issue: the first draft
normalized the raw pet expressive-tag configuration. A bounded Terra xhigh
follow-up authored the source-derived tests and benchmark, and Terra at high
corrected the raw JSON policy so the helper passes through the
`filters.expressiveTags` value as supplied; callers may provide raw or already
normalized settings. GPT-6.1 Sol at xhigh handled parent review and
capped validation; GPT-6 Luna at high was assigned source-backed documentation.
The first draft's missing benchmark and configuration issue are recorded as
task-specific review outcomes, not a model-tier ranking.

**Evidence:** Final actual-source Node run `node-1793245647083747340` passed
1,774 new cases (1,303 normalization, 342 pet composition, nine emote
extraction, and 120 spoken-user composition), plus separate replays of the
existing 1,932 expressive and 276 credit-fallback cases. Final source SHA-256
is `0f6d2b024c6333461e6bd007512f798d64f09fbcb72629c631866bef9ae0dbd4`; Node
replay took 6.003 seconds (7.296 seconds total), and post-run report validation
passed in 2.002 seconds (3.228 seconds total). Final capped compiler
`compiler-1793245700167727814` passed 129 ordinary, eight explicit, and one
release-benchmark execution, formatting, TTS and all-features strict checks,
and the no-default-features check. It took 172.817 seconds (180.379 seconds
total). The source implementation is commit
`782e036316810290e89e8638516f38f0eb081d4d`. Receipts and source hashes are
indexed in the [migration note](../migration-notes/tts-lossless-normalization-2026-10-29.md)
and its evidence pack.

The paired benchmark input SHA-256 is
`0b64cdffa9c43c3e1f0545beed6e64a49727eca2df06ad0d7e4558325d9b895a`. The
first run had two regressions: Links (Rust 24.3% higher elapsed time) and
Whitespace controls (10.7% higher). The final run has eight lower Rust medians
and two near-parity rows: Links and large UTF-8, both about 1%. Keep both sets
of medians in the migration note. The allocation change was limited to the
ill-formed UTF-16 branch; do not attribute timing variation in unchanged UTF-8
code to it. There is no statistically significant or generalized performance
claim, or CPU/RSS/provider/production claim.

**Assessment:** Low confidence and task-specific. The work provides one
bounded implementation/review example, including a real source-fidelity
correction and a complete measurement harness. It does not establish a broad
capability, quality, or TPS comparison. See the [migration record](../migration-notes/tts-lossless-normalization-2026-10-29.md)
for scope and verification boundaries.
