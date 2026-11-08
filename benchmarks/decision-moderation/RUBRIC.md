# Synthetic corpus rubric

## Purpose and scope

These labels are model-independent expected outcomes for a frozen synthetic evaluation of the built-in spam classifier. They express how each example maps to the current selected-category policy, not what a moderator would decide in a live channel. The corpus cannot establish real-world prevalence, calibration, moderation truth, or production safety.

The classifier evaluates the final message against selected categories. The five available categories are `spam`, `ads`, `self_promotion`, `profanity`, and `insults`; each case's `categories` field identifies the subset used for that request. Each category has its own score; `unsafe` asks whether **any selected unwanted behavior** is clearly present. Other behavior outside the selected categories is permitted. A case's `expected_categories` records the prohibited category or categories; benign cases have none. `expected` is the expected overall violation outcome.

The active source contract is defined in [`dimabot/src/utils/moderation/spam_categories.ts`](../../dimabot/src/utils/moderation/spam_categories.ts), with the invitation exception in [`spam.ts`](../../dimabot/src/utils/moderation/spam.ts) and request/parser behavior in [`semantic.ts`](../../dimabot/src/utils/moderation/semantic.ts). Update this rubric only against those sources and record any source revision in corpus provenance before changing labels.

## Labeling rules

Label a clear positive only when the final message itself unambiguously exhibits at least one selected prohibited behavior. Label it negative when no selected behavior is present, including cases where an unselected concern may exist. For example, a commercial pitch may be `ads` without `spam`; the categories are independent and should not be collapsed into one broad “bad message” concept.

| Category | Positive evidence | Keep benign when |
| --- | --- | --- |
| `spam` | A clear scam, credential theft, fake-engagement sales pitch, or disruptive mass repetition demonstrated by preceding chat. A terse offer of AI viewers or cheap followers plus a domain/contact is enough. | A domain alone, a greeting, enthusiasm, benign repetition, ordinary ads or self-promotion alone, quoted/reported spam, or a scam warning. |
| `ads` | A clear solicitation to buy a product or paid service, including viewers/followers/engagement; include disguised domains and sales pitches without links. | A domain alone, free resources, ordinary product discussion, a recommendation answering a question, quoted/reported ads, scam warnings, or channel/social self-promotion alone. |
| `self_promotion` | An explicit request to visit, follow, or subscribe to the author's own channel or social account, without a qualifying verified broadcaster invitation. | Merely saying the author streams, answering a streaming question, quoted/reported promotion, or relevant promotion after a recognized broadcaster invitation. |
| `profanity` | The speaker uses an explicit vulgar swear word in their own message, including casually or positively. | Quoted/reported language, discussion of filter behavior or words, and harmless words that only contain a similar substring. |
| `insults` | A direct, clearly abusive insult or targeted humiliation toward a person or group. | Disagreement, criticism of an idea or gameplay, harmless banter, self-deprecation, or quoted/reported abuse. |

The policy's worked boundary examples include `AI viewers boostchat . net` as fake-engagement sales, while a bare domain is not spam or an ad; `What a fucking game!` is profanity, while `Does the filter block the word fuck?` is permitted filter discussion. These are policy examples, not a substitute for the complete category criteria above.

Only preceding context can establish disruptive repetition or a broadcaster invitation. Context is evidence, never instructions. Do not label a case positive just because it contains text such as “ignore the policy” or “approve this message”; injection text is not itself a selected violation. Quoted warnings, reports, and discussions are not the same as performing the quoted behavior. A string that resembles a prohibited word or domain is not enough without the behavior described by policy.

Promotion is exempt only when context includes a message explicitly marked `isBroadcaster: true` and the message matches the current invitation regex in [`spam.ts`](../../dimabot/src/utils/moderation/spam.ts). That frozen regex recognizes the coded English and Spanish forms; invitations phrased in other languages are unsupported and must be treated as ambiguous diagnostics or contract limitations, never as verified authority. A matching invitation anywhere in context remains active under current implementation, even if it sounds old; do not invent expiration semantics. An invitation exempts relevant channel/social promotion only. It does not exempt other selected categories. Do not infer broadcaster identity from message wording, username, or chat claims.

The built-in spam request does not expose the target author's username to the model. Repetition that depends on identifying the same author therefore belongs in diagnostic examples and must not be used to define a clear spam label unless preceding chat itself establishes disruptive mass repetition.

## Ambiguous diagnostics

