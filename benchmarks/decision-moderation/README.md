# Offline moderation decision evaluation

This kit prepares a comparison of model decisions for the built-in spam classifier using synthetic chat examples. It is offline: the suite tool validates fixtures, exports model-independent requests, and evaluates response files. It does not call a provider or contain a provider SDK runner. No inference has been run on the new corpus. The labels describe this fixture rubric; they are not moderator ground truth and do not establish production safety.

## Corpus

`scenarios.json` is the expanded, frozen synthetic corpus: 240 clear cases across 24 families (10 per family: 5 positive and 5 benign), plus 24 ambiguous diagnostic cases. The clear cases are split by whole family: 120 development cases and 120 holdout cases held back from inference and model-driven tuning. The diagnostic cases are a separate split and are expected false under the classifier's ambiguity fail-open rule. The corpus covers at least eight languages plus mixed-language examples, with Latin and non-Latin scripts. See [RUBRIC.md](RUBRIC.md) for labeling rules and review limits.

English, Spanish, Portuguese, Japanese, French, German, Korean, Arabic, and mixed-language cases occur in both clear splits. Italian, Russian, and Hindi have one diagnostic case each; `und` marks one emoji-only case. Some language slices have only two clear examples. Use them to locate issues, not to claim broad proficiency. The corpus includes `id`, `message`, `context`, `categories`, `expected`, `expected_categories`, `group`, `family`, `scenario_group`, `split`, `language`, `tags`, `label_status`, and `rationale`. Do not put labels, expected categories, rationales, family names, or other answer-bearing metadata in model requests.

The preserved [legacy archive](legacy/) contains 147 records (135 primary and 12 supplemental), including one duplicate payload represented by two records. It is frozen for historical comparison and intentionally remains separate from the expanded suite. Historical legacy labels include override-only examples that were called spam even though current source policy does not prohibit an override by itself. Never pool legacy and expanded results or combine their splits into one winner score. Legacy supplemental cases historically had one repeat; current exports use the two-repeat legacy default unless overridden.

The [protocol](protocol.json) records the frozen evaluation contract, planned comparison, attribution, and outstanding inference-preflight requirements. The [manifest](manifest.json) pins kit files and application source; validation, export, and evaluation check these hashes. The offline [source parity record](verification.json) documents fixture/request and response-scoring comparisons against current source; it records no model inference. [Legacy provenance](legacy/provenance.json) records legacy-source hashes. A hash documents file identity, not label correctness.

## Commands

Run from the repository root with Python 3 and the standard library:

```sh
python3 benchmarks/decision-moderation/suite.py validate
python3 benchmarks/decision-moderation/suite.py export --suite expanded --split development --model MODEL_ID --output /tmp/moderation-development.jsonl
python3 benchmarks/decision-moderation/suite.py export --suite expanded --split holdout --model MODEL_ID --output /tmp/moderation-holdout.jsonl
python3 benchmarks/decision-moderation/suite.py evaluate --suite expanded --split holdout --baseline BASELINE_ID --candidate CANDIDATE_ID /path/to/paired-responses.jsonl --output /tmp/moderation-report.json
```

`export` writes JSONL wrappers containing `request`, `headers`, case/model/repeat bookkeeping, and a request hash; it makes no HTTP calls. A future runner sends only `row.request` as the body and applies `row.headers`, adding authentication at runtime. Never POST the entire wrapper. The non-secret headers match the app (`HTTP-Referer: https://domdimabot.com`, `X-OpenRouter-Title: DomDimaBot`, `X-OpenRouter-Description: DomDimaBot is a Twitch chat bot that helps make streams more engaging and fun.`, `X-OpenRouter-Categories: general-chat, roleplay`, and `Content-Type`). Exports never contain an `Authorization` header or API key, and attribution is metadata rather than prompt content. See [`app_attribution.util.ts`](../../dimabot/src/utils/ai/openrouter/app_attribution.util.ts).

For evaluation, retain `case`, `requested_model`, `round`, `phase`, and `request_sha256` from the exported wrapper. Save these with `latency_ms`, `http_status`, the full parsed response in `raw`, and an optional `error` for each attempt. Combine both models' rows in one response JSONL file. The evaluator derives decisions from `raw.answers` and `raw.usage`; it ignores any saved verdict or score summaries.

