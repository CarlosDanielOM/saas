# Real chat Luna tuning experiment

This benchmark evaluates offline Luna prompt variants against the unchanged
Jev 1.13 baseline. It is a benchmark and recommendation exercise only. This
scope does not change the production model, prompt, parser, thresholds, veto
behavior, or configuration. Jev 1.13 remains the incumbent paid model.

## Experiment protocol

- Development uses 237 cases: 177 reviewed real-chat cases (12 positive and
  165 benign) plus 60 previously observed synthetic guardrails (30 positive,
  30 benign). The real positives cover six campaigns.
- Jev is evaluated only with its unchanged baseline prompt. Luna is evaluated
  with its baseline and three frozen candidates: `policy_v2`, `concise_v3`,
  and `fewshot_v4`.
- Each model/variant/case receives two repeats, for 2,370 planned development
  calls. Selection follows the frozen rule in [protocol.json](protocol.json):
  no worse false positives, timely true positives, or errors within each
  evaluation group, plus at least one strict overall TP/FP improvement.
  Otherwise retain Luna baseline. A few-shot gain on its training examples is
  not sufficient.
- The 113-case real heldout is benign-only after strict campaign grouping and
  exclusion of previous targets; three overlapping records were moved to
  development. It checks false positives; it cannot measure real-spam recall.
  Campaign groups are disjoint, but channels may overlap.
- The separate sealed challenge contains 74 newly authored synthetic cases
  (34 positive, 40 benign), from 80 independently authored proposals receiving
  a blind second review; six without clear consensus were excluded.
  It is synthetic generalization evidence, not evidence of real-spam recall.
- Final comparison is Luna's selected variant versus Jev baseline. Luna must
  avoid higher false positives, fewer timely positive attempts/cases, and
  more errors or late responses across the real benign heldout and challenge;
  at least one strict improvement is required. Ties retain Jev.

## Results and benchmark decision

The 2,370-call development phase completed with 2,370 observed attempts, no
missing rows, zero request/metric mismatches, zero native baseline mismatches,
and zero HTTP errors. The frozen development-only selection is Luna
`concise_v3`; Jev remains baseline-only. Luna `concise_v3` recorded 10 returned
false positives and 76 timely true positives over development, versus 12 and
74 for Luna baseline. `policy_v2` and `fewshot_v4` were rejected: each improved
real-development counts but regressed synthetic-guardrail timely true
positives, violating the per-group no-loss rule.

The final gate result is **`luna_candidate_on_this_benchmark`**. On the real
heldout, Jev, Luna baseline, and selected Luna each returned zero false
positives across 113 benign messages repeated three times (339 attempts each).
This is a false-positive check only; there are no real positive cases.

On the fresh synthetic challenge (74 cases, 34 positive and 40 benign, three
repeats), Jev had 80/102 timely positive attempts and caught at least one
attempt on 28/34 positive cases; Luna baseline had 93/102 and 31/34; selected
Luna `concise_v3` had 96/102 and 32/34. Each had zero false positives across
120 benign attempts. The selected prompt adds three timely positive attempts
over Luna baseline in this challenge; Luna baseline already exceeds Jev here.
P95 latency was 286.5 ms for Jev, 326.3 ms for Luna baseline, and 306.1 ms for
selected Luna. All audited phases had zero errors, late responses, and
mismatches.

**Important limitation:** on the known synthetic development guardrails,
selected Luna had 10 false-positive attempts among 60 benign attempts, versus
Jev's 8/60. A fresh-challenge gate pass does not show that Luna is globally
preferable or justify a live switch. Labels are AI consensus, language coverage
is sparse outside English and Spanish, and the real heldout contains no
positive examples. Jev remains the production incumbent; this result is a
benchmark candidate only, not production authorization.

The reviewed labels come from two independent AI reviewers who did not see
the original predictions. Consensus is provisional and is not moderator
ground truth. Across both review folds, 290 of 300 labels reached consensus;
10 were excluded. Source attribution is `DomDimaBot`. The benchmark's
synthetic guardrails remain separately identified and are not counted as real
positive evidence.

## Fixed behavior and privacy

The parser, category threshold (`0.85`), safe veto, and exclusive response
deadline (`4,000 ms`) stay fixed. Safe veto selects the highest category only
when it exceeds `1 - unsafe`; ties, late responses, and errors fail open. The
normal OR/DimaBot BYOK routing path is used. Baseline preflight recorded 474
native request comparisons with zero mismatches. Twenty new tests passed:
four adapter, six gate, and ten renderer fixture tests. No production
configuration changed.

Real-data exports and case-level files stay local and untracked. The docs and
aggregate reports must not include case text, labels tied to cases, channel or
identity details, or other personal payload. Usernames, context IDs, and
`@mentions` use HMAC pseudonyms. Timestamps were retained, and unstructured
text may still contain names. Few-shot examples are drawn from development
only, with original prediction labels absent; labels are presented as
examples in instructions, not inserted into the actual chat state. The
evaluated context is preserved; context is omitted only for selected
target-only labeled examples.

## Running and auditing

Use `benchmarks/decision-moderation/real-chat/run_experiment.py` with its
`run`, `validate`, and `analyze` commands. Run the separate audit with
`python3 benchmarks/decision-moderation/tuning/audit.py --out <phase-output-dir>`.
Render case-free aggregates with
`python3 benchmarks/decision-moderation/real-chat/render_results.py --root <results-root>`;
the renderer uses `<results-root>/selection.json` by default.
Keep generated cases, raw attempts, and other private run artifacts in the
local ignored results directory. Run validation and the separate audit before
interpreting an aggregate; the [preflight manifest](preflight.json) records
the frozen counts and baseline parity checks. Do not use a paid rerun as the
default verification path.

Auditing stored phases requires the protected local source snapshot and phase
outputs. This public aggregate-only bundle does not contain per-case inputs or
raw responses, so it cannot independently replay the inference run. Final
aggregate records are linked below; no paid calls are needed to inspect them.

Aggregate inputs are documented in the [corpus manifest](evidence/corpus-manifest.json),
[review manifest](evidence/review-manifest.json),
[challenge manifest](evidence/challenge-manifest.json),
and [example manifest](evidence/example-manifest.json).
Completed development counts and selection are in the
[development aggregate](evidence/development-aggregate.json),
[frozen selection](evidence/selection.json), and
[execution-integrity record](evidence/execution-integrity.json).

Final metrics and the gate decision are in the [real-heldout aggregate](evidence/real-holdout-aggregate.json),
[fresh-challenge aggregate](evidence/fresh-challenge-aggregate.json),
[decision record](evidence/decision.json),
[comparison data](evidence/comparison-data.json),
[results table](evidence/results-table.csv),
[cost record](evidence/cost.json), and
[challenge profile](evidence/challenge-profile.json). The [report](REPORT-2026-11-08.md)
records phase-specific results without publishing per-case IDs, labels, or
message payload. Production remains unchanged.
