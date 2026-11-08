# Informal viewer-chat validation

This is a fixed-prompt synthetic validation cohort focused on informal viewer messages. It complements the earlier conditional stress cases, whose invitation and quote-request-heavy contexts were not intended to represent ordinary traffic. The cohort is balanced by design, not traffic-weighted; see [fixture notes](fixture-notes.md) for the design limits and hidden-voice information boundary.

## Frozen design

The frozen [plan](plan.json) schedules two repeats for each of three models and two variants across 130 cases: 1,560 planned OpenRouter requests. The variants are the production-equivalent `baseline` and the already selected `policy_v2`; the selection was frozen using development data before this cohort. This is a transfer check, not new prompt tuning or prompt selection. Do not use these validation outcomes to change the frozen selection. No production configuration change or deployment is in scope.

The three model IDs are `respan/span-01`, `typesafe/jev-1.13`, and `openai/gpt-6-luna-decisions`. Each case is submitted as baseline and `policy_v2`. Repeats measure response consistency and do not add independent examples.

## Provenance and information boundary

The [input-visibility record](input-visibility.json) traces the request to current source: the moderation handler reads up to seven recent chat lines within 60 seconds, each limited to 500 characters, and derives broadcaster status from a badge. The model receives chat text and badges; it receives no microphone audio or transcript. The [preflight](preflight.json) records 130 cases, 65 positive and 65 benign, zero broadcaster context lines, zero double-quoted targets, maximum target length 63, numeric epoch-millisecond context timestamps, five visible-context target pairs, and 12 separate non-scored hidden-voice pairs. It also records the production contract parity checks and fixture hash.

The hidden-voice pairs have identical whole visible inputs and opposite hidden histories. Their exclusion from model scoring does not mean the end-to-end system can resolve them; a chat-only system cannot infer unheard speech, and legitimate spoken promotion may remain unresolvable without an explicit additional signal. They are diagnostic only. No ASR feature or production permission behavior was added for this benchmark.

See the [fixture notes](fixture-notes.md), the frozen [plan](plan.json), [preflight](preflight.json), [freeze manifest](freeze-manifest.json), [request visibility evidence](input-visibility.json), and [hidden-story diagnostics](visibility-diagnostics.json). The preflight establishes fixture and source-contract consistency, not model performance.

## Offline reproduction and audit

Run commands from the repository root. These validation commands are offline and do not make model calls. The live run is already assigned to `benchmarks/decision-moderation/results/2026-11-08-informal-chat/validation`; do not start or resume inference as part of offline analysis.

```sh
# Check request construction and the fixed plan.
python3 benchmarks/decision-moderation/tuning/experiment.py validate \
  --plan benchmarks/decision-moderation/informal-chat/plan.json

# Analyze the stopped run's saved responses. Offline only.
python3 benchmarks/decision-moderation/tuning/experiment.py analyze \
  --out benchmarks/decision-moderation/results/2026-11-08-informal-chat/validation

# Audit coverage, request construction, and production parser replay after the run has stopped.
python3 benchmarks/decision-moderation/tuning/audit.py \
  --out benchmarks/decision-moderation/results/2026-11-08-informal-chat/validation

# Render the audited validation comparison using the pre-existing development selection.
python3 benchmarks/decision-moderation/informal-chat/render_results.py \
  --root benchmarks/decision-moderation/results/2026-11-08-informal-chat \
  --selection benchmarks/decision-moderation/tuning/selection-2026-11-08.json
```

The analysis writes the run-local summary and related outputs. The audit is read-only with respect to the saved raw attempts and writes `audit.json`. The adapter renderer creates comparison HTML, JSON, and CSV under the result root; it reuses the audited tuning renderer and does not run inference or choose a prompt. The authoritative prompt mapping remains [selection-2026-11-08.json](../tuning/selection-2026-11-08.json), frozen from development only.

## Current status

The 1,560-request inference phase and offline audit are complete: all calls returned, with zero errors, refusals, late responses, or audit mismatches. See the [final report](REPORT-2026-11-08.md), [comparison HTML](../results/2026-11-08-informal-chat/comparison.html), [comparison CSV](../results/2026-11-08-informal-chat/results-table.csv), [structured comparison data](../results/2026-11-08-informal-chat/comparison-data.json), [run summary](../results/2026-11-08-informal-chat/validation/summary.json), [audit](../results/2026-11-08-informal-chat/validation/audit.json), and [post hoc default-category slice](../results/2026-11-08-informal-chat/default-category-slice.json). The renderer uses the frozen development-only selection and does not tune or select a prompt.

On the full cohort, policy_v2 increased timely positive attempts for Span 01 and Jev 1.13 while reducing false-ban attempts; Luna eliminated false-ban attempts but had fewer timely positives. These are synthetic fixture results, not moderator ground truth, real-world accuracy, or production safety evidence. The main cohort tests selected categories including profanity and insults, so it is not a default spam-only score. The post hoc default-category slice is a separate descriptive view and did not affect prompt selection.
