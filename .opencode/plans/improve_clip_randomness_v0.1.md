# Plan: Improve Clip Fetching + Anti-Repetition (Grok Build 0.1)

## Goal
Reduce repetitive clips shown during shoutouts and promos.

## Confirmed Decisions (user answers)
- Tracking scope: per **target** (the owner of the clips)
- Retention: 24-hour window; reset when the current clip batch has all been shown
- Cache usage: shoutout/promo now use cache (only fallback on empty/error)
- Fetch amount: **50** (configurable constant)
- Cache TTL: **5 hours**
- Reroll: exactly **1** reroll attempt (configurable constant)

## What Was Implemented

### 1. Tunables (single source of truth)
**File:** `dimabot/src/functions/clips/get_clips.clip.ts`

Exported constants:
```ts
export const DEFAULT_CLIP_FETCH_AMOUNT = 50;
export const CLIP_CACHE_TTL_HOURS = 5;
export const MAX_RANDOM_REROLLS = 1;
export const SHOWN_CLIPS_TTL_SECONDS = 24 * 60 * 60;
```

- `getChannelClips` now defaults `amount` to `DEFAULT_CLIP_FETCH_AMOUNT`
- Cache write uses `CLIP_CACHE_TTL_HOURS` (was hardcoded 3h)

Re-exported from `dimabot/src/functions/clips/index.ts` for easy access.

### 2. Smarter Selection + Shown-Clip Tracking
**File:** `dimabot/src/functions/clips/show_clip.clip.ts`

Logic (per target = `streamerData.id`):

1. Read shown set: `twitch:{targetChannelID}:clips:shown` (Redis Set)
2. Filter incoming clip list to exclude shown IDs
3. If filter result is empty → delete the shown key (full cycle reset) and use full list
4. Pick random from the effective (filtered) list
5. If the pick is in the shown set **and** we have reroll budget (`attempts < MAX_RANDOM_REROLLS`):
   - Reroll once
   - If reroll also collides → accept it (per spec)
6. After successfully queuing the clip:
   - `SADD` the clip `id` into the shown set
   - `EXPIRE` the key to `SHOWN_CLIPS_TTL_SECONDS`
7. All cache operations are best-effort; on error we fall back to simple random so the feature never breaks playback.

Two recording sites (game-fallback path + normal path) both call the record logic.

### 3. Call-Site Updates (stop forcing fresh API calls)
- `dimabot/src/commands/shoutout.command.ts`
  - Before: `getChannelClips(targetUserData.id, null, true)`
  - After:  `getChannelClips(targetUserData.id)`

- `dimabot/src/functions/promo/chat.promo.ts`
  - Before: `getChannelClips(streamerData.id, null, true)`
  - After:  `getChannelClips(streamerData.id)`

- `dimabot/src/commands/promo.command.ts`
  - Before: `getChannelClips(..., null, true)`
  - After:  `getChannelClips(...)`

### 4. New Dragonfly Key
- `twitch:{channelID}:clips:shown` — Redis **Set** of clip IDs
  - TTL: 86400s (24h) or deleted on full-cycle reset

### 5. Build Verification
- `cd dimabot && npm run build` → clean `tsc` (no errors)

## Configurability for Later
To change behavior later:
- Raise to 100 clips → set `DEFAULT_CLIP_FETCH_AMOUNT = 100`
- 10h cache → `CLIP_CACHE_TTL_HOURS = 10`
- N rerolls → `MAX_RANDOM_REROLLS = N`
- Different shown TTL → `SHOWN_CLIPS_TTL_SECONDS = ...`

All constants are exported and documented in the source.

## Edge Cases Handled
- Empty cache / cache error in `getChannelClips` → internal `skip_cache=true` fallback still works
- Twitch returns fewer than 50 clips → use what we have
- All clips in current batch marked shown → auto-reset the per-target set
- Cache read/write failures in `showClip` → degrade to plain random selection
- No clips at all → original error paths preserved

## Files Modified
- `dimabot/src/functions/clips/get_clips.clip.ts`
- `dimabot/src/functions/clips/show_clip.clip.ts`
- `dimabot/src/functions/clips/index.ts`
- `dimabot/src/commands/shoutout.command.ts`
- `dimabot/src/functions/promo/chat.promo.ts`
- `dimabot/src/commands/promo.command.ts`

## Rollback Notes
All changes are additive (new constants + extra logic inside existing functions). Reverting to previous behavior is possible by:
- Restoring the three call sites to pass `null, true`
- Reverting the selection block in `show_clip.clip.ts` to the original two-line random pick
- Changing cache TTL constant back to 3

---

**Status:** Implemented and built successfully (Grok Build 0.1).
