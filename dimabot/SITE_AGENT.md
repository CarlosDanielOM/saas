# Site agent ("Dima assistant")

An AI assistant inside dimasite's logged-in pages (`/:streamer/...`). It answers from the docs, knows the channel,
and can change things for the streamer after they approve. Opened from the mascot. Two levels the person picks in the
composer (both `high`, through OpenRouter, BYOK; model names are never shown): **Standard** = GPT-6 Luna (the owner's
OpenAI key; `xhigh` until 2026-11-11) and **Expert** = Claude Haiku 5.5 (the owner's Anthropic key; Premium/Pro, since
2026-11-13). Free for now: no AI credits; usage goes to Polar as
`ai_assistant` events. Contracts: `src/site_agent/types.ts`, `config.ts`, `navigation.ts`.

The assistant uses website access rules (`site` mode); MCP uses `mcp` mode. See [MCP.md](./MCP.md).

## Product rules (owner decisions, 2026-11-11)

- Everyone with website access to the channel (owner, admins with `dashboard:view`) can use it, on every plan.
- Daily limit per **channel** (owner + admins share it), per UTC day: free 20, premium 100 (80 until 2026-11-13), pro
  400 **messages**. A Standard message uses 1 and an Expert message 2, no matter how many tool calls (Premium = 100
  Standard or 50 Expert; Pro = 400 or 200). A steer pays what its running answer pays; queued messages pay their own
  level, fixed when sent. Approvals, form answers, Stop and retries after our own errors don't count. No global spend
  cap for now.
- Levels and context limits (owner decisions 2026-11-13; `SITE_AGENT_PLANS` in config.ts), in the model's own tokens:

  | Plan | Standard (Luna, 1) | Expert (Haiku, 2) |
  |---|---|---|
  | Free | 100k | locked (Premium chip → plans) |
  | Premium | 256k | 100k |
  | Pro | 256k | 256k (prompts over 100k bill at 5×; accepted) |

  Compaction starts when the prompt reaches the limit itself (was 90% until 2026-11-13). The pick is saved per person
  (`site_agent:prefs` field `level`) and sent with every message; a saved Expert on Free runs as Standard.
- **Moving a chat** to the other level loses its prompt cache, so the message that moves it pays a move fee on top of
  its level (owner decision 2026-11-13, `LEVEL_SWITCH` / `messageCost` in config.ts): Standard → Expert +2 (4 in all),
  or +4 (6 in all) when the chat is over 100k in Claude's tokens (Luna tokens × 1.8); Expert → Standard +1 (2 in all).
  Later messages pay their level only. A new chat never pays to move. The chat remembers its last answering level and
  model (`lastLevel`, `contextModel` on the session); a queued message compares with the answer it waits for; a steer
  pays its turn's level price (`levelCost`), never the fee. `GET /sessions[/:id]` returns `nextCost` per level and the
  panel shows it (`×N` + a note) before sending.
- **Expert refusals:** when Anthropic's or OpenRouter's safety filter declines an Expert step (a `content_filter` /
  native `refusal` reply, or a 403 / mid-stream error whose `metadata` has `error_type` refusal /
  content_policy_violation, `reasons` or `flagged_input`), the step is redone on Standard for the rest of the turn, the
  chat shows the `expert_fallback` note, the turn pays 2 more (1 switch + 1 Standard answer, owner decision; `chargeMore`,
  never past the daily limit, refunded with the rest on our own zero-step failure; the chat is on Standard afterwards,
  so the next Expert message pays the move fee), and a record goes to Mongo
  `site_agent_refusals` (what was asked, steers, the last 8 context items clipped, the partial answer, OpenRouter's
  metadata; 90-day TTL; removed with the account) so the owner can see why. Browse it in dimadb. A refusal on Standard
  has no fallback (`model_refused`).
- Sessions live in Dragonfly, 72 h after the last activity, max 10 per person per channel. Private between the person and DomDimaBot's operators: nobody else on the channel (not even the owner for an admin's chat) can read them; the operator can, in the admin site (owner only), to help and to debug.
- Every change needs approval. The owner sees all assistant changes on the channel (who, what they asked,
  before → after) and can undo any; an admin sees and undoes their own. Change log kept 90 days (Mongo).
