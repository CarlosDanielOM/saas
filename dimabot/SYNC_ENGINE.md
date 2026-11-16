# Live sync engine (proposal, not built)

Status: planning (2026-11-16), revised after GPT-6.1 Sol's second review the same day. Nothing here exists yet. The
owner's open decisions are at the end.

## What it is for

When anything saves data shown on a page, every open page and OBS source showing that data updates without a reload:

- the streamer has two tabs of the same page (or the Studio in two tabs) and saves in one;
- the owner edits a channel from the admin site while the streamer looks at that page;
- an MCP client or the site assistant changes something;
- the bot or a cron worker changes data a page shows (for example, a chat command that changes the TTS voice);
- a streamer publishes mid-stream: OBS sources pick it up at their next safe moment.

Today, pages and OBS sources read data once when they load. The only live path is Overlay Studio publishing: the one-second
loop in `src/overlays/live/connections.live.ts` re-reads each published overlay that has an open source.

## Design

The engine sends a notice, never data: "`tts.settings` of channel 533538623 changed". Pages watching that resource fetch it again
through the endpoint they already use, so permissions, validation and response shapes stay where they are.

```
MongoDB (single-node replica set) ── change stream ──▶ every API server: map collection → resource + channel
                                                         └─ /sync rooms "<resource>:<channel>" ──▶ watching pages
page: notice → refetch (debounced); also on (re)connect, on becoming visible, and every few minutes as a safety net
```

- **Change source: MongoDB change streams.** They report every committed write, from the API, the bot, cron workers,
  the dimadb console and native-driver code alike, and only after a transaction commits. A Mongoose middleware layer
  was considered and rejected as the main source: it would have to be registered before any model compiles in every
  writer process (the API imports its routes before initialising; cron runs separate worker processes), and query
  middleware cannot reliably name the channel for `updateMany`, deletes, `_id`-only updates (`trigger.route.ts`
  `findByIdAndUpdate`) or multi-channel updates (`follow_defense_actions.ts`). Change streams need MongoDB to run as a
  single-node replica set (see "Infrastructure release").
- **Mapping** (`src/sync/resources.ts`, server-only): per collection, how to find the channel (`channelID` field, `_id` =
  channel, or a lookup) and which resources a change affects. A change whose channel cannot be found invalidates
  conservatively (every watcher of that resource) rather than being dropped. Deletes use pre-images where the
  collection needs them (`changeStreamPreAndPostImages`), or an `_id` → channel mapping. One endpoint can depend on
  several collections (TTS settings also read Fish voice favorites and the user record), so the mapping lists read
  dependencies per resource rather than listing one model per resource. Dragonfly-only data (for example, moderation's
  read-through cache) is not page data; caches are never a change source.
- **Each API server** opens its own change stream and forwards to its own sockets: no shared server state, no Socket.IO
  adapter for this path. It persists its resume token after processing (Dragonfly), tolerates duplicate replays, and if
  the token is too old because the oplog rolled over, it tells its watchers to refetch everything.
- **No server-side version counters.** Clients do not compare versions; they refetch on a notice, on (re)connect, when
  the page becomes visible again, and every few minutes while visible. A lost notice therefore costs at most one
  safety-net interval, never a permanently stale page.
- **Portable registry** (`src/sync/topics.ts`, shared to the site by `scripts/sync-overlay-widget-contract.mjs`): topic IDs
  and the permission each needs, reusing `AREA_VIEW_PERMISSIONS` (`src/site_agent/tools/mcp_changes.ts`) and
  `CHANNEL_ADMIN_PERMISSIONS`. Server-only mapping stays out of the shared file.

## The `/sync` namespace

- Session token in the handshake, validated exactly like HTTP (`authMiddleware` semantics); invalid or expired tokens
  disconnect. `watch(topic, channel)` accepts only registry topics and requires
  `getChannelAccessDecisions(...).permissions[topic.permission] === true`. Permissions are re-checked every few minutes
  and on token expiry; revoked watches are removed.
- Connection-state recovery is off for `/sync` (`src/pets/socket_adapter.ts` gives it the plain adapter, as for the pet
  namespaces): the global recovery would restore rooms without re-running authorization. A reconnect re-watches and
  refetches.
- Limits: watches per socket, sockets per principal, watch rate, concurrent authorization checks; duplicate watches
  are merged; dropped notices and reconciliations are counted in telemetry.
- Notices carry topic and channel only. No actor (pages say "Changed elsewhere"), no data, no draft details.

