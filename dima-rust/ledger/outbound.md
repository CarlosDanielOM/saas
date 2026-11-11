# Outbound network calls: inventory for the Rust port

Generated 2026-11-11 on branch `rust-v2`. Machine-readable twin: [`outbound.json`](outbound.json) (same IDs). This list is the checklist for "100% migrated": every live row needs a Rust equivalent or an explicit drop decision.

## Summary

- **199 call rows** (187 live, the rest dead/implicit/Rust foundations), **23 providers/targets**, **24 distinct hosts/endpoints** for the mock rig.
- Twitch: 86 rows over 60 distinct method+endpoint pairs (Helix + OAuth, incl. 3 Rust).
- Coverage: 133 `fetch(`-style call sites found by search; 121 recorded as their own row, 12 accounted for with a reason (wrapper bodies, prompt text, dev-only hooks, grouped duplicates) - 0 unaccounted. Plus 1 indirect call (`ai.ts:527`, ternary `fetch`) and every SDK method call, found separately.
- Processes are from a static import graph (entrypoint reachability); `cron (shared)` means the module is reachable from many workers, not that each calls it. Real triggers are noted where known.

### Not present (checked, zero hits)

- Google Gemini (@google/genai declared, never imported)
- xAI (no api.x.ai / grok client)
- gTTS (declared, never imported)
- Spotify (only an `spotify` literal in getAppToken platform union, utils/tokens.ts:505; no calls)
- StreamElements API (only media CDN copy; no StreamElements REST/JWT calls)
- Twitch GQL, usher/VOD playlist, clips.twitch.tv download, static-cdn.jtvnw.net fetches (URLs only built as strings for clients)
- Twitch OAuth revoke (no oauth2/revoke call anywhere)
- Twitch EventSub WebSocket/Conduits and IRC (tmi.js declared, no import; chat arrives via EventSub webhooks)
- S3 presigning and multipart upload

### How coverage was verified

- grep of fetch(/fetchWithRetry(/audioFetch(/videoFetch(/fetchStreamSummary(/safeFetch(/deps.fetch( and indirect `(cond ? fetch : fetchWithRetry)(` (ai.ts:527) across all scoped trees, excluding *.test.ts/*.spec.ts
- grep of every SDK import (@anthropic-ai/sdk, @google/genai, @polar-sh/sdk, @qdrant/qdrant-js, @aws-sdk/*, resend, posthog-node, fish-audio, gtts, @opentelemetry/*, standardwebhooks, ws, tmi.js) and every SDK method call
- grep of every literal http(s)/ws(s) host
- static import-graph reachability from each entrypoint to attribute processes (over-approximates: a shared util reachable from a worker is not necessarily called by it)
- SDK defaults read from the installed node_modules versions, not from memory
- Excluded `fetch(` sites and why:
  - `dimabot/src/utils/ai/fetch.utils.ts:45`: wrapper body (createFetchWithRetry)
  - `dimabot/src/utils/ai/memory/stream_summary_decider.simulate.ts:161`: dev simulation fetch-hook (unreachable)
  - `dimabot/src/utils/ai/memory/stream_summary_decider.run.ts:113`: dev runner fetch-hook (unreachable)
  - `dimabot/src/widget_feed/badges.ts:62`: DI default (deps.fetch) -> recorded at badges.ts:37
  - `dimabot/src/utils/ai/tools/code_execution.tool.ts:246`: text inside LLM prompt template
  - `dimabot/src/utils/ai/tools/code_execution.tool.ts:274`: text inside LLM prompt template (example code for sandbox)
  - `dimabot/src/custom_widgets/media.ts:46`: safeFetch body -> recorded as UU rows (media.ts:66,89)
  - `dimabot/src/commands/sumimetro.command.ts:101`: grouped into sumimetro row (:88)
  - `dimabot/src/commands/sumimetro.command.ts:120`: grouped
  - `dimabot/src/commands/sumimetro.command.ts:134`: grouped
  - `dimabot/src/utils/credit_gift_provider.ts:91`: giftPolarRequest wrapper body -> recorded per caller (PO rows with 15s timeout)
  - `dimabot/src/utils/billing.ts:482`: polarRequest wrapper body -> recorded per caller

## Shared mechanics (apply to many rows)

- **Twitch headers** (`dimabot/src/utils/header.ts`): `Client-Id: $CLIENT_ID`, `Authorization: Bearer <token>`, `Content-Type: application/json` on every Helix call (also GET). Token kinds: *app* (client_credentials, Dragonfly `app:twitch:token`, `utils/tokens.ts:481,505`), *streamer* (Mongo user token, `header.ts:74`), *bot* (account 698614112, `header.ts:42,122,138`; all moderation runs as the bot).
- **Twitch token refresh** `POST id.twitch.tv/oauth2/token grant_type=refresh_token` (`utils/tokens.ts:175`): 3 attempts, 400/900 ms backoff, retry only on network error/5xx; permanent failures (400/401 "invalid refresh token"/revoked) invalidate stored tokens (`tokens.ts:39-63`).
- **401 retry wrapper** `utils/twitch_helix_retry.ts`: on 401 refresh then retry after 1s/3s/5s; streamer variant stops if refresh returns the same token and reports 503. Only rows that say so use it; most Helix calls have **no retry, no timeout and no 429 handling**. Only `ban.moderation.ts` (reads Ratelimit-*/Retry-After) and `overlays/ad-schedule.ts` (reschedules on 429) look at rate-limit headers.
- **AI retry wrapper** `utils/ai/fetch.utils.ts:26` createFetchWithRetry: per-attempt timeout, fixed delays (default 1s/3s/5s), retry on network error/timeout and 429/500/502/503/504, ignores Retry-After, returns the last response.
- **OpenRouter attribution headers** `utils/ai/openrouter/app_attribution.util.ts:2-7`: `HTTP-Referer: https://domdimabot.com`, `X-OpenRouter-Title: DomDimaBot`, `X-OpenRouter-Description`, `X-OpenRouter-Categories: general-chat, roleplay`. Older call sites still send `X-Title: DomDimaBot` instead (code_execution, stream_summary_decider, clip recommendations, dead messages.ai.ts). `user` = channel ID for per-channel attribution.
- **instrumentFetch** (`utils/observability/telemetry.ts:145-171`, installed in API and bot only) wraps global fetch: spans per provider, and for hosts `dima-server`/`127.0.0.1` adds `traceparent` + `x-observability-signature` (HMAC). Skips `us.i.posthog.com` and `dima-analytics`.
- **Default timeouts**: Node 22 fetch (undici) has no total timeout; headers/body timeouts are 300 s each. "none" below means that.

## Twitch (Helix + OAuth) (86)

Auth column: app / streamer / bot / user / client-secret (see Shared mechanics). Consequence column flags money/moderation/roles.

| ID | Method | Endpoint | Query / body | Auth | Timeout | Retry | Errors / rate limit | Consequence | Where | Processes | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| TW-001 | GET | `id.twitch.tv/oauth2/validate` |   | user | 3000 | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `dima-analytics/src/index.mjs:41` | dima-analytics | Validates the caller token with `Authorization: OAuth <token>`, 3s; result cached in Dragonfly observability:v1:identity:* for <=60s. |
| TW-002 | GET | `api.twitch.tv/helix/channels/followers` | broadcaster_id; user_id  | streamer | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `commands/followage.command.ts:49` | api; bot |  |
| TW-003 | GET | `api.twitch.tv/helix/streams` | user_id: channelID  | app | 10000 | 401-refresh | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `domain_events/stream_operations_events.ts:194` | api; cron:domain_events\|stream_analytics | app token with 401 refresh retry; 10s timeout. |
| TW-004 | POST | `api.twitch.tv/helix/moderation/moderators` | broadcaster_id; user_id  | streamer | none | none | checks status codes 204; rl: none (no Ratelimit-* / 429 handling) | role change (moderator) | `functions/channels/add_moderator.channel.ts:39` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-005 | POST | `api.twitch.tv/helix/channels/vips` | user_id: userID,             broadcaster_id: channelID  | streamer | none | none | checks status codes 204; rl: none (no Ratelimit-* / 429 handling) | role change (VIP) | `functions/channels/add_vip.channel.ts:32` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-006 | GET | `api.twitch.tv/helix/channels/editors` | broadcaster_id: channelID  | streamer | 10000 | 401-refresh | checks status codes 401,403; rl: none (no Ratelimit-* / 429 handling) |  | `functions/channels/get_editors.channel.ts:25` | api; bot; cron:11 workers (shared util); script:4 scripts | streamer token with 401 refresh retry; 10s timeout. |
| TW-007 | GET | `api.twitch.tv/helix/channels/followers` | broadcaster_id: channelID  | streamer | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `functions/channels/get_followers.channel.ts:33` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-008 | GET | `api.twitch.tv/helix/channels` | broadcaster_id: channelID  | app | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `functions/channels/get_information.channel.ts:31` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-009 | GET | `api.twitch.tv/helix/subscriptions` | broadcaster_id: channelID  | streamer | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `functions/channels/get_subs.channel.ts:34` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-010 | GET | `api.twitch.tv/helix/streams` | user_id: channelID  | app | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `functions/channels/is_live.channel.ts:19` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-011 | GET | `api.twitch.tv/helix/streams` | type: 'live'; user_id  | app | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `functions/channels/is_live.channel.ts:82` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-012 | POST | `api.twitch.tv/helix/raids` | from_broadcaster_id; to_broadcaster_id  | streamer | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) | channel action (raid) | `functions/channels/raid.channel.ts:32` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-013 | DELETE | `api.twitch.tv/helix/moderation/moderators` | broadcaster_id; user_id  | streamer | none | none | checks status codes 204; rl: none (no Ratelimit-* / 429 handling) | role change (moderator) | `functions/channels/remove_moderator.channel.ts:32` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-014 | DELETE | `api.twitch.tv/helix/channels/vips` | user_id: userID,             broadcaster_id: channelID  | streamer | none | none | checks status codes 204; rl: none (no Ratelimit-* / 429 handling) | role change (VIP) | `functions/channels/remove_vip.channel.ts:32` | api; bot; cron:11 workers (shared util); script:4 scripts |  |
| TW-015 | PATCH | `api.twitch.tv/helix/channels` | broadcaster_id body: newInformation) | streamer | none | none | checks status codes 204; rl: none (no Ratelimit-* / 429 handling) | channel metadata change (title/category) | `functions/channels/set_information.channel.ts:36` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-016 | DELETE | `api.twitch.tv/helix/raids` | broadcaster_id  | streamer | none | none | checks status codes 204; rl: none (no Ratelimit-* / 429 handling) | channel action (raid) | `functions/channels/unraid.channel.ts:30` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-017 | POST | `api.twitch.tv/helix/chat/announcements` | broadcaster_id: channelID,             moderator_id: TWITCH_BOT_ACCOUNT_ID body: bodyData) | bot | none | none | checks status codes 204; rl: none (no Ratelimit-* / 429 handling) | public chat output | `functions/chats/announcement.chat.ts:42` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-018 | DELETE | `api.twitch.tv/helix/moderation/chat` |   | bot | none | none | checks status codes 204; rl: none (no Ratelimit-* / 429 handling) | moderation (clear chat / delete message) | `functions/chats/clear_chat.chat.ts:30` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-019 | DELETE | `api.twitch.tv/helix/moderation/chat` |   | bot | none | none | checks status codes 204; rl: none (no Ratelimit-* / 429 handling) | moderation (clear chat / delete message) | `functions/chats/delete_message.chat.ts:31` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-020 | GET | `api.twitch.tv/helix/chat/chatters` | broadcaster_id; moderator_id  | bot | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `functions/chats/get_chatters.chat.ts:35` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-021 | GET | `api.twitch.tv/helix/chat/settings` |   | bot | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `functions/chats/get_only_emotes.chat.ts:34` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-022 | GET | `api.twitch.tv/helix/chat/settings` |   | bot | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `functions/chats/get_settings.chat.ts:30` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-023 | GET | `api.twitch.tv/helix/chat/color` |   | app | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `functions/chats/get_user_color.chat.ts:16` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-024 | GET | `api.twitch.tv/helix/chat/pins` |   | bot | 10000 | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `functions/chats/pinned_messages.chat.ts:208` | api; bot; cron:10 workers (shared util); script:4 scripts | moderator_id=bot; readTwitchPayload parses JSON/empty bodies. |
| TW-025 | PUT | `api.twitch.tv/helix/chat/pins` |   | bot | 10000 | none | checks status codes 204; rl: none (no Ratelimit-* / 429 handling) | moderation (pinned message) | `functions/chats/pinned_messages.chat.ts:298` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-026 | PATCH | `api.twitch.tv/helix/chat/pins` |   | bot | 10000 | none | checks status codes 204; rl: none (no Ratelimit-* / 429 handling) | moderation (pinned message) | `functions/chats/pinned_messages.chat.ts:392` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-027 | DELETE | `api.twitch.tv/helix/chat/pins` |   | bot | 10000 | none | checks status codes 204; rl: none (no Ratelimit-* / 429 handling) | moderation (pinned message) | `functions/chats/pinned_messages.chat.ts:479` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-028 | POST | `api.twitch.tv/helix/chat/messages` |  body: body), | app | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) | public chat output | `functions/chats/send_message.chat.ts:90` | api; bot; cron:10 workers (shared util); script:4 scripts | sender_id = bot (MODERATOR_ID); body {broadcaster_id,sender_id,message,for_source_only:true,reply_parent_message_id?}; APP token (chat:bot scope path); is_sent=false logged as held-for-moderation. |
| TW-029 | PATCH | `api.twitch.tv/helix/chat/settings` |  body: { | bot | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) | moderation (chat mode change) | `functions/chats/set_only_emotes.chat.ts:32` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-030 | POST | `api.twitch.tv/helix/chat/shoutouts` | from_broadcaster_id; moderator_id; to_broadcaster_id  | bot | none | none | checks status codes 204; rl: none (no Ratelimit-* / 429 handling) | public chat output | `functions/chats/shoutout.chat.ts:36` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-031 | POST | `api.twitch.tv/helix/clips` | broadcaster_id; duration; title  | bot | none | none | checks status codes 202,404; rl: none (no Ratelimit-* / 429 handling) | creates public clip | `functions/clips/create.clip.ts:58` | api; bot; cron:10 workers (shared util); script:4 scripts | params broadcaster_id, duration?, title? (Create Clip with bot token); 202 success, 404 offline. |
| TW-032 | GET | `api.twitch.tv/helix/clips` | id  | app | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `functions/clips/get_clip.clip.ts:43` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-033 | GET | `api.twitch.tv/helix/clips` | broadcaster_id; first  | app | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `functions/clips/get_clips.clip.ts:68` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-034 | POST | `api.twitch.tv/helix/moderation/bans` | broadcaster_id: channelID,             moderator_id: moderatorID body: bodyData) | bot | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: handled | moderation (ban/timeout) | `functions/moderation/ban.moderation.ts:76` | api; bot; cron:10 workers (shared util); script:4 scripts | body {data:{user_id,duration?,reason?}}; moderator_id = caller-supplied moderatorID while token is the BOT token (mismatch => Helix 401). Reads Ratelimit-Remaining/Ratelimit-Reset/Retry-After (ban.moderation.ts:24-38) and returns them; no automatic retry. |
| TW-035 | GET | `api.twitch.tv/helix/moderation/moderators` | broadcaster_id: channelID; user_id  | streamer | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `functions/moderation/get_moderators.moderation.ts:67` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-036 | POST | `api.twitch.tv/helix/moderation/warnings` | broadcaster_id: channelID,             moderator_id: TWITCH_BOT_ACCOUNT_ID body: { | bot | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) | moderation (warn) | `functions/moderation/warn.moderation.ts:35` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-037 | POST | `api.twitch.tv/helix/polls` |  body: bodyData) | streamer | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) | channel-points economy (polls/predictions; PATCH predictions RESOLVED pays out) | `functions/polls/create.poll.ts:60` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-038 | PATCH | `api.twitch.tv/helix/polls` |  body: bodyData) | streamer | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) | channel-points economy (polls/predictions; PATCH predictions RESOLVED pays out) | `functions/polls/end.poll.ts:57` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-039 | GET | `api.twitch.tv/helix/polls` | broadcaster_id; id  | streamer | none | none | checks status codes 404; rl: none (no Ratelimit-* / 429 handling) |  | `functions/polls/get.poll.ts:66` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-040 | POST | `api.twitch.tv/helix/predictions` |  body: bodyData) | streamer | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) | channel-points economy (polls/predictions; PATCH predictions RESOLVED pays out) | `functions/predictions/create.prediction.ts:72` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-041 | PATCH | `api.twitch.tv/helix/predictions` |  body: bodyData) | streamer | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) | channel-points economy (polls/predictions; PATCH predictions RESOLVED pays out) | `functions/predictions/end.prediction.ts:75` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-042 | GET | `api.twitch.tv/helix/predictions` | broadcaster_id; id  | streamer | none | none | checks status codes 404; rl: none (no Ratelimit-* / 429 handling) |  | `functions/predictions/get.prediction.ts:79` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-043 | GET | `api.twitch.tv/helix/search/categories` | query: searchQuery, first: '100'  | app | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `functions/search/search_categories.search.ts:31` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-044 | GET | `api.twitch.tv/helix/games` | external_id  | app | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `functions/search/search_games.search.ts:128` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-045 | GET | `api.twitch.tv/helix/games` | id  | app | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `functions/search/search_games.search.ts:26` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-046 | GET | `api.twitch.tv/helix/games` | name  | app | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `functions/search/search_games.search.ts:77` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-047 | GET | `api.twitch.tv/helix/authorization/users` | user_id  | app | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `functions/users/get_scopes.users.ts:26` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-048 | GET | `api.twitch.tv/helix/users` |   | app | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `functions/users/get_user_by_id.users.ts:28` | api; bot; cron:10 workers (shared util); script:4 scripts | query raw `id=${userID}` (not encoded). |
| TW-049 | GET | `api.twitch.tv/helix/users` |   | app | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `functions/users/get_user_by_login.users.ts:28` | api; bot; cron:10 workers (shared util); script:4 scripts | query built as raw string `login=${login}` (NOT URL-encoded) - byte-exact URL depends on caller input. |
| TW-050 | GET | `api.twitch.tv/helix/goals` | broadcaster_id: channel  | streamer | 8000 | none | checks status codes 401,403; rl: none (no Ratelimit-* / 429 handling) |  | `goals/twitch-store.ts:80` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-051 | GET | `id.twitch.tv/oauth2/validate` |   | user | none | none | checks status codes 401; rl: none (no Ratelimit-* / 429 handling) |  | `middleware/auth.middleware.ts:59` | api | GET id.twitch.tv/oauth2/validate with `Authorization: Bearer <user token>` (note: OAuth routes use `OAuth <token>`); 401 => invalid. |
| TW-052 | GET | `api.twitch.tv/helix/users` |   | user | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `middleware/auth.middleware.ts:83` | api | GET helix/users with the caller token (Bearer + Client-Id) to resolve the user. |
| TW-053 | GET | `api.twitch.tv/helix/channels/ads` | broadcaster_id: channel  | streamer | 8000 | none | checks status codes 401,403,404,429; rl: handled |  | `overlays/ad-schedule.ts:46` | api | 429 handled: reads `ratelimit-reset` and reschedules (ad-schedule.ts:48-51); 401/403/404 => null for 10x refresh interval. |
| TW-054 | GET | `api.twitch.tv/helix/polls \| predictions` | broadcaster_id: channel, first: '1'  | streamer | 8000 | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `overlays/interactions.ts:120` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-055 | GET | `api.twitch.tv/helix/hypetrain/status` | broadcaster_id: channel; broadcaster_id: channel, first: '1'  | streamer | 8000 | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `overlays/interactions.ts:90` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-056 | GET | `id.twitch.tv/oauth2/validate` |   | user | 5000 | none | checks status codes 401,429; rl: handled |  | `server/oauth/routes.ts:49` | api | Desktop OAuth: validate with `Authorization: OAuth <token>`, 5s timeout; maps 401 and 429 (sets Retry-After: 60 on our response). |
| TW-057 | GET | `api.twitch.tv/helix/streams` | type: 'live'; user_id  | app | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `server/routes/admin_site.route.ts:185` | api |  |
| TW-058 | GET | `api.twitch.tv/helix/users` |   | user | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `server/routes/auth.route.ts:228` | api | GET helix/users with freshly exchanged user token (no Content-Type). |
| TW-059 | POST | `id.twitch.tv/oauth2/token` | client_id: process.env.CLIENT_ID!,         client_secret: process.env.CLIENT_SECRET!,         code: code,         grant_type: 'authorization_code',         redirect_uri: redirectUri body: params.toString() | client-secret | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `server/routes/auth.route.ts:402` | api |  |
| TW-060 | DELETE | `api.twitch.tv/helix/channel_points/custom_rewards` |   | streamer | none | none | checks status codes 204; rl: none (no Ratelimit-* / 429 handling) | channel-points reward management | `server/routes/reward.route.ts:259` | api |  |
| TW-061 | GET | `api.twitch.tv/helix/channel_points/custom_rewards` |   | streamer | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `server/routes/reward.route.ts:40` | api |  |
| TW-062 | GET | `api.twitch.tv/helix/channel_points/custom_rewards` |   | streamer | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `server/routes/twitch.route.ts:46` | UNREACHABLE (no static import from any entrypoint) | Dead: route file not imported by server.ts; also passes the whole header RESULT object as headers. |
| TW-063 | DELETE | `api.twitch.tv/helix/channel_points/custom_rewards` | broadcaster_id; id body: Record<string, any>, rewardID: string): Promise<any> { | streamer | none | none | checks status codes 204; rl: none (no Ratelimit-* / 429 handling) | channel-points reward management | `server/services/reward_creation.service.ts:32` | api |  |
| TW-064 | PATCH | `api.twitch.tv/helix/channel_points/custom_rewards` | broadcaster_id; id body: parsedBody) | streamer | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) | channel-points reward management | `server/services/reward_creation.service.ts:58` | api |  |
| TW-065 | POST | `api.twitch.tv/helix/channel_points/custom_rewards` | broadcaster_id body: parsedBody) | streamer | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) | channel-points reward management | `server/services/reward_creation.service.ts:87` | api |  |
| TW-066 | GET | `api.twitch.tv/helix/channel_points/custom_rewards` | broadcaster_id: channelId, id: rewardId  | streamer | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `site_agent/tools/stream.ts:307` | api |  |
| TW-067 | GET | `api.twitch.tv/helix/videos` | id: vodID; user_id: channelID, type: 'archive', first: '1'  | app | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `utils/ai/clip_recommendations/vod_clip_recommendation_runner.ts:332` | api; cron:vod_clip_recommender |  |
| TW-068 | GET | `api.twitch.tv/helix/chat/emotes/global` |   | app | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `utils/ai/emote_context.ai.ts:17` | api; bot; cron:10 workers (shared util); script:4 scripts |  |
| TW-069 | GET | `api.twitch.tv/helix/channels/followers` |   | streamer | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `utils/ast_parser/functions/followage.functions.ts:40` | api; bot; cron:10 workers (shared util); script:4 scripts | streamer token with 401 refresh retry. |
| TW-070 | PATCH | `api.twitch.tv/helix/channel_points/custom_rewards` | broadcaster_id: document.channelID, id: document.rewardID body: { is_enabled: document.isEnabled }), signal: AbortSignal.timeout(15000) | streamer | 15000 | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) | channel-points reward management | `utils/availability/service.ts:52` | api; bot; cron:10 workers (shared util); script:4 scripts | body {is_enabled\|is_paused...}; 15s timeout; checks response.ok. |
| TW-071 | POST | `api.twitch.tv/helix/eventsub/subscriptions` |  body: { | streamer | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) | EventSub subscription management (controls inbound events) | `utils/eventsub.ts:409` | api; bot; cron:11 workers (shared util); script:5 scripts | body {type,version,condition,transport:{method:"webhook",callback:"https://subscriptions.domdimabot.com/eventsub",secret:$TWITCH_EVENTSUB_SECRET}}; app token required by Twitch for webhook transport. |
| TW-072 | GET | `api.twitch.tv/helix/eventsub/subscriptions` | first: '100'; after; user_id  | app | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `utils/eventsub.ts:499` | api; bot; cron:11 workers (shared util); script:5 scripts | paginated (first=100, after cursor, optional user_id); aborts on repeated cursor / page cap. |
| TW-073 | DELETE | `api.twitch.tv/helix/eventsub/subscriptions` |   | app | none | none | checks status codes 204,404; rl: none (no Ratelimit-* / 429 handling) | EventSub subscription management (controls inbound events) | `utils/eventsub.ts:549` | api; bot; cron:11 workers (shared util); script:5 scripts | ?id=<subscription id> (raw concatenation); 204 and 404 both success. |
| TW-074 | GET | `api.twitch.tv/helix/channels/followers` | broadcaster_id: channelID,             first: '100'; after  | streamer | none | 401-refresh | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `utils/follow_ledger.ts:202` | cron:follow_ledger | paginated first=100 + after; executeHelixStreamerRequestWith401Retry (401 => refresh+retry at 1s/3s/5s). |
| TW-075 | GET | `api.twitch.tv/helix/channels/followed` | user_id: channelID,             first: '100'; after  | streamer | none | 401-refresh | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `utils/follow_ledger.ts:265` | cron:follow_ledger | paginated first=100 + after; streamer token of the channel (user_id=channelID). |
| TW-076 | GET | `api.twitch.tv/helix/streams` | type: 'live'; id; user_id  | app | none | 401-refresh | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `utils/siteanalytics.ts:246` | api; bot; cron:11 workers (shared util); script:5 scripts | batched user_id/id params; app token with 401 refresh retry. |
| TW-077 | GET | `api.twitch.tv/helix/users` | id  | app | none | 401-refresh | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `utils/siteanalytics.ts:300` | api; bot; cron:11 workers (shared util); script:5 scripts |  |
| TW-078 | GET | `api.twitch.tv/helix/streams` | type: 'live'; user_id  | app | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `utils/stream_analytics.ts:364` | api; bot; cron:11 workers (shared util); script:5 scripts |  |
| TW-079 | POST | `id.twitch.tv/oauth2/token` | client_id: process.env.CLIENT_ID!,             client_secret: process.env.CLIENT_SECRET!,             grant_type: 'refresh_token',             refresh_token body: params.toString() | client-secret | none | 3 attempts, backoff 400ms/900ms, retry only on network error or 5xx (utils/tokens.ts:10-11,199) | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `utils/tokens.ts:175` | api; bot; cron:15 workers (shared util); script:7 scripts |  |
| TW-080 | POST | `id.twitch.tv/oauth2/token` | client_id: process.env.CLIENT_ID!,             client_secret: process.env.CLIENT_SECRET!,             grant_type: 'client_credentials', body: params.toString() | client-secret | none | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `utils/tokens.ts:481` | api; bot; cron:15 workers (shared util); script:7 scripts |  |
| TW-081 | GET | `api.twitch.tv/helix/chat/emotes/global` |   | app | 3000 | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `utils/tts/emote_names.util.ts:24` | api; bot; cron:10 workers (shared util); script:4 scripts | 3s timeout; cached global emote names. |
| TW-082 | GET | `api.twitch.tv/helix/chat/emotes` | broadcaster_id: channelID  | app | 3000 | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `utils/twitch_emotes.ts:38` | api; bot; cron:10 workers (shared util); script:4 scripts | 3s timeout; failure => empty emote list. |
| TW-083 | GET | `api.twitch.tv/helix/chat/badges/global \| chat/badges` | broadcaster_id: key  | app | 5000 | none | parses JSON; non-2xx returned as {error:true,message:data.message,status}; rl: none (no Ratelimit-* / 429 handling) |  | `widget_feed/badges.ts:37` | api; bot | chat/badges/global (6h cache) or chat/badges?broadcaster_id= (1h cache, 500-entry LRU, in-flight dedupe); throws on !ok and keeps stale cache. |
| TW-084 | ANY | `TwitchClient::request (generic Helix) / refresh (twitch.rs:509) / app_token (twitch.rs:523)` |   | dima-rust/src/utils/twitch.rs (reqwest 0.12, rustls): only https://api.twitch.tv | optional per call (no default, mirrors TS) | mirrors TS 401 refresh semantics | sanitised diagnostics (twitch.rs:682-860); rl: none |  | `dima-rust/src/utils/twitch.rs:354` | rust (library; used by twitch_tokens/twitch_streamers adapters) |  |
| TW-085 | GET | `api.twitch.tv/helix/chat/emotes?broadcaster_id={channel}` |   | app token from Dragonfly; Client-Id + bearer_auth + Content-Type: application/js | 3s request+body (dashboard_emote_catalog.rs:18,146-147) | none; retry after RETRY_MS 60s | !success => cached previous; rl: none |  | `dima-rust/src/workers/dashboard_emote_catalog.rs:149` | rust:cron_index/dashboard_emote_catalog |  |
| TW-086 | POST | `id.twitch.tv/oauth2/token (client_credentials)` |   | client-secret | 3s | none | error => skip; rl: none |  | `dima-rust/src/workers/dashboard_emote_catalog.rs:202` | rust:cron_index/dashboard_emote_catalog |  |

