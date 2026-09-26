# Overlay studio: agreed direction and mock

Status: interactive frontend prototype only. Backend implementation still needs the
streamer's green light. The mock route is `/mocks/dev/overlay-editor`; all saved data
and published snapshots are local to the current browser. Clip tests now use the selected signed-in streamer’s existing clip test endpoint and live socket. Trigger tests load a random saved trigger and play its media locally, with a glow fallback for an empty trigger list. Other events remain simulated.

## Durable documents

- **Global overlay:** internal ID, owner channel, name, user-defined canvas width/height,
  layers, waiting categories, draft revision, published revision, random public ID.
- **Saved alert design:** independent internal ID, owner channel, name, revision,
  canvas width/height, event layouts keyed by event type. Each layout holds layers,
  duration and animation settings. Designs are reusable across global overlays.
- **Alert instance:** unique layer ID, position/size/stack order, visibility/lock,
  saved design ID and enabled events. Event selections and placement belong to the
  instance. For example one instance receives subs/bits, another follows/raids.
- **Layers within alert designs:** positioned text, asset references, video and animation.
  Event context supplies `$(user)` and event-specific fields. The mock supports
  `$(user)` and illustrative `$(amount)` replacement using sample values.

Mongo is the intended durable store. Authenticated editing, owner checks, schema versions
and revision conflict checks belong in the backend implementation. Asset files remain
owned by the future asset library; layouts reference asset IDs.

## Reuse and publishing

The mock proposes linked reuse: saving an alert design updates every referencing overlay
draft. Save as a new design creates an independent copy. Publishing a global overlay
captures its complete layout, waiting settings and exact saved design revisions. Editing
a shared design does not silently alter already-published snapshots; publish each overlay
when ready. A production publish message tells clients to fetch the latest snapshot.

Preserve websocket subscriptions, in-flight events and pending queue while updating a
client. Proposed behavior: an active event finishes with its existing render snapshot;
subsequent events use the new one. Publish and fetch failures keep the current live version.

Public browser sources use `domdimabot.com/overlays/:publicId`, with a long random indexed
ID separate from the internal document ID. Regeneration invalidates the old URL. The mock
shows an example URL only; it does not provision the public route or websocket clients.

## Canvas and playback rules

- Resizing a canvas preserves all layer coordinates and sizes, even outside its bounds.
- Each open browser source subscribes independently. Multiple sources intentionally play
  the same events; the streamer manages duplicated OBS sources.
- Selected event categories share a FIFO queue; other categories play independently.
- Long backlogs drain naturally. Do not expire/drop events just because they waited.
- Media failures release their active slot. Finite visual alert duration also releases it.
- Proposed default: one event matching multiple instances displays in all matching
  placements together, completing when those placements finish or fail.
- Background images and looping videos are permanent asset placements. Triggers own
  temporary media activation. Nested event designs have their own event lifetime.
- Alert templates need a presentation-only AST context. Do not execute chat/moderation
  or other actions once per rendering subscriber. Preserve event context while queued.

## Integration work still required

Existing TTS/clip channel queues and client acknowledgments need idempotent event IDs.
TTS file cleanup must retain audio needed by waiting clients. Clips need immutable event
media URLs so a newer clip cannot overwrite one awaiting playback. Confirm these contracts
against backend source when implementation begins. Normalize future alert events through
the existing domain-event pipeline, including anonymous/missing-user context fallbacks.

Deferred: trigger-ID allowlists per trigger instance, asset-library connection, trigger
image/GIF playback improvements, and an AST action for clearing queues. The mock's
media-error control exercises slot release; it is not the deferred queue-clear action.
