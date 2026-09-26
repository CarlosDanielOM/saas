# Roulette backend v1

The `roulette` module persists saved roulettes, individual multiplier copies, order,
settings, overlay state and server-selected draw results. The Pro-only Alpha dashboard supports wheel, cards and reel designs, with a
read-only OBS renderer. Cards remain stationary and highlight random positions
before settling on the server-selected winner.

## Ownership and storage

Management endpoints are mounted at `/roulettes/:channelID`. They use the normal
Bearer account authentication and require the authenticated Twitch ID to match
`channelID`. V1 does not grant management through another module's permissions.
AST uses its execution context's broadcaster ID and the existing authored-command
permission model. AI-invoked mutations require user level 7; `result` is read-only.

Mongo collection `roulette_channels` holds one versioned document per channel.
Every mutation uses compare-and-swap on `revision`; draw selection, snapshot,
visibility and subsequent winner removal commit atomically. No replica-set
transactions or Redis locks are required. Up to 20 roulettes and 4 MiB of state per
channel are supported. History retains the latest 100 completed draws per channel.
The collection and its deadline index are created by the application model.

Roulette IDs, item IDs, draw IDs and copy keys are UUID hex strings without hyphens,
so they remain single unquoted AST arguments. A roulette also has a
channel-unique alias matching `[a-z][a-z0-9_-]*` (40 characters maximum). API and AST
roulette references accept IDs or aliases; item operations require an item ID.
Quote aliases containing hyphens because the AST parser treats hyphens as operators.

## Management API

Responses follow `{ error, message, status, data }`. Error responses include a
stable `code`. Mutations return `{ revision, result, replayed }`; `result` is the
created/affected ID, or an empty string for visibility changes. Fetch the snapshot
after editing. Snapshots and token responses use `Cache-Control: no-store`.

| Method | Suffix after `/roulettes/:channelID` | Body / result |
| --- | --- | --- |
| GET | `/` | Full management snapshot: roulettes, activeId, visible, draw, history, hideAt, revision, serverTime |
| POST | `/roulettes` | Create from `{name, alias, ...configuration}`; returns roulette ID |
| PATCH | `/roulettes/:roulette` | Partial configuration |
| DELETE | `/roulettes/:roulette` | Delete saved roulette; deleting active roulette clears/hides overlay |
| POST | `/roulettes/:roulette/items` | `{label, multiplier?: 1, weight?: 1, action?: ""}`; returns item ID |
| PATCH | `/roulettes/:roulette/items/:item` | Partial `{label, multiplier, weight, action}` |
| DELETE | `/roulettes/:roulette/items/:item` | Remove all copies of the item |
| POST | `/actions/show`, `/actions/hide` | `{}`; visibility only |
| POST | `/actions/start` | `{roulette?: idOrAlias, user?: twitchLogin}`; defaults to active and streamer; returns draw ID |
| POST | `/actions/switch` | `{roulette: idOrAlias}`; preserves visibility |
| POST | `/actions/shuffle` | `{roulette?: idOrAlias}`; defaults to active |
| POST | `/overlay-token` | Rotate token; returns token once and Socket.IO namespace |
| GET | `/overlay` | Read-only token Bearer authentication; returns overlay snapshot |

Mutation requests may supply `If-Match: <revision>` to reject stale editor saves
with `409 revision_conflict`. They may supply `Idempotency-Key` (1–128 characters).
The last 200 successful keys per channel are retained for up to 24 hours. Retrying
within that window returns the original result without repeating the mutation;
reusing a key with different arguments returns `409 idempotency_conflict`. Clients
should reuse the same key after a timeout. Token rotation is intentionally separate
and not idempotent: a new rotation invalidates the previous token.

Example creation body:

```json
{
  "name": "Community prizes",
  "alias": "giveaways",
  "design": "reel",
  "durationSeconds": 4,
  "colors": ["#f4b942", "#ef7d5a"],
  "settings": {
    "insertion": "append",
    "duplicate": "separate",
    "shuffleBeforeDraw": false,
    "showOnStart": true,
    "hideAfterSeconds": null,
    "winnerAction": "keep"
  }
}
```