## OpenRouter (15)

### OR-001 POST `https://openrouter.ai/api/v1/audio/speech`
- Where: `dimabot/src/server/services/tts/fish_tts.service.ts:73` (readBackendAudio (fish-audio/drama-3 via OpenRouter)); processes: api; bot; cron (shared); scripts; status: live
- Body: {model:"fish-audio/drama-3",input,voice:<fish reference id>,response_format:"mp3",user:channelID}
- Auth: Authorization: Bearer $OPENROUTER_API_KEY; Content-Type: application/json; OPENROUTER_APP_HEADERS (utils/ai/openrouter/app_attribution.util.ts:2-7): HTTP-Referer: https://domdimabot.com, X-OpenRouter-Title: DomDimaBot, X-OpenRouter-Description: "DomDimaBot is a Twitch chat bot that helps make streams more engaging and fun.", X-OpenRouter-Categories: "general-chat, roleplay"
- Timeout: 20s covering headers + full body (fish_tts.service.ts:24,57); retry: backend chain: OpenRouter drama-3 first, then Fish SDK s2.1-pro (fish_tts.service.ts:20-23,108); streaming: chunked audio body read via readAudioStream with maxAudioBytes
- Errors: !ok => cancel body, throw; requires content-type audio/mpeg; rate limit: none

### OR-002 POST `https://openrouter.ai/api/v1/audio/speech`
- Where: `dimabot/src/server/services/tts/kokoro_tts.service.ts:25` (KokoroTtsService.synthesize); processes: api; status: live
- Body: {model:"hexgrad/kokoro-82m",input,voice,response_format:"mp3",user,provider:{only:["deepinfra"],order:["deepinfra"],allow_fallbacks:false}}
- Auth: Authorization: Bearer $OPENROUTER_API_KEY; Content-Type: application/json; OPENROUTER_APP_HEADERS (utils/ai/openrouter/app_attribution.util.ts:2-7): HTTP-Referer: https://domdimabot.com, X-OpenRouter-Title: DomDimaBot, X-OpenRouter-Description: "DomDimaBot is a Twitch chat bot that helps make streams more engaging and fun.", X-OpenRouter-Categories: "general-chat, roleplay"
- Timeout: 20s (kokoro_tts.service.ts:10); retry: none; streaming: audio body
- Errors: !ok => error; requires audio/mpeg; rate limit: none

### OR-003 POST `https://openrouter.ai/api/v1/chat/completions (SSE)`
- Where: `dimabot/src/site_agent/llm/openrouter.ts:406` (attemptStream / streamChat); processes: api; status: live
- Body: {model,messages,stream:true,reasoning:{effort},usage:{include:true},session_id,user,tools?,parallel_tool_calls:true,tool_choice?,max_tokens?}
- Auth: Authorization: Bearer $OPENROUTER_API_KEY; Content-Type: application/json; OPENROUTER_APP_HEADERS (utils/ai/openrouter/app_attribution.util.ts:2-7): HTTP-Referer: https://domdimabot.com, X-OpenRouter-Title: DomDimaBot, X-OpenRouter-Description: "DomDimaBot is a Twitch chat bot that helps make streams more engaging and fun.", X-OpenRouter-Categories: "general-chat, roleplay" (site_agent/llm/openrouter.ts:62-68); base overridable by $OPENROUTER_BASE_URL
- Timeout: headers 60s, stream idle 120s (openrouter.ts:17-18); retry: max 2 retries before any SSE data, delays 1s,3s, on network error/429/502/503; honours Retry-After capped 10s (openrouter.ts:6,19-20,149-158,417); streaming: SSE (text/event-stream) read with getReader + TextDecoder
- Errors: 408/504=>timeout, 429=>rate_limited, context errors classified; JSON 200 body treated as error; stream error chunks parsed; partial generation reconciled via /generation; rate limit: Retry-After honoured
- **Bytes matter:** messages prefix (system prompt, docs context) is prompt-cache sensitive

### OR-004 GET `https://openrouter.ai/api/v1/generation?id={generationId}`
- Where: `dimabot/src/site_agent/llm/openrouter.ts:578` (lookupGeneration); processes: api; status: live
- Auth: Authorization: Bearer + OPENROUTER_APP_HEADERS (no Content-Type)
- Timeout: 15s per lookup; retry: schedule 5s,15s,45s,90s from first lookup (openrouter.ts:22); 404 = not ready; streaming: no
- Errors: 401/403 => give up; other non-ok => retry later; rate limit: none

### OR-005 POST `https://openrouter.ai/api/v1/chat/completions`
- Where: `dimabot/src/utils/ai/clip_recommendations/openrouter_clip_recommendations.client.ts:326` ((audio clip analysis)); processes: api; cron:vod_clip_recommender; status: live
- Body: {model, messages with audio input (base64)}
- Auth: Authorization: Bearer $OPENROUTER_API_KEY; HTTP-Referer; X-Title: DomDimaBot (client.ts:329-333)
- Timeout: 60s per attempt (client.ts:22); retry: createFetchWithRetry retries=3 default delays; streaming: no
- Errors: !ok => throws; rate limit: none
- Notes: Large multimodal request bodies (audio).

### OR-006 POST `https://openrouter.ai/api/v1/chat/completions`
- Where: `dimabot/src/utils/ai/clip_recommendations/openrouter_clip_recommendations.client.ts:492` ((video verification)); processes: api; cron:vod_clip_recommender; status: live
- Body: {model, messages with video input}
- Auth: Authorization: Bearer; HTTP-Referer; X-Title (client.ts:495-499)
- Timeout: max(60s, $CLIP_RECOMMENDATION_VIDEO_VERIFY_TIMEOUT_MS || 300s) per attempt (client.ts:27-28); retry: createFetchWithRetry retries=3; streaming: no
- Errors: !ok => throws; rate limit: none

