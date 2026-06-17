# Follow Defense UI Plan for Designer Agent

## Purpose

Design and implement the Angular website UI for the DimaBot Follow Defense / Protection Mode system. The backend logic exists first; this plan focuses on frontend UX, information architecture, and Angular implementation guidance.

The goal is to let streamers configure, understand, monitor, and manually activate follow-flood protection without interfering with users who already use another moderation system.

## Product Context

Follow Defense protects streamers from bot follow attacks and hate raids. It has three automated modes:

1. **Silent Mode** — triggered by a small burst of follows. It suppresses follow alerts/chat spam and tracks followers.
2. **Protection Mode** — triggered by a larger burst. It announces protection and bans new followers from the wave unless an active raid is detected.
3. **Attack Mode** — triggered by a larger threshold or manually with a streamer command such as `!defmode`. It bans all tracked followers from the wave.

Raid-aware behavior:

- If a Twitch raid is detected, the system tracks follows silently for 5 minutes.
- It does not auto-ban during the raid by default.
- If the streamer manually activates Attack Mode during that raid, tracked raid followers are banned and the raider is stored as a hate-raid source for future reference.

## Important Backend Notes

Backend files already added:

- `dimabot/src/schemas/follow_defense_settings.schema.ts`
- `dimabot/src/schemas/follow_attack_log.schema.ts`
- `dimabot/src/schemas/follow_hate_raid_source.schema.ts`
- `dimabot/src/utils/follow_defense_queue.ts`
- `dimabot/src/utils/follow_defense.ts`
- `dimabot/src/workers/follow_defense.worker.ts`
- `dimabot/src/utils/ast_parser/functions/defense.functions.ts`

Current backend does **not yet include public HTTP routes** for the frontend. Designer Agent should either:

1. build the UI using mock interfaces and clearly mark API integration points, or
2. coordinate with backend implementation to add routes before wiring live data.

Recommended backend API endpoints for frontend integration:

```txt
GET    /follow-defense/:channelID/settings
PATCH  /follow-defense/:channelID/settings
GET    /follow-defense/:channelID/status
POST   /follow-defense/:channelID/attack
POST   /follow-defense/:channelID/reset
GET    /follow-defense/:channelID/attacks?page=&limit=
GET    /follow-defense/:channelID/hate-raids?page=&limit=
```

All responses should follow the existing envelope pattern:

```ts
interface ApiEnvelope<T> {
  error: boolean;
  message?: string;
  status?: number;
  data?: T;
}
```

## Route Placement

Preferred authenticated route:

```txt
/:streamer/modules/follow-defense
```

Required route updates if this route is used:

- Add child route in `dimasite/src/app/app.routes.ts`.
- Add module whitelist entry in `dimasite/src/app/guards/streamer-route.guard.ts`.
- Add navigation entry from modules page or settings/security section.
- Add i18n keys in both:
  - `dimasite/src/assets/i18n/en.json`
  - `dimasite/src/assets/i18n/es.json`

Alternative: place it under Settings as a security card, but a dedicated module page is preferred because it contains history, live status, and advanced controls.

## UX Principles

1. **Safety first** — clearly explain that Attack Mode performs permanent bans.
2. **No interference** — global system toggle must be the first/most obvious setting.
3. **Progressive disclosure** — basic mode toggles first, advanced thresholds second.
4. **Raid-aware clarity** — visually separate raid tracking from bot attack behavior.
5. **Low panic design** — use warning colors sparingly; avoid making normal config look like an emergency.
6. **Action confirmation** — manual Attack Mode must require confirmation.
7. **Accessibility** — all controls need labels, descriptions, keyboard focus, and clear error states.

## Visual Direction

Use the current DimaSite authenticated dashboard style. Recommended tone:

- SaaS security dashboard
- modern glass/card surfaces
- clear status chips
- accessible warning colors
- subtle motion only
- no emoji icons as UI icons; use SVG/Lucide-style icons

Status color guidance:

| State | Suggested Treatment |
| --- | --- |
| Disabled | neutral gray, low emphasis |
| Normal | green / success chip |
| Silent | amber / caution chip |
| Protection | orange / elevated warning |
| Attack | red / danger treatment |
| Raid Tracking | purple/blue info treatment |

Keep WCAG AA contrast. Do not rely on color alone; include labels and icons.

## Page Layout

### 1. Header / Hero Summary

Content:

- Title: `Follow Defense`
- Subtitle: explain it protects against follow floods and hate raids.
- Current status chip:
  - Disabled
  - Normal
  - Silent Mode
  - Protection Mode
  - Attack Mode
  - Raid Tracking
