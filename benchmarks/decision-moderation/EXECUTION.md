# Seven-model live baseline execution

## Status and scope

The run in [`results/2026-11-08-seven-model-baseline/`](results/2026-11-08-seven-model-baseline/) is complete; all 9,618 main attempts and seven smoke attempts are saved and integrity-checked. See the [final report](REPORT-2026-11-08.md) for results. The run's `frozen-inputs/` snapshot preserves the prepared manifest and contract; later workspace manifest/documentation refreshes do not change this completed run. Do not resubmit or refill its grid. No prompt optimization or threshold search was part of this baseline.

The fixed model IDs are:

| Requested model | OpenRouter ID |
| --- | --- |
| Span 01 | `respan/span-01` |
| Span 02 | `respan/span-02` |
| Jev 1.13 | `typesafe/jev-1.13` |
| Jev 1.14 | `typesafe/jev-1.14` |
| Perplexity Decider 1.2, standard Decider (not Flash) | `perplexity/pplx-decider-v1.2` |
| Liquid d1.1 | `liquid/d1.1` |
| OpenAI Luna Decisions | `openai/gpt-6-luna-decisions` |

Each model is scheduled against 507 frozen cases: legacy 147 records at two repeats, original expanded 264 records at three repeats, and Unicode obfuscation 96 records at three repeats. That is 1,374 main attempts per model, or 9,618 main attempts total, plus seven single benign smoke requests. Keep the legacy, expanded development/holdout/diagnostic, and obfuscation groups in separate reports; there is no blended winner score.

## Production contract snapshot

[`production-source/`](results/2026-11-08-seven-model-baseline/production-source/) contains the compiled JavaScript moderation modules captured from the running `dima-bot` image `sha256:cfa1f51dca33aeed518b3f08ae1a402d61bbc023bb79495ee70f7a49e341240f`. [`snapshot.json`](results/2026-11-08-seven-model-baseline/production-source/snapshot.json) pins the per-file hashes. The moderation source files matched across `dima-bot`, `dima-cron`, and `dima-server`. [`live-contract-verification.json`](results/2026-11-08-seven-model-baseline/live-contract-verification.json) records 3,549 request-contract comparisons against compiled production JavaScript with zero mismatches and no model inference in that check.

All requests use the current compiled category questions and parser: selected-category score at least 0.85, plus the existing safe veto (`max(selected category) > 1 - P(unsafe)`). The 4,000 ms strict transport deadline and fail-open behavior are unchanged. The runner collects a full response for up to 12 seconds so late judgments can be recorded; only responses under 4,000 ms count as timely enforcement. Timing covers the direct HTTP request through the full response and excludes application queueing, credit checks, and moderation actions. This direct request run does not consume application queues or execute moderation actions, and it is not a provider-capacity test.

## Runner and provenance

[`run_openrouter.py`](run_openrouter.py) builds the fixed schedule, requires one successful benign smoke response for each model before the main grid, and then resumes already completed exact `(suite, case, model, round)` tuples. The schedule uses a shared 0.2 second minimum between request starts and one in-flight request per provider family, rotating models round-robin within shared families (Respan and TypeSafe); the other model families have one model each. This pacing is for a bounded comparison, not a throughput or capacity benchmark.

The runner sends direct OpenRouter requests with the frozen DomDimaBot attribution headers (`HTTP-Referer`, `X-OpenRouter-Title`, `X-OpenRouter-Description`, `X-OpenRouter-Categories`, and `Content-Type`) and a synthetic `user` value, `decision-benchmark-2026-11-08`. For historical compatibility, `request_sha256` excludes that transport `user`; `wire_request_sha256` includes it. Both hashes and the schedule are pinned in run metadata. The prepared manifest freezes evaluation inputs; the later-added runner is separately pinned by `run-meta.json`'s `runner_sha256` and copied as [`runner-source.py`](results/2026-11-08-seven-model-baseline/runner-source.py). The run metadata also pins model IDs, repeats, schedule hash, deadline, headers, and timeout. The runner copies manifest-pinned inputs into [`frozen-inputs/`](results/2026-11-08-seven-model-baseline/frozen-inputs/); later analysis imports only that verified run-local copy, not the mutable workspace corpus or prompt builder. The final archived artifact will also retain hashes/copies of the analyzer and verifier used for its report.

