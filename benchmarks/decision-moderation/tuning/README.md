# Moderation prompt tuning experiment

This is a synthetic, prompt-only experiment for three authorized model IDs: Span-01 (`respan/span-01`), Jev 1.13 (`typesafe/jev-1.13`), and Luna (`openai/gpt-6-luna-decisions`). It compares the exact production-equivalent baseline request with two experimental prompt configurations. It does not change production configuration or deploy anything.

## Frozen comparison

The baseline uses the existing production request contract: the same question and state shape, selected categories, Unicode content, parser, and 0.85 threshold. Preflight compared 1,008 baseline requests with captured compiled production code and found zero request mismatches. The captured source hashes matched the code in both running moderation containers; response replay follows inference. See [`preflight-verification.json`](preflight-verification.json).

The candidates are:

- `context_v1`: adds shared instructions to distinguish an action from reporting or quoting, while addressing obfuscation and fake wrapper claims. It changes question instructions only.
- `policy_v2`: includes `context_v1` instructions and adds wording for credential theft, paid-service solicitation, fake-engagement offers, and invitation-scoped self-promotion. This combines policy wording changes, so the experiment cannot attribute an effect to one definition alone.

Parser behavior, threshold, safe-veto logic, question/state structure, and production policy remain fixed. These are candidate prompts for evaluation, not adopted policy.

## Development selection

The development corpus has 168 cases: 120 expanded-development and 48 obfuscation-development cases. Each model runs baseline and both candidates twice, for 3 models × 3 configurations × 168 cases × 2 repeats = **3,024 planned calls**. Repeats measure response consistency; they are not independent examples.

Selection is frozen per model and uses development results only. A candidate is eligible only if, **within each evaluation group**, its returned false positives are no higher than baseline, its timely true positives are no lower, and its errors are no higher. It must also show at least one strict overall improvement: fewer returned false positives or more timely true positives. Eligible candidates rank by fewer total returned false positives, then more timely true positives, then variant order. If none qualifies, retain baseline. A timely catch must arrive in strictly less than 4,000 ms. Do not use fresh-validation or historical-regression outcomes to select prompts.

## Reserved validation and historical regression

After development selection is frozen, fresh validation runs baseline and each model's selected prompt on all 168 reserved cases for three repeats: 84 positive and 84 benign cases, or **3,024 planned calls** when all three selections differ from baseline. If a model selects baseline, run it once per repeat without a duplicate candidate. Do not revise selection using these results.

The fresh fixture's SHA-256 is recorded in [`protocol.json`](protocol.json) and [`preflight-verification.json`](preflight-verification.json). It was authored without access to original model outputs or scenario files, but its design was informed by the task and policy; it is synthetic expected labeling, not independent moderator ground truth.

The 135-case legacy regression set is a separate historical reference run twice (1,620 planned calls for baseline plus one selected prompt per model). It contains known synthetic policy disagreements. Keep it separate from the contemporaneous fresh-validation comparison; do not change its labels or present it as the main improvement test.

## Reproduction

Run commands from the repository root with Python 3 and standard library dependencies. `validate` is offline. `run` makes paid OpenRouter requests; use only after the relevant plan and source hashes are frozen. Store the API key in a protected env file with exactly one `OPENROUTER_API_KEY=...` line; never put the key in a command, source file, or benchmark output. The runner uses a 12-second response timeout, one in-flight request per model, 0.2-second global start spacing, no automatic retries, and preserves failures for analysis. Its $1 cost alert is informational and does not stop a run.

```sh
# Offline: check the frozen development plan and request construction.
python3 benchmarks/decision-moderation/tuning/experiment.py validate \
  --plan benchmarks/decision-moderation/tuning/development-plan.json

# Paid inference: use a protected key file and a new private output directory.
python3 benchmarks/decision-moderation/tuning/experiment.py run \
  --plan benchmarks/decision-moderation/tuning/development-plan.json \
  --out /secure/path/decision-tuning-development \
  --key-env-file /secure/path/openrouter.env

# Offline: analyze a completed run's saved responses; this does not call a model.
python3 benchmarks/decision-moderation/tuning/experiment.py analyze \
  --out /secure/path/decision-tuning-development
```

Fresh validation requires its own frozen plan whose `model_variants` encode the development-only selection for each model and whose cases match the reserved fixture hash. Validate and run that plan using the same commands, substituting its path and a separate output directory. The analysis command is offline and reproducible from the run snapshot.

## Current status and limits

Preparation is verified; development inference is running. No model-performance result or prompt winner is claimed here. The fixtures are synthetic, language slices are sparse, some multilingual examples are translation-shaped, and repeated calls do not add independent coverage. Results can identify prompt behavior on these fixtures; they do not establish real-world moderation performance, policy correctness, or production safety.
