# Moderation variations source-oracle handoff

The author-only fixture executes the pinned actual `variations.ts`, `normalize.ts`, OpenRouter attribution source, and reused `advanced.ts` with its private Node RE2 addon. Fetch, provider credentials, and abort state are controlled for transport observations; no live provider request is made. Source, loader, runtime, RE2, manifest, and independent reader bindings are retained and verified in [the evidence package](evidence/2026-10-30-moderation-variations/index.json).

The final oracle covers all 15 runtime exports and records all four type exports in 175 calls: 173 pure calls and two exact request cases, plus 15 mocked transport observations. Values preserve undefined/null, holes, UTF-16 code units, and binary64 bits; compatible results also compare JSON wire output. Cache identity/FIFO and transport are separate observations. This bounded corpus does not exhaust malformed inputs, regexes, Unicode sequences, or network failures.

Variation-source fixture SHA-256: `1d3ab58bd78a0d34b60e139b24901920fe32d1e32de3e96bd6db486b14e39c54`; it remained unchanged. The separate NFC fixtures changed only native provenance, with identical code-point and sequence results. Engine-specific regex and JSON diagnostics remain compatibility limits. See the main note for final validation and matrix status.