- Never: ban/timeout/raid/mod/vip, editors, billing, account deletion (only navigate there), bot on/off.
- Published to every channel on 2026-11-11 (`SITE_AGENT_CHANNELS = '*'` in config.ts), labelled "Experimental" in the
  panel (pill in the header, lab-gradient line on top, a note on the welcome screen). Setting a list there pulls it
  back to those channels (dark launch was the owner's channel, 533538623).

## Phase 0 facts (OpenRouter, `openai/gpt-6-luna`)

- `reasoning: {effort: 'xhigh'}`, `stream: true`, `usage: {include: true}`; provider "OpenAI", `usage.is_byok: true`.
- `reasoning_details` stream as fragments (`reasoning.summary` text pieces + one `reasoning.encrypted` with `id`):
  merge by (type, index) and send the merged array back on the assistant message.
- `usage.cost` = 0 (BYOK); real cost = `usage.cost_details.upstream_inference_cost`. Cached input:
  `usage.prompt_tokens_details.cached_tokens` (automatic, 75–87% on later steps). Reasoning:
  `usage.completion_tokens_details.reasoning_tokens`.
- Aborted stream: no usage chunk; `GET /api/v1/generation?id=` returns 404 for a few seconds, then the tokens and
  upstream cost (`cancelled: true`) after ~15 s.
- Last step with `tool_choice: 'none'` plus a system note forces a final answer.
- Typical answer: 11–43 s, $0.001–0.005.

## Claude Haiku 5.5 = Expert (OpenRouter `anthropic/claude-haiku-5.5`, checked 2026-11-13)

- Same Chat Completions request as Luna. `reasoning.effort` works (more thinking at higher effort, no 400s);
  `reasoning_details` come back as `reasoning.text` with a `signature` and are echoed like Luna's. With no
  `max_tokens`, output is not capped low (11k tokens in one reply).
- **Price:** $0.10 / $0.50 per M up to a 100k-token prompt, then 5× ($0.50 / $2.50). Cache reads $0.01, 5-minute
  cache writes $0.125. Hence the 100k limit. BYOK reports the real cost in `cost_details.upstream_inference_cost`;
  cache writes are in `prompt_tokens_details.cache_write_tokens`.
- **Tokens:** Claude counts the same text as ~1.8× Luna's tokens. The system prompt + Pro tools were 32.2k tokens
  on Haiku and 17.6k on Luna, so Haiku's 100k holds about as much as 55k on Luna. Our `estimateTokens` undercounts
  Haiku by ~38%, so the runner multiplies estimates by `modelTraits(model).tokenFactor` (1.5) before comparing with the
  limit. Within a turn the real `prompt_tokens` of the last step drive it, so compaction starts near 90k real tokens
  (about 83k at the start of a turn, when only estimates exist), below the price step. Claude's replayed thinking
  counts at the step's reported reasoning tokens (`reasoning.tokens`; Luna's encrypted item stays discounted).
  A Claude step whose usage never arrived keeps no thinking (it is not replayed, which is always accepted).
  The compaction summary is capped at 16k output tokens. If compaction fails, `dropOldest` removes older
  messages and then, if needed, the current request's own older tool rounds (a note says so; the request, every
  steer message and the newest round stay). For Claude, if the prompt that would be sent is still over the limit,
  the turn fails with `model_context_too_long` rather than paying the 5× rate (Luna keeps sending it).
- **Prompt cache:** Claude only caches at breakpoints. `requestBody` adds `cache_control` on the system text
  (shared by every chat with the same tools + prompt) and OpenRouter's top-level automatic `cache_control` (moves to
  the last message, so each step reuses the one before). Compaction calls send none (`promptCache: false`).
