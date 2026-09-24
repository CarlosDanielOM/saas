# AI chat verification

Run from the production checkout with a built `bot`, `api`, or `cron` candidate:

```sh
scripts/saas-ops verify <run-id> \
  --dependency mongo --dependency redis \
  --test-env ops/checks/ai-chat-fixtures/test-env.json \
  --fixtures ops/checks/ai-chat-fixtures \
  --check ops/checks/ai-chat.mjs
```

The check exercises compiled code, disposable thread storage for all three tiers,
the actual chat request builder and tool loop, denied viewer actions and allowed
moderator actions, memory/prompt regression tests, and service readiness. The
provider fixture records synthetic requests and blocks unrecognized external
requests. Twitch actions and model responses are mocked; this check does not
measure generated prose quality.

The direct conversation budgets are 10/40/100 individual user or assistant
messages for Free/Premium/Pro, independent of the existing background-chat
budgets. Reply length guidance lives in `constructChatSystemMessages` in
`dimabot/src/utils/ai/prompts.ai.ts`, under `Reply style`.

## Initial model comparison (2026-09-24)

Synthetic Spanish conversations were compared using the previous and new prompt
with `deepseek/deepseek-v4.1-flash` and `meta/muse-spark-1.2-contributor` through
OpenRouter. No real chat messages or executable actions were involved. There
were 16 initial-response cases and 16 cases completing tool exchanges with
simulated results. Both versions completed continuity, named-person memory,
moderator title-change, and permission-denial cases. Denials were not retried.
Muse sometimes consulted AST documentation before the title action.

For the single casual-banter sample on each model:

| Model | Input tokens before/after | Reply characters before/after |
| --- | --- | --- |
| Flash | 4334 / 2679 | 196 / 145 |
| Muse | 4523 / 2921 | 124 / 111 |

These are small, nondeterministic samples, not a guarantee of response length,
latency, or identical personality across all conversations. Longer thread
windows can increase total input tokens despite the smaller fixed instructions.
