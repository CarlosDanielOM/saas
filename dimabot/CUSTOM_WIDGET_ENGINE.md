# Custom widget engine (Dima SDK v1)

Status: live. Latest: "Block outside connections" and the outside-code notice (2026-11-06).

Runs the code of custom widget layers (see [`CUSTOM_WIDGETS.md`](./CUSTOM_WIDGETS.md) for the package/data model).
Our own runtime is the base; StreamElements support is a translation layer built only from Dima SDK calls.

## 1. Packages: `widget.json`

Optional sixth file. Imports without one (StreamElements exports) get it inferred from their code.

```json
{ "engine": "dima", "api": 1, "name": "Pastel chat", "author": "Ana", "version": "1.2.0",
  "description": "Chat with pastel bubbles", "uses": ["chat", "alerts", "storage", "signals", "polls", "goals", "hypetrain", "ads", "tts", "triggers", "rewards", "pets", "duels", "roulette", "dimafx"] }
```

- `engine`: `dima` (native) or `streamelements` (adds the SE translation layer). Default: `streamelements` without a manifest.
- `api`: Dima SDK version the code targets. Only `1` exists. Unknown versions are refused on import.
- `uses` (api 1): `chat` (messages, deletes, clears), `alerts` (follow, sub, resub, gift, bits, raid, tip), `storage`
  (persistent key/value), `signals` (chat command signals), `counters` (read command counts), `session` (latest/recent/session totals),
  `polls`, `goals`, `hypetrain`, and `ads` (live state), and `tts`, `triggers`, `rewards`, `pets`, `duels`, `roulette`, and `dimafx` (bot events). Unknown entries are reported as import
  issues and ignored. Studio shows these in plain words before a widget is added, and the server only streams what a
  published widget uses.
- SE inference: any `onEventReceived` handler gets `chat` and `alerts` (listener names are often built indirectly),
  otherwise `chat` if the code checks the `message` / `delete-message` listeners, `alerts` for `*-latest`,
  `storage` for `SE_API.store`, `counters` for `SE_API.counters`, `session` for `session`/`onSessionUpdate`/`-recent`/`-goal`.

## 2. The frame

Each custom layer is an `<iframe sandbox="allow-scripts" srcdoc="…">` sized to the layer box. Opaque origin: no access
to the site's storage/login, the parent DOM, top navigation, popups or forms. Same in the editor preview and OBS.