- Primary action:
  - `Activate Attack Mode`
  - disabled if global system disabled
  - opens confirmation dialog

Include short helper text:

> Use this only when you are certain the current follow wave is hostile. This may permanently ban tracked followers.

### 2. Global Enable Card

This should be visually prominent.

Fields:

- Toggle: `Enable Follow Defense`
- Description:
  - EN: `Turn this off if you use another protection system or do not want DimaBot to interfere with follow alerts/moderation.`
  - ES: `Desactiva esto si usas otro sistema de protección o no quieres que DimaBot interfiera con alertas/moderación de follows.`

When disabled:

- gray out all automation cards
- keep history visible
- disable manual Attack Mode button
- show note: `Follow Defense is disabled. DimaBot will not queue defense events or suppress follow alerts.`

### 3. Mode Configuration Cards

Use three cards in a responsive grid.

#### Silent Mode Card

Fields:

- Toggle: `Silent Mode`
- Numeric input: `Follows threshold` default `10`
- Numeric input: `Detection window (seconds)` default `5`
- Numeric input: `Tracking duration (seconds)` default `60`

Description:

> If this many follows happen inside the detection window, DimaBot pauses follow alerts and tracks the wave.

#### Protection Mode Card

Fields:

- Toggle: `Protection Mode`
- Numeric input: `Protection threshold` default `100`

Description:

> If the wave grows past this threshold, DimaBot warns chat and bans new follows from the wave. During raids, DimaBot tracks silently instead.

#### Attack Mode Card

Fields:

- Toggle: `Attack Mode`
- Numeric input: `Attack threshold` default `500`
- Info row: `Manual command: !defmode -> $(bot.mode attack)`

Description:

> If this threshold is reached, or if a moderator uses your custom defense command, DimaBot bans all tracked follows from the wave.

### 4. Baseline / Sensitivity Card

Fields:

- Numeric input: `Expected follows per hour`

Description:

> Optional streamer-defined baseline. Use it as context for dashboards and future smart recommendations. It does not need to auto-calculate in the first UI version.

### 5. Live Status Card

Show current runtime status from `/status` endpoint when available.

Suggested data:

- Current mode
- Remaining seconds in current mode
- Tracked followers in current wave
- Current raid marker if present:
  - raider name
  - viewers
  - expires in
- Last transition reason

Loading/error behavior:

- show skeleton only on first load with no data
- show stale data with small `Refreshing...` indicator during background refresh
- surface errors in an inline banner with retry

### 6. Manual Attack Confirmation Dialog

Trigger: `Activate Attack Mode` button.

Dialog content:

- Title: `Activate Attack Mode?`
- Body:
  - `This will ban all followers currently tracked in the active follow wave and continue banning new follows until the mode expires or is reset.`
  - If raid active: `A raid is currently being tracked. Activating Attack Mode will mark this as a possible hate raid.`
- Confirm text: `Activate Attack Mode`
- Cancel text: `Cancel`
- Optional typed confirmation for stronger safety: require typing `ATTACK` if tracked count is high.

Button states:

- disable confirm while request is submitting
- show loading label
- show success toast / inline success
- show error if activation fails

### 7. Attack History Table

Columns:

- Date/time
- Triggered mode
- Triggered by: threshold/manual
- Total follows
- Velocity
- Raid?
- Raider channel, if any
- Banned count
- Details action

Details drawer/modal:

- tracked followers list
- follower ID/login/name
- followed at
- banned status
- ban error if any

Empty state:

> No follow defense events recorded yet.

### 8. Hate Raid Sources Card/Table

Columns:

- Raider channel
- Count
- First seen
- Last seen
- Last raid viewers, if available later

Description:

> Channels listed here were manually marked as hostile when Attack Mode was activated during a raid.

## Data Models for Frontend

Create or extend models under `dimasite/src/app/models/`:

```ts
export type FollowDefenseMode = 'normal' | 'silent' | 'protection' | 'attack';
export type FollowDefenseLanguage = 'en' | 'es';

export interface FollowDefenseSettings {
  channelID: string;
  channel: string;
  enabled: boolean;
  silentModeEnabled: boolean;
  protectionModeEnabled: boolean;
  attackModeEnabled: boolean;
  silentThresholdX: number;
  silentWindowYSeconds: number;
  protectionThresholdB: number;
  attackThreshold: number;
  silentDurationSeconds: number;
  baselineFollowsPerHour: number | null;
  language: FollowDefenseLanguage;
  settingsVersion: number;
}

export interface FollowDefenseStatus {
  mode: FollowDefenseMode;
  channelID: string;
  channelLogin: string;
  channelName: string;
  modeStartedAt: number;
  burstStartedAt: number;
  expiresAt: number;
  triggeredBy: 'threshold' | 'manual';
  lastTransitionReason: string;
  lastUpdatedAt: number;
  trackedCount?: number;
  raid?: FollowDefenseRaidMarker | null;
}

export interface FollowDefenseRaidMarker {
  raiderChannelID: string;
  raiderChannelLogin: string;
  raiderChannelName: string;
  raidViewers: number;
  createdAt: number;
  expiresAt: number;
}
```

## Service Plan

Create `dimasite/src/app/services/follow-defense-api.service.ts`.

Methods:

```ts
getSettings(channelID: string)
updateSettings(channelID: string, patch: Partial<FollowDefenseSettings>)
getStatus(channelID: string)
activateAttackMode(channelID: string)
resetMode(channelID: string)
getAttackLogs(channelID: string, page?: number, limit?: number)
getHateRaidSources(channelID: string, page?: number, limit?: number)
```

Use typed `ApiEnvelope<T>` responses.

## Angular Implementation Guidelines

- Use standalone components.
- Use signals for local UI state.
- Use Angular v21 control flow: `@if`, `@for`, `@empty`.
- For forms, prefer Angular signal forms from `@angular/forms/signals` if available in project; otherwise use reactive forms only if required.
- Disable buttons during async operations.
- Show errors to users; never swallow API errors silently.
- Use optimistic updates for toggles, but rollback and show error if save fails.
- Keep page-level/shared CSS in `dimasite/src/styles.css` per project styling policy.
- Component CSS should stay minimal.

## Suggested Component Breakdown

```txt
dimasite/src/app/features/follow-defense/
  follow-defense-page.component.ts/html/css
  follow-defense-settings-card.component.ts/html/css
  follow-defense-mode-card.component.ts/html/css
  follow-defense-status-card.component.ts/html/css
  follow-defense-attack-dialog.component.ts/html/css
  follow-defense-history-table.component.ts/html/css
  follow-defense-hate-raid-table.component.ts/html/css
```

If the app prefers fewer files, combine smaller cards into the page component initially, but keep API service and models separate.

## i18n Keys

Add matching keys in EN and ES.

Suggested namespace:

```json
{
  "followDefense": {
    "title": "Follow Defense",
    "subtitle": "Protect your channel from follow floods and hate raids.",
    "enabled": "Enable Follow Defense",
    "enabledDescription": "Turn this off if you use another protection system or do not want DimaBot to interfere with follow alerts/moderation.",
    "status": "Status",
    "activateAttack": "Activate Attack Mode",
    "silentMode": "Silent Mode",
    "protectionMode": "Protection Mode",
    "attackMode": "Attack Mode",
    "followsThreshold": "Follows threshold",
    "detectionWindow": "Detection window (seconds)",
    "trackingDuration": "Tracking duration (seconds)",
    "protectionThreshold": "Protection threshold",
    "attackThreshold": "Attack threshold",
    "expectedFollowsPerHour": "Expected follows per hour",
    "manualCommand": "Manual command",
    "history": "Attack history",
    "hateRaidSources": "Hate raid sources",
    "noHistory": "No follow defense events recorded yet."
  }
}
```

## Accessibility Checklist

- Every toggle has a visible label and description.
- Numeric inputs have labels, min values, and helper text.
- Danger actions require confirmation.
- Dialog traps focus and returns focus to trigger.
- Status color chips include text labels.
- Tables have proper headers.
- Empty/loading/error states are visible and descriptive.
- All clickable elements meet 44x44px target size.

## Responsive Behavior

- Mobile: single-column cards; attack button below status summary.
- Tablet: two-column mode cards where space allows.
- Desktop: header summary + status card top row; settings cards in three-column grid; history full width.
- Avoid horizontal table overflow by using stacked row cards on mobile or responsive scroll with clear affordance.

## Designer Agent Acceptance Criteria

- Streamer can clearly turn the entire system off.
- Streamer can configure each mode and thresholds.
- Streamer understands raid-aware behavior.
- Streamer can manually activate Attack Mode with confirmation.
- Streamer can review attack history and hate raid sources.
- UI supports EN/ES copy.
- UI follows current DimaSite authenticated layout and styling rules.
- UI handles loading, error, empty, and disabled states.
- No backend data writes are attempted unless matching endpoints exist.