- **History-editing check:** a Claude thinking block is valid only while everything before it is unchanged
  (enforced for Anthropic accounts created on or after 2026-08-31; the owner's key was not enforced on 2026-11-13).
  Our history does change: compaction, a system prompt change (persona toggle, new docs index), a tool list change,
  and the unsaved last-step note. Each assistant step stores `reasoning.prefixHash` (sha256 of tools + messages
  sent); `toMessages` sends a Claude block back only while the prefix still hashes the same. Leaving reasoning out
  is always accepted. Luna is unchanged.
- **Refusals:** Haiku's safety classifiers can decline and Anthropic has no server-side fallback for Haiku, so we do
  it ourselves (see "Expert refusals" above). OpenRouter does not pass Anthropic's refusal category through; the
  record keeps what it gives (finish reasons, refusal text, `error.metadata`).

## Layout

```
src/site_agent/
  types.ts config.ts navigation.ts      contracts (owner: integrator)
  store.ts                               Dragonfly sessions, items, context, turns, events, leases
  runner.ts                              the agent loop: steps, tools, steer/stop/retry, approvals, forms
  context.ts                             prompt assembly, token estimate, compaction
  prompt.ts                              system instructions
  limits.ts access.ts                    daily limits; channel access + plan
  llm/openrouter.ts                      streaming client (+ cost, generation reconcile)
  usage.ts                               daily stats + Polar `ai_assistant` events
  docs/                                  docs section index, prompt index (≤10k tokens), hybrid search, read
  changes.ts changes.schema.ts           change log + undo
  tools/registry.ts                      registry, permission filter, validation, clipping
  tools/knowledge.ts                     search_docs, read_docs, search_ast_functions, test_command
  tools/read.ts                          channel overview, commands, timers, settings reads, chat, stream stats
  tools/ui.ts                            show_ui, navigate
  tools/write/*.ts                       commands, timers, settings areas (approval + undo)
  tools/stream.ts                        stream-visible / Twitch actions (approval every time)
src/server/routes/site-agent.route.ts    HTTP + SSE
```

## Storage (Dragonfly, keys in `config.ts` `SITE_AGENT_KEYS`)

- `site_agent:s:<sid>` session meta JSON; `:items` display transcript (list of `DisplayItem` JSON, tool results
  clipped); `:ctx` model context (`ContextItem[]` JSON, after compaction); `:queue` queued user inputs.
- `site_agent:sessions:<channel>:<user>` zset sid → updatedAt. Every write refreshes the 72 h TTL of all session keys.
- `site_agent:t:<tid>` turn JSON with `revision` (compare-and-set via Lua); `:ev` event stream (XADD, MAXLEN ~2000,
  2 h TTL) for SSE replay. `site_agent:lease:<sid>` = fencing token (PX 60 s, renewed every 15 s).
- `site_agent:active` set of turn ids that are queued/running/waiting (boot recovery).
- Mongo `site_agent_changes` (90-day TTL): change log.
- Mongo `site_agent_turn_logs` (90-day TTL, `turn_log.ts`): one row per finished turn for the operator (admin site,
  owner only): who, when, plan, level, models, status, error code, steps, daily messages used, tokens, cost, duration,
  rating, cost per model (`modelCosts`: a fell-back turn has two), **and, for 3 days, the exchange as text** (the
  dashboard tells people "Chats are kept for 3 days", so `clearExpiredTurnText` blanks the text 3 days after the
  message and sets `textCleared`; the numbers stay the full 90 days): the message (4,000),
  the last 10 steers (2,000 each), the answer (the turn's assistant items joined with blank lines, 12,000; empty
  when the chat was already deleted), and each tool's name, end state, arguments and result (2,000 each). Every text
  is scrubbed over a wider window, then clipped by code points: message, steers and answer with `scrubSensitive`,
  tool arguments and results with `scrubMaybeJson` (JSON values under secret key names too) on the whole text
  (`utils/scrub_text.ts`: tokens, keys, JWTs, webhook paths, URL credentials, e-mail addresses). Never proposal
  payloads, undo data or page titles (only the route key); a `show_ui` form's submitted values are not kept (its
  result is stored as `[form submitted]`). Inserted once after the turn ends, without waiting (a failure is logged,
  never retried), and only while the channel's account and, for a manager, the requester's account exist; a rating
  given before the insert is read from `site_agent:feedback:<turn>`. A cost reconciled later is keyed by its step
  (Polar external id) and recorded in `reconciledSteps`, so a step is added once; until it is on the row it waits in
  the hash `site_agent:turnlog:late:<turn>` (1 day; retry index `site_agent:turnlog:late`, a sorted set, oldest
  attempt first, 50 a tick, one pass at a time). A waiting step is removed only once the row lists its key, and is
  retried every 30 s until then. Account deletion stops the person's queued or running turns (like Stop), then
  removes the channel's rows and the person's rows on other channels, with a second pass 15 s later. Its cost is the day
  stats' cost (`effectiveCostUsd`: provider + OpenRouter fee), and so is the turn's own `usage.costUsd`.
- `site_agent:limit_hits:<day>` hash channel → messages refused for the daily limit (120-day TTL).

## HTTP API (`/agent/:channelID`, `authMiddleware`, envelope `{error, message, status, data}`)