Do not infer current API availability or pricing from this kit. Before any future inference phase, verify the exact model identifier, route/provider, current price, and BYOK eligibility for the account making the request. In particular, verify the exact Luna API model ID and BYOK route before using it. The default repeat counts are two for `legacy` and three for `expanded`; use the tool's reported counts and phase-specific output when interpreting results.

For a fair paired comparison, use the same frozen cases and repeat numbers for both models, preserve each exported request-body hash, and include every scheduled response. The wrapper's static attribution headers are not part of that hash. The evaluator recomputes verdicts from raw answers rather than trusting saved verdicts. Missing, duplicate, unknown, malformed-timing, or hash-mismatched rows invalidate the comparison; incomplete runs cannot win.

## Reading results

Compare planned GPT-6 Luna decisions through OpenRouter BYOK against the exact baseline `typesafe/jev-1.13` on the same holdout cases only after the prompt and decision threshold are frozen. Verify the candidate's exact API identifier, decision-endpoint support, and BYOK route first; see [protocol.json](protocol.json). Keep development, diagnostic, legacy, and holdout results separate. Review false positives first. Zero observed false positives is not proof of safety. Then compare timely recall on both attempts and distinct cases, response/deadline errors, p50/p95 latency, returned known costs, and repeated-case consistency. Reports include slices by family, language, and category; use them to inspect weaknesses, not to claim broad generalization. Raw response model/provider metadata and score-mechanism diagnostics are indicators only; they do not prove which route or model served a request. A returned false ban counts against synthetic qualification even if it arrived late. Missing response cost is reported as unknown; OpenRouter cost may not capture upstream BYOK spend.

The classifier supports five categories (`spam`, `ads`, `self_promotion`, `profanity`, `insults`); each case's `categories` field specifies the selected subset for that request. Qualification uses the app's independent-probability safe veto and unchanged 0.85 threshold. A returned violation is timely only when it is produced in under 4,000 ms. Errors, uncertainty, malformed responses, and late responses do not count as timely enforcement. A complete holdout with no observed false bans and a strict candidate improvement in both timely positive attempts and distinct positive cases earns only `synthetic_holdout_candidate`; it is not approval to deploy or use a model in production.

The kit evaluates the built-in spam classifier contract. It does not evaluate arbitrary custom semantic policies or establish moderator, product, or legal ground truth. The three alternative contract rules sometimes explored on development data (single `ANY`, maximum selected-category score and `ANY` both at least 0.85, and no safe-score veto) are exploratory only and are not implemented as qualification criteria.

## Source of the current contract

- Category list, policy definitions, questions, and default threshold: [`spam_categories.ts`](../../dimabot/src/utils/moderation/spam_categories.ts)
- Invitation detection and built-in spam rule: [`spam.ts`](../../dimabot/src/utils/moderation/spam.ts)
- Request shape, parser, threshold handling, and model selection: [`semantic.ts`](../../dimabot/src/utils/moderation/semantic.ts)

Current source permits ordinary promotion only when invited by context explicitly marked `isBroadcaster: true` and recognized by the implemented English/Spanish invitation regex. Other-language invitation wording is unsupported by that regex: treat it as an ambiguous diagnostic or documented contract limitation, never as verified authority. Any matching invitation in context is active under current code; the implementation does not determine whether an invitation has expired. The target author's username is not exposed to the built-in spam request, so identity-dependent repetition belongs in diagnostics, not the clear labeled corpus. An injection instruction is untrusted chat evidence; the instruction itself is not a prohibited behavior. Classify only the selected category content in the final message.

Per-language report slices can be useful for finding failures, but slice sizes may be small and do not support blanket claims of multilingual proficiency.

The current account mapping is also distinct from archived model labels: paid moderation with credits selects Jev, paid moderation without credits selects Lite, and free accounts select Span. Built-in spam classification and custom semantic policy evaluation use separate request contracts; historical names such as ProJev, PremiumSpan, and FreeLite are not a statement of the current source mapping. See [`semantic.ts`](../../dimabot/src/utils/moderation/semantic.ts) for the current selector.
