# Plan: Enforce Stream Summary JSON Schema for Deepseek V4 Pro

## Reason

Deepseek V4 Pro is used for stream summary decisions on the Pro plan tier. The system currently describes the expected JSON output **only in natural language** inside the system prompt, and OpenRouter's `response_format: { type: 'json_object' }` only enforces that the output is a JSON object — not its shape, types, or enum values. As a result, when V4 Pro deviates from the schema (wrong `action` casing, missing fields, truncated arrays, etc.), the code silently drops the malformed actions in `sanitizeAction()` and the stream summary is saved with `actions: []`. The streamer sees a successful run with zero memories created and there is no operator-visible log line explaining why.

## Goal

Stop Deepseek V4 Pro from silently losing memory actions due to invalid JSON, wrong field shapes, or enum mismatches. Apply defense-in-depth: strict OpenRouter JSON Schema, Zod validation, and a self-healing retry that falls back to a secondary model. Add operator-only logging so we can see what the model is doing without exposing diagnostics to streamers.

## Decisions (confirmed with user)

| Decision | Choice |
|---|---|
| Schema enforcement | Both — OpenRouter `json_schema` + Zod validation/retry (defense in depth) |
| Logging | Operator-only via standard `console`/project logger. NOT added to `IStreamSummary` schema. NOT visible in the dashboard. |
| Retry | Yes — retry same model once with a "fix the JSON" instruction, then fall back to `BACKGROUND_MODEL_FALLBACK` (deepseek-v4-flash), then give up. |
| Confidence thresholds | Leave as-is. No changes to `stream_memory_apply.ts`. |

## Files to modify

### 1. NEW: `dimabot/src/utils/ai/memory/stream_summary_schema.ts`
Single source of truth for the expected LLM response shape.

- Export a Zod schema mirroring the `SummaryOutput` interface in `stream_summary_decider.ts`:
  - `summary.headline` (string, 1–120 chars)
  - `summary.recap` (string, 1–2000 chars)
  - `summary.highlights` (string[], max 8)
  - `actions[]` with: `action` (enum), `type`, `targetMemoryId`, `summary`, `content`, `confidence` (0–1), `risk` (enum), `reason`, `evidence` (string[])
- Export a `STREAM_SUMMARY_JSON_SCHEMA` constant — the same shape as a JSON Schema object — used in the OpenRouter `response_format` payload.
- Export a `parseStreamSummaryResponse(raw: string)` helper that:
  1. Strips markdown fences (` ```json ` wrappers).
  2. `JSON.parse`s.
  3. Validates with Zod.
  4. Returns `{ ok: true, data } | { ok: false, error, rawSnippet }`.

This single file drives both the LLM contract and the validator — they can never drift.

### 2. EDIT: `dimabot/src/utils/ai/memory/stream_summary_decider.ts`
Replace the loose prompt + parse with the structured flow.

- **System prompt** (line 260–306): Keep the human-readable description but shorten the schema section and add: `"Your response must validate against the JSON schema provided via response_format.json_schema."`
- **Request body** (line 346–356): Replace `response_format: { type: 'json_object' }` with the full `json_schema` from the new shared file. If OpenRouter rejects `strict: true` for V4 Pro (will discover empirically), drop to `strict: false` and rely on Zod as primary guard.
- **Add a `tryDecideWithRetry()` helper** that runs the fetch + parse loop:
  1. Call model with strict schema.
  2. If Zod validation fails → log operator-only warning → re-call **once** with same model, appending `"Your previous response failed validation: {error}. Return ONLY the JSON object conforming to the schema, no prose."` to the system prompt.
  3. If retry fails → fall back to `BACKGROUND_MODEL_FALLBACK` (v4-flash) with strict schema.
  4. If fallback fails → return `fallbackOutput(context)` as today.
  5. Each attempt logs: `model`, `attempt`, `parseError` (if any), `validationError` (if any), `actionCountRaw` (post-parse), `actionCountValid` (post-Zod).
- **Operator-only logging** — use the existing `console.error` / project logger (whatever the codebase already uses for dev logs, e.g. `console.error('[STREAM DECIDER] ...')`). Log on:
  - JSON parse failure (raw snippet, first 500 chars)
  - Zod validation failure (Zod issue list)
  - Sanitization drop (count + per-action reason)
  - Empty `actions` array from the model (warning)
  - Fallback model used
  - All retries exhausted

These logs go to the standard server log stream — **not** to the summary document, **not** to the dashboard. Streamers see nothing different.

### 3. EDIT: `dimabot/src/utils/ai/memory/stream_memory_runner.ts`
- No behavior change in the apply step.
- When `decisionOutput.actions.length === 0` AND `usedFallback === true` → log operator warning with `channelID`, `mode`, model used, and a hint to check the logs.
- Add a single line per run: `console.log('[STREAM MEMORY] channelID=X actions=N model=M fallback=Y')` so the operator can grep for runs where `actions=0` and `fallback=Y`.

### 4. EDIT: `dimabot/src/utils/ai/memory/stream_memory_apply.ts`
No changes. Per user decision, leave confidence thresholds at the current defaults.

### 5. EDIT: `dimabot/src/utils/ai/memory/index.ts`
Re-export the new schema/parser so they're testable from a unit test.

### 6. NEW: `dimabot/src/utils/ai/memory/stream_summary_decider.test.ts` (or `.spec.ts`)
Two small unit tests:
- `parseStreamSummaryResponse` accepts a valid V4-Pro-shaped response
- `parseStreamSummaryResponse` rejects: bad JSON, wrong action enum, missing `summary` key, `confidence` > 1, `evidence` not an array

If no test runner is configured in the project, this step is skipped.

## What will NOT change

- `IStreamSummary` schema in `channel_stream_summary.schema.ts` — no new fields visible to streamers.
- `stream_memory_apply.ts` confidence thresholds.
- Model selection constants in `constants.ts`.
- The runner's high-level workflow steps.
- The existing fallback model logic — just extending it, not replacing it.

## Verification

1. `npm run build` in `dimabot/` passes.
2. Run the unit tests if the test runner is configured.
3. Manual smoke test using a known bad-shape response (a hand-crafted string with a typo'd enum) and confirm:
   - It retries once with v4-pro
   - It falls back to v4-flash if retry fails
   - The fallback also fails
   - `fallbackOutput()` is returned
   - Operator log lines appear on every step
4. Manual smoke test using a known good response and confirm:
   - It parses on first try
   - No retry, no fallback
   - Actions flow through to `applyStreamMemoryActions()` with no schema-related drops

## Risks / open items

- **OpenRouter strict mode cost**: `strict: true` may use more tokens on some models. Negligible in practice.
- **Model-specific quirks**: If `deepseek/deepseek-v4-pro` rejects the `strict: true` flag with a 400, fall back to `strict: false` and rely on Zod validation as the primary guard.
- **Retry cost**: A failure path now costs 3 LLM calls instead of 1. Success paths cost 1 as before.
