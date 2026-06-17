# Follow Defense Backend Plan

## Goal

Build a backend-only follow attack protection system for Twitch follow floods. The system must avoid blocking the main bot/EventSub flow even during bursts of thousands of follows, while still tracking, silencing, and banning according to streamer-configurable settings.

No Angular/UI work is included in this phase.

## Non-blocking architecture decision

Use a hybrid event-driven queue:

1. `follow.handler.ts` receives a Twitch `channel.follow` EventSub event.
2. The handler performs only lightweight work:
   - enqueue the follow payload into Dragonfly
   - ask the defense state whether normal follow alerts should be suppressed
   - return quickly
3. A dedicated `follow_defense.worker.ts` consumes queued follow events in the background.
4. The worker performs heavier work:
   - sorted-set burst tracking
   - mode transitions
   - attack log persistence
   - Twitch ban API calls
   - rate-limited retryable moderation actions

This keeps Twitch EventSub processing and normal bot responses responsive during a 5k-follow attack. If Twitch ban calls are slow or rate-limited, the queue grows for the affected channel, but the main bot process stays available for other streamers.

## Modes

### Normal
- Follow alerts work normally.
- Every follow is still enqueued for defense evaluation.

### Silent Mode
- Trigger: `silentThresholdX` follows inside `silentWindowYSeconds`.
- Defaults: `10` follows in `5` seconds.
- Action:
  - suppress follow chat alerts/triggers
  - track followers in the burst window
  - no bans yet
- Expiry:
  - default `silentDurationSeconds = 60`
  - if no escalation happens, return to normal and send summary message: how many follows happened during the silent period.

### Protection Mode
- Trigger: `protectionThresholdB` follows inside the detection window.
- Default: `100` follows.
- Action:
  - send localized warning message unless a raid cache flag is active
  - ban all new follows after protection activates using the existing Twitch ban endpoint with no duration
  - continue tracking all follows
- Raid exception:
  - if a raid flag is active, do not announce or auto-ban; only track.

### Attack Mode
- Trigger:
  - `attackThreshold` follows inside the detection window, default `500`, configurable
  - manual AST activation: `$(bot.mode attack)` (for example streamer command `!defmode`)
- Action:
  - ban all tracked followers from the same burst, ideally from the first event in the burst; if this is too costly/fuzzy, at minimum from Silent Mode start
  - ban all new follows while attack mode remains active
  - persist attack log
- Manual raid attack:
  - if `$(bot.mode attack)` is used while a raid flag is active, record the raider as a hate-raid source and increment future reference count.

## Config defaults

```ts
const DEFAULT_FOLLOW_DEFENSE_SETTINGS = {
  enabled: true,
  silentModeEnabled: true,
  protectionModeEnabled: true,
  attackModeEnabled: true,
  silentThresholdX: 10,
  silentWindowYSeconds: 5,
  protectionThresholdB: 100,
  attackThreshold: 500,
  silentDurationSeconds: 60,
  baselineFollowsPerHour: null,
  language: 'en'
};
```

`baselineFollowsPerHour` is user-adjustable, not auto-calculated in the first implementation.

## Cache keys

Use the Twitch cache naming convention with channel ID:

| Key | Type | Purpose |
| --- | --- | --- |
| `twitch:{channelID}:follow-defense:settings` | string JSON | Cached persistent settings |
| `twitch:{channelID}:follow-defense:state` | string JSON | Current mode, activation timestamps, counts |
| `twitch:{channelID}:follow-defense:recent` | sorted set | Recent follows for threshold checks |
| `twitch:{channelID}:follow-defense:tracked` | sorted set | Followers tracked for current burst |
| `twitch:{channelID}:follow-defense:follow:{followerID}` | string JSON | Follow payload details |
| `twitch:{channelID}:follow-defense:raid` | string JSON | Active raid marker, 5-minute TTL |
| `twitch:follow-defense:queue` | sorted set | Global worker queue of follow/control events |
| `twitch:follow-defense:queue:data:{eventID}` | string JSON | Queued event payload |

## MongoDB schemas

### FollowDefenseSettings

Persistent per-channel configuration:
- channel ID/name
- enabled flag
- mode enable flags
- thresholds and durations
- user-set baseline
- language
- cache version / updatedAt

### FollowAttackLog

Historical attack/raid events:
- attacked channel ID/name
- triggered mode and trigger source (`threshold` or `manual`)
- total follows, velocity, timestamps
- tracked follower IDs/logins/names
- ban results per follower
- raid metadata when applicable
- hate raid marker

### FollowHateRaidSource

Aggregated future-reference table:
- target channel ID/name
- raider channel ID/name
- count
- firstSeenAt / lastSeenAt

## Integration points

### `follow.handler.ts`

- Enqueue follow defense event.
- Query a fast cache helper to decide whether follow alerts should be suppressed.
- If suppressed, do not send follow alert message/triggers.
- Do not perform threshold calculations or ban API calls in the handler.

### `raid.handler.ts`

- Set `twitch:{channelID}:follow-defense:raid` with 5-minute TTL.
- Include raider channel ID/name and viewer count.
- Worker uses this flag to distinguish likely legitimate raids from attacks.

### AST parser

- Add `$(bot.mode attack)`.
- Add optional `$(bot.mode status)` for moderator feedback.
- Register it in AST function registration.
- User-facing command can be custom, e.g. `!defmode -> $(bot.mode attack)`.

## Ban behavior

- Use existing `ban(channelID, userID, BOT_ID, null, reason)`.
- No duration means permanent ban.
- Rate-limit ban processing per channel to avoid API burst failures.
- Store failures for audit/retry visibility.

## Localized messages

No UI translations yet; backend constant map only:

EN:
- Silent summary: `⚠️ Follow spike detected: {count} follows in {seconds}s. Protection active.`
- Protection: `⚠️ Follow flood detected! Follow protection enabled. Use !defmode to activate attack mode.`
- Attack: `🚨 Attack mode activated! Banning all followers from this wave.`

ES equivalents can be added in backend constants for this phase.

## Worker safety

- Single distributed worker lock.
- Batch queue processing with per-channel lock.
- Rate-limit Twitch ban calls.
- Never block EventSub handler on MongoDB writes or Twitch moderation calls.
- If worker is down, queued events remain in Dragonfly until processed or TTL expires.

## Phase 1 backend deliverables

1. Schemas for settings, attack logs, and hate raid sources.
2. Follow defense utility for cache state/settings/queue helpers.
3. Follow defense worker registered in cron supervisor.
4. Follow handler integration for enqueue + suppression.
5. Raid handler integration for raid marker.
6. AST function `$(bot.mode attack/status)`.
7. Backend build verification.
