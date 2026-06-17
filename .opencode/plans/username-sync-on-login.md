# Implementation Plan: Sync Platform Account `name` on Sign-in

**Date:** 2026-06-15  
**Status:** In Progress (build phase)  
**Related Task:** Update stored Twitch (and future platform) account `name` when it changes on the platform.

## Goal
Every time a user signs in, the backend checks the `accounts` array for the matching platform (`type`) + `id`. If the stored `name` differs from the freshly resolved name (from incoming login payload or Twitch Helix), atomically update only that `accounts.$` entry's `name`.

## Scope
- **Endpoints:**
  - `POST /auth/login`
  - `GET /auth/register` (OAuth callback after activation)
  - `GET /auth/reauthenticate` (OAuth callback after re-auth)
- **Platforms:** Initially Twitch only. Design is platform-agnostic (filter by `type` + `id`).
- **Fields:**
  - Update only `accounts[].name`.
  - **Never** touch top-level `user.name` (that is the "first account name on creation" and must remain stable across platforms).

## Constraints & Invariants
1. One account record per platform type per user (schema + business rule). Safe to use MongoDB positional `$` operator with filter on `type` + `id`.
2. Use `info` level logging (`console.info`) so changes surface in structured logs / PostHog without being treated as warnings or errors.
3. Idempotent: if names match, do nothing (no DB write, no log spam).
4. In-memory object consistency: after a successful sync, the local `twitchAccount` / `user` object used for the response should reflect the new name where relevant (so the returned session data is fresh).

## Files Changed
- `dimabot/src/server/routes/auth.route.ts` (primary logic + logging)
- `.opencode/plans/username-sync-on-login.md` (this plan)

## Implementation Details

### 1. New Helper Function
Add near the other `getUserBy*` helpers (around line 180, after `getUserByUsername`):

```ts
async function syncAccountName(
  userId: Types.ObjectId,
  platformType: 'twitch' | 'youtube' | 'kick' | 'tiktok' | 'spotify',
  platformId: string,
  newName: string,
  oldName: string
): Promise<void> {
  if (!newName || !platformId || newName === oldName) {
    return;
  }

  await UsersSchema.updateOne(
    {
      _id: userId,
      'accounts.type': platformType,
      'accounts.id': platformId
    },
    { $set: { 'accounts.$.name': newName } }
  );

  console.info('[AUTH] Platform account name synced', {
    userId: userId.toString(),
    platform: platformType,
    platformId,
    oldName,
    newName,
    timestamp: new Date().toISOString()
  });
}
```

**Notes:**
- Generic over platform type for future-proofing (Kick, etc.).
- Early return if `newName` is falsy or identical.
- Single `console.info` with structured context (good for PostHog ingestion).

### 2. `POST /auth/login` Changes
**Location:** Inside `if (existingUser)` block, after the language sync block (~lines 878-885), before `cleanupLegacyBitsSubscriptions`.

Current code finds `twitchAccount` right after language check. Insert the sync right after the "twitch account not found" guard.

```ts
const twitchAccount = existingUser.accounts.find(acc => acc.type === 'twitch');
if (!twitchAccount) { ... }

// NEW: Sync name if the incoming normalizedLogin differs from stored name
if (normalizedLogin && twitchAccount.name !== normalizedLogin) {
  await syncAccountName(existingUser._id, 'twitch', id, normalizedLogin, twitchAccount.name);
  twitchAccount.name = normalizedLogin; // keep in-memory object consistent for response
}

await cleanupLegacyBitsSubscriptions(twitchAccount.id);
```

**Why here?** The `normalizedLogin` comes directly from the client payload (`login || name`), which is what the frontend sends on sign-in (usually the current Twitch login).

### 3. `GET /auth/register` Changes
**Location:** After `updateUserDataTokens` succeeds (~line 528), before the Polar ingest block. We already have `twitchAccount` and `twitchUser` in scope.

Current warning (around line 591):
```ts
if (twitchUser && twitchUser.login && twitchAccount.name !== twitchUser.login) {
  console.warn('[AUTH/REGISTER] State username differed...');
}
```

Replace / augment with the sync:

```ts
if (twitchUser?.login && twitchAccount.name !== twitchUser.login) {
  await syncAccountName(user._id, 'twitch', channelID, twitchUser.login, twitchAccount.name);
  twitchAccount.name = twitchUser.login; // in-memory consistency
}
```

We can keep a lighter log or remove the old warn entirely since the new `console.info` inside the helper is authoritative.

### 4. `GET /auth/reauthenticate` Changes
**Location:** After `updateUserDataTokens`, inside the `if (twitchAccount)` block (~lines 665-679).

Current code:
```ts
const twitchAccount = (updatedUser as IUsers).accounts.find(...);

if (twitchAccount) {
  await seedTwitchTokenCache(...);
  await TwitchStreamers.getTwitchAccountById(...);

  if (twitchUser && twitchUser.login && twitchAccount.name !== twitchUser.login) {
    console.warn('[AUTH/REAUTHENTICATE] State username differed...');
  }
}
```

Change to:
```ts
if (twitchAccount) {
  await seedTwitchTokenCache(twitchAccount.id, access_token, refresh_token, expires_in);
  await TwitchStreamers.getTwitchAccountById(twitchAccount.id);

  if (twitchUser?.login && twitchAccount.name !== twitchUser.login) {
    await syncAccountName(user._id, 'twitch', twitchAccount.id, twitchUser.login, twitchAccount.name);
    twitchAccount.name = twitchUser.login;
  }
}
```

Note: `user` is the original from `resolveOAuthUser`; `updatedUser` is after token update. We use `user._id` (or `updatedUser._id`) — both are fine.

### 5. Logging Strategy
- All name changes go through `syncAccountName` → single `console.info('[AUTH] Platform account name synced', { ... })`.
- Old `console.warn` blocks for "state username differed" are replaced or downgraded to avoid duplicate noise.
- The info log includes `userId`, `platform`, `platformId`, `oldName`, `newName`, `timestamp` — perfect for PostHog / log aggregation.

### 6. In-Memory Consistency
After calling `syncAccountName`, we mutate the local `twitchAccount.name = newName` (or the account object from the user doc) so that any subsequent response construction (or the objects returned in `/login` JSON) reflect the fresh name without requiring another DB read.

### 7. Future-Proofing
- The helper accepts any platform type string literal from the schema enum.
- When adding Kick / YouTube support, the same helper can be called with the appropriate `type` and resolved name from that platform's profile fetch.
- No schema changes required (`IAccounts.name` is already a plain string).

## Testing & Verification Checklist
- [ ] Existing user with old Twitch name `abc` logs in with current name `acd` → DB `accounts.name` becomes `acd`; top-level `user.name` stays `abc` (or whatever it was at creation).
- [ ] No change if names match → no DB write, no extra log.
- [ ] `/register` and `/reauthenticate` flows also sync correctly when Helix returns a different login.
- [ ] Info log appears at `console.info` level (not warn/error).
- [ ] Multiple platforms (twitch + kick) on same user → only the matching platform entry is touched.
- [ ] `npm run build` in `dimabot/` completes with zero TypeScript errors.
- [ ] Manual or integration test via frontend login after a username change on Twitch.

## Rollout Notes
- This is a low-risk additive change (read + conditional write on existing path).
- No migration needed; existing documents will be updated lazily on next sign-in.
- Monitor the new info logs for a few days to confirm username change detection works in the wild.

## Plan File Location
This document lives at: `.opencode/plans/username-sync-on-login.md`