| Method + path | Body | Result |
|---|---|---|
| `GET /status` | | `{enabled, role, limits: LimitsView, contextLimit}` |
| `GET /sessions` | | `{sessions: SessionMeta[]}` (own sessions only) |
| `GET /sessions/:sid` | | `{session, items: DisplayItem[], activeTurn: TurnSnapshot \| null}` |
| `PATCH /sessions/:sid` | `{title}` | `{session}` |
| `DELETE /sessions/:sid` | | `{deleted: true}` (stops its active turn) |
| `POST /messages` | `{sessionId?, text, mode: 'send'\|'steer'\|'queue', page: PageContext, lang: 'en'\|'es', clientRequestId}` | 202 `{sessionId, turnId, limits}` |
| `GET /turns/:tid` | | `TurnSnapshot {turnId, sessionId, status, inputRevision, cursor}` |
| `GET /turns/:tid/events?after=<cursor>` | | SSE: `id: <cursor>`, `event: <AgentEvent.type>`, `data: <json>`; `event: resync` when the cursor is gone; ends after `done`; `: ping` every 15 s |
| `POST /turns/:tid/stop` | | `{status}` |
| `POST /turns/:tid/retry` | `{clientRequestId}` | 202 `{turnId}` (failed/cancelled/interrupted only; not counted) |
| `POST /turns/:tid/approvals/:callId` | `{decision: 'apply'\|'skip'}` | `{state}` |
| `POST /turns/:tid/ui/:callId` | `{values}` | `{state}` |
| `POST /turns/:tid/feedback` | `{helpful}` | `{recorded}` |
| `GET /changes?before=<cursor>` | | `{changes: ChangeView[], next}` (owner: all; admin: own) |
| `POST /changes/:id/undo` | | `{change}`; 409 `undo_conflict` with what changed |

All POSTs carry `clientRequestId` (idempotent per user, 10 min). `send` with an active turn → 409 `turn_active`
(client switches to steer/queue). The model and the browser never choose the channel: it comes from the URL and the
access check (`dashboard:view`); every session/turn/change id is checked against requester + channel.

## Runner semantics (SAM-style)