`design`: `wheel|cards|reel` (default wheel). `cardSize`: `large|medium|small`
(default large). Duration is an integer 1–120 seconds. Colors are 1–12 hex colors.
Names/labels contain 1–120 characters. Weight and multiplier are positive safe
integers; total weighted tickets must also fit a safe integer. Weight affects
selection only. Multiplier creates separately identified copies in `order`.

Capacity is 10,000 copies for wheels, 60 for reels, and 50/75/100 for large/medium/
small cards. Invalid additions or design changes reject the entire mutation.

`insertion=random` inserts each new copy independently without reordering existing
copies. `duplicate=increase` merges the first exact matching label; conflicting
weights or explicitly different actions reject the addition so an increase cannot
silently change existing odds or scripts. Omitting action preserves the existing script.
The default creates a separate item even when labels match. Multiplier updates
preserve surviving copy keys and create/remove only the difference.

## Draw lifecycle

`start` validates capacity, optionally shuffles, uses cryptographic rejection
sampling to pick a weighted copy, and atomically saves the immutable draw. The
snapshot includes exact ordered slots, winner key, presentation, start/end times,
and the winner/auto-hide policy chosen at start. All consumers use this draw;
clients must never pick their own result.

While spinning, item edits affect the next draw; the current snapshot is frozen.
Start, switch, shuffle, configuration changes and roulette deletion return
`409 spinning`. Show/hide remain available; hiding never cancels a draw.

The cron supervisor runs `roulette-completion` every second. It completes due
draws, records history and applies `keep|remove-copy|remove-item` once in the same
atomic write. Remove-copy targets the saved copy UUID, so manually removed copies
are not removed twice. Completion does not depend on OBS or a browser callback.
Reads/mutations also settle elapsed deadlines to recover immediately after downtime.

`hideAfterSeconds` is null (stay visible) or 1–3600 seconds after the draw's end.
Show/hide after completion cancels a pending hide deadline. Switch clears the old
draw display/deadline while preserving visibility. Starting with `showOnStart=false`
preserves visibility. Empty roulettes cannot start.

## Winning item actions and target users

Items may have an optional `action` AST script (maximum 8,000 characters). Empty
text clears it. The owner-only API validates AST syntax before saving. The script
runs once for the winning item, regardless of its multiplier, after the draw ends.
For example:

```text
$(user), no speaking for 5 minutes! $(timer 300 $(user), you can speak again.)
```

This example announces the restriction and a later reminder; it does not itself
apply a Twitch timeout. Existing AST functions and command references are available.
Scripts run with the owning streamer's authoring authority, while user expressions
refer to the saved target. `roulette_id`, `roulette_draw_id`, `roulette_item_id` and
`roulette_item` are supplied as AST context variables.

`$(roulette.start ...)` saves the initiating execution context's user ID, login,
display name and original argument. This applies equally to commands and event
triggers (bits, subs, follows, etc.). Manual dashboard starts accept an optional
Twitch username, resolved server-side; blank uses the streamer. When an automated
context has no user, the streamer is the fallback. Timers retain this target context.

The winning script and target are frozen in the same atomic write as the draw.
Editing or deleting an item during animation affects future draws. Scripts are
stored privately, never in visual slots or OBS snapshots. A separate supervised
`roulette-actions` worker settles completion before executing due scripts. Actions
remain pending through downtime and do not depend on an open browser.

The worker durably claims an action before evaluating it. Claims are never retried:
this gives at most one attempt, not guaranteed exactly-once external effects. If the
process stops after claiming, the action remains marked started and may not finish.
Completed or failed scripts are not automatically repeated. A Pro downgrade before
dispatch skips the action. Existing timer behavior applies after a timer is scheduled.
Management snapshots include `actionRuns: [{drawId, status}]`, where status is
`pending|running|done|failed|skipped`; the dashboard shows it beside draw history.

