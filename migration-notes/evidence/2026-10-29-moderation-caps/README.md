# Caps evaluator evidence

Two runtime exports and their equivalent typed contracts map to the native caps evaluator and sequential emote stripping. All 5,348 actual-TypeScript cases, three ordinary tests, native source replay and strict feature/profile checks passed. Pinned Unicode 17 letter/uppercase tables were generated from the actual source regexes and independently read back. Source hashes, exact static release ELF and before/after runtime hashes are retained.

The paired prepared benchmark reports Rust 2.772507625 microseconds and Node 18.865917625 microseconds per evaluation (85.304146% lower Rust median), across seven alternating pairs of one equally weighted eight-case pool. It measures evaluator calls only, with prepared inputs and preallocated output containers; checksums, parsing, IPC, serialization and drop are outside timing. Every paired checksum matched. This is one isolated host run, not production latency, CPU, RSS or a whole-application result. Raw trials, independent readback and comparison HTML are retained.

Earlier combined Node runs failed in the separate shared-Unicode generator after caps oracle generation/check had succeeded; those failures and their source variants are retained. The final standalone caps runtime and oracle check passed. Do not describe failed combined phases as passing.

The sole source import is type-only; broader moderation settings, registries and enforcement remain open. No TypeScript retirement, caller adoption, deployment or push occurred. All 19 production records remained unchanged, and no owned resources remained after checks.