Per turn: claim lease + fence → loop steps (max 30 model steps, 40 tool calls, 10 min active time):
1. Apply pending steer inputs (append user context items, emit `update`), stop if `stopRequested`.
2. Compact if the prompt estimate (last step's real `prompt_tokens` + new items) ≥ 90% of the plan limit.
3. Stream the model with the tools the requester may use (filtered by ALL permissions + plan). Last step (or out
   of active time): `toolChoice: 'none'` + note.
4. Text streams into an assistant item (`final: false`); if the step ends with tool calls, that text stays as a
   progress note. A steer aborts only this stream: its tool calls are dropped, usage reconciled, loop continues.
5. Save the assistant context item (content, tool calls, merged reasoning), record usage (stats + Polar).
6. Run tool calls one by one. Before each: stop/steer check (a newer `inputRevision` marks the rest
   `superseded`). Permissions re-checked per call. Results clipped to 16 KB and saved before the next call.
   - `approval`: turn → `awaiting_approval`; card shows title/target/before/after/effects. Wait ≤15 min (not
     active time). Apply: re-check permissions, `tool.apply` (compare-and-set) → change log → result to model.
     Skip/expiry/steer/stop → result says not applied. An approval is bound to the call id + inputRevision.
   - `ui` with `waitForInput`: turn → `awaiting_input`, same wait rules; submitted values go to the model.
   - `navigate`: emitted to the browser; `go` navigates now, `offer` shows a button.
7. No tool calls → final answer; `done`. Then the next queued input (if any) starts a new turn.

Race rules (from review): after Apply, the runner re-checks permissions and then atomically moves the approval
`approved → applying` only if the turn is still active, not stopped, on the same `inputRevision` and fenced by
this process's lease; otherwise nothing is applied. A change that applied stays "applied" even if writing the
change log fails; a write that takes over 120 s is reported as "outcome unknown" (never "not applied") and still
gets its log entry if it finishes later. A turn never completes while a steer input is pending (the loop answers
it). Sends claim the session with compare-and-set (two quick sends → one 409). A queued message that lands after
the answer finished is started by the request itself. Turn/context writes check the lease token in the same Lua
script; renewals failing for ~45 s stop the turn. Active time excludes approval/form waits; the tool-call budget
is checked per call. A stream that fails after starting a generation is still reconciled for usage.

Stop: abort the stream and tools (cooperative), save partial text, reconcile usage via `/generation`. An effect
already started may finish; report its real result. Boot recovery: turns in `site_agent:active` whose lease expired
→ `interrupted`; calls without a saved result → "result unknown", never re-run. Retry (manual) starts a new turn on
the same context. Events are saved before they are sent; reconnect = snapshot + `after=<cursor>`.

## Tools

- Docs: the prompt holds an index (≤10k tokens, `docs/prompt_index.ts`); `search_docs` is hybrid (BM25F + lfm2
  embeddings in batches of ≤8, cached per chunk by content hash, keyword-only fallback); `read_docs` returns one
  section or a whole topic, paged (~8k tokens per page, `resultBytes` 32 KB). Section ids = page path + the docs
  site's own heading anchors (github-slugger), e.g. `/tts#choose-a-voice-engine`, `/es/tts#…`, `#_top` = intro.
- Definition: `AgentTool` in `types.ts`. Names are snake_case. Descriptions are written for the model: what it
  does, when to use it, limits. `permissions` = ALL required, mirroring the route that the page uses for the same
  action (look it up in the route file; never guess). Plan gates mirror the feature's own gate.
- Tools never read or return secrets (tokens, keys, emails of others, overlay tokens).
- Read results are data: chat messages, command bodies, viewer names and descriptions come wrapped as
  `{"untrusted_data": ...}` so the prompt can tell the model not to follow instructions inside them.
- Write tools: `run` validates and returns `{type: 'approval', proposal}` (no side effects); `apply` performs it with
  compare-and-set against `payload.expected` and throws `ToolConflictError` if the target changed; returns a
  `ChangeRecordInput` with `undo` data; `undo` restores it only if the current value still equals `after`.
  Reuse the same service functions the routes use (extract them from route handlers where needed, keeping the
  route's behavior identical). Never call a GET route that creates defaults.
- Compare-and-set must be part of the database write itself (expected values in the update filter, or the
  area's revision/If-Match), never a JS check followed by an unconditional save; only the fields the proposal
  changes are written. Exceptions, stated on the proposal: Twitch-side writes (rewards, stream info, polls,
  predictions) have no conditional form, and a chat-event delete unsubscribes on Twitch before removing the row.
- Effects: for anything holding a command body (commands, timers, roulette winner actions, chat events), run it
  through `utils/ast_parser/simulate.ts` and list recorded actions in plain words on the proposal.
- Repeating messages follow the website's model (`tools/write/repeat.ts`), since 2026-11-11: the Commands page
  lists a repeat only as a command plus the timer named like it (message = a copy of the reply, `#(name)` for
  block commands; dimasite `syncCommandTimer`). So there is no `create_timer` any more: `create_command` /
  `update_command` take `repeatMinutes` (0 = stop), and a rename, a new reply or a delete moves the timer in the
  same change. First real use had created a stand-alone "referral" timer the owner could not find on the page.
  - Linking is resolved like the page (`commandRepeat` / `timerCommand`, and `repeatLinks` in read.ts): the timer
    named like the trigger, else (older data) like the display name unless that word is another command's
    trigger. Keywords and built-in commands have no repeat.
  - `moveRepeat(from → to)` is ONE guarded write: create (already on or off), edit in place (interval, message,
    on/off and name together) or delete. `timer_manager` got additive options for that (`createTimer`
    `{active, restore}`, `updateTimerIfUnchanged` `name`). A ToolConflictError from it means it wrote nothing; any
    other error means unknown. A write that fails after landing (stored, then the live cache fails) is recognised
    by reading the timer back; it counts as done only after `syncTimerCache` repaired the cache (the timer worker
    reads only that cache while live), otherwise the outcome stays unknown.
  - Order in apply and undo (`changeWithRepeat`): the repeat first, then the command write. If the service
    refuses the command write, the repeat is moved back with a guarded write and the refusal is passed on, so
    "Not applied" always means nothing changed. If it cannot be moved back, or the command write's outcome is
    unknown, the error is a plain one (the card shows "outcome unknown"). Never roll the command back instead:
    that write could cover someone's edit.
  - A proposal that depends on the repeat (new reply, new name, delete) records what it saw, also "none", and
    Apply refuses if that changed, including which timer is the command's repeat now (`assertRepeatLink`).
    Timers are compared by content, not by id (undoing a removal re-creates the timer); the write is still
    guarded by the row just read.
  - A change that only moves the repeat has no command write to carry a guard, so the command is read again
    after the repeat was written (`unchangedCommand`); a command deleted or edited in between moves the repeat back.
  - Undo data keeps the command's repeat as the change left it (`repeatAfter`, also "none"). An undo that
    deletes, renames or re-words the command is refused while the repeat differs from that (a later change added
    or changed it): undo the newer change first. Records from before this was stored are refused while the
    command has a repeat. An undo of only cooldown, access, on/off or description does not look at the repeat.
  - `update_timer` / `delete_timer` remain for pausing or re-timing a repeat and for stand-alone timers made in
    chat (`!cct`), which the Commands page does not list: reads mark them (`command: null`), their cards say so.
    `create_timer` is kept undo-only (`registry.getUndoTool`) for changes already in the log.

## MCP surface

The tool registry is shared with MCP. `surfaces` controls where a tool is available; `executableFields` identifies command-language text that MCP must check before applying a write. A read result may set `billable: false` when it should not be charged. Add every new site tool to `MCP_ALLOWLIST` or `MCP_EXCLUDED` in `tools/mcp.ts`; a test enforces the classification. See [MCP.md](./MCP.md) for execution, safety and billing.

## Frontend (dimasite `src/app/features/assistant/`)

- `assistant-root` is mounted once in `AuthenticatedLayoutComponent` (hidden in Overlay Studio focus mode); shows
  nothing unless `GET /status` says `enabled`.
- Mascot: the docs character (port of `dimadocs/src/components/MascotFigure.astro` + states). Docked bottom-right;
  tap opens the panel. Guide = a fixed full-screen overlay layer with `pointer-events: none`: the figure flies
  (transform only) to `[data-assistant-anchor="<key>"]` and a highlight ring follows the element's rect (scroll,
  resize, route change). No DOM moves, no layout shift, never blocks clicks. Reduced motion = no flight.
- Panel: side panel on desktop (page stays usable), bottom sheet on phones (shrinks to a peek bar after
  navigating). Session list, messages, status line, tool rows, approval cards, UI frames, navigate cards, composer
  (Send; while a turn runs: Steer by default + "Queue for after"), Stop, Retry, feedback, messages left, Changes tab.
- UI blocks (`show_ui`): sandboxed iframe (`sandbox="allow-scripts"`, opaque origin, CSP from
  `features/overlays/widget-runtime/frame-document.ts` `restrictedPolicy`: no network, no frames, no forms) with
  site theme tokens + a small UI kit (Live First styles, `dima.chart`). Bridge (postMessage with a per-frame
  token): `dima.submit(values)`, `dima.resize()`, `dima.navigate(routeKey)` (checked against the route list),
  `dima.theme` / `dima.onTheme(cb)`. A frame can never apply a change.
  Hardening (from review): the card runs page → relay frame (our code, `frame-src 'none'` so a card can't navigate
  data out) → card frame. The kit removes its own `<script>` (it holds the bridge token) before the card's code
  runs. `submit`/`navigate` need real user activation, checked by the kit and again by the page
  (`navigator.userActivation`, which a click inside the card propagates up). No nested frames: `createElement`
  refuses frame tags, `attachShadow`/`setHTMLUnsafe` are off, frame URL setters are no-ops and a MutationObserver
  removes any parser-inserted frame before it loads (a nested realm would get WebRTC back); the API also rejects
  frame tags in `show_ui` HTML. Cards carry a native "Made by the assistant" label outside the frame.
- Navigation: Angular Router, keys from `assistant-routes.ts` (mirror of `navigation.ts`), always under the current
  streamer.
- Pages hear about changes: when a card becomes applied (or its outcome is unknown) or a change is undone, the
  store calls `AssistantPresenceService.notifyDataChanged(area)`, which bumps a per-area revision. A page that
  shows that area compares `changedAt(...areas)` with the revision it last loaded and reloads past its cache
  (Commands page: `commands` and `timers`; it waits while one of its own saves is pending and keeps pending
  rows when a fresh list arrives). Other pages still need a manual reload; add the same effect when one is
  reported.
- en + es-MX, dark first, mobile first, Live First, `appThrottleClick` on action buttons.

## Host rules for anyone building this

- Work only in `/root/worktrees/site-agent` (branch `feat/site-agent`). Never edit `/root/saas` (production checkout).
- Never run two Angular builds at once on this host; wrap every Angular build/test in
  `flock /root/worktrees/.site-agent-ng.lock systemd-run --scope -q -p MemoryMax=5G -p CPUQuota=400% nice -n 10 …`.
  Wrap full backend `tsc` in `flock /root/worktrees/.site-agent-tsc.lock …` too. No watch builds.
- Backend tests: `cd dimabot && node --experimental-test-module-mocks --import tsx --test <files>`.
- No real provider calls, no production data writes, no deploys, no commits (the integrator commits).
