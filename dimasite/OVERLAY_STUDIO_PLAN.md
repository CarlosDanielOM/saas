# Overlay Studio Alpha

The production editor lives at `/:streamer/modules/overlays`. It is marked Alpha and
requires the channel owner's Pro plan. Management requests enforce both ownership
and entitlement on the server. Published browser sources check Pro on connection,
HTTP reads, and while connected. The earlier mock remains at `/mocks/dev/overlay-editor`.

## Documents and publishing

Mongo collection `overlay_studios` stores one versioned document per channel:
`schemaVersion`, `revision`, `scenes`, and reusable `designs`. Updates require the
current revision; concurrent edits receive HTTP 409 and retain the local edits.
There are up to 25 overlays, 50 saved designs, and 60 layers per canvas. Dimensions,
IDs, layer kinds, event categories, media URLs and AST templates are validated.

A global overlay has a name, custom canvas size, positioned layers, shared-queue
categories, publication revision, private public ID, and a published snapshot.
Resizing a canvas never shifts or scales its stored layer rectangles. Array order
is the stack order. Each alert instance selects its design and events independently.

Saving a design updates all referring drafts. Publishing explicitly captures the
scene and referenced design revisions. Later draft edits leave that snapshot intact.
The OBS URL is `https://domdimabot.com/overlays/:publicId`; its random 192-bit ID is
indexed and is a read-only bearer. Replacing it invalidates previous HTTP access and
disconnects old sources on the next check. Public sources never receive account credentials.
Analytics is disabled on private overlay routes, and sources use a no-referrer policy.

## Browser source and event delivery

Each browser source has an independent Socket.IO subscription at
`/overlay-studio/:publicId`. Existing TTS, clip and trigger publishers feed it through
the API's overlay bridge; the legacy browser sources still receive their usual events.
The streamer manages duplicate OBS sources. Adding a global source does not suppress
another client or elect a single playback leader.

Categories selected to wait share a FIFO. Other categories play independently. A
queued event starts using the current published layout; an already playing event
retains its render snapshot. Publishing neither clears nor restarts the pending queue. Adding clip or TTS placements
also activates their producers without requiring an OBS reconnect.
One event can appear in multiple matching instances, and completes when all finish.
Media errors, load timeouts and finite alert durations release their queue slots.
There is no age or length cutoff for connected clients' pending events.

Generated clip and TTS files are copied before their producer advances. Each copy is
retained until every receiving client completes it. If no legacy subscriber is present,
the producer can advance after copying; client playback acknowledgments release only
that client's retention claim. Clip completion rejects duplicate/stale acknowledgments.
An interrupted socket can reconnect with its existing client ID for two minutes and
recover unacknowledged events. Disconnected claims are then removed. These playback
queues are session state: refreshing an OBS page or restarting the API does not provide
a durable replay of pending media. Saved documents and published layouts survive restarts.

Alerts subscribe to new Twitch events in the existing Mongo domain-event journal while
the source is open: bits, follows, subscriptions/gifts, and raids. This API browser
subscriber does not introduce another cron consumer or replay historical offline alerts.

## Actual AST alert text

Templates use the existing parser, evaluator, user/event functions and text-formatting
handlers, evaluated server-side. `$(cheer.amount)` is the bits variable; `$(amount)` is
not an alias. Other examples: `$(user)`, `$(cheer.message)`, `$(sub.tier)`,
`$(sub.months)`, `$(gifted.user)`, `$(raid.channel)`, and `$(raid.viewers)`.
Anonymous events get a stable `Anonymous` display value. Browser text uses interpolation,
never HTML insertion, and returned event text is not reparsed as AST.

The complete syntax tree is checked before evaluation. Display functions, bounded
expressions, and text formatting are allowed; commands, moderation, storage writes,
loops, network functions and indirect command references are rejected. A subscriber
cannot repeat stream actions by rendering a design. The editor's sample preview calls
the same backend renderer. A separate control sends a sample alert to published OBS sources.

## Assets and later work

Image/video placements accept HTTPS URLs; the model reserves `assetId` for the future
asset library picker. Global media placements stay visible (videos loop muted). Nested
alert designs can contain text, images, video and an animated accent. Temporary media
activation otherwise belongs to trigger instances.

Deferred as agreed: trigger-ID allowlists per instance, the asset-library picker, further
trigger GIF/image behavior, and the AST queue-clear function. The editor's existing clip
and trigger tests remain available; its TTS button currently uses a sample animation.

## Verification

- `ops/checks/overlay-studio-backend.mjs`: isolated actual API, ownership/Pro gates,
  revision conflicts, real AST, publication isolation, domain journal delivery, independent
  clients, generated media retention, reconnection, rotation and downgrade.
- `ops/checks/overlay-studio-browser.mjs`: editor interactions and API contracts, shared
  designs, server preview requests, mobile layouts, accessibility, and the OBS scheduler.
- Existing TTS queue regression tests cover producer lock and completion behavior.

Use `scripts/saas-ops` to preview, build, verify, deploy and clean up the API and site.
