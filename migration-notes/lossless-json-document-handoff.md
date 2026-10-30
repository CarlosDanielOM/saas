# Reusable flat JSON document handoff

The shared Rust JSON document capability was accepted at source commit
`94fd1031381e397d749abf641e2db9fe285f9aa5`, bound to 1,491 inputs and source
tree SHA-256
`d66bd88a1496d50a55b097531e5e9f0c89cd91b5392c136cc1a7d874243ca053`.
The final Node oracle, capped compiler checks, formatting, scoped Clippy and
all-feature strict checks passed. Exact run epochs and limitations are in
[`lossless-json-document.md`](lossless-json-document.md) and the
[indexed evidence package](evidence/2026-10-30-lossless-json-document/README.md).

The capability provides a flat, stack-safe `JsonDocument`/`JsonView` core and
keeps the existing TTS coercion adapter and feature gate. The V8 depth-4096
`JSON.stringify` failure is recorded as a resource-limited oracle case, not a
parser failure or full canonical-output parity. No performance claim is made.

This is internal Rust utility work. No TypeScript source retirement, central
matrix row, application caller cutover, production deployment, or push is
included. The separate deletion helper remains unverified future work.