### OR-007 POST `https://openrouter.ai/api/v1/chat/completions`
- Where: `dimabot/src/utils/ai/memory/stream_summary_decider.ts:336` ((stream summary decider)); processes: cron:stream_memory; status: live
- Body: {model,messages,response_format/json}
- Auth: Authorization: Bearer $OPENROUTER_API_KEY; Content-Type: application/json; HTTP-Referer: https://domdimabot.com; X-Title: DomDimaBot (LEGACY title header, not X-OpenRouter-Title)
- Timeout: 60s per attempt (stream_summary_decider.ts:25-30); retry: createFetchWithRetry retries=3 delays 15s,30s,60s retryOn 429,5xx; streaming: no
- Errors: !ok handled (ok check present); rate limit: none

### OR-008 POST `https://openrouter.ai/api/v1/chat/completions`
- Where: `dimabot/src/utils/ai/openrouter/ai.ts:527` (callOpenRouter); processes: api; bot; cron:10 workers (AST/AI command paths); scripts; status: live
- Body: {model,messages,tools,max_tokens,user:channelID,usage:{include:true},session_id,trace:{trace_id},...extraOptions}
- Auth: Authorization: Bearer $OPENROUTER_API_KEY; Content-Type: application/json; OPENROUTER_APP_HEADERS (utils/ai/openrouter/app_attribution.util.ts:2-7): HTTP-Referer: https://domdimabot.com, X-OpenRouter-Title: DomDimaBot, X-OpenRouter-Description: "DomDimaBot is a Twitch chat bot that helps make streams more engaging and fun.", X-OpenRouter-Categories: "general-chat, roleplay"; plus X-Trace-ID: <uuidv7> (ai.ts:494)
- Timeout: 30s per attempt (ai.ts:45); singleAttempt path: AbortSignal.any(caller, 30s); retry: createFetchWithRetry (utils/ai/fetch.utils.ts:26): per-attempt AbortController timeout, retries on network error/timeout and on status in retryOn (default 429,500,502,503,504), fixed delays (default 1s,3s,5s), returns last response; NO Retry-After honouring with retries=3 (ai.ts:46-49); singleAttempt=true (ai.ts:1071, when caller passes a signal) => plain fetch, no retry; streaming: no
- Errors: !ok => logs body, returns {error:true,status}; ok => JSON IOpenRouterResponse; DSML tool-call recovery post-processing (ai.ts:574+); rate limit: 429 retried by wrapper (fixed delays)
- **Bytes matter:** system prompt + tools array order/bytes drive provider prompt caching
- Notes: Main chat/AI-command harness: tool loop (search, code_execution, AST_PARSER, ast_docs, chat_summary, stream_stats, recall_memory, create_memory). Callers at ai.ts:740, 1061, 1316. Cost billed to Polar via utils/polarsh.ts ingest.

### OR-009 POST `https://openrouter.ai/api/v1/embeddings`
- Where: `dimabot/src/utils/ai/openrouter/embeddings.ai.ts:102` (generateEmbedding); processes: api; bot; cron (11 workers); scripts; status: live
- Body: {model:"qwen/qwen3-embedding-8b" default,user:channelID,input:string,dimensions?}
- Auth: Authorization: Bearer $OPENROUTER_API_KEY; Content-Type: application/json; OPENROUTER_APP_HEADERS (utils/ai/openrouter/app_attribution.util.ts:2-7): HTTP-Referer: https://domdimabot.com, X-OpenRouter-Title: DomDimaBot, X-OpenRouter-Description: "DomDimaBot is a Twitch chat bot that helps make streams more engaging and fun.", X-OpenRouter-Categories: "general-chat, roleplay"
- Timeout: 20s per attempt (embeddings.ai.ts:7); retry: createFetchWithRetry (utils/ai/fetch.utils.ts:26): per-attempt AbortController timeout, retries on network error/timeout and on status in retryOn (default 429,500,502,503,504), fixed delays (default 1s,3s,5s), returns last response; NO Retry-After honouring retries=3; streaming: no
- Errors: !ok => {error:true}; rate limit: none

### OR-010 POST `https://openrouter.ai/api/v1/embeddings`
- Where: `dimabot/src/utils/ai/openrouter/embeddings.ai.ts:204` (generateEmbeddings (batch)); processes: api; bot; cron (11 workers); scripts; status: live
- Body: {model,user,input:string[],dimensions?}
- Auth: Authorization: Bearer $OPENROUTER_API_KEY; Content-Type: application/json; OPENROUTER_APP_HEADERS (utils/ai/openrouter/app_attribution.util.ts:2-7): HTTP-Referer: https://domdimabot.com, X-OpenRouter-Title: DomDimaBot, X-OpenRouter-Description: "DomDimaBot is a Twitch chat bot that helps make streams more engaging and fun.", X-OpenRouter-Categories: "general-chat, roleplay"
- Timeout: 20s per attempt; retry: createFetchWithRetry (utils/ai/fetch.utils.ts:26): per-attempt AbortController timeout, retries on network error/timeout and on status in retryOn (default 429,500,502,503,504), fixed delays (default 1s,3s,5s), returns last response; NO Retry-After honouring retries=3; streaming: no
- Errors: !ok => {error:true}; rate limit: none

### OR-011 POST `https://openrouter.ai/api/v1/chat/completions`
- Where: `dimabot/src/utils/ai/openrouter/messages.ai.ts:312` (AiMessage); processes: UNREACHABLE (dead module); status: dead
- Auth: Authorization: Bearer $OPENROUTER_API_KEY; Content-Type: application/json; HTTP-Referer: https://domdimabot.com; X-Title: DomDimaBot (LEGACY title header, not X-OpenRouter-Title)
- Timeout: OPENROUTER_TIMEOUT; retry: createFetchWithRetry retries=3; streaming: no
- Errors: ok check; rate limit: none

### OR-012 POST `https://openrouter.ai/api/v1/chat/completions`
- Where: `dimabot/src/utils/ai/tools/code_execution.tool.ts:172` (generateCodePlan); processes: api; bot; cron (shared); status: live
- Body: {model,messages:[plan prompt]} 
- Auth: Authorization: Bearer $OPENROUTER_API_KEY; Content-Type: application/json; HTTP-Referer: https://domdimabot.com; X-Title: DomDimaBot (LEGACY title header, not X-OpenRouter-Title)
- Timeout: 30s per attempt (code_execution.tool.ts:19); retry: createFetchWithRetry (utils/ai/fetch.utils.ts:26): per-attempt AbortController timeout, retries on network error/timeout and on status in retryOn (default 429,500,502,503,504), fixed delays (default 1s,3s,5s), returns last response; NO Retry-After honouring retries=3; streaming: no
- Errors: !ok => error result; does not check ok before json at :172 (extractor) - errors surface as parse failures; rate limit: none

### OR-013 POST `https://openrouter.ai/api/v1/chat/completions`
- Where: `dimabot/src/utils/ai/tools/code_execution.tool.ts:314` (generateCode); processes: api; bot; cron (shared); status: live
- Body: {model,messages:[codegen prompt]}
- Auth: Authorization: Bearer $OPENROUTER_API_KEY; Content-Type: application/json; HTTP-Referer: https://domdimabot.com; X-Title: DomDimaBot (LEGACY title header, not X-OpenRouter-Title)
- Timeout: 30s per attempt; retry: createFetchWithRetry (utils/ai/fetch.utils.ts:26): per-attempt AbortController timeout, retries on network error/timeout and on status in retryOn (default 429,500,502,503,504), fixed delays (default 1s,3s,5s), returns last response; NO Retry-After honouring retries=3; streaming: no
- Errors: reads choices[0].message.content, strips ``` fences (code_execution.tool.ts:360-362); rate limit: none
- Notes: Output is executed by Deno with unrestricted --allow-net, see SSRF section.

### OR-014 POST `https://openrouter.ai/api/alpha/decisions`
- Where: `dimabot/src/utils/moderation/semantic.ts:118` (evaluateSemanticDecision); processes: cron:semantic_moderation; status: live
- Body: {...semanticRequest (input/output or JSON targetMessage), user:channelID}
- Auth: Authorization: Bearer $OPENROUTER_API_KEY; Content-Type: application/json; OPENROUTER_APP_HEADERS (utils/ai/openrouter/app_attribution.util.ts:2-7): HTTP-Referer: https://domdimabot.com, X-OpenRouter-Title: DomDimaBot, X-OpenRouter-Description: "DomDimaBot is a Twitch chat bot that helps make streams more engaging and fun.", X-OpenRouter-Categories: "general-chat, roleplay"
- Timeout: remaining time until decision.deadline (semantic.ts:113); retry: none; streaming: no
- Errors: 429 => fallback rate_limited; other non-ok/timeout => fallback (no action); rate limit: 429 mapped to fallback, no retry
- **Consequence:** feeds automated moderation decisions (deletes/timeouts downstream)

### OR-015 POST `https://openrouter.ai/api/v1/chat/completions`
- Where: `dimabot/src/utils/moderation/variations.ts:196` (generateMuseVariations); processes: api; bot; cron (shared); status: live
- Body: {...museVariationRequest(terms) (structured output, provider:{require_parameters:true}), user:channelID}
- Auth: Authorization: Bearer $OPENROUTER_API_KEY; Content-Type: application/json; OPENROUTER_APP_HEADERS (utils/ai/openrouter/app_attribution.util.ts:2-7): HTTP-Referer: https://domdimabot.com, X-OpenRouter-Title: DomDimaBot, X-OpenRouter-Description: "DomDimaBot is a Twitch chat bot that helps make streams more engaging and fun.", X-OpenRouter-Categories: "general-chat, roleplay"
- Timeout: caller AbortSignal only; retry: none; streaming: no
- Errors: !ok => throw generation_unavailable; requires finish_reason=stop and JSON content; rate limit: none


## MiniMax (Anthropic-compatible SDK) (1)

### MM-001 POST `https://api.minimax.io/anthropic/v1/messages (stream:true)`
- Where: `dimabot/src/utils/ai/minimax/minimax_client.ts:236` (minimaxChat/minimaxChatStream (anthropic.messages.stream)); processes: api; status: live
- Body: {model:"MiniMax-M3.1-Flash",messages,system (string or text blocks),max_tokens,output_config:{effort}?,tools?,tool_choice:{type:auto|none}}
- Auth: @anthropic-ai/sdk 0.80.0: x-api-key: $MINI_TOKEN_PLAN_API_KEY, anthropic-version: 2023-06-01, User-Agent Anthropic/JS 0.80.0 + x-stainless-* headers; baseURL $MINIMAX_BASE_URL || https://api.minimax.io/anthropic (constants.ts:79)
- Timeout: SDK timeout 60s (minimax_client.ts:29,118) + own idle watchdog 120s; retry: SDK maxRetries=2 (minimax_client.ts:32): connection errors, 408/409/429/5xx, honours retry-after/retry-after-ms, exponential backoff 0.5s..8s with jitter; never after text started; streaming: SSE via SDK MessageStream (message_start, content_block_delta text/thinking, message_delta)
- Errors: errors mapped to MiniMaxError kinds config/aborted/timeout/rate_limited/overloaded/bad_request/upstream; rate limit: SDK retry on 429
- **Bytes matter:** system text blocks kept stable for MiniMax prompt cache; thinking blocks must be passed back unchanged across tool rounds
- Notes: Only caller: utils/ai/docs_assistant/docs_assistant.ts (route server/routes/docs-assistant.route.ts).


## Fish Audio (2)

### FA-001 POST `https://api.fish.audio/v1/tts`
- Where: `dimabot/src/server/services/tts/fish_tts.service.ts:42` (convertWithBackend (FishAudioClient.textToSpeech.convert)); processes: api; bot; cron (shared); scripts; status: live
- Body: msgpack-encoded {text (reinforceFishTtsTags applied for s2.1-*), reference_id, format:"mp3"}
- Auth: fish-audio SDK 0.1.0: Authorization: Bearer $FISH_AUDIO_API_KEY; header `model: s2.1-pro`; Content-Type: application/msgpack
- Timeout: timeoutInSeconds=20 (fish_tts.service.ts:24,52) + outer 20s abort; retry: SDK requestWithRetries default maxRetries=2 on 408/429/>=500, backoff 1s*2^n +-10% jitter, honours Retry-After (node_modules/fish-audio/dist/esm/core/fetcher/requestWithRetries.js:1-60); streaming: responseType streaming (mp3 bytes)
- Errors: 422 => UnprocessableEntityError, else FishAudioError; caller tries next backend; rate limit: SDK retry honours Retry-After
- **Bytes matter:** body is MessagePack, not JSON

### FA-002 GET `https://api.fish.audio/model/{id} | https://api.fish.audio/model?page_size=20&page_number=&sort_by=score&title=&tag=&language=&licensed=`
- Where: `dimabot/src/server/services/tts/fish_voice_catalog.service.ts:49` (fishGet (getFishVoice:97 / searchFishVoices:107)); processes: api; status: live
- Auth: Authorization: Bearer $FISH_AUDIO_API_KEY
- Timeout: 12s; retry: none; 60s in-process cache, 100 entries; streaming: no
- Errors: 404 => voice_unavailable; other non-ok => 503 catalog_unavailable; rate limit: none


## Piper TTS (1)

### PI-001 POST `${PIPER_HTTP_URL}/synthesize`
- Where: `dimabot/src/server/services/tts/piper_tts.service.ts:108` (runPiperHttp); processes: api; bot; cron (shared); scripts; status: live
- Body: {text,voice}
- Auth: none
- Timeout: 30s (AbortSignal.any with caller signal); retry: none (falls back to local piper binary only when PIPER_HTTP_URL unset, piper_tts.service.ts:26); streaming: WAV body
- Errors: !ok => error with body text; rate limit: none


## Self-hosted embeddings (LFM2) (2)

### EM-001 POST `${LFM2_EMBEDDINGS_URL:-http://lfm2.5-embeddings:8080/v1/embeddings}`
- Where: `dimabot/src/utils/ai/lfm2_embeddings/lfm2_embeddings.client.ts:115` (generateEmbedding); processes: api; bot; cron (11 workers); scripts; status: live
- Body: {input:string,model,kind:"query"|"document"}
- Auth: none
- Timeout: $LFM2_EMBEDDINGS_TIMEOUT_MS || 10s per attempt; retry: createFetchWithRetry retries=$LFM2_EMBEDDINGS_RETRIES||2 on 429/5xx (client.ts:31-36); streaming: no
- Errors: !ok => error result; rate limit: none

### EM-002 POST `${LFM2_EMBEDDINGS_URL}`
- Where: `dimabot/src/utils/ai/lfm2_embeddings/lfm2_embeddings.client.ts:213` (generateEmbeddings (batch)); processes: api; bot; cron (11 workers); scripts; status: live
- Body: {input:string[],model,kind}
- Auth: none
- Timeout: same; retry: same; streaming: no
- Errors: same; rate limit: none


## Qdrant (18)

### QD-001 GET `${QDRANT_URL}/metrics`
- Where: `dima-analytics/src/collectors.mjs:53` (collector sample); processes: dima-analytics; status: live
- Auth: api-key: $QDRANT_API_KEY (if set)
- Timeout: 3s; retry: none; streaming: no
- Errors: !ok skipped; rate limit: none

### QD-002 PUT `http://$QDRANT_HOST:$QDRANT_PORT/collections/{COLLECTION}/points?wait=false`
- Where: `dimabot/src/classes/embedding_batcher.class.ts:130` (EmbeddingBatcher.storeInQdrant upsert); processes: api; bot; cron (11 workers); scripts; status: live
- Body: {points:[...]}
- Auth: @qdrant/qdrant-js 1.19.0 (REST via js-client-rest): api-key: $QDRANT_API_KEY; Content-Type: application/json; base http://$QDRANT_HOST:$QDRANT_PORT (utils/databases/qdrant.database.ts:16-19)
- Timeout: SDK default 300s (qdrant-js timeout = 300_000); retry: none (SDK has no retry); streaming: no
- Errors: SDK throws ApiError on non-2xx; callers catch/log; rate limit: none

### QD-003 POST `http://$QDRANT_HOST:$QDRANT_PORT/collections/twitch_chat_logs/points`
- Where: `dimabot/src/scripts/smoke_test_lfm2_embeddings.script.ts:62` (smoke test retrieve); processes: script:smoke_test_lfm2_embeddings; status: live
- Auth: @qdrant/qdrant-js 1.19.0 (REST via js-client-rest): api-key: $QDRANT_API_KEY; Content-Type: application/json; base http://$QDRANT_HOST:$QDRANT_PORT (utils/databases/qdrant.database.ts:16-19)
- Timeout: SDK default 300s (qdrant-js timeout = 300_000); retry: none (SDK has no retry); streaming: no
- Errors: SDK throws ApiError on non-2xx; callers catch/log; rate limit: none

### QD-004 POST `http://$QDRANT_HOST:$QDRANT_PORT/collections/{memory}/points/scroll`
- Where: `dimabot/src/utils/ai/memory/stream_summary_context.ts:267` (stream summary scroll); processes: api; bot; cron (11 workers); scripts; status: live
- Body: scrollParams
- Auth: @qdrant/qdrant-js 1.19.0 (REST via js-client-rest): api-key: $QDRANT_API_KEY; Content-Type: application/json; base http://$QDRANT_HOST:$QDRANT_PORT (utils/databases/qdrant.database.ts:16-19)
- Timeout: SDK default 300s (qdrant-js timeout = 300_000); retry: none (SDK has no retry); streaming: no
- Errors: SDK throws ApiError on non-2xx; callers catch/log; rate limit: none