## OBS transport contract

Connect Socket.IO to `/overlays/roulette/:channelID` with `auth: {token}`. The token
is random, read-only, and stored only as a SHA-256 hash. Rotation disconnects existing
subscribers on their next revision poll and rejects subsequent HTTP/socket reads.
Tokens cannot authorize management API calls. The frontend should put the token in
its URL fragment and pass it in the Socket.IO auth payload, not a server query string.

The backend emits `roulette-state` with:

```text
{ revision, serverTime, visible, roulette, draw, hideAt }
```

`roulette` is only the active saved configuration (or null), never the full library.
Item scripts and action execution context are stripped from overlay responses.
`draw` is the latest active draw snapshot, with `completedAt=null` while spinning.
Render `draw.slots` during a draw, not the mutable `roulette.items`. Use `serverTime`
to align animation timing; reconnect mid-spin resumes the same draw, while an
elapsed draw shows its completed winner without spinning again. Copy identity is
`slot.key`; `slot.copy` is the display ordinal captured for that draw. Hidden state
must render transparent. Use monotonically increasing revisions to discard stale
updates. `roulette-error` signals transient storage unavailability; do not invent a
winner locally. No socket events can mutate state.

One 500 ms revision poll is shared per connected channel. Changed revisions trigger
fresh authenticated snapshots. Socket.IO session replay is disabled for roulette
namespaces so reconnects cannot bypass token revocation; polling the persisted revision recovers notifications
across API/bot/cron processes and reconnects without depending on lossy pub/sub.

## AST

```text
$(roulette.add giveaways "VIP for a day" 3 10)
$(roulette.remove giveaways item_id)
$(roulette.update giveaways item_id 5 10)
$(roulette.shuffle giveaways)
$(roulette.switch giveaways)
$(roulette.show)
$(roulette.hide)
$(roulette.start)
$(roulette.start giveaways)
$(roulette.result giveaways)
```

`add`: multiplier then weight, both optional and default 1. Quote multiword labels;
labels produced by nested AST expressions remain one evaluated argument. To set
only weight, explicitly pass multiplier 1. `update` requires multiplier and keeps
the existing weight when omitted. `result` defaults to active and returns the most
recent completed winner label, or empty text if none exists. `add` returns the item
ID (capture in a variable if chat output is unwanted); other mutations return empty
text on success. Failures return `Error: roulette.<action>: ...`.

Each AST invocation is an intentional action. AST does not infer idempotency from
label or message text; the existing command/trigger caller controls invocation.
The registry metadata and generated AST catalog include all nine functions.

## Verification and deployment

Run `tsx --test src/roulette/model.test.ts` from dimabot for draw engine tests.
Use `scripts/saas-ops` targets `api`, `bot`, and `cron` because all three execute AST,
and the API owns the transport while cron owns completion. For each candidate:

```sh
scripts/saas-ops verify RUN --dependency mongo --dependency redis \
  --fixtures ops/checks/roulette-fixtures \
  --test-env ops/checks/roulette-fixtures/test-env.json \
  --check ops/checks/roulette-backend.mjs
```

The check exercises real HTTP authentication, quoted AST parsing, concurrent starts,
idempotent retry after completion, reconnects, token revocation, durable process
recovery, capacity rejection and individual-copy removal with disposable data.

## Alpha access

Roulette is currently exclusive to Pro broadcasters. Account APIs, AST operations (including result), and overlay authentication check the owning Twitch account’s `plan_tier`. Existing overlay connections disconnect after a downgrade. Saved roulettes remain intact, and already-started draws still settle through the completion worker.

The dashboard lives at `/:streamer/modules/roulette`; the OBS browser source is `/overlays/roulette/:channelID#TOKEN`. Its private token is stored only on the generating browser for later copying; replacing it revokes old links. During Alpha, management is owner-only.
