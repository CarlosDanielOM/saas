# Site agent ("Dima assistant")

An AI assistant inside dimasite's logged-in pages (`/:streamer/...`). It answers from the docs, knows the channel,
and can change things for the streamer after they approve. Opened from the mascot. Model: GPT-6 Luna (`xhigh`)
through OpenRouter on the owner's OpenAI key (BYOK). Free for now: no AI credits; usage goes to Polar as
`ai_assistant` events. Contracts: `src/site_agent/types.ts`, `config.ts`, `navigation.ts`.

## Product rules (owner decisions, 2026-11-11)

- Everyone with website access to the channel (owner, admins with `dashboard:view`) can use it, on every plan.
- Daily limit per **channel** (owner + admins share it), per UTC day: free 20, premium 80, pro 400 **user messages**.
  One message = 1 no matter how many tool calls. Steer and queued messages count; approvals, form answers, Stop and
  retries after our own errors don't. No global spend cap for now.
- Context limit by the channel's plan: free 100k, premium 256k, pro 256k tokens; compaction at 90%.
- Sessions live in Dragonfly, 72 h after the last activity, max 10 per person per channel. Private to the person.
- Every change needs approval. The owner sees all assistant changes on the channel (who, what they asked,
  before → after) and can undo any; an admin sees and undoes their own. Change log kept 90 days (Mongo).
- Never: ban/timeout/raid/mod/vip, editors, billing, account deletion (only navigate there), bot on/off.
- Published only when everything is done; until then `SITE_AGENT_CHANNELS` (config.ts) limits it to the owner's channel.

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
- en + es-MX, dark first, mobile first, Live First, `appThrottleClick` on action buttons.

## Host rules for anyone building this

- Work only in `/root/worktrees/site-agent` (branch `feat/site-agent`). Never edit `/root/saas` (production checkout).
- Never run two Angular builds at once on this host; wrap every Angular build/test in
  `flock /root/worktrees/.site-agent-ng.lock systemd-run --scope -q -p MemoryMax=5G -p CPUQuota=400% nice -n 10 …`.
  Wrap full backend `tsc` in `flock /root/worktrees/.site-agent-tsc.lock …` too. No watch builds.
- Backend tests: `cd dimabot && node --experimental-test-module-mocks --import tsx --test <files>`.
- No real provider calls, no production data writes, no deploys, no commits (the integrator commits).