The `srcdoc` document, in order:
1. A CSP meta (`object-src 'none'; form-action 'none'`), `<base href="<site origin>/">` (so widget code can't read the
   overlay's link from its base URL) and the base style (`html,body{margin:0;background:transparent;overflow:hidden}`).
2. Dima SDK, called with this run's boot data `{ exec, fields }` (`exec` tags every message; `Dima.fields` works before
   the widget's code runs). The SDK and SE layer are TypeScript functions compiled into the app and inlined as text:
   they must stay self-contained and must not use object spread (the production build turns it into a shared helper).
3. StreamElements only: jQuery 3.7.1 (`assets/widget-runtime/jquery-3.7.1.min.js`, SRI-checked when added) and the SE layer.
4. Widget CSS in `<style>`, widget HTML in `<body>`, widget JS in a classic `<script>` at the end of `<body>` (sloppy mode,
   like StreamElements — widgets rely on implicit globals).

Text substitution of settings (`{key}` and `{{key}}`, only for keys that exist; arrays joined by `,`; null → empty):
StreamElements engine in HTML, CSS and JS (StreamElements parity); Dima engine in HTML and CSS only (JS reads `Dima.fields`).
`</script` and `</style` in substituted text are escaped so a value can't end our tags early.

Copied media: URLs in files/values that were copied into the channel's storage are rewritten to our URLs before
substitution (editor: owner asset URL; OBS: the overlay's public asset URL).

Opaque origins throw on `localStorage`; the SDK installs an in-memory `localStorage`/`sessionStorage` before widget code runs.

### Trust boundaries

- **The site and the account:** widget code never runs on the site's origin, so it can't read the login, call the API as
  the streamer, or touch Studio. Editor previews get short-lived asset links, never the session token.
- **Each frame is isolated from the page and other layers.** Widget code cannot read the overlay link or another
  layer's data. It talks to DomDimaBot through the host-checked, rate-limited SDK RPC; storage is scoped to its own
  widget, and command counters are read-only.
- **OBS:** OBS gives every browser source page (and frame) its `window.obsstudio` API at the permission level set in the
  source's "Page permissions". The SDK removes it before widget code runs, as a best effort. Restricted mode also blocks
  inner frames. This is not airtight (an inner frame or an opened page gets a fresh copy): the OBS setting still decides
  what pages in the source can do, so recommend "No access to OBS" for sources that show imported widgets.
- **Network:** by default, widgets may load scripts and call public APIs (StreamElements widgets rely on it). Anything a widget
  loads runs with the widget's data: public chat, alerts and its own saved values. By default a widget may send received
  data to other servers, expose the streaming PC's IP to them, display anything on stream, and consume CPU and memory.
  Code loaded from another site can change after import. The import dialog detects and lists outside script/style hosts,
  warns about changing code and outgoing data, and offers the owner-controlled per-widget switch.
- **Block outside connections:** the per-widget owner setting is off by default and is never read from `widget.json`.
  When enabled, the frame policy (`restrictedPolicy` in frame-document.ts) is `default-src 'none'` with only inline
  scripts and eval (no outside scripts, StreamElements included), styles inline or from Google Fonts, `connect-src 'none'`,
  `frame-src 'none'`, and `worker-src 'none'`; images/fonts/media load from DomDimaBot and copied files, StreamElements
  file hosts (`cdn.streamelements.com`, `static.streamelements.com`), Google Fonts, and Twitch emotes/badges
  (`static-cdn.jtvnw.net`). DNS prefetch is off and WebRTC constructors are removed. The iframe also carries the policy
  (`csp`, embedded enforcement); the host probes the frame after its first load (`probe`/`probe-ok` with the exec nonce,
  5 s) and stops it on a second load, so a frame that navigates (even before its first load) or reloads is stopped. That
  is containment: the navigation request has already been sent. Libraries or fonts from hosts such as cdnjs or jsDelivr
  stop working. Studio preview uses the same rule; a change makes connected OBS sources reload that widget
  (`overlay-widget-reload`, bridge `widgetChanged`). It stops normal tracking, uploads and later code changes, but is
  not airtight against a determined author (navigation URLs, explicit DNS hints).
- **Resources:** a widget can still use CPU, memory or audio in its OBS source. Heartbeats restart frozen frames (3 times
  in 5 minutes, then the frame is stopped); a widget stuck in a tight loop can stall its own browser source page.

## 3. Host ⇄ frame protocol (`postMessage`)

Every message is `{ dima: 1, type, … }`. The host accepts only messages whose `event.source` is that frame's
`contentWindow`; the SDK accepts only `event.source === window.parent`. Data is plain JSON (structured clone).

Host → frame:
- `init` `{ widget: { id, layerId, name, revision }, engine, manifest, fields, channel: { id, login, name }, mode: 'editor'|'live', muted, session? }`
- `event` `{ event: DimaEvent }` — only categories in `manifest.uses` (plus `button` in the editor).
- `fields` `{ fields }` — settings changed in the editor (Dima engine updates live; SE engine reloads the frame).
- `rpc-result` `{ id, ok, value?, error? }`

Frame → host:
- `ready` (after the widget's scripts ran), `heartbeat` every 2 s, `log` `{ level, args }` (console capture),
  `error` `{ message, stack? }` (uncaught errors / rejections)
- `rpc` `{ id, method, params }`: `store.get`, `store.set`, `counters.get`, `field.set` (editor only), `queue.done` (no-op in v1)

Host limits: 30 RPCs/s and 200 logs/min per frame (excess dropped, counted); RPC payloads ≤ 64 KB; a frame that misses
heartbeats for 10 s is reloaded (max 3 reloads per 5 min, then stopped with an error shown in Studio). Note: an endless
loop in a same-process frame can still stall the page; a separate widget origin (out-of-process frames) is a later step.


## 4. Command signals

Widgets opt in with `"signals"` in `widget.json` `uses`. Optional declarations provide Studio with ready-made commands:

```json
{ "uses": ["signals"], "signals": [{ "name": "feed", "description": "Feed the pet", "values": ["pizza", "cake"] }] }
```

There can be up to 30 declarations. Names match `^[a-z0-9_]{1,40}$`; descriptions are at most 200 characters; values contain up to 30 examples, each at most 60 characters. Invalid entries are skipped with the import note `signal declaration skipped`.

The Dima SDK emits `signal` and `signal:<name>` events. `DimaSignal` has `id`, `name`, `value`, `json`, `args`, `at`, verified-badge `user` and `source` metadata, and a `target` layer name or `null`. `value`, `args`, and `json` originate in viewer text: render them with `textContent` or `Dima.escape()`, never `innerHTML`. StreamElements compatibility sends the same data through `onEventReceived` with `listener: 'dima:signal'`.

Signals are sent only from real Twitch chat commands, keywords, referenced commands, and Chat event messages. Timer, channel-point reward, roulette, AI request, and dashboard/docs-assistant test contexts return `Error: widget_signal_context_required`. A command run may send 5 signals maximum (shared with referenced commands); a channel may send 30 per 10 seconds. Excess signals are silently dropped and counted. Twitch duplicate chat delivery is de-duplicated. Signals are live-only with no reconnect replay.

The public SDK storage names are `Dima.storage.get/set`, the `storage` update event (`DimaStorageUpdate { key, value, namespace }`), and `widget.json` `uses: ["storage"]`. There is no compatibility alias because no live widget used the old public API. StreamElements retains `SE_API.store` and `kvstore:update`. Internal names remain RPC `store.get` / `store.set`, route `custom-widgets/store/...`, and collection `custom_widget_store`.

## 5. Dima SDK v1 (inside the frame)

```js
const ctx = await Dima.ready();         // { widget, channel, fields, mode: 'editor'|'live', muted, session }
Dima.fields;                             // current settings (plain object)
Dima.on('chat' | 'chat.delete' | 'chat.clear' | 'alert' | 'button' | 'fields' | 'storage' | 'session' | 'signal' | 'signal:<name>' | 'state' | 'tts' | 'trigger' | 'reward' | 'pet' | 'duel' | 'roulette' | 'dimafx', handler) → off()
Dima.state('polls' | 'goals', handler) → off() // latest value once known, then every change
Dima.storage.get(key) / Dima.storage.set(key, value)   // Promise; JSON values ≤ 64 KB
Dima.counters.get(name)                  // Promise<number> — the count of the channel's command `name`
Dima.html(message)                       // safe HTML for a chat message: escaped text + <img> emotes
Dima.escape(text)
Dima.log(...args)                        // shows in Studio's widget log
```

Events (all JSON):

```ts
type Platform = 'twitch';
interface DimaUser { id: string; login: string; name: string }
interface DimaChat {
  id: string; platform: Platform; at: number;
  user: DimaUser & { color: string | null; badges: DimaBadge[]; roles: DimaRoles; subMonths: number | null };
  text: string; parts: DimaPart[]; kind: 'text' | 'highlighted' | 'intro' | 'power-up' | 'gigantified';
  action: boolean; firstMessage: boolean; bits: number; rewardId: string | null;
  reply: { id: string; user: DimaUser; text: string } | null;
  sharedChat: { channelId: string; messageId: string } | null;
}
interface DimaBadge { set: string; version: string; info: string; title: string; images: { '1x': string; '2x': string; '4x': string } }
interface DimaRoles { broadcaster: boolean; moderator: boolean; vip: boolean; subscriber: boolean; founder: boolean;
  artist: boolean; staff: boolean; partner: boolean; turbo: boolean; prime: boolean }
type DimaPart =
  | { type: 'text'; text: string }
  | { type: 'emote'; text: string; id: string; animated: boolean; images: { '1x': string; '2x': string; '4x': string } }
  | { type: 'cheer'; text: string; prefix: string; bits: number; tier: number }
  | { type: 'mention'; text: string; user: DimaUser };
interface DimaChatDelete { messageId: string; userId: string | null }
interface DimaChatClear { userId: string | null }          // null = whole chat cleared
interface DimaAlert {
  id: string; type: 'follow' | 'sub' | 'resub' | 'gift' | 'bits' | 'raid' | 'tip'; at: number; test: boolean;
  user: DimaUser | null;                                   // null: anonymous gifter
  amount: number;                                          // months (sub/resub), gifts, bits, viewers, tip amount
  tier: '1000' | '2000' | '3000' | 'prime' | null; months: number | null; streak: number | null;
  message: string | null; recipient: DimaUser | null; currency: string | null; rule: { id: string; name: string } | null;
}
interface DimaPollChoice { id: string; title: string; votes: number; users: number; points: number;
  channelPointsVotes?: number; color?: string }
interface DimaPoll {
  kind: 'poll' | 'prediction'; id: string; title: string;
  phase: 'active' | 'locked' | 'completed' | 'archived' | 'terminated' | 'resolved' | 'canceled';
  choices: DimaPollChoice[]; startedAt: string; deadline: string | null; endedAt: string | null;
  winnerId: string | null; revision: number; occurredAt?: string; receipt?: string;
}
interface DimaPolls { poll: DimaPoll | null; prediction: DimaPoll | null } // totals only; never voter identities
interface DimaGoal {
  id: string; name: string; metric: 'follows' | 'subs' | 'bits' | 'currency'; mode: string; target: number; current: number;
  percent: number; currency: string | null; status: 'scheduled' | 'active' | 'reached' | 'ended';
  startsAt: number; endsAt: number | null; windowSeconds: number | null; period: unknown | null;
} // money uses currency units (e.g. 87.5); public state, no completion actions
interface DimaTts {
  id: string; phase: 'start' | 'end'; text: string; user: DimaUser | null;
  reason: 'ended' | 'skipped' | 'cleared' | 'interrupted' | null; at: number; test: boolean;
}
interface DimaTrigger { id: string; triggerId: string; name: string; mediaType: 'audio' | 'video' | 'image' | 'unknown'; at: number; test: boolean }
interface DimaReward {
  id: string; reward: { id: string; title: string; cost: number }; user: DimaUser | null;
  input: string | null; at: number; test: boolean;
}
interface DimaPet { id: string; kind: 'talk' | 'ask' | 'tts'; phase: 'speaking' | 'done'; text: string; mood: string | null; result: 'completed' | 'stopped' | null; at: number; test: boolean }
interface DimaDuel { id: string; phase: 'started' | 'ended'; challenger: string; opponent: string; mode: 'overlay' | 'chat'; winner: string | null; loser: string | null; endsAt: number | null; at: number; test: boolean }
interface DimaRoulette { id: string; rouletteId: string; name: string; phase: 'spinning' | 'result'; label: string | null; endsAt: number; at: number; test: boolean }
interface DimaDimafx { id: string; item: { id: string; name: string; type: string }; source: 'bits' | 'credits' | 'saved' | 'test'; bits: number | null; credits: number | null; user: DimaUser | null; message: string | null; at: number; test: boolean }
type DimaState = { name: 'polls'; value: DimaPolls } | { name: 'goals'; value: DimaGoal[] };
```

Twitch notes: first-time chatters are marked from `message_type: 'user_intro'` (Twitch's "introduce yourself"); EventSub
has no general first-message flag. Emote images use `https://static-cdn.jtvnw.net/emoticons/v2/<id>/<static|animated>/dark/<1.0|2.0|3.0>`.
Badge images come from a cached Helix global + channel badge lookup.

## 6. StreamElements translation layer

Built on the Dima SDK; loaded only for `engine: "streamelements"`.

- `onWidgetLoad` (after `Dima.ready()`): `detail = { channel: { id, username, providerId }, currency: { code: 'USD', name:
  'U.S. Dollar', symbol: '$' }, fieldData, recents, session: { data }, overlay: { isEditorMode, muted }, emotes: [] }`.
  No `apiToken` (SE API calls from widgets are not supported).
- `onEventReceived` `detail.listener` / `detail.event`:
  - chat → `message` with `event.data = { time, tags, nick, userId, displayName, displayColor, badges: [{ type, version, url,
    description }], channel, text, isAction, emotes: [{ type: 'twitch', name, id, gif, urls: { 1, 2, 4 }, start, end }], msgId }`
    and `event.renderedText` (escaped HTML with emote images). `tags` are IRC-style strings: `badges`, `badge-info`, `color`,
    `display-name`, `emotes`, `first-msg`, `id`, `mod`, `subscriber`, `vip`, `turbo`, `room-id`, `user-id`, `tmi-sent-ts`, `user-type`.
  - chat.delete → `delete-message` `{ msgId }`; chat.clear with a user → `delete-messages` `{ userId }` (whole-chat clear has no SE event).
  - alerts → `follower-latest` `{ name }`, `subscriber-latest` `{ name, amount, tier, message, gifted, sender, bulkGifted,
    isCommunityGift }`, `cheer-latest` `{ name, amount, message }`, `raid-latest` `{ name, amount }`, `tip-latest`
    `{ name, amount, message, currency }`. Each also updates `session.data` and fires `onSessionUpdate`.
  - buttons → `widget-button` `{ field, value }`; store writes → `kvstore:update` `{ data: { key, value } }`.
- `SE_API`: `store.get/set` (channel-wide namespace `se`; updates arrive as `kvstore:update` with key `customWidget.<key>`),
  `counters.get(name)` → `{ id, count }` (plus `{ counter, value }` for older widgets), `sanitize({ message })` →
  `{ skip: false, result: { message } }`, `cheerFilter(text)` (removes cheermotes), `getOverlayStatus()` →
  `{ isEditorMode, muted }`, `resumeQueue()`, `setField(key, value, reload = true)` (editor only, never saved).
- Alert queue: with a `widgetDuration` setting, alerts play one at a time for that many seconds or until
  `SE_API.resumeQueue()`; chat and other events never wait.
- A whole-chat clear (no StreamElements event exists) restarts StreamElements widgets so cleared messages disappear.

## 7. Server: delivery to OBS

Code: `GET /overlay-studio/public/:publicId/custom-widgets/:widgetId/:revision` returns `{ engine, manifest, files, media }`
only when that published overlay pins that widget revision. Immutable, cacheable. Owner editor:
`GET /overlay-studio/:channel/custom-widgets/:id/bundle`.

Socket (existing `/overlay-studio/:publicId` namespace):
- server → source: `overlay-feed` `{ v: 1, type: 'chat' | 'chat.delete' | 'chat.clear' | 'alert' | 'storage' | 'session' | 'signal' | 'state' | 'tts' | 'trigger' | 'reward', data }`,
  sent only to sources whose published snapshot has a visible custom layer using that category.
- source → server: `overlay-widget-rpc` `{ layerId, method, params }` with an ack `{ ok, value | error }`; checked against
  the layer's manifest (`storage` / `counters`) and rate-limited per source.

Chat feed (bot → API): the bot handles `channel.chat.message` (and, once activated, `channel.chat.message_delete`,
`channel.chat.clear_user_messages`, `channel.chat.clear`). When the Dragonfly key `widget-feed:demand:<channel>` exists
(set by the API every 20 s, TTL 60 s, while a source using `chat` is connected), it normalizes the event (section 4) and
publishes `{ channel, type, data }` to the Dragonfly channel `widget-feed`. The API subscribes once and forwards.
Delete/clear subscriptions are created per channel when an overlay with a chat widget is published (like poll/prediction
activation), never for every channel.

Alerts: the API already polls the domain-event journal for follow/sub/gift/bits/raid; each alert is also normalized to a
`DimaAlert` and sent as `overlay-feed` to sources using `alerts` (no queue, no acknowledgement). OBS tests from Studio reach
code widgets too, including overlays that have only custom widgets. Alerts follow the built-in alert filter (gift
recipients come as one gift alert; a sub + resub-message pair shows once) and Bits rules with alerts turned off.

Delivery guarantees: chat, deletes and alerts for widgets are live only. A source that is disconnected misses them (the
built-in alert boxes keep their recoverable queue); session snapshots are sent again on every connection.

### Step 5B-1: live state and bot events (live 2026-11-06)

`state` is the current snapshot keyed by `name`: `polls` is `{ poll, prediction }` (each `null` when absent); `goals` is
the public `DimaGoal[]` projection from the Goals page. State is resent after source connection/layer changes and only
emitted when the value changes. The SDK remembers known values: `Dima.state(name, handler)` immediately invokes the
handler once known, then on changes, and returns an unsubscribe function. An unknown state does not call the handler.
Polls reuse the sanitized Twitch interactions source and expose totals, never voters. The channel's enabled Twitch poll
and prediction events are required. Goal state follows goal/progress edits within seconds and refreshes at least once a
minute for time-based changes; it does not execute goal completion actions.

Bot feed events are `tts`, `trigger`, `reward`, `pet`, `duel`, `roulette`, and `dimafx`; all include `at` (milliseconds) and `test` (true for Studio tests).
They are live-only and have no reconnect replay. TTS start is emitted when audio plays and end once on completion;
both share `id`, end carries `reason`, and a message that never plays has no event. Trigger sends include only the send
ID, trigger ID, name and media type, never a media URL; widget-only sources observe the send without playing it. Reward
sends represent every channel-points redemption whether or not a bot action exists. The `input` property is viewer text
and widget examples must render it as text or escape it.

Studio's **Bot events** test row appears for a layer using these categories: TTS start followed by end after 3 seconds,
Trigger, Channel points, Sample poll, and Sample goals. The code editor preview has the same tests. A sample state sent
to OBS is shown for about one minute before real state is restored. Studio previews are initialized from real polls and
goals. The **Replay recent chat** button in the Chat row is preview-only and sends the last 20 stored messages
oldest-first, text-only (no emotes, name colors, or badge images). Moderator-deleted messages can appear, so replay is
not sent to OBS.

### Step 5B-2: pet, duel, roulette, and DimaFX events (live 2026-11-06)

Widgets opt in with `uses` values `pets`, `duels`, `roulette`, or `dimafx`. Dima SDK event names are `pet`, `duel`,
`roulette`, and `dimafx`; StreamElements compatibility listeners are `dima:pet`, `dima:duel`, `dima:roulette`,
and `dima:dimafx`.

- Pet events send `speaking` when a pet actually starts playback and `done` once when a reply that spoke finishes.
  `text` is the pet's spoken output, never the viewer's question; private DomDimaBot desktop-app requests are excluded.
  `mood` is null when moods are off, and `result` is populated only on `done` (`completed` or `stopped`).
- Duel events send `started` on an accepted challenge or a challenge against the streamer, then `ended` once the fight
  finishes. Challenger and opponent are Twitch logins; winner and loser stay null until `ended` to avoid spoilers.
- Roulette events send `spinning` and then `result` with the landed label. The result comes from the saved spin, so an
  API restart or OBS reconnect does not lose it. A source connecting up to two minutes after the spin ended still gets
  the result; widgets that should ignore old spins must check `endsAt`.
- DimaFX events send once when an item starts playing and require the DimaFX overlay to be connected. Viewer identity
  is present only when shared with the extension; custom TTS message text is viewer input and must be escaped or shown
  with `textContent`.
- Studio's Bot events row includes Pet reply, Duel, Roulette, and DimaFX purchase. Paired events send the second phase
  about three seconds later; editor preview has the same tests. All Studio events carry `test: true`.
- Delivery (code): producers publish to Dragonfly `widget-feed` (`widget_feed/bot-events.ts`) after their own claim —
  pets after the ready→playing update and the terminal `finishRequest` claim, duels after the accept/`fightStreamer`
  write and the `run.completedAt: null` settle claim, roulette after the start CAS (never a replay). The API drops a
  pet `speaking` that arrives after its `done` (producers run in different processes), refuses roulette deadlines more
  than 10 minutes ahead and holds the label in a timer until `endsAt`. DimaFX claims `widgetSentAt` on the playback job
  before publishing, so a job recovered after an API restart is not announced again. The duel worker flushes pending
  widget messages (2 s cap) before it exits.

### Step 5B-3: Hype trains, ad breaks and roulette from saved spins (live 2026-11-06)

This change is implemented in the current checkout and awaits deployment. Existing 5B-1 and 5B-2 releases remain live.

Widgets opt in with `uses` values `hypetrain` and `ads`. These are live state alongside polls and goals, not bot events:
`Dima.state('hypetrain', handler)` receives a `DimaHypeTrain` or `null`, and `Dima.state('ads', handler)` receives a
`DimaAds` object. Both handlers get the latest known value immediately, then every change. They also arrive through
`Dima.on('state', ...)`.

- Hype train state includes ID, active/ended phase, level, total points in Twitch units, next-level progress and goal
  (`null` when ended), public top contributions, channel all-time high, regular/golden-kappa/treasure type, shared-train
  status and participant channels, and start/expiry/end/cooldown timestamps. `expiresAt` is `null` after end. An ended
  train remains visible until cooldown ends (up to two hours), then becomes `null`. If the end was missed, the API asks
  Twitch for current status and clears stale active state when Twitch reports no running train. Twitch exposes the top
  contributors publicly; no private contribution details are added.
- Ad state is `{ active, schedule }`. `active` is null or `{ startedAt, endsAt, duration, automatic }`; duration is
  seconds and `automatic` reports whether the schedule started it. The starter is never included. `schedule` is null
  when unknown, otherwise includes next break time, duration, last break, snoozes, snooze refresh, and preroll-free
  expiry. Times are milliseconds except duration, which is seconds. Because Twitch emits no schedule-change event, the
  API reads the schedule about once a minute only while an OBS source with an `ads` widget is connected. A streamer
  with an old login may need to log in again to grant schedule permission; until then, schedule stays null.
- StreamElements listeners are `dima:hypetrain` (`event.hypetrain`, null when none) and `dima:ads`
  (`event.active`, `event.schedule`). Studio's Bot events row adds **Sample hype train** and **Sample ad break**; in
  OBS each sample reverts to real state after about a minute, like Sample poll. Hype train and ad break chat messages
  remain unchanged on the Events page. Very late Twitch retries do not announce an old train or ad break.
- Roulette event shape is unchanged. Its result is now read from the saved spin, so an API restart or OBS reconnect
  does not lose the result. A source connecting up to two minutes after the spin ended still receives it; check
  `endsAt` if your widget should ignore old spins.
- Public typings include `DimaHypeTrain`, `DimaHypeContribution`, `DimaAds`, `DimaAdBreak`, and `DimaAdSchedule`.

Chat delete/clear subscriptions are activated when an overlay with a chat widget is published and re-checked at most
hourly when such an overlay connects; failures are logged and retried, never blocking publishing.

Storage: collection `custom_widget_store` `{ _id: '<owner>:<namespace>:<key>', owner, namespace, key, json, bytes, updatedAt }`
(values kept as JSON text so any JSON round-trips).
Namespace: `se` for StreamElements widgets (channel-wide, like SE), the widget ID for Dima widgets. Limits: key ≤ 100
chars, value ≤ 64 KB JSON, 500 keys / 2 MB per channel. Writes broadcast `storage` feed events (`DimaStorageUpdate { key, value, namespace }`) to the channel's sources that use `storage` in the same
namespace, and each frame host applies only updates from its own namespace (one OBS source can hold several widgets). Each source may
make 20 widget requests per second and the channel 60 saves per 10 seconds.
The editor reads the real storage but keeps its writes in memory (previews don't change live data).

Session (`session.data` for SE, `Dima.ready().session` for Dima): `*-latest` and `*-recent` (up to 25) come from the newest
500 alerts in the last 7 days. `*-session` counts/amounts cover the latest `stream.started`, else the last 24 h;
`*-week` covers 7 days; `*-month` (follows, subs, Bits, raids) covers the current UTC calendar month. The session counts
and amounts are counted in the database over each range. `follower-total` and `subscriber-total` use current dashboard
ledgers (follow updates are included as they happen); `cheer-total` and `raid-total` cover the retained 90-day event
journal and can decrease as events age out. Subscriber counts count each subscriber once plus gifted subs, so a 5-sub
community gift adds 5.

StreamElements manual goals map to `follower-goal`, `subscriber-goal`, `cheer-goal`, and `tip-goal`, each `{ amount }`.
For each metric, the first active goal in the streamer's list is used, else the first reached goal; no matching goal means
0. The value is progress, not target. Goal counting options (since creation, current count, set dates, rolling window,
calendar month) are selected on the Goals page. `tip-goal` is currency units (stored cents divided by 100) and includes
everything counted by that goal (Bits, subs, custom items), not only tips. Changes to goals or progress reach OBS widgets
within seconds through session updates. Test alerts also update session totals in the preview and send updated totals to
OBS after each alert; tests never change real data. Tip event values (`tip-*`) remain 0 until DomDimaBot tipping exists;
the manual `tip-goal` can still show a Goals page goal.

## 8. Copying StreamElements media

Import lists remote files (`externalMedia`). For images, video and audio on StreamElements' media hosts
(`cdn.streamelements.com`, `static.streamelements.com`; the server and Studio use the same list), Studio
offers "Copy to your storage (X MB)" vs "Keep loading from StreamElements". Copying downloads them server-side
(https on the default port, StreamElements hosts only, every redirect hop re-checked, names resolving to private
addresses refused, 50 MB per file, the channel's storage quota), stores them in the channel's Asset Library and saves a
`media` map (URL → asset ID) on the widget. The map is shared by all revisions on purpose: copying protects every
overlay at once, including published ones. The runtime rewrites those URLs (section 2). Copied assets can't be deleted
while a widget uses them; the original files keep the StreamElements URLs, so exports stay StreamElements-compatible.

OBS loads copied files through the overlay's public asset route. Studio previews use owner preview links
(`/asset-library/:channel/:id/access?for=custom-widget`): 12 hours for files a custom widget copied (sounds and videos
load again each time they play, long after the frame started), 15 minutes for everything else. Studio fetches fresh
links for new frames once its cached ones are an hour old, and restarts a widget's preview when its copied files change.

The download guard checks every address a name resolves to before connecting, but doesn't pin the connection to the
checked address (a DNS answer that changes between the check and the connect isn't caught). Only two StreamElements
CDN hosts are allowed, which keeps that window narrow; pinning is a follow-up.
