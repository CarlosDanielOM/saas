# 2026-10-22 — dual cron supervisor routing observation

**Status:** lead accepted run `cron-7629f95f5dfd` / image `sha256:f848743bc0f0817656d2399dd00a4e08e5828d2a0261096c551bb48302ae000f` after the 32-sample watch, final readbacks, and cleanup passed. Rollback target: accepted run `cron-2056ce9d790c` / image `sha256:adac7d8de9b5c5cfb138f8051a05123ac02a6c3467cc85784873ee85370d892f`.

## Scope and routing

This lifecycle integration used GPT-6.1 Sol at high/xhigh for source integration and review corrections, GPT-6 Astra at high for release coordination, and GPT-6 Luna at high for evidence-backed documentation. Keep these as task-specific routes; one result does not support a broad tier reorder. The user's ascending preference remains unchanged. A Grok 4.7 high exploration attempt ended in an unusable ILI and provides no capability evidence.

## Observation

The initial production probe stopped before its first sample because it counted 14 internal domain-event consumers as duplicate primaries. Source review confirmed those consumer forks are separate from the 25 registered worker primaries. The corrected offline probe passed 58 topology groups and seven Python tests; the production watch then passed. This historical first-attempt issue was probe accounting, not an application correction or evidence of application regression.

For exact build, suite, source identity, architecture, dependency review, and acceptance evidence, see [`migration-notes/dual-cron-supervisors.md`](../migration-notes/dual-cron-supervisors.md). No performance claim or model-tier change is supported.
