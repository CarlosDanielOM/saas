# Findings in the running TypeScript

The Rust migration was paused on 2026-11-12, so the TypeScript on `master` stays in production and
none of what follows is closed by a cutover. This file gathers, in one place and by urgency, what
the migration found in the TypeScript while porting it. Nothing here has been changed in the
TypeScript. Each line says how it is known: **recorded** (the real TypeScript was run and did
this), **read** (seen in the source, not executed), or **data** (seen in the copy of the production
database). Paths are under `dimabot/src/` unless they name another project. The fuller notes, and
what the Rust port does instead, are in `packages.md` (table "Known reference bugs and security
findings"), `upper-layers.md` (section 4) and `reviews/`.

## 1. Reachable by anyone, without signing in

| # | What | Where | Known | Smallest fix |
|---|---|---|---|---|
| 1 | **One request makes the bot process exit.** A request to the EventSub endpoint with a non-JSON or missing content type feeds an object to the HMAC; one with a signature of the wrong byte length makes `timingSafeEqual` throw. Nothing catches either. Repeated, it keeps the bot down. | `bot/eventsub.twitch.ts:282`, `:292` | recorded | Refuse unless the body is a buffer; compare lengths before `timingSafeEqual`; wrap the check in `try` and answer 403 |
| 2 | **Anyone can make a channel speak.** `POST /speech/:channelID` has no authentication: a channel with TTS on speaks the given text on stream and its AI credits are spent. The bot is its only caller. | `server/routes/speech.route.ts:423` | read | Require a shared service token in a header the bot sends, compared in constant time |
| 3 | `POST /users/premium` has no authentication and puts body values straight into a MongoDB filter: it reveals a user's plan, and accepts query operators. | `server/routes/user.route.ts:142` | read | Require a signed-in user; cast `channel` and `channelID` to strings |
| 4 | `POST /overlays/furry/:channelID` is open: anyone can push text to a channel's overlay. No caller in the repository. | overlay routes | read | Remove it, or require the channel's overlay token |
| 5 | `GET /auth/mock-register` has no guard; `POST /auth/mock-login` is live whenever `MOCK_LOGIN_TOKEN` is set, and it is set in production. | `server/routes/auth.route.ts:1168` and above | read | Remove both from production builds, or unset the variable |
| 6 | `POST /auth/login` trusts the id in the body: it returns the account's e-mail and can rename the account. | `server/routes/auth.route.ts:968` | read | Verify the Twitch token against the id |
| 7 | The OAuth rate limit of the desktop sign-in is one bucket for everyone (`req.ip` with proxy trust off): one client can lock every user out. | `server/oauth/routes.ts:83`, `:178` | recorded | `app.set('trust proxy', …)` for the reverse proxy, or key on the forwarded address |
| 8 | An unknown command name costs a MongoDB query on every chat message, and `commands` has no index on `channelID`: a viewer typing `!x` repeatedly forces a collection scan each time. | `classes/command.class.ts` | recorded, data | Add the index `{channelID: 1, cmd: 1}`; cache "no such command" |

## 2. Reachable by a signed-in streamer or channel manager

| # | What | Where | Known | Smallest fix |
|---|---|---|---|---|
| 9 | **A command can stall or crash the bot for every channel.** The command language has no limit on work: four nested loops on the Pro plan run a body 100 million times; text can double in a loop without bound; `$(replace)` builds its result with no size check. | `utils/ast_parser/evaluator.ts`, `utils/ast_parser/functions/string.functions.ts:74` | read (the unbounded cases were reproduced in the first, faithful Rust port) | A step counter and a size check in the evaluator's loop and in `replace` |
| 10 | Any signed-in user can create or change the global event templates shown to every streamer. | `server/routes/site.route.ts:66`, `:226` | read | Add the admin middleware |
| 11 | The PATCH routes for EventSub settings, events and rewards write the request body as given: a channel manager can set `channelID` and move a document (for an EventSub setting, a message the bot then posts) into another channel, and can send update operators that skip plan checks. | `server/services/eventsub_config.service.ts:477`, `server/routes/reward.route.ts:363`, `server/services/command_mutations.service.ts:281` | read | Pick the allowed fields; never spread `req.body` into an update |
| 12 | The validation cache key is the raw Twitch user token (`token:<token>`): anyone who can list Dragonfly keys (the DB console, the analytics service) can read live tokens. The expiry is set by a second command (if it fails the entry never expires), and 14,000 s outlives a revocation. | `middleware/auth.middleware.ts:122`, `:164`, `:173`, `:16` | read | Key on a hash of the token; `SET … EX` in one command; one hour |
| 13 | The admin site finds the super admin by Twitch login (`cdom201`), which Twitch lets a user change and someone else claim later. | `server/routes/admin_site.route.ts:72`, `:140` | read | Compare the Twitch id |
| 14 | With `BILLING_ALLOWED_REDIRECT_HOSTS` unset (as in production) any URL is accepted as a checkout return URL, `javascript:` included. | `utils/billing.ts` | recorded | Set the variable; refuse non-HTTP schemes |
| 15 | The activation JWT falls back to a hard-coded secret when `EMAIL_AUTH_JWT_SECRET` is unset. | `utils/email/email-activation-token.ts:8` | read | Refuse to start without the variable |
| 16 | `GET /admin/read-file` checks the raw path, so `../` passes (owner only; its directories do not exist in the production containers, so it can only fail today). | admin routes | read | Remove it |
| 17 | The DimaFX service token and the OAuth refresh-token hash are compared with `!==`. | `dimafx/server`, `server/oauth/service.ts` | read | `timingSafeEqual` on equal-length buffers |

## 3. Money

| # | What | Where | Known |
|---|---|---|---|
| 18 | The usage flush to Polar can delete usage that was never sent (an 8-second lock that is not checked again, then a trim by length), cannot flush a large backlog at all, and one event Polar refuses blocks that channel's queue for ever. | `utils/polarsh.ts` | read (reproduced in the first, faithful Rust port) |
| 19 | A grant retried after a lost reply is a second grant: the id is drawn per call. The admin grant also credits the cache when Polar's figure already includes it. | `utils/polarsh.ts`, `utils/billing.ts`, admin routes | read (reproduced in the faithful Rust port) |
| 20 | A Bits purchase checks and then inserts, and the index on `extensionwallettransactions.twitchTransactionID` is not unique in production though the schema declares it so: two deliveries of one transaction can both be fulfilled. The copy holds no duplicate today. | `server/routes/dimafx.route.ts:735` | read, data |
| 21 | Two plan changes can apply their retention out of order: a Free write finishing late deletes a Premium channel's usage history. A slow balance fetch overwrites a newer balance or a debit made meanwhile. | `utils/billing.ts`, `utils/ai_usage_ledger.ts:417` | read |
| 22 | With `POLARSH_ENVIRONMENT=sandbox` some SDK calls still go to production. | `utils/polarsh.ts` | read |
| 23 | A paid gift whose process dies between claiming and sending its fulfilment stays at `needs_support`. Referral conversions are counted on the code as typed, while codes are stored in lower case. | `utils/credit_gifts.ts`, `utils/referral.ts` | recorded, read |

## 4. Features that do not work as meant

| # | What | Where | Known |
|---|---|---|---|
| 24 | Enabling or disabling a redemption from a command fails for 26 of the 69 stored rewards ("Only Twitch redemptions are supported"): the read skips the schema default of `createdFor`. | `utils/availability/service.ts:48`, `:81` | recorded, data |
| 25 | `$(count)` can lose increments: the count is stored with `$set` from a command cached for up to an hour. A command changed in the dashboard can be served stale for up to an hour after a racing read. | `handlers/commands.handler.ts:205`, `classes/command.class.ts:147` | recorded |
| 26 | The timed VIP redemption never works (the stored document lacks a required field): the viewer's points are spent, the reward's cost may be raised, no VIP is granted. The owner has dropped the feature. | `functions/redemptions/vip.redemption.ts:103` | recorded, data |
| 27 | `automod.message.hold` is sent to Twitch without the `moderator_user_id` it requires, so it has never been subscribed. | `utils/eventsub.ts:328` | read, data |
| 28 | When Twitch refuses or does not answer a batch, the stream analytics tick closes the live sessions of the channels it could not see. | `utils/stream_analytics.ts` (tick) | recorded |
| 29 | The EventSub reconciliation ignores transport and callback, so it would delete another environment's subscriptions as duplicates (it is off in production). A subscription Twitch dropped stays off for 12 hours. | `utils/eventsub_reconciliation.ts:269`, `:229` | recorded |
| 30 | The links rule of chat moderation is passed by `example . com`, `example[.]com`, an IP address or a full-width dot. A blacklist pattern RE2 cannot compile lets the whole message through and skips every later rule. | `utils/moderation/rules/links.rule.ts:11`, `handlers/moderation.handler.ts:249` | recorded |
| 31 | The public live-channels board is published partial or empty when Twitch fails a batch, and a slow partial refresh can overwrite a newer complete board. | `utils/siteanalytics.ts` | recorded |
| 32 | Responses written with `%(responses[] …)` are never saved: the flag that enables saving is never set. | `utils/ast_parser/evaluator.ts:1326` | read |
| 33 | A scan of followers overwrites the time of an earlier re-follow. | `utils/follow_ledger.ts` | recorded |
| 34 | An app or bot token Twitch has revoked keeps failing until its cache key expires (about 58 days): a 401 is retried with the same token. | `utils/twitch_helix_retry.ts`, `utils/tokens.ts` | read |
| 35 | A Twitch delivery that can never be valid is answered 503, so Twitch redelivers it until it gives up. | `bot/eventsub.twitch.ts` | recorded |
| 36 | A retried chat message counts twice in a session's message total; an offline event without a key can lose its post-stream summary or clip job if the process dies in between. | `utils/stream_analytics.ts` | recorded |
| 37 | Production holds 769 confirmed "known user fact" AI memories about the channel itself, which current code would refuse to create, and no confirmed viewer fact carries a user id, so viewer-fact recall is always empty. | `channelaimemories` | data |

## 5. Lower risk, for completeness

- `utils/video.ts:29` builds a `yt-dlp` shell command by interpolation; the URL comes from Twitch's API through the clip queue, not from a viewer (read, traced).
- `server/routes/file.route.ts:23` joins a decoded `:channelID` into a path; it can only reach files ending in `-clip.mp4` (read).
- `server/services/media_library.service.ts:88`, `:104`, `:109` build file names and S3 keys from the raw name and extension (read).
- The command arguments as typed and the spoken TTS text are sent to PostHog; nothing in the repository reads them back (recorded).
- Every log level is sent to PostHog (`utils/logger.ts:130`); S3 uploads are `public-read` (`utils/s3.ts:34`) (read).
- The `dimadb` console lets an operator run arbitrary Lua (`dimadb/server/redis.mjs:182`) (read).
- Two one-off scripts still match rows in the copy: `migrate_ast_variables_global` (9) and `cleanup_orphaned_clip_recommendations` (19) (data; the copy is stale).
- Collections that are empty in the copy, so their features look unused: `temporary_moderators`, `vips`, `duel_moderator_restores`, `follow_defense_actions`, `overlay_deliveries`; DimaFX has no playbacks and one channel's items, last touched in July (data).