## Pages (site and admin)

`SyncService` (one socket per tab) and a helper `syncedResource({ topic, channel, load, editGeneration })`:

- **Subscribe before loading.** A notice that arrives while a load is in flight marks the resource as remotely changed and
  triggers one more load after the current one; responses carry a request sequence number and an old response never replaces a
  newer one; responses for a previous channel are discarded.
- **Unsaved edits are checked when a response arrives, not when the request starts.** If the user edited the form meanwhile, the
  response is kept aside and the page shows "Changed elsewhere: Load the new version / Keep editing". A failed
  background refresh never clears the form (the current TTS loader clears the form and baseline on failure:
  `features/tts/tts-page.component.ts`).
- **Keeping one's own version is only offered for resources with a revision.** Most settings endpoints are
  last-write-wins (the TTS page's PUT has no revision; `saveChannelTtsSettings`). Each resource gets a revision and
  compare-and-set support in all its writers when it joins the engine; until then the page offers only "Load the new version"
  or an explicit "Overwrite with mine" that says what it does.
- A page that has not joined works exactly as today.

## OBS pages (public)

- An OBS page watches only its own published overlay, by public ID. The server resolves the public ID, checks that it is
  published and that the account exists (`publicState`, `src/overlays/store.ts`), and subscribes it to that scene's
  published-copy topic only. Draft saves never notify public watchers (the server compares the published revision before
  notifying). Rotation, unpublishing, deletion and account removal disconnect existing watchers.
- In `connections.live.ts`, only the published-overlay re-read moves to notices; the loop keeps its other jobs (queue
  controls, revocation, activation retries, widget refresh, alerts) and a slow fallback re-read.
- Each OBS page applies a change at a safe moment (between alerts, between duel runs) with a maximum wait, so a long
  animation cannot postpone it forever.

## Infrastructure release (before the engine)

Converting MongoDB 8.2.6 (`/root/databases/docker-compose.yaml`, auth on) to a single-node replica set:

- verified backup and a written rollback (restart as standalone on the same data);
- `replSetName` plus a keyFile (owned by the mongodb user, mode 400) because auth is on;
- a member hostname every client can reach (containers use `mongodb`; host-side tools need `directConnection=true`);
- `rs.initiate()` with a privileged user, wait for PRIMARY, then check every client connects (API, bot, cron, dimafx
  server, dimadb, analytics, host scripts);
- budget for a few minutes of database downtime, oplog disk space and I/O; a single node adds no redundancy;
- transactions start working: code that falls back when transactions fail (for example `utils/follow_ledger.ts`
  `withTransaction`) takes the transactional path from then on and must be tested on a disposable replica set first.

Reviewed and released on its own, at a quiet time, with the owner's go-ahead.

## Multiple API servers later

The engine path is stateless. The rest of the real-time code is not: the Overlay Studio delivery queues and leases
(`src/overlays/live/`), TTS queue owners and the legacy socket namespaces keep per-server memory. Before adding a second API
server, the following are needed: Socket.IO Redis adapter for the remaining namespaces, websocket-only transport or sticky sessions in Nginx Proxy
Manager, per-channel Dragonfly locks for background loops, and the live queues in shared storage. A separate project.

## Phases

1. Infrastructure release (above).
2. Vertical slice, one release (API + site): change-stream consumer and mapping for TTS settings and its dependencies,
   `/sync`, `SyncService` + `syncedResource`, TTS settings revision + compare-and-set on every writer (page, assistant,
   MCP, the bot's voice command). Checks drive each real writer, two tabs with unsaved edits, edits during a load, a
   failed refresh, access revoked while watching, a token too old to resume, and two API processes.
3. Admin consumers: owner-console pages that show data the engine covers.
4. The other areas, a few per release, each with its revision and a two-tab check.
5. Overlay Studio (two tabs; then OBS publish notices), then duel, roulette, widgets, pet and DimaFX OBS pages.
6. Only when a second API server is needed: the multi-server items above.

## Open decisions (owner)

1. **Change source.** Recommended: change streams, after the infrastructure release (complete coverage, the
   infrastructure change described above). The alternative is a Mongoose middleware pilot without infrastructure changes,
   explicitly best-effort (known gaps: `_id`-only and multi-channel updates, native-driver writes, separate processes).
2. **First page.** TTS settings (base settings first; favorites and status after)?
3. **Overwrite.** Until a resource has a revision, offer an explicit "Overwrite with mine", or only "Load the new
   version"?