### QD-005 GET `http://$QDRANT_HOST:$QDRANT_PORT/`
- Where: `dimabot/src/utils/databases/qdrant.database.ts:16` (new QdrantClient (checkCompatibility default true -> versionInfo())); processes: api; bot; cron (11 workers); scripts; status: live
- Auth: @qdrant/qdrant-js 1.19.0 (REST via js-client-rest): api-key: $QDRANT_API_KEY; Content-Type: application/json; base http://$QDRANT_HOST:$QDRANT_PORT (utils/databases/qdrant.database.ts:16-19)
- Timeout: SDK default 300s (qdrant-js timeout = 300_000); retry: none (SDK has no retry); streaming: no
- Errors: SDK throws ApiError on non-2xx; callers catch/log; rate limit: none
- Notes: Implicit: client fetches server version on construction and warns on major/minor mismatch; pass checkCompatibility:false to skip.

### QD-006 GET `http://$QDRANT_HOST:$QDRANT_PORT/collections`
- Where: `dimabot/src/utils/databases/qdrant.database.ts:22` (getQdrantConnection getCollections (connection probe)); processes: api; bot; cron (11 workers); scripts; status: live
- Auth: @qdrant/qdrant-js 1.19.0 (REST via js-client-rest): api-key: $QDRANT_API_KEY; Content-Type: application/json; base http://$QDRANT_HOST:$QDRANT_PORT (utils/databases/qdrant.database.ts:16-19)
- Timeout: SDK default 300s (qdrant-js timeout = 300_000); retry: none (SDK has no retry); streaming: no
- Errors: SDK throws ApiError on non-2xx; callers catch/log; rate limit: none

### QD-007 POST `http://$QDRANT_HOST:$QDRANT_PORT/collections/twitch_chat_logs/points/query`
- Where: `dimabot/src/utils/qdrant/functions/chat_logs/retrieve_chat_context.qdrant.ts:126` (retrieve chat context (query; fallbacks :137,:148)); processes: api; bot; cron (11 workers); scripts; status: live
- Body: {query,limit,with_payload,filter,score_threshold}
- Auth: @qdrant/qdrant-js 1.19.0 (REST via js-client-rest): api-key: $QDRANT_API_KEY; Content-Type: application/json; base http://$QDRANT_HOST:$QDRANT_PORT (utils/databases/qdrant.database.ts:16-19)
- Timeout: SDK default 300s (qdrant-js timeout = 300_000); retry: none (SDK has no retry); streaming: no
- Errors: SDK throws ApiError on non-2xx; callers catch/log; rate limit: none

### QD-008 POST `http://$QDRANT_HOST:$QDRANT_PORT/collections/twitch_chat_logs/points/scroll`
- Where: `dimabot/src/utils/qdrant/functions/chat_logs/retrieve_chat_window.qdrant.ts:139` (chat window scroll); processes: api; bot; cron (11 workers); scripts; status: live
- Body: {filter,limit,offset,with_payload,order_by?}
- Auth: @qdrant/qdrant-js 1.19.0 (REST via js-client-rest): api-key: $QDRANT_API_KEY; Content-Type: application/json; base http://$QDRANT_HOST:$QDRANT_PORT (utils/databases/qdrant.database.ts:16-19)
- Timeout: SDK default 300s (qdrant-js timeout = 300_000); retry: none (SDK has no retry); streaming: no
- Errors: SDK throws ApiError on non-2xx; callers catch/log; rate limit: none

### QD-009 PUT `http://$QDRANT_HOST:$QDRANT_PORT/collections/twitch_chat_logs/points?wait=false`
- Where: `dimabot/src/utils/qdrant/functions/chat_logs/store_chat_log.qdrant.ts:73` (storeChatLog upsert); processes: api; bot; cron (11 workers); scripts; status: live
- Body: {points:[{id,vector,payload}]}
- Auth: @qdrant/qdrant-js 1.19.0 (REST via js-client-rest): api-key: $QDRANT_API_KEY; Content-Type: application/json; base http://$QDRANT_HOST:$QDRANT_PORT (utils/databases/qdrant.database.ts:16-19)
- Timeout: SDK default 300s (qdrant-js timeout = 300_000); retry: none (SDK has no retry); streaming: no
- Errors: SDK throws ApiError on non-2xx; callers catch/log; rate limit: none

### QD-010 GET `http://$QDRANT_HOST:$QDRANT_PORT/collections/{name}/exists`
- Where: `dimabot/src/utils/qdrant/functions/collections/create.collecion.ts:21` (collectionExists); processes: api; bot; cron (11 workers); scripts; status: live
- Auth: @qdrant/qdrant-js 1.19.0 (REST via js-client-rest): api-key: $QDRANT_API_KEY; Content-Type: application/json; base http://$QDRANT_HOST:$QDRANT_PORT (utils/databases/qdrant.database.ts:16-19)
- Timeout: SDK default 300s (qdrant-js timeout = 300_000); retry: none (SDK has no retry); streaming: no
- Errors: SDK throws ApiError on non-2xx; callers catch/log; rate limit: none

### QD-011 PUT `http://$QDRANT_HOST:$QDRANT_PORT/collections/{name}`
- Where: `dimabot/src/utils/qdrant/functions/collections/create.collecion.ts:23` (createCollection); processes: api; bot; cron (11 workers); scripts; status: live
- Body: config from config/qdrant/collections.ts
- Auth: @qdrant/qdrant-js 1.19.0 (REST via js-client-rest): api-key: $QDRANT_API_KEY; Content-Type: application/json; base http://$QDRANT_HOST:$QDRANT_PORT (utils/databases/qdrant.database.ts:16-19)
- Timeout: SDK default 300s (qdrant-js timeout = 300_000); retry: none (SDK has no retry); streaming: no
- Errors: SDK throws ApiError on non-2xx; callers catch/log; rate limit: none

### QD-012 PUT `http://$QDRANT_HOST:$QDRANT_PORT/collections/{name}/index?wait=true`
- Where: `dimabot/src/utils/qdrant/functions/collections/create.collecion.ts:37` (createPayloadIndex); processes: api; bot; cron (11 workers); scripts; status: live
- Body: {field_name,field_schema}
- Auth: @qdrant/qdrant-js 1.19.0 (REST via js-client-rest): api-key: $QDRANT_API_KEY; Content-Type: application/json; base http://$QDRANT_HOST:$QDRANT_PORT (utils/databases/qdrant.database.ts:16-19)
- Timeout: SDK default 300s (qdrant-js timeout = 300_000); retry: none (SDK has no retry); streaming: no
- Errors: SDK throws ApiError on non-2xx; callers catch/log; rate limit: none

### QD-013 POST `http://$QDRANT_HOST:$QDRANT_PORT/collections/{memory}/points/query`
- Where: `dimabot/src/utils/qdrant/functions/memory/retrieve_memory_context.qdrant.ts:132` (retrieve memories (query; search/queryPoints fallbacks at :143/:154 unused with 1.19)); processes: api; bot; cron (11 workers); scripts; status: live
- Body: {query:vector,limit,with_payload,filter,score_threshold}
- Auth: @qdrant/qdrant-js 1.19.0 (REST via js-client-rest): api-key: $QDRANT_API_KEY; Content-Type: application/json; base http://$QDRANT_HOST:$QDRANT_PORT (utils/databases/qdrant.database.ts:16-19)
- Timeout: SDK default 300s (qdrant-js timeout = 300_000); retry: none (SDK has no retry); streaming: no
- Errors: SDK throws ApiError on non-2xx; callers catch/log; rate limit: none

### QD-014 POST `http://$QDRANT_HOST:$QDRANT_PORT/collections/{memory}/points/delete?wait=true`
- Where: `dimabot/src/utils/qdrant/functions/memory/sync_memory.qdrant.ts:168` (delete point(s)); processes: api; bot; cron (11 workers); scripts; status: live
- Body: {points:[id]} | {filter}
- Auth: @qdrant/qdrant-js 1.19.0 (REST via js-client-rest): api-key: $QDRANT_API_KEY; Content-Type: application/json; base http://$QDRANT_HOST:$QDRANT_PORT (utils/databases/qdrant.database.ts:16-19)
- Timeout: SDK default 300s (qdrant-js timeout = 300_000); retry: none (SDK has no retry); streaming: no
- Errors: SDK throws ApiError on non-2xx; callers catch/log; rate limit: none

### QD-015 POST `http://$QDRANT_HOST:$QDRANT_PORT/collections/{memory}/points/delete?wait=true`
- Where: `dimabot/src/utils/qdrant/functions/memory/sync_memory.qdrant.ts:198` (delete by filter); processes: api; bot; cron (11 workers); scripts; status: live
- Body: {filter}
- Auth: @qdrant/qdrant-js 1.19.0 (REST via js-client-rest): api-key: $QDRANT_API_KEY; Content-Type: application/json; base http://$QDRANT_HOST:$QDRANT_PORT (utils/databases/qdrant.database.ts:16-19)
- Timeout: SDK default 300s (qdrant-js timeout = 300_000); retry: none (SDK has no retry); streaming: no
- Errors: SDK throws ApiError on non-2xx; callers catch/log; rate limit: none

### QD-016 POST `http://$QDRANT_HOST:$QDRANT_PORT/collections/{memory}/points`
- Where: `dimabot/src/utils/qdrant/functions/memory/sync_memory.qdrant.ts:45` (retrievePointPayload (retrieve)); processes: api; bot; cron (11 workers); scripts; status: live
- Body: {ids:[id],with_payload}
- Auth: @qdrant/qdrant-js 1.19.0 (REST via js-client-rest): api-key: $QDRANT_API_KEY; Content-Type: application/json; base http://$QDRANT_HOST:$QDRANT_PORT (utils/databases/qdrant.database.ts:16-19)
- Timeout: SDK default 300s (qdrant-js timeout = 300_000); retry: none (SDK has no retry); streaming: no
- Errors: SDK throws ApiError on non-2xx; callers catch/log; rate limit: none

### QD-017 PUT `http://$QDRANT_HOST:$QDRANT_PORT/collections/{memory}/points?wait=true`
- Where: `dimabot/src/utils/qdrant/functions/memory/sync_memory.qdrant.ts:93` (upsertChannelMemoryEmbedding); processes: api; bot; cron (11 workers); scripts; status: live
- Body: {points:[{id,vector,payload}]}
- Auth: @qdrant/qdrant-js 1.19.0 (REST via js-client-rest): api-key: $QDRANT_API_KEY; Content-Type: application/json; base http://$QDRANT_HOST:$QDRANT_PORT (utils/databases/qdrant.database.ts:16-19)
- Timeout: SDK default 300s (qdrant-js timeout = 300_000); retry: none (SDK has no retry); streaming: no
- Errors: SDK throws ApiError on non-2xx; callers catch/log; rate limit: none

### QD-018 gRPC `qdrant-client ~1.17 over gRPC http://{QDRANT_HOST}:{grpc_port} (qdrant.rs:100)`
- Where: `dima-rust/src/utils/qdrant.rs:105` (get_qdrant_client); processes: rust (library); status: port-foundation
- Auth: api-key metadata $QDRANT_API_KEY
- Timeout: client default; retry: none; streaming: no
- Errors: QdrantError; rate limit: none
- Notes: Node uses REST (port $QDRANT_PORT, 6333); Rust uses gRPC (6334): the mock must speak gRPC for Rust or the port must switch to REST.


## Polar (36)