The API key is read at runtime from `OPENROUTER_API_KEY` or `--key-env-file`; the env file is parsed as text (it is not executed) and accepts whitespace, an optional `export ` prefix, and quoted values. The runner does not log credentials. Its account snapshots request `/api/v1/key` for usage/limit accounting and persist only allowlisted numeric usage/limit fields in `account-snapshots.jsonl`, not authentication metadata.

Raw attempts and request intents are append-only JSONL. Each append is flushed, fsynced, and read back. There is no automatic retry. A completed tuple is skipped on resume; an intent without a recorded outcome blocks the run for manual reconciliation. Do not delete intents, rewrite outcomes, or resubmit an unresolved tuple to fill the grid. Invalid successful response schemas stop further attempts for that model rather than invoking a fallback.

The single benign smoke request per model is a routing/response preflight, not an evaluation case. The Luna smoke response was marked `is_byok=true`; its OpenRouter `usage.cost` was zero while `usage.cost_details.upstream_inference_cost` was reported separately. That confirms the smoke response's BYOK accounting path, not a conclusion about model quality or all later responses.

## Cost handling for this run

The user expects this finite grid to cost under $1 and authorized a soft $1 warning with instructions to continue; there is no $1 hard stop. This authorization applies to this run's fixed finite schedule, not future runs. The runner can issue the warning from returned request costs or an account usage delta. The account ledger is shared and may include concurrent production traffic, so it is not a strict reconciliation of benchmark-only spend.

[`summarize_run.py`](summarize_run.py) sums each returned OpenRouter `usage.cost` once. It adds `usage.cost_details.upstream_inference_cost` only when `usage.is_byok` is `true`; it does not add upstream cost for non-BYOK responses, which could double-count. Missing usage or upstream cost remains unknown, never free. OpenRouter-reported and BYOK upstream costs remain separately visible, with a combined known estimate only when observed data supports it.

## Commands

The smoke command is one live request per model. After inspecting its saved results, run without `--smoke-only` to execute or resume the finite grid. Both commands make paid OpenRouter requests; they are documented here for this already authorized run.

```sh
python3 benchmarks/decision-moderation/run_openrouter.py \
  --output-dir benchmarks/decision-moderation/results/2026-11-08-seven-model-baseline \
  --key-env-file /secure/path/openrouter.env \
  --smoke-only

python3 benchmarks/decision-moderation/run_openrouter.py \
  --output-dir benchmarks/decision-moderation/results/2026-11-08-seven-model-baseline \
  --key-env-file /secure/path/openrouter.env
```

After the run has stopped, create the analysis outputs from the pinned run snapshot. The summarizer makes no API calls; while the grid is incomplete it reports `INCOMPLETE` and exits nonzero, which is not a final comparison.

```sh
python3 benchmarks/decision-moderation/summarize_run.py \
  --run-dir benchmarks/decision-moderation/results/2026-11-08-seven-model-baseline
```

Replay all recorded requests, responses, headers, scores, and timing against the captured compiled production JavaScript. This verifier is offline and makes no provider/API calls.

```sh
python3 benchmarks/decision-moderation/verify_live_contract.py \
  --run-dir benchmarks/decision-moderation/results/2026-11-08-seven-model-baseline
```

The verifier writes `native-verification.json`; the analyzer writes `summary.json`, `case-failures.json`, and `coverage.json`. Use `coverage.json` to confirm a complete grid and valid run snapshot before interpreting comparisons. The offline unit test command is:

```sh
python3 -m unittest discover -s benchmarks/decision-moderation -p 'test_*.py'
```

## Reading the eventual report

Read every suite and split separately, review false bans first, and distinguish attempts from distinct cases and paired obfuscation IDs. The two legacy duplicate records remain historical references and are not ground truth; the original holdout is reserved from inference-driven tuning; obfuscation diagnostics measure clean-to-obfuscated changes but do not merge into original-suite qualification. These are synthetic expected labels, not moderator truth. A complete run can describe behavior on these fixtures only; it cannot prove real-world safety, calibration, or production performance.
