# Moderation action log schema

Historical author handoff, superseded by the verified result in
[`persistence-model-retirement.md`](persistence-model-retirement.md). The
accepted native model reuses the shared `ModerationAction` enum and
`SchemaDefinition` machinery; this reuse was covered by actual-source Mongoose
and MongoDB fixture validation. The source-only migration and its post-archive
checks are documented in the
[evidence package](evidence/2026-10-30-persistence-model-retirement/README.md).

The earlier pre-retirement schema epoch and its private cache-maintenance audit
remain preserved separately in that package. The action-log source is now
archived byte-for-byte. TypeScript callers remain active and unadopted.