### PO-001 GET `https://api.polar.sh/v1/customers/{id}/state`
- Where: `dimabot/src/domain_events/polar_billing_events.ts:64` (client.customers.getState); processes: api; cron:domain_events; status: live
- Auth: @polar-sh/sdk 0.42.5 (new Polar({accessToken:$POLARSH_OAT}), server production => https://api.polar.sh, IGNORES POLARSH_API_BASE_URL/POLARSH_ENVIRONMENT, utils/polarsh.ts:31): Authorization: Bearer; user-agent: "speakeasy-sdk/typescript 0.42.5 2.801.0 0.1.0 @polar-sh/sdk"
- Timeout: 10s (POLAR_ENTITLEMENT_REQUEST_OPTIONS polar_entitlements.ts:52); retry: retries {strategy:"none"}; streaming: no
- Errors: throws; rate limit: none

### PO-002 GET `https://api.polar.sh/v1/benefit-grants/?customer_id=&is_granted=true&page=&limit=100`
- Where: `dimabot/src/domain_events/polar_entitlements.ts:104` (client.benefitGrants.list); processes: api; cron:domain_events; status: live
- Auth: @polar-sh/sdk 0.42.5 (new Polar({accessToken:$POLARSH_OAT}), server production => https://api.polar.sh, IGNORES POLARSH_API_BASE_URL/POLARSH_ENVIRONMENT, utils/polarsh.ts:31): Authorization: Bearer; user-agent: "speakeasy-sdk/typescript 0.42.5 2.801.0 0.1.0 @polar-sh/sdk"
- Timeout: 10s; retry: none; streaming: no
- Errors: throws; paginated; rate limit: none

### PO-003 GET `https://api.polar.sh/v1/subscriptions/{id}`
- Where: `dimabot/src/domain_events/polar_entitlements.ts:116` (client.subscriptions.get); processes: api; cron:domain_events; status: live
- Auth: @polar-sh/sdk 0.42.5 (new Polar({accessToken:$POLARSH_OAT}), server production => https://api.polar.sh, IGNORES POLARSH_API_BASE_URL/POLARSH_ENVIRONMENT, utils/polarsh.ts:31): Authorization: Bearer; user-agent: "speakeasy-sdk/typescript 0.42.5 2.801.0 0.1.0 @polar-sh/sdk"
- Timeout: 10s; retry: none; streaming: no
- Errors: throws; rate limit: none
- **Consequence:** derives plan entitlements (plan tier)

### PO-004 POST `https://api.polar.sh/v1/customers/`
- Where: `dimabot/src/server/routes/auth.route.ts:1087` (polarshClient.customers.create); processes: api; status: live
- Body: {email,name,externalId,...}
- Auth: @polar-sh/sdk 0.42.5 (new Polar({accessToken:$POLARSH_OAT}), server production => https://api.polar.sh, IGNORES POLARSH_API_BASE_URL/POLARSH_ENVIRONMENT, utils/polarsh.ts:31): Authorization: Bearer; user-agent: "speakeasy-sdk/typescript 0.42.5 2.801.0 0.1.0 @polar-sh/sdk"
- Timeout: none; retry: none; streaming: no
- Errors: throws (caught by route); rate limit: none
- **Consequence:** creates billing customer

### PO-005 GET `https://api.polar.sh/v1/benefit-grants/?{query}`
- Where: `dimabot/src/utils/ai_credit_sources.ts:40` (credit sources); processes: api; bot; cron (shared); scripts; status: live
- Auth: Authorization: Bearer $POLARSH_OAT; Content-Type: application/json; redirect:"error"; base ${POLARSH_API_BASE_URL} || https://sandbox-api.polar.sh if $POLARSH_ENVIRONMENT=sandbox || https://api.polar.sh (billing.ts:458-468)
- Timeout: 15s (credit_gift_provider.ts:95); retry: none; streaming: no
- Errors: non-2xx => GiftProviderError(status) (body never logged); rate limit: none

### PO-006 GET `https://api.polar.sh/v1/orders/{id}`
- Where: `dimabot/src/utils/ai_credit_sources.ts:51` (credit sources order); processes: api; bot; cron (shared); scripts; status: live
- Auth: Authorization: Bearer $POLARSH_OAT; Content-Type: application/json; redirect:"error"; base ${POLARSH_API_BASE_URL} || https://sandbox-api.polar.sh if $POLARSH_ENVIRONMENT=sandbox || https://api.polar.sh (billing.ts:458-468)
- Timeout: 15s (credit_gift_provider.ts:95); retry: none; streaming: no
- Errors: non-2xx => GiftProviderError(status) (body never logged); rate limit: none

### PO-007 GET `https://api.polar.sh/v1/customers/{id}/state`
- Where: `dimabot/src/utils/ai_usage_receipts.ts:463` (client.customers.getState); processes: api; bot; cron (shared); scripts; status: live
- Auth: @polar-sh/sdk 0.42.5 (new Polar({accessToken:$POLARSH_OAT}), server production => https://api.polar.sh, IGNORES POLARSH_API_BASE_URL/POLARSH_ENVIRONMENT, utils/polarsh.ts:31): Authorization: Bearer; user-agent: "speakeasy-sdk/typescript 0.42.5 2.801.0 0.1.0 @polar-sh/sdk"
- Timeout: none; retry: none; streaming: no
- Errors: throws; rate limit: none

### PO-008 GET `https://api.polar.sh/v1/events/?{request}`
- Where: `dimabot/src/utils/ai_usage_receipts.ts:670` (client.events.list); processes: api; bot; cron (shared); scripts; status: live
- Auth: @polar-sh/sdk 0.42.5 (new Polar({accessToken:$POLARSH_OAT}), server production => https://api.polar.sh, IGNORES POLARSH_API_BASE_URL/POLARSH_ENVIRONMENT, utils/polarsh.ts:31): Authorization: Bearer; user-agent: "speakeasy-sdk/typescript 0.42.5 2.801.0 0.1.0 @polar-sh/sdk"
- Timeout: none; retry: none; streaming: no
- Errors: throws; rate limit: none

### PO-009 POST `https://api.polar.sh/v1/checkouts/`
- Where: `dimabot/src/utils/billing.ts:1129` (createCheckout (credit pack)); processes: api; bot; cron (shared); scripts; status: live
- Auth: Authorization: Bearer $POLARSH_OAT; Content-Type: application/json; base ${POLARSH_API_BASE_URL} || https://sandbox-api.polar.sh if $POLARSH_ENVIRONMENT=sandbox || https://api.polar.sh (billing.ts:458-468)
- Timeout: none; retry: none; streaming: no
- Errors: non-2xx => PolarApiError(status, body text) (billing.ts:491-494); rate limit: none
- **Consequence:** money (creates checkout session)

### PO-010 POST `https://api.polar.sh/v1/customer-sessions/`
- Where: `dimabot/src/utils/billing.ts:1193` (customer portal session); processes: api; bot; cron (shared); scripts; status: live
- Auth: Authorization: Bearer $POLARSH_OAT; Content-Type: application/json; base ${POLARSH_API_BASE_URL} || https://sandbox-api.polar.sh if $POLARSH_ENVIRONMENT=sandbox || https://api.polar.sh (billing.ts:458-468)
- Timeout: none; retry: none; streaming: no
- Errors: non-2xx => PolarApiError(status, body text) (billing.ts:491-494); rate limit: none
- **Consequence:** money (portal access)

### PO-011 GET `https://api.polar.sh/v1/customers/{customerId}/state`
- Where: `dimabot/src/utils/billing.ts:1220` (getState (raw REST)); processes: api; bot; cron (shared); scripts; status: live
- Auth: Authorization: Bearer $POLARSH_OAT; Content-Type: application/json; base ${POLARSH_API_BASE_URL} || https://sandbox-api.polar.sh if $POLARSH_ENVIRONMENT=sandbox || https://api.polar.sh (billing.ts:458-468)
- Timeout: none; retry: none; streaming: no
- Errors: non-2xx => PolarApiError(status, body text) (billing.ts:491-494); rate limit: none

### PO-012 GET `https://api.polar.sh/v1/products/{productId}/`
- Where: `dimabot/src/utils/billing.ts:596` (polarRequest); processes: api; bot; cron (shared); scripts; status: live
- Auth: Authorization: Bearer $POLARSH_OAT; Content-Type: application/json; base ${POLARSH_API_BASE_URL} || https://sandbox-api.polar.sh if $POLARSH_ENVIRONMENT=sandbox || https://api.polar.sh (billing.ts:458-468)
- Timeout: none; retry: none; streaming: no
- Errors: non-2xx => PolarApiError(status, body text) (billing.ts:491-494); rate limit: none

### PO-013 GET `https://api.polar.sh/v1/discounts/{discountId}/`
- Where: `dimabot/src/utils/billing.ts:636` (polarRequest); processes: api; bot; cron (shared); scripts; status: live
- Auth: Authorization: Bearer $POLARSH_OAT; Content-Type: application/json; base ${POLARSH_API_BASE_URL} || https://sandbox-api.polar.sh if $POLARSH_ENVIRONMENT=sandbox || https://api.polar.sh (billing.ts:458-468)
- Timeout: none; retry: none; streaming: no
- Errors: non-2xx => PolarApiError(status, body text) (billing.ts:491-494); rate limit: none

### PO-014 POST `https://api.polar.sh/v1/checkouts/`
- Where: `dimabot/src/utils/billing.ts:987` (createCheckout); processes: api; bot; cron (shared); scripts; status: live
- Auth: Authorization: Bearer $POLARSH_OAT; Content-Type: application/json; base ${POLARSH_API_BASE_URL} || https://sandbox-api.polar.sh if $POLARSH_ENVIRONMENT=sandbox || https://api.polar.sh (billing.ts:458-468)
- Timeout: none; retry: none; streaming: no
- Errors: non-2xx => PolarApiError(status, body text) (billing.ts:491-494); rate limit: none
- **Consequence:** money (creates checkout session)

### PO-015 GET `https://api.polar.sh/v1/products/{id}`
- Where: `dimabot/src/utils/credit_gift_provider.ts:129` (loadGiftPair (x2 parallel :129-130)); processes: api; bot; cron (shared); scripts; status: live
- Auth: Authorization: Bearer $POLARSH_OAT; Content-Type: application/json; redirect:"error"; base ${POLARSH_API_BASE_URL} || https://sandbox-api.polar.sh if $POLARSH_ENVIRONMENT=sandbox || https://api.polar.sh (billing.ts:458-468)
- Timeout: 15s (credit_gift_provider.ts:95); retry: none; streaming: no
- Errors: non-2xx => GiftProviderError(status) (body never logged); rate limit: none

### PO-016 GET `https://api.polar.sh/v1/checkouts/?{query}`
- Where: `dimabot/src/utils/credit_gift_provider.ts:144` (recoverGiftCheckout); processes: api; bot; cron (shared); scripts; status: live
- Auth: Authorization: Bearer $POLARSH_OAT; Content-Type: application/json; redirect:"error"; base ${POLARSH_API_BASE_URL} || https://sandbox-api.polar.sh if $POLARSH_ENVIRONMENT=sandbox || https://api.polar.sh (billing.ts:458-468)
- Timeout: 15s (credit_gift_provider.ts:95); retry: none; streaming: no
- Errors: non-2xx => GiftProviderError(status) (body never logged); rate limit: none
- Notes: bounded paginated scan; never re-creates an ambiguous checkout

### PO-017 GET `https://api.polar.sh/v1/orders/?{query}`
- Where: `dimabot/src/utils/credit_gift_provider.ts:156` (gift order lookup); processes: api; bot; cron (shared); scripts; status: live
- Auth: Authorization: Bearer $POLARSH_OAT; Content-Type: application/json; redirect:"error"; base ${POLARSH_API_BASE_URL} || https://sandbox-api.polar.sh if $POLARSH_ENVIRONMENT=sandbox || https://api.polar.sh (billing.ts:458-468)
- Timeout: 15s (credit_gift_provider.ts:95); retry: none; streaming: no
- Errors: non-2xx => GiftProviderError(status) (body never logged); rate limit: none

### PO-018 GET `https://api.polar.sh/v1/benefit-grants/?{query}`
- Where: `dimabot/src/utils/credit_gift_provider.ts:164` (gift grant lookup); processes: api; bot; cron (shared); scripts; status: live
- Auth: Authorization: Bearer $POLARSH_OAT; Content-Type: application/json; redirect:"error"; base ${POLARSH_API_BASE_URL} || https://sandbox-api.polar.sh if $POLARSH_ENVIRONMENT=sandbox || https://api.polar.sh (billing.ts:458-468)
- Timeout: 15s (credit_gift_provider.ts:95); retry: none; streaming: no
- Errors: non-2xx => GiftProviderError(status) (body never logged); rate limit: none

### PO-019 POST `https://api.polar.sh/v1/checkouts/`
- Where: `dimabot/src/utils/credit_gifts.ts:172` (gift purchase checkout); processes: api; cron:domain_events\|credit_gifts; status: live
- Auth: Authorization: Bearer $POLARSH_OAT; Content-Type: application/json; redirect:"error"; base ${POLARSH_API_BASE_URL} || https://sandbox-api.polar.sh if $POLARSH_ENVIRONMENT=sandbox || https://api.polar.sh (billing.ts:458-468)
- Timeout: 15s (credit_gift_provider.ts:95); retry: none; streaming: no
- Errors: non-2xx => GiftProviderError(status) (body never logged); rate limit: none
- **Consequence:** money (paid gift checkout)

### PO-020 GET `https://api.polar.sh/v1/orders/{orderId}`
- Where: `dimabot/src/utils/credit_gifts.ts:194` (gift); processes: api; cron:domain_events\|credit_gifts; status: live
- Auth: Authorization: Bearer $POLARSH_OAT; Content-Type: application/json; redirect:"error"; base ${POLARSH_API_BASE_URL} || https://sandbox-api.polar.sh if $POLARSH_ENVIRONMENT=sandbox || https://api.polar.sh (billing.ts:458-468)
- Timeout: 15s (credit_gift_provider.ts:95); retry: none; streaming: no
- Errors: non-2xx => GiftProviderError(status) (body never logged); rate limit: none

### PO-021 GET `https://api.polar.sh/v1/checkouts/{checkoutId}`
- Where: `dimabot/src/utils/credit_gifts.ts:201` (gift); processes: api; cron:domain_events\|credit_gifts; status: live
- Auth: Authorization: Bearer $POLARSH_OAT; Content-Type: application/json; redirect:"error"; base ${POLARSH_API_BASE_URL} || https://sandbox-api.polar.sh if $POLARSH_ENVIRONMENT=sandbox || https://api.polar.sh (billing.ts:458-468)
- Timeout: 15s (credit_gift_provider.ts:95); retry: none; streaming: no
- Errors: non-2xx => GiftProviderError(status) (body never logged); rate limit: none

### PO-022 GET `https://api.polar.sh/v1/checkouts/{checkoutId}`
- Where: `dimabot/src/utils/credit_gifts.ts:283` (gift fulfilment); processes: api; cron:domain_events\|credit_gifts; status: live
- Auth: Authorization: Bearer $POLARSH_OAT; Content-Type: application/json; redirect:"error"; base ${POLARSH_API_BASE_URL} || https://sandbox-api.polar.sh if $POLARSH_ENVIRONMENT=sandbox || https://api.polar.sh (billing.ts:458-468)
- Timeout: 15s (credit_gift_provider.ts:95); retry: none; streaming: no
- Errors: non-2xx => GiftProviderError(status) (body never logged); rate limit: none

### PO-023 GET `https://api.polar.sh/v1/orders/{paidOrderId}`
- Where: `dimabot/src/utils/credit_gifts.ts:302` (gift fulfilment); processes: api; cron:domain_events\|credit_gifts; status: live
- Auth: Authorization: Bearer $POLARSH_OAT; Content-Type: application/json; redirect:"error"; base ${POLARSH_API_BASE_URL} || https://sandbox-api.polar.sh if $POLARSH_ENVIRONMENT=sandbox || https://api.polar.sh (billing.ts:458-468)
- Timeout: 15s (credit_gift_provider.ts:95); retry: none; streaming: no
- Errors: non-2xx => GiftProviderError(status) (body never logged); rate limit: none

### PO-024 POST `https://api.polar.sh/v1/checkouts/`
- Where: `dimabot/src/utils/credit_gifts.ts:307` (gift fulfilment checkout (free product)); processes: api; cron:domain_events\|credit_gifts; status: live
- Auth: Authorization: Bearer $POLARSH_OAT; Content-Type: application/json; redirect:"error"; base ${POLARSH_API_BASE_URL} || https://sandbox-api.polar.sh if $POLARSH_ENVIRONMENT=sandbox || https://api.polar.sh (billing.ts:458-468)
- Timeout: 15s (credit_gift_provider.ts:95); retry: none; streaming: no
- Errors: non-2xx => GiftProviderError(status) (body never logged); rate limit: none
- **Consequence:** money (grants credits to recipient)

### PO-025 GET `https://api.polar.sh/v1/checkouts/{fulfillmentCheckoutId}`
- Where: `dimabot/src/utils/credit_gifts.ts:318` (gift fulfilment); processes: api; cron:domain_events\|credit_gifts; status: live
- Auth: Authorization: Bearer $POLARSH_OAT; Content-Type: application/json; redirect:"error"; base ${POLARSH_API_BASE_URL} || https://sandbox-api.polar.sh if $POLARSH_ENVIRONMENT=sandbox || https://api.polar.sh (billing.ts:458-468)
- Timeout: 15s (credit_gift_provider.ts:95); retry: none; streaming: no
- Errors: non-2xx => GiftProviderError(status) (body never logged); rate limit: none

### PO-026 GET `https://api.polar.sh/v1/orders/{paidOrderId}`
- Where: `dimabot/src/utils/credit_gifts.ts:324` (gift fulfilment); processes: api; cron:domain_events\|credit_gifts; status: live
- Auth: Authorization: Bearer $POLARSH_OAT; Content-Type: application/json; redirect:"error"; base ${POLARSH_API_BASE_URL} || https://sandbox-api.polar.sh if $POLARSH_ENVIRONMENT=sandbox || https://api.polar.sh (billing.ts:458-468)
- Timeout: 15s (credit_gift_provider.ts:95); retry: none; streaming: no
- Errors: non-2xx => GiftProviderError(status) (body never logged); rate limit: none

### PO-027 POST `https://api.polar.sh/v1/checkouts/client/{client_secret}/confirm`
- Where: `dimabot/src/utils/credit_gifts.ts:328` (confirm free fulfilment checkout); processes: api; cron:domain_events\|credit_gifts; status: live
- Body: "{}"
- Auth: Authorization: Bearer $POLARSH_OAT; Content-Type: application/json; redirect:"error"; base ${POLARSH_API_BASE_URL} || https://sandbox-api.polar.sh if $POLARSH_ENVIRONMENT=sandbox || https://api.polar.sh (billing.ts:458-468)
- Timeout: 15s (credit_gift_provider.ts:95); retry: none; streaming: no
- Errors: non-2xx => GiftProviderError(status) (body never logged); rate limit: none
- **Consequence:** money (confirms credit grant)
- Notes: client_secret in URL path: never log path.

### PO-028 GET `https://api.polar.sh/v1/customers/{polar_sh_customer_id}`
- Where: `dimabot/src/utils/credit_gifts.ts:89` (gift recipient check); processes: api; cron:domain_events\|credit_gifts; status: live
- Auth: Authorization: Bearer $POLARSH_OAT; Content-Type: application/json; redirect:"error"; base ${POLARSH_API_BASE_URL} || https://sandbox-api.polar.sh if $POLARSH_ENVIRONMENT=sandbox || https://api.polar.sh (billing.ts:458-468)
- Timeout: 15s (credit_gift_provider.ts:95); retry: none; streaming: no
- Errors: non-2xx => GiftProviderError(status) (body never logged); rate limit: none

### PO-029 GET `https://api.polar.sh/v1/subscriptions/?{customer_id|external_customer_id}=&limit=100&page=`
- Where: `dimabot/src/utils/polar_account_cancellation.ts:16` (listBillableSubscriptionIds); processes: api; status: live
- Auth: Authorization: Bearer $POLARSH_OAT; Content-Type: application/json; base ${POLARSH_API_BASE_URL} || https://sandbox-api.polar.sh if $POLARSH_ENVIRONMENT=sandbox || https://api.polar.sh (billing.ts:458-468)
- Timeout: none; retry: none; streaming: no
- Errors: non-2xx => PolarApiError(status, body text) (billing.ts:491-494); rate limit: none
- Notes: paginates to pagination.max_page

### PO-030 DELETE `https://api.polar.sh/v1/subscriptions/{id}`
- Where: `dimabot/src/utils/polar_account_cancellation.ts:47` (revokePolarSubscriptionsForAccount); processes: api; status: live
- Auth: Authorization: Bearer $POLARSH_OAT; Content-Type: application/json; base ${POLARSH_API_BASE_URL} || https://sandbox-api.polar.sh if $POLARSH_ENVIRONMENT=sandbox || https://api.polar.sh (billing.ts:458-468)
- Timeout: none; retry: none; streaming: no
- Errors: non-2xx => PolarApiError(status, body text) (billing.ts:491-494); rate limit: none
- **Consequence:** subscription management: REVOKES (ends now) every billable subscription on account deletion
- Notes: on failure re-GETs (:50) and only throws if still billable

### PO-031 GET `https://api.polar.sh/v1/subscriptions/{id}`
- Where: `dimabot/src/utils/polar_account_cancellation.ts:50` (revokePolarSubscriptionsForAccount); processes: api; status: live
- Auth: Authorization: Bearer $POLARSH_OAT; Content-Type: application/json; base ${POLARSH_API_BASE_URL} || https://sandbox-api.polar.sh if $POLARSH_ENVIRONMENT=sandbox || https://api.polar.sh (billing.ts:458-468)
- Timeout: none; retry: none; streaming: no
- Errors: non-2xx => PolarApiError(status, body text) (billing.ts:491-494); rate limit: none

### PO-032 POST `https://api.polar.sh/v1/events/ingest`
- Where: `dimabot/src/utils/polarsh.ts:336` (ingestPolarSHEvent (immediate)); processes: api; bot; cron (shared); scripts; status: live
- Body: {events:[{name:"ai_usage",customerId,externalId,metadata:{cost,currency,credits,reason,_cost?,_llm?,...usage}}]}
- Auth: @polar-sh/sdk 0.42.5 (new Polar({accessToken:$POLARSH_OAT}), server production => https://api.polar.sh, IGNORES POLARSH_API_BASE_URL/POLARSH_ENVIRONMENT, utils/polarsh.ts:31): Authorization: Bearer; user-agent: "speakeasy-sdk/typescript 0.42.5 2.801.0 0.1.0 @polar-sh/sdk"
- Timeout: none (SDK timeoutMs -1); retry: SDK default retryConfig {strategy:"none"} (funcs/eventsIngest.js:48-51); streaming: no
- Errors: throws on HTTP error; success requires inserted+duplicates == sent (polarsh.ts:160-165); rate limit: none
- **Consequence:** money (metered AI-credit usage billing)
- **Bytes matter:** externalId is the dedupe key; metadata numeric truncation rules (polarsh.ts:296-309)

### PO-033 POST `https://api.polar.sh/v1/events/ingest`
- Where: `dimabot/src/utils/polarsh.ts:410` (ingestPolarSHEvent (batch flush of Dragonfly queue twitch:{channelID}:ai:polarshevent)); processes: api; bot; cron (shared); scripts; status: live
- Body: {events:[...queued]}
- Auth: @polar-sh/sdk 0.42.5 (new Polar({accessToken:$POLARSH_OAT}), server production => https://api.polar.sh, IGNORES POLARSH_API_BASE_URL/POLARSH_ENVIRONMENT, utils/polarsh.ts:31): Authorization: Bearer; user-agent: "speakeasy-sdk/typescript 0.42.5 2.801.0 0.1.0 @polar-sh/sdk"
- Timeout: none; retry: none; queue retained on failure, per-channel lock locks:polar-ingest:{channelID} (8s TTL); streaming: no
- Errors: incomplete => queue left intact; rate limit: none
- **Consequence:** money (metered usage)

### PO-034 POST `https://api.polar.sh/v1/events/ingest`
- Where: `dimabot/src/utils/polarsh.ts:489` (grantPolarAiCredits); processes: api; bot; cron (shared); scripts; status: live
- Body: {events:[{name:"ai_usage",metadata:{credits:-N,...}}]}
- Auth: @polar-sh/sdk 0.42.5 (new Polar({accessToken:$POLARSH_OAT}), server production => https://api.polar.sh, IGNORES POLARSH_API_BASE_URL/POLARSH_ENVIRONMENT, utils/polarsh.ts:31): Authorization: Bearer; user-agent: "speakeasy-sdk/typescript 0.42.5 2.801.0 0.1.0 @polar-sh/sdk"
- Timeout: none; retry: none; streaming: no
- Errors: incomplete => error; rate limit: none
- **Consequence:** money (grants credits, negative usage)

### PO-035 POST `https://api.polar.sh/v1/events/ingest`
- Where: `dimabot/src/utils/polarsh.ts:581` (ingestPolarNamedEvents); processes: api; bot; cron (shared); scripts; status: live
- Body: {events:[{name!="ai_usage",customerId,externalId,metadata}]}
- Auth: @polar-sh/sdk 0.42.5 (new Polar({accessToken:$POLARSH_OAT}), server production => https://api.polar.sh, IGNORES POLARSH_API_BASE_URL/POLARSH_ENVIRONMENT, utils/polarsh.ts:31): Authorization: Bearer; user-agent: "speakeasy-sdk/typescript 0.42.5 2.801.0 0.1.0 @polar-sh/sdk"
- Timeout: none; retry: none; streaming: no
- Errors: throws if incomplete; rate limit: none

### PO-036 ANY `PolarConfig::request_json (dima-rust/src/utils/polar.rs:346)`
- Where: `dima-rust/src/utils/polar.rs:372` (foundation client); processes: rust (library); status: port-foundation
- Auth: Bearer $POLARSH_OAT; base POLARSH_API_BASE_URL/env as TS (polar.rs:30-31)
- Timeout: billing: none; gift: 15s total incl. body (polar.rs:285-305,411-414); retry: none; redirects rejected for gift (Policy::none); streaming: no
- Errors: PolarApiError / GiftProviderError parity; rate limit: none


## S3-compatible storage (DigitalOcean Spaces) (10)

### S3-001 PUT `PutObject (custom widget files)`
- Where: `dimabot/src/custom_widgets/files.ts:27` (); processes: api; status: live
- Auth: @aws-sdk/client-s3 3.1111.0: SigV4 (S3_ACCESS_KEY/S3_SECRET_KEY, region $S3_REGION); endpoint $S3_ENDPOINT_URL (path-style) || https://{S3_REGION}.{S3_ENDPOINT} virtual-hosted (utils/s3.ts:5-13)
- Timeout: none; retry: SDK standard retry mode: 3 attempts total, exponential backoff with jitter on throttling/5xx/transient; no request timeout configured; streaming: no
- Errors: throws; rate limit: none

### S3-002 GET `GetObject`
- Where: `dimabot/src/custom_widgets/files.ts:39` (); processes: api; status: live
- Auth: @aws-sdk/client-s3 3.1111.0: SigV4 (S3_ACCESS_KEY/S3_SECRET_KEY, region $S3_REGION); endpoint $S3_ENDPOINT_URL (path-style) || https://{S3_REGION}.{S3_ENDPOINT} virtual-hosted (utils/s3.ts:5-13)
- Timeout: none; retry: SDK standard retry mode: 3 attempts total, exponential backoff with jitter on throttling/5xx/transient; no request timeout configured; streaming: no
- Errors: throws; rate limit: none

### S3-003 DELETE `DeleteObject`
- Where: `dimabot/src/custom_widgets/files.ts:50` (); processes: api; status: live
- Auth: @aws-sdk/client-s3 3.1111.0: SigV4 (S3_ACCESS_KEY/S3_SECRET_KEY, region $S3_REGION); endpoint $S3_ENDPOINT_URL (path-style) || https://{S3_REGION}.{S3_ENDPOINT} virtual-hosted (utils/s3.ts:5-13)
- Timeout: none; retry: SDK standard retry mode: 3 attempts total, exponential backoff with jitter on throttling/5xx/transient; no request timeout configured; streaming: no
- Errors: swallowed; rate limit: none

### S3-004 POST `DeleteObjects (POST /?delete, XML body, Content-MD5/checksum)`
- Where: `dimabot/src/utils/ai/clip_recommendations/clip_recommendation_previews.ts:41` (deleteKeys batch); processes: api; scripts; status: live
- Auth: @aws-sdk/client-s3 3.1111.0: SigV4 (S3_ACCESS_KEY/S3_SECRET_KEY, region $S3_REGION); endpoint $S3_ENDPOINT_URL (path-style) || https://{S3_REGION}.{S3_ENDPOINT} virtual-hosted (utils/s3.ts:5-13)
- Timeout: none; retry: SDK standard retry mode: 3 attempts total, exponential backoff with jitter on throttling/5xx/transient; no request timeout configured; streaming: no
- Errors: throws; per-key Errors in XML; rate limit: none
- **Bytes matter:** requires checksum header over XML body

### S3-005 PUT `PutObject (clip preview)`
- Where: `dimabot/src/utils/ai/clip_recommendations/vod_clip_recommendation_runner.ts:174` (); processes: api; cron:vod_clip_recommender; status: live
- Auth: @aws-sdk/client-s3 3.1111.0: SigV4 (S3_ACCESS_KEY/S3_SECRET_KEY, region $S3_REGION); endpoint $S3_ENDPOINT_URL (path-style) || https://{S3_REGION}.{S3_ENDPOINT} virtual-hosted (utils/s3.ts:5-13)
- Timeout: none; retry: SDK standard retry mode: 3 attempts total, exponential backoff with jitter on throttling/5xx/transient; no request timeout configured; streaming: no
- Errors: throws; rate limit: none

### S3-006 PUT `PutObject s3://$S3_BUCKET/{key}`
- Where: `dimabot/src/utils/s3.ts:38` (uploadTriggerFileToS3); processes: api; cron:vod_clip_recommender; scripts; status: live
- Body: Body stream|Buffer, ContentType, ACL:public-read, CacheControl:"public, max-age=31536000"
- Auth: @aws-sdk/client-s3 3.1111.0: SigV4 (S3_ACCESS_KEY/S3_SECRET_KEY, region $S3_REGION); endpoint $S3_ENDPOINT_URL (path-style) || https://{S3_REGION}.{S3_ENDPOINT} virtual-hosted (utils/s3.ts:5-13)
- Timeout: none; retry: SDK standard retry mode: 3 attempts total, exponential backoff with jitter on throttling/5xx/transient; no request timeout configured; streaming: no
- Errors: throws; rate limit: none
- **Bytes matter:** SigV4 signs headers (x-amz-acl, cache-control, content-type, x-amz-content-sha256)

### S3-007 DELETE `DeleteObject`
- Where: `dimabot/src/utils/s3.ts:53` (deleteTriggerFileFromS3); processes: api; cron:vod_clip_recommender; scripts; status: live
- Auth: @aws-sdk/client-s3 3.1111.0: SigV4 (S3_ACCESS_KEY/S3_SECRET_KEY, region $S3_REGION); endpoint $S3_ENDPOINT_URL (path-style) || https://{S3_REGION}.{S3_ENDPOINT} virtual-hosted (utils/s3.ts:5-13)
- Timeout: none; retry: SDK standard retry mode: 3 attempts total, exponential backoff with jitter on throttling/5xx/transient; no request timeout configured; streaming: no
- Errors: throws; rate limit: none

### S3-008 PUT `PutObject (thumbnail jpg)`
- Where: `dimabot/src/utils/thumbnail_generator.ts:103` (thumbnail); processes: api; scripts; status: live
- Auth: @aws-sdk/client-s3 3.1111.0: SigV4 (S3_ACCESS_KEY/S3_SECRET_KEY, region $S3_REGION); endpoint $S3_ENDPOINT_URL (path-style) || https://{S3_REGION}.{S3_ENDPOINT} virtual-hosted (utils/s3.ts:5-13)
- Timeout: none; retry: SDK standard retry mode: 3 attempts total, exponential backoff with jitter on throttling/5xx/transient; no request timeout configured; streaming: no
- Errors: throws; rate limit: none

### S3-009 PUT|DELETE `aws-sdk-s3 upload_public_object / delete_object`
- Where: `dima-rust/src/utils/s3.rs:174` (S3Storage); processes: rust (library); status: port-foundation
- Auth: SigV4 (sigv4a feature enabled)
- Timeout: SDK default; retry: SDK default; streaming: no
- Errors: SdkError; rate limit: none

### S3-010 GET `{parent.storageUrl}`
- Where: `dimabot/src/utils/thumbnail_generator.ts:74` (generateThumbnail source download); processes: api; script:migrate_dimafx_thumbnails; status: live
- Auth: none (public object)
- Timeout: none; retry: none; streaming: no
- Errors: !ok throws; content-length > MAX_INPUT_FETCH_BYTES rejected; rate limit: none
- Notes: URL comes from our own DB (uploaded asset), not user-typed.


## Resend (2)

### RS-001 POST `https://api.resend.com/emails`
- Where: `dimabot/src/utils/email/email.service.ts:69` (sendRenderedEmail (resend.emails.send)); processes: api; cron:activation-reminder\|stream_memory\|vod_clip_recommender; scripts; status: live
- Body: {from,to[],subject,html,text}
- Auth: resend 6.20.0: Authorization: Bearer $RESEND_API_KEY; User-Agent: resend-node:6.20.0; Idempotency-Key when given; base $RESEND_BASE_URL || https://api.resend.com
- Timeout: none; retry: none (SDK does not retry); streaming: no
- Errors: SDK returns {data,error}; error => {error:true}; rate limit: none
- **Consequence:** sends email to users
- **Bytes matter:** Idempotency-Key reuse semantics

### RS-002 POST `resend-rs send (dima-rust/src/utils/email.rs:100-120)`
- Where: `dima-rust/src/utils/email.rs:109` (send_rendered_email_with); processes: rust (library); status: port-foundation
- Auth: Bearer RESEND_API_KEY; base explicit (email.rs:28,92)
- Timeout: resend-rs default; retry: resend-rs default; streaming: no
- Errors: Api error; rate limit: none


## PostHog + OTLP logs (5)

### PH-001 POST `https://us.i.posthog.com/batch/`
- Where: `dimabot/src/utils/posthog_events.ts:6` (PostHog client (identify:27, capture:48,81,111,157, shutdown:185)); processes: api; bot; cron (18 workers); scripts; status: live
- Body: gzip-compressed JSON {api_key,batch:[{event,distinct_id,properties,timestamp,uuid,type}],sent_at} with Content-Encoding: gzip when CompressionStream available (SDK default)
- Auth: posthog-node 5.49.1: project key phc_ApcLd2... hard-coded in body `api_key` (posthog_events.ts:6)
- Timeout: requestTimeout 10s (SDK default); retry: SDK fetchRetryCount 3, fetchRetryDelay 3s; queue flushAt 20 / flushInterval 1000ms (posthog_events.ts:8-9); maxBatchSize 100, maxQueueSize 1000; streaming: no
- Errors: errors swallowed/emitted on client; rate limit: none

### PH-002 POST `posthog-rs async client (posthog.rs:25,48)`
- Where: `dima-rust/src/utils/posthog.rs:46` (get_posthog_client); processes: rust (library); status: port-foundation
- Auth: project key in body
- Timeout: posthog-rs default; retry: posthog-rs default; streaming: no
- Errors: ignored; rate limit: none

### OT-001 POST `https://us.i.posthog.com/i/v1/logs`
- Where: `dimabot/src/utils/opentelemetry_posthog.ts:15` (OTLPLogExporter via NodeSDK.start() (server/index.ts:44, bot/index.ts:39)); processes: api; bot; status: live
- Body: OTLP/HTTP JSON (exporter-logs-otlp-http => application/json) ExportLogsServiceRequest; resource service.name=DomDimaBot; every logger call (utils/logger.ts:130) emits regardless of destination
- Auth: Authorization: Bearer phc_ApcLd2... (hard-coded, opentelemetry_posthog.ts:17)
- Timeout: 10s per export (otlp-exporter-base shared-configuration.js:43); retry: retrying-transport: max 5 attempts, initial backoff 1s exponential with jitter on retryable codes (429,502,503,504) (otlp-exporter-base retrying-transport.js:9-10); streaming: no
- Errors: dropped after retries; rate limit: none
- Notes: BatchLogRecordProcessor defaults: scheduledDelay 5000ms, maxExportBatchSize 512, maxQueueSize 2048 (sdk-logs BatchLogRecordProcessorBase.js:22-24). Rust port (dima-rust/src/utils/otel.rs) uses http-proto, not JSON.

### OT-002 POST `https://us.i.posthog.com/i/v1/logs (OTLP http-proto)`
- Where: `dima-rust/src/utils/otel.rs:25` (posthog_logger_provider); processes: rust (library); status: port-foundation
- Auth: Bearer phc_...
- Timeout: opentelemetry-otlp default; retry: reqwest-blocking-client; streaming: no
- Errors: dropped; rate limit: none
- Notes: Content-Type application/x-protobuf vs Node JSON.

### OT-003 POST `http://localhost:4318/v1/traces and /v1/metrics`
- Where: `node_modules/@opentelemetry/sdk-node/build/src/sdk.js:174,225` (NodeSDK env defaults); processes: api; bot; status: implicit
- Auth: none
- Timeout: 10s; retry: same retrying transport; streaming: no
- Errors: connection refused inside container; silent; rate limit: none
- Notes: NodeSDK with no OTEL_* env enables default OTLP trace span processor and periodic OTLP metric reader (http/protobuf -> localhost:4318). No instrumentations are registered so traffic is likely empty/none, but a mock may see connection attempts. Recommend NOT porting.


## Our own services (17)

### IN-001 POST `${INTERNAL_API_URL...}/speech/{channelID}/control`
- Where: `dimabot/src/functions/chats/control_tts.chat.ts:13` (controlTts); processes: api; bot; cron (shared); status: live
- Body: {action:"skip"|"clear"|"refresh"}
- Auth: Authorization: Bearer <channel owner Twitch token>; instrumentFetch (utils/observability/telemetry.ts:145-171) adds `traceparent` + `x-observability-signature` = HMAC-SHA256($SECRET_KEY, traceparent) hex for hosts dima-server / 127.0.0.1 (API and bot processes only: server/index.ts:35, bot/index.ts:33)
- Timeout: 10s; retry: none; streaming: no
- Errors: !ok || result.error; rate limit: none

### IN-002 GET `${INTERNAL_API_URL...}/speech/{channelID}/status`
- Where: `dimabot/src/functions/chats/control_tts.chat.ts:31` (getTtsStatus); processes: api; bot; cron (shared); status: live
- Auth: Authorization: Bearer <owner token>
- Timeout: 10s; retry: none; streaming: no
- Errors: validated with isTtsStatusData; rate limit: none

### IN-003 POST `${INTERNAL_API_URL || (NODE_ENV=production ? http://dima-server:3000 : getUrl())}/speech/{channelID}`
- Where: `dimabot/src/functions/chats/speech.chat.ts:40` (requestTts); processes: api; bot; cron (shared); status: live
- Body: TtsRequestBody {text,voice,...,meta}
- Auth: NONE (no Authorization header); instrumentFetch (utils/observability/telemetry.ts:145-171) adds `traceparent` + `x-observability-signature` = HMAC-SHA256($SECRET_KEY, traceparent) hex for hosts dima-server / 127.0.0.1 (API and bot processes only: server/index.ts:35, bot/index.ts:33)
- Timeout: none; retry: none; streaming: no
- Errors: non-2xx => {error:true,message}; rate limit: none
- Notes: Unauthenticated internal call; relies on network isolation.

### IN-004 POST `${INTERNAL_API_URL...}/overlay-studio/{channel}/queue`
- Where: `dimabot/src/utils/ast_parser/functions/overlay.functions.ts:26` (overlay control AST functions); processes: api; bot; cron (shared); status: live
- Body: {action,platform}
- Auth: Authorization: Bearer <overlay owner Twitch token>
- Timeout: 10s; retry: none; streaming: no
- Errors: !ok => Error text; rate limit: none

### IN-005 GET|POST|PATCH `${DIMABOT_INTERNAL_API_URL:-http://dima-server:3000}/extensions/dimafx/internal/channels/{channelID}/... (overlay-status, viewers/{userID}/init, items, viewers/{userID}/config, items/{itemID}/purchase|use-credit|redeem)`
- Where: `dimafx/server/src/services/dimabot-client.ts:62` (DimabotClient.requestFrom); processes: dimafx-server; status: live
- Auth: x-dimafx-service-token: $DIMAFX_SERVICE_TOKEN; Content-Type: application/json
- Timeout: none; retry: on transport error or status>=500 from internal URL, REPEATS the same request against ${DIMABOT_PUBLIC_API_URL:-https://api.domdimabot.com} (dimabot-client.ts:31-55); streaming: no
- Errors: payload.error passthrough; !ok => error with status; rate limit: none
- **Consequence:** money-like (Bits/credit purchases & redemptions in DimaFX store) - fallback can double-submit POSTs
- Notes: 7 callers in dimafx/server/src/routes/extension.routes.ts:30,59,86,102,122,148,168.

### IN-006 POST `https://api.domdimabot.com/sumimetro/{dominante|sumiso}/{channelID}`
- Where: `dimabot/src/commands/sumimetro.command.ts:88` (sumimetro command (also :101,:120,:134)); processes: api; bot; status: likely-dead
- Body: {username,value}
- Auth: none
- Timeout: none; retry: none; streaming: no
- Errors: response ignored; rate limit: none
- Notes: 4 call sites. No matching POST route found in server/routes (only a socket.io page server/routes/public/sumimetro.html) - likely 404 today; verify before porting.

### IN-007 PATCH `https://api.domdimabot.com/rewards/{id}/{rewardID}`
- Where: `dimabot/src/functions/redemptions/custom.redemption.ts:62` (); processes: api; bot; status: live
- Auth: Bearer <streamer token>
- Timeout: none; retry: none; streaming: no
- Errors: logged; rate limit: none
- **Consequence:** channel-points reward management

### IN-008 PATCH `https://api.domdimabot.com/rewards/{channelID}/{rewardID}`
- Where: `dimabot/src/functions/redemptions/resetredemptioncost.redemption.ts:48` (resetRedemptionCost (loop)); processes: api; cron:domain_events\|stream_analytics; status: live
- Auth: Bearer <streamer token>
- Timeout: none; retry: none; streaming: no
- Errors: logged; rate limit: none
- **Consequence:** channel-points reward management

### IN-009 PATCH `https://api.domdimabot.com/rewards/{id}/{rewardID}`
- Where: `dimabot/src/functions/redemptions/vip.redemption.ts:68` (); processes: api; bot; status: live
- Auth: Bearer <streamer token>
- Timeout: none; retry: none; streaming: no
- Errors: logged; rate limit: none
- **Consequence:** channel-points reward management

### IN-010 POST `https://api.domdimabot.com/triggers/{channelID}/send`
- Where: `dimabot/src/functions/triggers/send_trigger.trigger.ts:53` (sendTrigger); processes: api; bot; cron (shared); status: live
- Body: {...triggerData,queue}
- Auth: Authorization: Bearer <streamer Twitch token>
- Timeout: none; retry: none; streaming: no
- Errors: !ok => log + error; rate limit: none
- Notes: Self-call over the PUBLIC hostname (getApiUrl() is hard-coded, utils/dev.ts:14-16), leaves the host and returns through the proxy.

### IN-011 PATCH `https://api.domdimabot.com/rewards/{broadcaster_user_id}/{rewardID}`
- Where: `dimabot/src/handlers/redemption.handler.ts:237` (redemption cost update); processes: api; bot; status: live
- Body: {title,prompt,cost}
- Auth: Authorization: Bearer <streamer token>
- Timeout: none; retry: none; streaming: no
- Errors: responseData.error logged; rate limit: none
- **Consequence:** channel-points reward management (via our API -> Helix PATCH custom_rewards)

### IN-012 GET|PUT|DELETE `http://dima-analytics:3210{req.url} (paths /api/session|overview|resources|traces[/id]|logs|grants[/id])`
- Where: `dimabot/src/server/routes/observability.route.ts:12` (observabilityRoute proxy); processes: api; status: live
- Body: PUT: JSON.stringify(req.body)
- Auth: forwards caller Authorization header verbatim
- Timeout: 12s; retry: none; redirect:"error"; streaming: no
- Errors: network failure => 503; upstream status/body passed through; rate limit: none

### IN-013 GET `${HOSTSTATS_URL:-http://dima-hoststats:3211}/v1/snapshot`
- Where: `dima-analytics/src/infrastructure.mjs:89` (fetchSnapshot); processes: dima-analytics; status: live
- Auth: none
- Timeout: 3s; retry: none; redirect:"error"; streaming: no
- Errors: !ok throws; body >512000 chars rejected; sanitizeSnapshot; rate limit: none

### DK-001 GET `http+unix://docker/containers/json?all=1 | /containers/{id}/json | /containers/{id}/stats?stream=false&one-shot=true`
- Where: `dima-hoststats/src/index.mjs:31` (dockerClient); processes: dima-hoststats; status: live
- Auth: none (socket access); Host: docker
- Timeout: 5s (index.mjs:28); retry: none; streaming: no
- Errors: status!=200 rejects; 16 MiB cap; ALLOWED path regex; rate limit: none
- Notes: Unix socket, not TCP; mock must provide a socket.

### IN-014 PUT `http://localhost:3355/user/active`
- Where: `dimabot/src/server/routes/user.route.ts:251` (PUT /active/:channelID); processes: api; status: likely-dead
- Body: {channelID,active} (no Content-Type header)
- Auth: none
- Timeout: none; retry: none; streaming: no
- Errors: errors logged and ignored; rate limit: none
- Notes: Nothing listens on :3355 in the API container as far as the repo shows; legacy. Verify, likely drop.

### DD-001 GET `${DOCS_ASSISTANT_SOURCE_URL:-http://dimadocs}/[es/]llms.txt`
- Where: `dimabot/src/site_agent/docs/source.ts:61` (downloadDescriptions); processes: api; status: live
- Auth: none
- Timeout: 10s; retry: none; streaming: no
- Errors: !ok => error; rate limit: none

### DD-002 GET `${DOCS_ASSISTANT_SOURCE_URL:-http://dimadocs}/[es/]llms-full.txt`
- Where: `dimabot/src/utils/ai/docs_assistant/docs_source.ts:58` (download); processes: api; status: live
- Auth: none
- Timeout: 10s; retry: none; streaming: no
- Errors: !ok => error; rate limit: none


## Other third parties (1)

### SX-001 GET `https://search.myhomelab.wtf/search?q={query}&format=json`
- Where: `dimabot/src/utils/ai/tools/search.tool.ts:52` (search tool execute); processes: api; bot; cron (shared); status: live
- Auth: none
- Timeout: none; retry: none; streaming: no
- Errors: json parsed; resultsData.error logged; no ok check; rate limit: none
- Notes: Third-party self-hosted SearXNG; query text comes from the model.


## User-supplied / model-supplied URLs (3)

### UU-001 HEAD `https://{cdn|static}.streamelements.com/...`
- Where: `dimabot/src/custom_widgets/media.ts:66` (size (via safeFetch)); processes: api; status: live
- Auth: none, credentials:"omit"
- Timeout: 10s; retry: none; streaming: no
- Errors: !ok => null size; rate limit: none
- Notes: see SSRF section

### UU-002 GET `https://{cdn|static}.streamelements.com/...`
- Where: `dimabot/src/custom_widgets/media.ts:89` (download (via safeFetch)); processes: api; status: live
- Auth: none
- Timeout: 120s; retry: none; streaming: streamed to temp file
- Errors: !ok throws; MAX_ASSET_BYTES enforced on declared and streamed length; rate limit: none

### UU-003 ANY `arbitrary URL chosen by AI-generated code`
- Where: `dimabot/src/utils/ai/sandbox/execute_sandbox.ai.ts:105` (executeAiCode (deno run --allow-net)); processes: api; bot; cron (shared); status: live
- Auth: script gets env AUTH_TOKEN = streamer.bot_token, CHANNEL_ID, CHANNEL_NAME (code_execution.tool.ts:381-385)
- Timeout: 8s process timeout (execute_sandbox.ai.ts:16); retry: none; streaming: no
- Errors: stdout parsed as JSON; rate limit: none
- **Consequence:** can perform any Helix action the bot token allows
- Notes: Prompted to call https://api.twitch.tv and https://api.domdimabot.com/command/{CHANNEL_ID} (code_execution.tool.ts:246-274) but NOT enforced. See SSRF section.


## SDK surface (minimal REST the Rust port must cover)

### @anthropic-ai/sdk (0.80.0 (installed))
- Used in: `dimabot/src/utils/ai/minimax/minimax_client.ts:15`
- `new Anthropic({baseURL,apiKey,timeout:60000,maxRetries:2})` -> - (minimax_client.ts:118)
- `messages.stream(body,{signal}) + .on("streamEvent") + .finalMessage()` -> POST {baseURL}/v1/messages with stream:true (SSE) (minimax_client.ts:236-256)
- `Anthropic.APIUserAbortError (type only)` -> - (minimax_client.ts:250)
- Implicit: Headers: x-api-key, anthropic-version: 2023-06-01, content-type, user-agent "Anthropic/JS 0.80.0", x-stainless-lang/package-version/os/arch/runtime/runtime-version/retry-count/timeout headers
- Implicit: Retries: maxRetries=2, retry on connection error, 408, 409, 429, >=500; honours retry-after-ms / retry-after; exponential backoff ~0.5s doubling to 8s with jitter; also honours x-should-retry header
- Implicit: Timeout applies per attempt until headers (stream body governed by caller idle watchdog 120s)
- Implicit: MessageStream accumulates content blocks incl. thinking + signature; finalMessage() resolves after message_stop
- Implicit: Base URL path join: baseURL "https://api.minimax.io/anthropic" + "/v1/messages"

### @google/genai (^0.6.1 declared in dimabot/package.json)
- Implicit: NOT imported anywhere in dimabot/src (grep GoogleGenAI|generativelanguage = 0 hits). No Gemini calls. Unused dependency.

### @polar-sh/sdk (0.42.5 (installed))
- Used in: `dimabot/src/utils/polarsh.ts:1`, `dimabot/src/domain_events/polar_entitlements.ts:1`, `dimabot/src/server/routes/webhooks/polarsh.webhook.ts:2`
- `events.ingest({events})` -> POST /v1/events/ingest (polarsh.ts:336,410,489,581)
- `events.list(request)` -> GET /v1/events/ (ai_usage_receipts.ts:670)
- `customers.getState({id})` -> GET /v1/customers/{id}/state (ai_usage_receipts.ts:463; polar_billing_events.ts:64)
- `customers.create(...)` -> POST /v1/customers/ (server/routes/auth.route.ts:1087)
- `benefitGrants.list({customerId,isGranted:true,page,limit:100})` -> GET /v1/benefit-grants/ (polar_entitlements.ts:104)
- `subscriptions.get({id})` -> GET /v1/subscriptions/{id} (polar_entitlements.ts:116)
- `validateEvent(rawBody, headers, secret) from @polar-sh/sdk/webhooks.js` -> inbound webhook verification (no network) (polarsh.webhook.ts:2,14-30)
- Implicit: Server defaults to production https://api.polar.sh; the SDK client IGNORES POLARSH_API_BASE_URL and POLARSH_ENVIRONMENT (only raw-REST helpers honour them) - a mock must intercept api.polar.sh for SDK calls
- Implicit: retryConfig default {strategy:"none"}; retryCodes 429/5xx only used if a strategy is passed (polar_entitlements passes strategy none explicitly)
- Implicit: timeoutMs default -1 (no timeout) except entitlement calls (10s)
- Implicit: camelCase request fields are serialised to snake_case query/body (customerId -> customer_id, isGranted -> is_granted, externalId -> external_id)
- Implicit: Responses are validated with zod schemas; unknown enum values can throw ResponseValidationError
- Implicit: user-agent: speakeasy-sdk/typescript 0.42.5 2.801.0 0.1.0 @polar-sh/sdk
- Implicit: validateEvent: standardwebhooks Webhook(base64(utf8 secret)).verify(rawBody, {webhook-id, webhook-timestamp, webhook-signature}) => HMAC-SHA256 over "{id}.{timestamp}.{raw body}" base64 (node_modules/@polar-sh/sdk/dist/esm/webhooks.js:1,111-112); route uses express.raw so bytes are unmodified

### @qdrant/qdrant-js (1.19.0 installed (^1.16.2 declared))
- Used in: `dimabot/src/utils/databases/qdrant.database.ts:1`
- `getCollections` -> GET /collections (qdrant.database.ts:22)
- `collectionExists` -> GET /collections/{c}/exists (create.collecion.ts:21)
- `createCollection` -> PUT /collections/{c} (create.collecion.ts:23)
- `createPayloadIndex` -> PUT /collections/{c}/index (create.collecion.ts:37)
- `upsert` -> PUT /collections/{c}/points?wait= (store_chat_log.qdrant.ts:73; embedding_batcher.class.ts:130; sync_memory.qdrant.ts:93)
- `retrieve` -> POST /collections/{c}/points (sync_memory.qdrant.ts:45)
- `delete` -> POST /collections/{c}/points/delete (sync_memory.qdrant.ts:168,198)
- `query` -> POST /collections/{c}/points/query (retrieve_memory_context.qdrant.ts:132; retrieve_chat_context.qdrant.ts:126)
- `scroll` -> POST /collections/{c}/points/scroll (retrieve_chat_window.qdrant.ts:139; stream_summary_context.ts:267)
- `search / queryPoints / scrollPoints (feature-detected fallbacks, not reached with 1.19)` -> POST /points/search (retrieve_memory_context.qdrant.ts:143,154)
- Implicit: checkCompatibility defaults true: constructor calls GET / (versionInfo) and logs a warning on mismatch
- Implicit: timeout default 300000 ms, no retries
- Implicit: api-key header
- Implicit: upsert default wait=true when not passed (callers pass explicitly)
- Implicit: Node uses REST; dima-rust uses gRPC (qdrant-client ~1.17, port 6334) - mock protocol differs

### @aws-sdk/client-s3 (3.1111.0 installed)
- Used in: `dimabot/src/utils/s3.ts:1`, `dimabot/src/utils/thumbnail_generator.ts:7`, `dimabot/src/custom_widgets/files.ts:2`, `dimabot/src/utils/ai/clip_recommendations/*.ts`
- `PutObjectCommand` -> PUT /{key} (virtual-hosted) (s3.ts:29; thumbnail_generator.ts:103; vod_clip_recommendation_runner.ts:174; custom_widgets/files.ts:27)
- `DeleteObjectCommand` -> DELETE /{key} (s3.ts:48; custom_widgets/files.ts:50)
- `GetObjectCommand` -> GET /{key} (custom_widgets/files.ts:39)
- `DeleteObjectsCommand` -> POST /?delete (XML) (clip_recommendation_previews.ts:41)
- Implicit: No presigning (@aws-sdk/s3-request-presigner not installed/used) and no multipart (lib-storage Upload not used); PutObject with a Readable body needs a known length or the SDK falls back to aws-chunked streaming signature
- Implicit: SigV4 with x-amz-content-sha256; recent SDKs add default CRC32 flexible checksums (x-amz-checksum-crc32, x-amz-sdk-checksum-algorithm) on PutObject/DeleteObjects - DigitalOcean Spaces must accept them
- Implicit: Standard retry strategy, maxAttempts 3, exponential backoff with jitter; no request timeout configured
- Implicit: forcePathStyle only when S3_ENDPOINT_URL set; public URL https://{bucket}.{region}.{endpoint}/{key} unless S3_PUBLIC_URL
- Implicit: ACL public-read + Cache-Control set on uploads

### resend (6.20.0 installed)
- Used in: `dimabot/src/utils/email/email.service.ts:7`
- `emails.send({from,to,subject,html,text},{idempotencyKey}?)` -> POST https://api.resend.com/emails (email.service.ts:69)
- Implicit: Base URL overridable via RESEND_BASE_URL env (SDK reads it)
- Implicit: User-Agent resend-node:6.20.0; Idempotency-Key header when provided
- Implicit: No retries; returns {data,error} instead of throwing for API errors
- Implicit: HTML rendered beforehand by @react-email/render (local, no network)

### posthog-node (5.49.1 installed)
- Used in: `dimabot/src/utils/posthog_events.ts:1`
- `new PostHog(key,{host:"https://us.i.posthog.com",flushInterval:1000,flushAt:20})` -> - (posthog_events.ts:6-10)
- `identify({distinctId,properties})` -> queued -> POST /batch/ (posthog_events.ts:27)
- `capture({distinctId,event,properties})` -> queued -> POST /batch/ (posthog_events.ts:48,81,111,157)
- `shutdown()` -> final flush (posthog_events.ts:185)
- Implicit: Batching: flushAt 20 events or every 1000 ms; maxBatchSize 100; maxQueueSize 1000 (drops oldest)
- Implicit: Transport: requestTimeout 10s, fetchRetryCount 3, fetchRetryDelay 3s
- Implicit: Body gzip-compressed (Content-Encoding: gzip) when the runtime supports CompressionStream; disableCompression not set
- Implicit: Each event gets uuid v7 + timestamp + $lib/$lib_version properties; no feature-flag calls (no personalApiKey), so /flags is never hit
- Implicit: Client is created at module import in every process that imports posthog_events.ts (API, bot, 18 cron workers, scripts)

### fish-audio (0.1.0 installed)
- Used in: `dimabot/src/server/services/tts/fish_tts.service.ts:4`
- `new FishAudioClient({apiKey})` -> - (fish_tts.service.ts:83)
- `textToSpeech.convert({text,reference_id,format:"mp3"}, backend "s2.1-pro", {abortSignal,timeoutInSeconds:20})` -> POST https://api.fish.audio/v1/tts, header model: s2.1-pro, Content-Type application/msgpack, streaming response (fish_tts.service.ts:42-55)
- Implicit: Body is MessagePack (@msgpack/msgpack encode), not JSON
- Implicit: Fern fetcher: default maxRetries 2 on 408/429/>=500, delay 1s*2^n with +-10% jitter capped 60s, Retry-After honoured
- Implicit: default timeout 240s overridden to 20s
- Implicit: The voice catalogue (api.fish.audio/model) is called with plain fetch, not the SDK

### gtts (^0.2.1 declared)
- Implicit: NOT imported in dimabot/src (0 hits). Unused dependency; no translate.google.com calls.

### @opentelemetry/sdk-node + exporter-logs-otlp-http + sdk-logs + resources + api-logs (0.214 / 2.6)
- Used in: `dimabot/src/utils/opentelemetry_posthog.ts:1-24`, `dimabot/src/utils/logger.ts:3,7,130`
- `new NodeSDK({resource:{service.name:"DomDimaBot"}, logRecordProcessor: new BatchLogRecordProcessor(new OTLPLogExporter({url,headers}))}).start()` -> POST https://us.i.posthog.com/i/v1/logs (opentelemetry_posthog.ts:10-21; server/index.ts:44; bot/index.ts:39)
- `logs.getLogger("DomDimaBot").emit({severityText,body,attributes})` -> - (logger.ts:7,130)
- Implicit: exporter-logs-otlp-http sends OTLP JSON (application/json)
- Implicit: BatchLogRecordProcessor: scheduledDelayMillis 5000, maxExportBatchSize 512, maxQueueSize 2048, exportTimeout 30000
- Implicit: Exporter: timeoutMillis 10000; retrying transport max 5 attempts, initial backoff 1s, on 429/502/503/504 (and Retry-After)
- Implicit: NodeSDK also auto-configures OTLP trace + metric exporters from env defaults (otlp, http/protobuf, http://localhost:4318) because none are passed (sdk-node sdk.js:27-33,174,225); auto resource detectors (host/process/env) run locally
- Implicit: Cron workers never start the SDK: their logger emits go to the no-op global provider

### standardwebhooks (transitive (via @polar-sh/sdk))
- Used in: `node_modules/@polar-sh/sdk/dist/esm/webhooks.js:1`
- `Webhook(base64Secret).verify(payload, headers)` -> inbound only (polarsh.webhook.ts:14)
- Implicit: Not imported directly by our code; signature = base64(HMAC-SHA256(key=base64-decoded secret, "{webhook-id}.{webhook-timestamp}.{body}")), timestamp tolerance 5 minutes, header may hold several "v1,<sig>" entries

### @react-email/* (-)
- Used in: `dimabot/src/utils/email/**`
- Implicit: Local rendering only; no network

## User-supplied URLs and SSRF protections

### Custom widget media copy
- Where: `dimabot/src/custom_widgets/media.ts:24-60`
- Protection: host allowlist cdn.streamelements.com / static.streamelements.com, https only, no userinfo, port 443 only (media.ts:24-28)
- Protection: DNS resolution check of ALL A/AAAA records against BlockList of private/loopback/CGNAT/link-local/benchmark/multicast/reserved v4 and ::, ::1, fc00::/7, fe80::/10, 64:ff9b::/96, ff00::/8 v6; also matches IPv4-mapped v6 (media.ts:30-34,44-45)
- Protection: redirect:"manual", max 3 hops, every hop re-validated (media.ts:40-52)
- Protection: credentials:"omit", no headers sent
- Protection: timeouts HEAD 10s, GET 120s; size cap MAX_ASSET_BYTES on Content-Length and streamed bytes (media.ts:89-96); MAX_FILES 40, 6 parallel
- **Gap:** DNS rebinding TOCTOU: lookup result is not pinned; fetch resolves again (Rust: use a custom resolver / connect to the checked IP with SNI)
- **Gap:** privateAddress treats non-IP strings as blocked (good) but no check on response Content-Type

### AI code_execution tool (Deno sandbox)
- Where: `dimabot/src/utils/ai/sandbox/execute_sandbox.ai.ts:105-113; dimabot/src/utils/ai/tools/code_execution.tool.ts:381-389`
- Protection: deno run --no-prompt --allow-net --no-allow-read --no-allow-write --no-allow-env; 8s timeout; max 25 concurrent processes (execute_sandbox.ai.ts:16-17)
- Protection: tool hidden from pet personas (ai.ts:1041-1042)
- **Gap:** --allow-net is UNRESTRICTED: model-written code can reach any host incl. internal Docker services (http://dima-server:3000, http://dima-analytics:3210, http://qdrant:6333, http://lfm2.5-embeddings:8080, piper, dimadocs, dima-hoststats:3211) and cloud metadata IPs
- **Gap:** the bot token is injected as AUTH_TOKEN, so prompt-injected chat can drive arbitrary Helix calls as the bot
- **Gap:** "only to allowed endpoints" exists only as prompt text (code_execution.tool.ts:246)

### Web search tool
- Where: `dimabot/src/utils/ai/tools/search.tool.ts:52`
- Protection: fixed host search.myhomelab.wtf; query is the only user/model-controlled input (URL-encoded)
- **Gap:** no timeout, no ok check, no size limit

### Thumbnail source download
- Where: `dimabot/src/utils/thumbnail_generator.ts:74`
- Protection: URL is parent.storageUrl from our DB (S3 public URL written by our upload code); Content-Length cap MAX_INPUT_FETCH_BYTES
- **Gap:** no timeout; no host check (trusts DB)

### Docs sources
- Where: `dimabot/src/utils/ai/docs_assistant/docs_source.ts:57; dimabot/src/site_agent/docs/source.ts:61`
- Protection: base from env DOCS_ASSISTANT_SOURCE_URL or http://dimadocs; only language segment varies; 10s timeout

### Observability proxy
- Where: `dimabot/src/server/routes/observability.route.ts:7-17`
- Protection: fixed host http://dima-analytics:3210; path regex allowlist; methods GET/PUT/DELETE; redirect:"error"; 12s
- **Gap:** forwards caller Authorization verbatim (by design; analytics re-validates with Twitch)

### Command functions fetching a custom user API
- Where: `-`
- **Gap:** None found: grep of functions/** and utils/ast_parser/** shows no AST function that fetches a user-supplied URL (fetch call sites there are fixed Helix / internal URLs). Custom widget runtime fetches happen in the browser, not the server.

## Hosts a mock must impersonate

| Host | TLS / transport | Used for |
|---|---|---|
| `api.twitch.tv` | TLS (SNI api.twitch.tv) | Helix |
| `id.twitch.tv` | TLS | OAuth token / validate |
| `openrouter.ai` | TLS | chat, SSE chat, embeddings, audio/speech, alpha/decisions, generation |
| `api.minimax.io` | TLS | Anthropic-compatible /anthropic/v1/messages |
| `api.fish.audio` | TLS | v1/tts (msgpack), model catalogue |
| `api.polar.sh` | TLS (sandbox-api.polar.sh when POLARSH_ENVIRONMENT=sandbox, raw REST only) | REST + SDK |
| `api.resend.com` | TLS | emails |
| `us.i.posthog.com` | TLS | /batch/ (gzip) and /i/v1/logs (OTLP) |
| `{S3_BUCKET}.{S3_REGION}.{S3_ENDPOINT} e.g. dima-media.nyc3.digitaloceanspaces.com` | TLS (virtual-hosted; wildcard *.nyc3.digitaloceanspaces.com) | S3 API + public object GET |
| `{S3_REGION}.{S3_ENDPOINT} e.g. nyc3.digitaloceanspaces.com` | TLS | S3 endpoint (SDK rewrites to bucket subdomain) |
| `search.myhomelab.wtf` | TLS | SearXNG JSON |
| `cdn.streamelements.com, static.streamelements.com` | TLS | custom widget media copy |
| `api.domdimabot.com` | TLS (our public API through Nginx Proxy Manager) | self-calls: triggers, rewards, sumimetro; DimaFX fallback |
| `dima-server:3000` | plain HTTP (Docker network) | internal API (speech, overlay-studio, dimafx internal) |
| `dima-analytics:3210` | plain HTTP | observability proxy target |
| `dima-hoststats:3211` | plain HTTP | host snapshot |
| `qdrant:$QDRANT_PORT (6333 REST) / qdrant:6334 gRPC for Rust` | plain HTTP / h2c | vector DB |
| `lfm2.5-embeddings:8080` | plain HTTP | self-hosted embeddings |
| `$PIPER_HTTP_URL (piper container)` | plain HTTP | Piper TTS |
| `dimadocs:80` | plain HTTP | llms.txt / llms-full.txt |
| `localhost:3355` | plain HTTP | legacy /user/active (likely nothing listening) |
| `localhost:4318` | plain HTTP | implicit OTLP trace/metric defaults (Node SDK) |
| `unix:/var/run/docker.sock` | unix socket | Docker Engine API (hoststats) |
| `Twitch EventSub webhook callback https://subscriptions.domdimabot.com/eventsub` | inbound (registered with Twitch, not called by us) | listed so the rig can deliver signed notifications |

The Node code hard-codes most third-party hosts (no base-URL env) - the rig needs DNS/hosts overrides plus a trusted CA, or the Rust port should take a base URL per provider. Overridable today: `OPENROUTER_BASE_URL` (site agent only), `MINIMAX_BASE_URL`, `POLARSH_API_BASE_URL` (raw REST only, not the SDK), `RESEND_BASE_URL`, `S3_ENDPOINT_URL`, `INTERNAL_API_URL`, `DIMABOT_INTERNAL_API_URL`/`DIMABOT_PUBLIC_API_URL`, `PIPER_HTTP_URL`, `LFM2_EMBEDDINGS_URL`, `DOCS_ASSISTANT_SOURCE_URL`, `QDRANT_HOST/PORT`, `QDRANT_URL`, `HOSTSTATS_URL`.

## Calls with money or moderation consequences

- **EventSub subscription management (controls inbound events)**: TW-071 POST `api.twitch.tv/helix/eventsub/subscriptions`, TW-073 DELETE `api.twitch.tv/helix/eventsub/subscriptions`
- **can perform any Helix action the bot token allows**: UU-003 ANY `arbitrary URL chosen by AI-generated code`
- **channel action (raid)**: TW-012 POST `api.twitch.tv/helix/raids`, TW-016 DELETE `api.twitch.tv/helix/raids`
- **channel metadata change (title/category)**: TW-015 PATCH `api.twitch.tv/helix/channels`
- **channel-points economy (polls/predictions; PATCH predictions RESOLVED pays out)**: TW-037 POST `api.twitch.tv/helix/polls`, TW-038 PATCH `api.twitch.tv/helix/polls`, TW-040 POST `api.twitch.tv/helix/predictions`, TW-041 PATCH `api.twitch.tv/helix/predictions`
- **channel-points reward management**: TW-060 DELETE `api.twitch.tv/helix/channel_points/custom_rewards`, TW-063 DELETE `api.twitch.tv/helix/channel_points/custom_rewards`, TW-064 PATCH `api.twitch.tv/helix/channel_points/custom_rewards`, TW-065 POST `api.twitch.tv/helix/channel_points/custom_rewards`, TW-070 PATCH `api.twitch.tv/helix/channel_points/custom_rewards`, IN-007 PATCH `api.domdimabot.com/rewards/{id}/{rewardID}`, IN-008 PATCH `api.domdimabot.com/rewards/{channelID}/{rewardID}`, IN-009 PATCH `api.domdimabot.com/rewards/{id}/{rewardID}`
- **channel-points reward management (via our API -> Helix PATCH custom_rewards)**: IN-011 PATCH `api.domdimabot.com/rewards/{broadcaster_user_id}/{rewardID}`
- **creates billing customer**: PO-004 POST `api.polar.sh/v1/customers/`
- **creates public clip**: TW-031 POST `api.twitch.tv/helix/clips`
- **derives plan entitlements (plan tier)**: PO-003 GET `api.polar.sh/v1/subscriptions/{id}`
- **feeds automated moderation decisions (deletes/timeouts downstream)**: OR-014 POST `openrouter.ai/api/alpha/decisions`
- **moderation (ban/timeout)**: TW-034 POST `api.twitch.tv/helix/moderation/bans`
- **moderation (chat mode change)**: TW-029 PATCH `api.twitch.tv/helix/chat/settings`
- **moderation (clear chat / delete message)**: TW-018 DELETE `api.twitch.tv/helix/moderation/chat`, TW-019 DELETE `api.twitch.tv/helix/moderation/chat`
- **moderation (pinned message)**: TW-025 PUT `api.twitch.tv/helix/chat/pins`, TW-026 PATCH `api.twitch.tv/helix/chat/pins`, TW-027 DELETE `api.twitch.tv/helix/chat/pins`
- **moderation (warn)**: TW-036 POST `api.twitch.tv/helix/moderation/warnings`
- **money (confirms credit grant)**: PO-027 POST `api.polar.sh/v1/checkouts/client/{client_secret}/confirm`
- **money (creates checkout session)**: PO-009 POST `api.polar.sh/v1/checkouts/`, PO-014 POST `api.polar.sh/v1/checkouts/`
- **money (grants credits to recipient)**: PO-024 POST `api.polar.sh/v1/checkouts/`
- **money (grants credits, negative usage)**: PO-034 POST `api.polar.sh/v1/events/ingest`
- **money (metered AI-credit usage billing)**: PO-032 POST `api.polar.sh/v1/events/ingest`
- **money (metered usage)**: PO-033 POST `api.polar.sh/v1/events/ingest`
- **money (paid gift checkout)**: PO-019 POST `api.polar.sh/v1/checkouts/`
- **money (portal access)**: PO-010 POST `api.polar.sh/v1/customer-sessions/`
- **money-like (Bits/credit purchases & redemptions in DimaFX store) - fallback can double-submit POSTs**: IN-005 GET|POST|PATCH `${DIMABOT_INTERNAL_API_URL:-http://dima-server:3000}/extensions/dimafx/internal/channels/{channelID}/... (overlay-status, viewers/{userID}/init, items, viewers/{userID}/config, items/{itemID}/purchase|use-credit|redeem)`
- **public chat output**: TW-017 POST `api.twitch.tv/helix/chat/announcements`, TW-028 POST `api.twitch.tv/helix/chat/messages`, TW-030 POST `api.twitch.tv/helix/chat/shoutouts`
- **role change (VIP)**: TW-005 POST `api.twitch.tv/helix/channels/vips`, TW-014 DELETE `api.twitch.tv/helix/channels/vips`
- **role change (moderator)**: TW-004 POST `api.twitch.tv/helix/moderation/moderators`, TW-013 DELETE `api.twitch.tv/helix/moderation/moderators`
- **sends email to users**: RS-001 POST `api.resend.com/emails`
- **subscription management: REVOKES (ends now) every billable subscription on account deletion**: PO-030 DELETE `api.polar.sh/v1/subscriptions/{id}`
- **Account deletion** revokes every billable Polar subscription (PO rows for `polar_account_cancellation.ts:47`) before data removal.
- **DimaFX fallback** re-sends POST/PATCH (purchase, use-credit, redeem) to the public API when the internal call fails with a network error or 5xx: possible double spend if the first request was applied (`dimafx/server/src/services/dimabot-client.ts:31-55`).
- **AI sandbox** can perform any Helix action the bot token allows (UU row for execute_sandbox).

## Where request bytes matter

- Twitch EventSub inbound: HMAC-SHA256($TWITCH_EVENTSUB_SECRET, message-id + message-timestamp + RAW body) compared with Twitch-Eventsub-Message-Signature (dimabot/src/bot/eventsub.twitch.ts:64-68). Rig must sign exact bytes; parser must keep the raw body.
- Polar webhook inbound: standardwebhooks HMAC over "{webhook-id}.{webhook-timestamp}.{raw body}" with base64(utf8 secret) key (polarsh.webhook.ts:14 express.raw; @polar-sh/sdk webhooks.js:111-112).
- Internal trace header: x-observability-signature = hex HMAC-SHA256($SECRET_KEY, traceparent string) (telemetry.ts:122-124 verify, 159-161 sign). Applied by instrumentFetch only to hostnames dima-server and 127.0.0.1.
- DimaFX: x-extension-jwt verified with base64-decoded $TWITCH_EXTENSION_SECRET (dimafx/server/src/middleware/twitch-extension-auth.ts:26,46) - inbound; outbound uses static x-dimafx-service-token.
- S3 SigV4: canonical request covers method, path, query, signed headers (host, x-amz-date, x-amz-content-sha256, x-amz-acl, content-type, cache-control, checksum headers) and payload hash; DeleteObjects needs a checksum over the XML body.
- Fish Audio /v1/tts: MessagePack body; key order {text, reference_id, format} as produced by @msgpack/msgpack encode of the object literal.
- Prompt-cache sensitive: MiniMax system text blocks (docs assistant keeps a stable prefix, minimax_client.ts:51) and thinking blocks echoed back unchanged across tool rounds; OpenRouter chat bodies (system prompt + tools JSON order) in ai.ts:499-512 and site agent (site_agent/llm/openrouter.ts:70-90) - reorder or whitespace changes reduce cache hits and change cost.
- Polar ingest: externalId is the dedupe key; amounts truncated by string length (polarsh.ts:296-309) - numeric formatting must match to keep metered cost identical.
- Twitch query strings built by raw concatenation (not URL-encoded): users?login=${login}, users?id=${id}, chat/settings?broadcaster_id=..&moderator_id=.., moderation/chat?...&message_id=.., eventsub/subscriptions?id=${id} (see TW rows).
- PostHog /batch/ body gzip-compressed; OTLP logs are JSON from Node but protobuf from dima-rust (otel.rs) - mock must accept both.

## Highest-risk items for the port

1. **AI `code_execution` sandbox has unrestricted network** (`execute_sandbox.ai.ts:108` `--allow-net`) and receives the bot token: SSRF into the Docker network and arbitrary Helix actions. Port with an allowlist (or drop) rather than reproduce.
2. **Billing paths**: Polar SDK ingest/customers/subscriptions ignore `POLARSH_API_BASE_URL` (always prod), `DELETE /v1/subscriptions/{id}` on account deletion, gift checkouts + `checkouts/client/{secret}/confirm`, and DimaFX purchase fallback that can double-submit. Ingest correctness depends on exact externalId/amount formatting.
3. **Moderation/role Helix calls without retry, timeout or 429 handling** (bans, warnings, chat clear/delete, mod/VIP add/remove, raids, chat settings) all run as the bot token; `ban` sends a caller-chosen `moderator_id` with the bot token. Byte-exact behaviour also matters for inbound EventSub/Polar HMAC verification and the msgpack Fish body.
