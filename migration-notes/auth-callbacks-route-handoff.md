# Auth callbacks slice 15 — blocked, authoring incomplete

Source: `dimabot/src/server/routes/auth.route.ts`, SHA-256
`05a6718d45f27365632ce7928a71a89d1b2e5a9e0e0e3a2a7dc919c8d17b806f`.
This is a static discovery handoff, not an implementation or validation. No
callback Rust module, oracle, replay, or private fixtures have been authored.
Do not mount or accept this slice until those are supplied and verified.

## Callback sequencing to preserve

Both endpoints reject missing code/state with 400 text, exchange the code using
the host-derived callback URI, resolve the Twitch user by token and then by ID
before falling back to the state username, and activate/update encrypted tokens.
An exchange error yields 400 text; missing user yields 404 text; thrown errors
yield 500 text. The token update helper returns a truthy error object for missing
tokens, not null; this unusual path must not be silently changed.

Register first locates the original Twitch account and records whether it was
inactive. After token update it awaits first-activation Polar ingestion, starts
welcome delivery without awaiting it, awaits first-activation moderation seed,
refreshes the account directory, writes five token-cache fields sequentially,
and looks up the account. If found, it adds moderator 698614112; any error
other than `user is already a mod` returns the provider status and JSON. It then
subscribes EventSubs sequentially (including raid repair checks) and ensures
reserved commands. Finally it synchronizes a changed Twitch login, increments
`active`, and redirects to `https://domdimabot.com/login`. EventSub response
errors are logged and iteration continues; thrown errors leave the route via
the outer 500 handler. Moderation seed catches its own errors, subject to its
logging operation. Welcome delivery is detached and catches its own rejection.

Reauthentication refreshes the directory immediately after updating tokens;
only if the updated user has a Twitch account does it seed token cache, look up
the directory account, and synchronize the login. It then redirects. It does
not run registration's Polar, mail, moderation, EventSub, commands or analytics.
Dropping a Rust request future must not accidentally cancel the detached welcome
delivery; no other work should be detached. Partial remote side effects and
Mongo/cache writes must not be retried implicitly on cancellation or failure.

## Reuse and single-owner gaps

- Team 1 (billing): `utils/polar_usage.rs` provides `ingest_polar_sh_event_mode`;
  wire and compare the exact immediate `-25` / `Free benefits` invocation and
  its returned-error versus thrown-error behavior. It is not enough to use the
  generic `polarsh.rs` transport alone.
- Team 3 (bot): `utils/eventsub.rs` has native subscription primitives and
  condition helpers, but the callback needs the actual subscription catalog,
  raid preference/repair decision and concrete directory/store wiring, plus the
  complete add-moderator operation and its moderator-cache side effects. Native
  `moderation/seed_plan.rs` is a pure plan; the Mongo race handling and cache
  prime/invalidate behavior in `moderation/defaults.ts` still need a concrete
  adapter. Team 3 owns these application-specific adapters.
- Team 2 (API/data): `CredentialCipher`, native Twitch HTTP primitives,
  `TwitchStreamers` and Mongo/Redis directory adapters, `SiteAnalyticsService`,
  `CommandDefaultsStore`, and rendered-email delivery are reusable. Callback
  code exchange, Helix-user lookup, positional Mongo update/name sync, ordered
  Redis token seeding and wiring still need callback-specific implementation and
  parity review. The Rust mail service accepts rendered content; no native
  welcome template/rendering was found. Team 2 owns the welcome rendering and
  detached delivery adapter. The directory's `reconcile` / `account_by_id`
  semantics must be compared with the TypeScript methods before treating them
  as substitutes.
- Integration owner: register the feature, module, dependencies and `/auth`
  mount only after the actual implementation exists. No central snippet can be
  specified safely before its API and feature dependencies are defined.

The source oracle must execute the pinned actual TypeScript in Express using
matched seam doubles, and replay native responses *and ordered side effects*,
including first/repeat activation, missing account/token, provider errors,
detached mail, moderator rejection, skipped raids, and thrown failures at each
await. Author task-owned private Mongo and loopback fixtures for concrete
adapters; never send real email or call Twitch or billing. Pin the source digest
and external fixture digest, and cover cancellation and partial-write behavior.
No tests, tools that execute application code, production resources, or network
were used in this authoring pass.
