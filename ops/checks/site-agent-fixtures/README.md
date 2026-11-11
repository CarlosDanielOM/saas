# Site agent fixtures

Fake providers for site agent ("Dima assistant") checks. Nothing leaves the candidate container: OpenRouter,
Polar and the docs export are answered in-process; every other host is blocked.

```sh
scripts/saas-ops verify <api-run-id> \
  --dependency mongo --dependency redis \
  --test-env ops/checks/site-agent-fixtures/test-env.json \
  --fixtures ops/checks/site-agent-fixtures \
  --check ops/checks/<site-agent-check>.mjs
```

`test-env.json` loads `providers.mjs` into every Node process (`NODE_OPTIONS=--import`), sets
`OPENROUTER_BASE_URL=http://openrouter.test/api/v1` with the test key `test-openrouter-key`, and points the
docs loader at `docs.test`. A check that spawns unit suites should clear `NODE_OPTIONS` for them.

## Fake OpenRouter (`openrouter.test`)

`POST /api/v1/chat/completions` streams a scripted reply. The script comes from markers in the **newest user
message that contains `[[`**, so a plain steer message keeps the running script and a steer with its own
marker switches it. `step` = number of assistant messages after that message (0 on the first model call of the
turn). Every reply has the real shape: `: OPENROUTER PROCESSING` comments, `reasoning` text, `reasoning_details`
fragments (two `reasoning.summary` pieces + a `reasoning.encrypted` item split in two), text in several chunks,
`finish_reason`, a usage chunk (BYOK: `cost: 0`, `cost_details.upstream_inference_cost`, cached tokens from
step 1 on), `[DONE]`. Each SSE event is written in two pieces so lines cross network chunks.

| Marker | Effect |
|---|---|
| `[[script:<name>]]` | Pick a script (below). Default `text`; `tools` when a `[[call:…]]` marker is present. |
| `[[call:<tool> {json}]]` | Tool call at step 0. Repeat for parallel calls. |
| `[[call@<n>:<tool> {json}]]` | Tool call at step `n` (multi-step flows). |
| `[[delay:<ms>]]` | Pause before every text/tool chunk (stop/steer tests). |
| `[[chunks:<n>]]` | `text`: `n` chunks (`part-0 … part-<n-1>`); `slow`: number of chunks. |
| `[[wait:<ms>]]` | Delay before the response headers. |
| `[[gen404:<n>\|never]]` | `/generation` answers 404 this many times first (default 2), or always. |
| `[[nocost]]` | Usage without `cost_details` (tests the estimated-cost path). |
| `[[crlf]]` | CRLF line endings. |
| `[[compaction:<script>]]` | Script for compaction calls (requests without tools). Default `summary`. |

| Script | Reply |
|---|---|
| `text` | `FIXTURE_TEXT …` in 8 chunks. |
| `tools` | At each step with `[[call…]]` markers: short progress text + those tool calls (ids, names and arguments split across chunks, calls interleaved), `finish_reason: tool_calls`. Defaults to `search_docs` + `read_docs` without markers. After the last call step: `FIXTURE_TOOLS_DONE step=<n> results=<count> reasoning=<ok\|missing> <tool_call_id>: <first 80 chars of each result> …`. `reasoning=ok` means every assistant tool-call message sent back carried the merged encrypted reasoning item exactly. |
| `loop` | A tool call on every step (first `[[call]]` marker or `search_docs`), for step/tool-call caps. |
| `slow` | 40 chunks `slow-<i>` 250 ms apart (`[[delay]]`, `[[chunks]]` change it). |
| `hang` | Reasoning, then only `:` comments every 5 s until the client aborts. |
| `error_mid` | Some text, then an error chunk (`code 502`, `finish_reason: error`) → `overloaded`. |
| `incomplete` | Some text, then the stream ends without `finish_reason` or `[DONE]`. |
| `no_usage` | Normal answer without the usage chunk (the runner reconciles it). |
| `flaky` | First request per session/message/step: HTTP 503 (`Retry-After: 0`), then `text`. |
| `context` | HTTP 400 "maximum context length" → `context_too_long`. |
| `http_<status>` | That HTTP status with an OpenRouter error body (`Retry-After: 1` on 429/503). |
| `summary` | `FIXTURE_SUMMARY …` (used for every request without tools unless `[[compaction:…]]`). |

With `tool_choice: 'none'` (the forced last step) every non-error script answers `FIXTURE_FINAL … (step <n>)`.

`GET /api/v1/generation?id=` knows every generation the fake streamed: 404 for the first `gen404` lookups, then
`{data: {native_tokens_*, upstream_inference_cost, total_cost: 0, is_byok: true, cancelled}}`. An aborted stream
is saved with `cancelled: true` and the tokens sent so far. Unknown ids are always 404. State lives in
`/tmp/saas-fixtures/generations/` so every process in the container shares it.

## Fake Polar (`api.polar.sh`)

`POST /v1/events/ingest` records the events and answers `{inserted, duplicates}`, deduplicating external ids
like Polar does. Write `{"polar": "fail"}` to `/tmp/saas-fixtures/control.json` to make it answer 503 (retry-list
tests); delete the file to recover. Other Polar paths answer 404 and are logged.

## Call log

Every request is appended to `/tmp/saas-fixtures/calls.jsonl` (no auth headers; `authOk` says whether
`Bearer test-openrouter-key` was sent):

- `{provider: 'openrouter', path, script, step, generationId, authOk, referer, title, lastUser, toolNames, forced,
  toolResults, reasoningEchoed, assistantToolCallMessages, body}`; error statuses add `status`.
- `{provider: 'openrouter', event: 'aborted', generationId, sentChunks}` when the client stops a stream.
- `{provider: 'openrouter-generation', id, status, cancelled?}`
- `{provider: 'polar', path, status, events, inserted, duplicates}`
- `{provider: 'docs', path}`, `{provider: 'blocked', url}`

```js
const calls = () => fs.readFileSync('/tmp/saas-fixtures/calls.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const modelCalls = calls().filter((c) => c.provider === 'openrouter' && c.body);
const assistantEvents = calls().filter((c) => c.provider === 'polar').flatMap((c) => c.events).filter((e) => e.name === 'ai_assistant');
```

## Local runs

`node ops/checks/site-agent-fixtures/providers.mjs serve 18787` serves the same fake OpenRouter on
`http://127.0.0.1:18787/api/v1` (set `OPENROUTER_API_KEY=test-openrouter-key` for both processes, and
`SITE_AGENT_FIXTURE_DIR` to a scratch folder for the log). Importing the module also installs the fetch hook, so
`startFakeOpenRouter({port})` is available to scripts that want a real socket.

The fake never judges answer quality. That needs a few real OpenRouter calls with the owner's key, run outside
the candidate and never with production data.
