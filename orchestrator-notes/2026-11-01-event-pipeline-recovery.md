# Event Pipeline Recovery Routing — 2026-11-01

## Task and routing

The recovery release covered lifecycle step receipts, durable post-reauthorization current-state reconciliation, rejected-token refresh classification, and explicitly bounded historical offline repair. GPT-6.1 Terra at high handled scoped lifecycle and token work; Terra at xhigh handled offline matching and repair; GPT-6 Luna at high reconciled source-backed documentation.

Lead integration review caught a classification issue: an unavailable temporary token refresh could be surfaced as an authorization 401. The lead requested a distinct `refreshUnavailable`/503 result when refresh did not produce a different credential. That correction was included before candidate verification.

All three target candidates passed exact-runtime feature checks and 140 mocked regression checks each, with zero skips, then were deployed and production-checked. See [event pipeline recovery release evidence](../migration-notes/event-pipeline-recovery.md).

## Routing implication

This supports a task-specific route of Terra high for scoped lifecycle/token implementation, Terra xhigh for difficult offline recovery work, and Luna high for source-backed release documentation. The lead correction is concrete integration-review evidence for this task. It does not support a broad tier reorder, a general model-quality ranking, or a throughput/TPS claim.
