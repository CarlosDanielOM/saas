# Advanced moderation literal optimization handoff

The advanced matcher caches the pure compiled literal result by the owned,
ordered raw typed term vector, using borrowed slice lookup. Empty input
bypasses the cache; nonempty lists whose terms all fold away cache `None`.
This internal cache clears all 128 literal entries before inserting a new
distinct set at capacity, independently of the 1,000-entry RE2 cache.
`PatternCache::len()` continues to count RE2 entries, and `clear()` clears
both. A mutex serializes compilation on misses; callers receive an `Arc` and
execute the pattern after releasing the lock.

When there is no literal pattern, matching skips literal text folding and
offset allocation. ASCII text uses full-string folding with identity UTF-16
offsets. Other input retains per-character folding and offset mapping, with
ASCII code units folded inline and non-ASCII characters sent through the
existing fold implementation. Literal results still precede regex results
and retain original text and offsets.

Authored tests cover ownership, shared concurrent compilation, filtered-empty
results, independent cache bounds and clearing, regex-only calls, and original
UTF-16 spans. The optimized implementation passed the focused suite and its
full source replay. Two complete paired benchmark rounds passed after the
initial baseline regression was retained. Exact scope and medians are in the
[integrated moderation evidence note](moderation-advanced.md) and standalone
[benchmark report](evidence/2026-10-30-moderation-advanced/artifacts/advanced-benchmarks.html).
The benchmark does not establish production throughput, CPU/RSS, startup,
database, or network performance. This optimization does not establish caller
adoption, deployment, or total migration completeness.