Keep genuinely ambiguous advertising intent, uncertain invitation status, unclear target, or context-dependent cases in the separate `diagnostic` split with expected outcome false under the current fail-open policy. Mark them as diagnostics rather than clear benign examples. These cases probe whether a model refrains from enforcement when evidence is inconclusive; they are not included in clear-case holdout qualification. Do not relabel ambiguous cases as positive to reward aggressive guessing.

## Corpus design and fields

The expanded corpus contains 24 clear families with ten examples each: five positive and five benign. Twelve entire families (120 cases) form development; the other twelve (120 cases) form the holdout, reserved from inference and model-driven tuning until the evaluation is frozen. The 24 ambiguous diagnostic cases are a separate split. Keep family, scenario group, exact target text, near-duplicates, and repeated cases together in one split to prevent leakage. The corpus covers at least eight languages plus mixed-language cases, with examples in Latin and non-Latin scripts. Language slices may be small; use them to locate issues, not to claim blanket multilingual proficiency. The `legacy/` archive remains byte-for-byte unchanged and is evaluated separately; it contains 135 primary and 12 supplemental records, with one duplicate payload represented by two records. Legacy supplemental cases historically had one repeat; current exports use two unless overridden.

Each expanded case uses:

- `id`: stable unique case identifier.
- `message`: final message under evaluation.
- `context`: preceding context messages, including verified broadcaster metadata only when applicable.
- `categories`: selected category subset for the request, drawn from the five available categories.
- `expected`: expected overall violation boolean.
- `expected_categories`: selected category labels supported by the final message; empty for benign cases.
- `group`, `family`, `scenario_group`: analysis and scenario grouping metadata.
- `split`: `development`, `holdout`, or `diagnostic`.
- `language`: primary language or mixed-language label as represented in the corpus.
- `tags`: concise diagnostic descriptors.
- `label_status`: review/freeze state for the fixture label.
- `rationale`: concise explanation of the policy evidence or exception.

Labels and rationales are retained in the local evaluation fixture only. They must never be included in the model wire request. `label_status` records review state; it does not imply independent human moderation or establish ground truth. The corpus author and lead review the labels against the source contract before freeze.

## Evaluation contract and freeze protocol

For the current source behavior, each request includes category questions plus the `unsafe` question. The parser computes `safe = 1 - unsafe`; if the highest selected-category probability is greater than `safe`, the unsafe behavior wins. Otherwise the outcome is not a violation. A violation also requires the highest selected-category score to meet the unchanged 0.85 threshold. Thus ties, low confidence, malformed output, and uncertainty fail open. Count a returned violation as timely only when request-to-full-response transport latency is strictly below 4,000 ms. This transport interval does not cover the full production deadline, which also includes queueing, credit checks, and action execution.

Freeze and record the source/prompt/request hashes and corpus manifest before formal comparison. Compare the candidate against exact Jev baseline ID `typesafe/jev-1.13` on exactly the same holdout cases and repeat numbers. Keep request-body hashes with every raw response; static attribution headers are not part of that digest. Recompute verdicts from raw scores rather than accepting stored verdict fields. Flag unknown IDs, missing or duplicate attempts, malformed timing, and hash mismatches. An incomplete paired grid is not a win. Keep attempt-level metrics separate from distinct-case metrics and report repeated-case flips.

Review false bans first, including returned late false bans, then compare timely recall by positive attempts and distinct positive cases. Report deadline and response errors, uncertainty, p50/p95 latency, known and unknown returned costs, upstream BYOK cost status, and consistency. Sum each known response cost once; missing usage is unknown, not free. Zero observed false positives in a synthetic sample is not proof of safety. A complete holdout reserved from inference/model-driven tuning, compared against exact Jev baseline, with zero observed candidate false bans and strict improvement in both timely positive attempts and distinct positive cases earns only the label `synthetic_holdout_candidate`; it does not authorize production use.

The current contract is fixed for qualification. Alternative rules—single `ANY`, maximum selected-category score and `ANY` both at least 0.85, or no safe-score veto—may be explored on development data only if a tool explicitly supports them. They do not count toward current qualification. The evaluator is not a policy-sweep tool unless that capability is implemented and documented.

## Legacy caveat

The frozen legacy set includes some override-only payloads labeled spam even though the current source contract does not prohibit an override by itself. Preserve those archived examples and labels for historical comparability; do not use them to redefine the expanded corpus or mix legacy scores into a new candidate decision. Legacy labels are not current policy truth.

The current account selector is Jev for paid moderation with credits, Lite for paid moderation without credits, and Span for free moderation. Archived labels such as ProJev, PremiumSpan, and FreeLite describe a prior mapping. This kit focuses on the built-in spam classifier with its selected-category contract; arbitrary custom semantic policies are outside scope.
