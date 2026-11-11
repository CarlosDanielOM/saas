# dimabot inbound network surface

Inventory for the Rust drop-in migration. `http.json` (same directory) is the record-level checklist; this file summarises it and lists the behaviours that are hard to reproduce. Source: `dimabot` on branch `rust-v2`, 2026-11-11. Library versions in `dimabot/node_modules`: express 4.22.2, body-parser 1.20.6, serve-static 1.16.3, cors 2.8.6, multer 1.4.5-lts.2, socket.io 4.8.3, engine.io 6.6.9, socket.io-adapter 2.5.8, ws 8.21.3.

## Headline counts

| Surface | Count |
|---|---|
| HTTP route handlers (`routes[]`) | **321** (320 on the API app, port 3000; 1 on the EventSub app, port 3333 in the bot process) |
| Terminal `router.use()` handlers (`terminalUse[]`) | 3 (`/observability` proxy, `/oauth/*` and `/v1/*` JSON 404 catch-alls) |
| Socket.IO namespaces (`sockets.namespaces[]`) | 16 (11 regex parents, 3 static, 1 lazily created static family, plus `/`) |
| Socket.IO events | 27 client→server listeners (excluding `disconnect`), 55 server→client event records with 80 emit sites; 68 distinct (direction, name) pairs |
| Raw WebSocket endpoints | 1 (`/v1/desktop/ws`, `ws` library) |
| SSE endpoints | 3 |
| Static directory | 1 (`dist/server/routes/public`), 9 checked-in files, 2 runtime-written file families, no runtime-generated HTML |
| Unmounted routers (dead code, not part of the surface) | 2: `server/routes/twitch.route.ts` (1 route), `server/routes/validation.route.ts` (1 route) |

### How the route count was verified

1. `dima-rust/tools/ledger/http_routes.mjs` walks the TypeScript AST of every non-test file that imports express, finds `express()` / `express.Router()` variables, resolves imports/exports, flattens the mount tree from both apps, and expands the one `for..of` tuple loop (`goals.route.ts:36`). It produced 321 routes and found no non-literal paths.
2. Independent grep for `<ident>.(get|post|put|patch|delete|all|options|head)('...` over `dimabot/src/server` and `bot/eventsub.twitch.ts` gives 322 lines. Subtract 2 false positives in `server/websocket.ts` (Map/Redis `.get`/`.delete`) and 2 routes in unmounted routers, then add 3 routes for the single grep line of the goals loop (322 − 2 − 2 + 3 = 321). Per-file counts match exactly.
3. No `.route()` chains, `app.all`, regex paths, wildcards or optional params are used anywhere.

Re-run: `node dima-rust/tools/ledger/http_routes.mjs > /tmp/routes.raw.json` (read-only, no build needed).

## Routes per file and auth kind

Auth kinds: `bearer session` = `authMiddleware` (Twitch token, Redis-cached) or `browserUser` (fresh Twitch validate); `oauth access token` = Dima OAuth `dima_at_…` token via `authenticateAccess`; `admin` = `workspaceOwnerMiddleware` or `ensureSuperAdmin` on top of `authMiddleware`; `service token` = `DIMAFX_SERVICE_TOKEN`; `signed webhook` = HMAC/Standard Webhooks; `other` = capability URLs, overlay tokens, tickets, OAuth code callbacks.

| File (`dimabot/src/…`) | Mount | Routes | Auth breakdown |
|---|---|---:|---|
| bot/eventsub.twitch.ts | (eventsub app) | 1 | signed webhook 1 |
| server/routes/webhooks/polarsh.webhook.ts | /polar/webhook | 1 | signed webhook 1 |
| server/routes/docs-assistant.route.ts | /docs-assistant | 2 | none 2 |
| server/oauth/routes.ts | /oauth, /v1 | 26 | oauth access token 16, bearer session (browserUser) 5, none 5 |
| server/server.ts | / | 4 | none 4 |
| server/routes/file.route.ts | /video | 1 | none 1 |
| server/routes/media.route.ts | /media | 1 | none 1 |
| server/routes/clip.route.ts | /clip | 2 | bearer 1, none 1 |
| server/routes/speech.route.ts | /speech | 13 | bearer 10, none 3 |
| server/routes/auth.route.ts | /auth | 12 | bearer 5, other 4, none 3 |
| server/routes/user.route.ts | /users | 7 | bearer 2, none 5 |
| server/routes/admin.route.ts | /admins | 7 | bearer 7 |
| server/routes/admin-tools.route.ts | /admin | 1 | admin 1 |
| server/routes/email-test.route.ts | /email | 1 | admin 1 |
| server/routes/email-auth.route.ts | /email | 1 | other 1 |
| server/routes/referral.route.ts | /referrals | 7 | bearer 6, none 1 |
| server/routes/command.route.ts | /commands | 8 | bearer 6, none 2 |
| server/routes/site-agent.route.ts | /agent | 16 | bearer 16 |
| server/routes/eventsub.route.ts | /eventsubs | 6 | bearer 5, none 1 |
| server/routes/bits-rules.route.ts | /bits-rules | 4 | bearer 4 |
| server/routes/aiPersonality.route.ts | /ai-personality | 3 | bearer 3 |
| server/routes/pet.route.ts | /pets | 9 | bearer 6, other 3 |
| server/routes/memories.route.ts | /memories | 5 | bearer 5 |
| server/routes/reward.route.ts | /rewards | 5 | bearer 5 |
| server/routes/trigger.route.ts | /triggers | 15 | bearer 15 |
| server/routes/overlay.route.ts | / | 5 | none 4, other 1 |
| server/routes/site.route.ts | /site | 5 | bearer 5 |
| server/routes/billing.route.ts | /billing | 13 | bearer 13 |
| server/routes/dashboard.route.ts | /dashboard | 6 | bearer 6 |
| server/routes/analytics.route.ts | /analytics | 1 | bearer 1 |
| server/routes/stream_timeline.route.ts | /analytics (nested `router.use`) | 8 | bearer 8 |
| server/routes/timer.route.ts | /timers | 6 | bearer 6 |
| server/routes/roulette.route.ts | /roulettes | 12 | bearer 11, other 1 |
| server/routes/widgets.route.ts | /widgets | 7 | bearer 6, other 1 |
| server/routes/duel-widget.route.ts | /widgets/:channelID/duel (nested, `mergeParams`) | 5 | bearer 5 |
| server/routes/goals.route.ts | /goals | 5 | bearer 5 |
| server/routes/overlay-studio.route.ts | /overlay-studio | 35 | bearer 29, other 6 |
| server/routes/asset-library.route.ts | /asset-library | 5 | bearer 4, other 1 |
| server/routes/follow_defense.route.ts | /follow-defense | 10 | bearer 10 |
| server/routes/moderation.route.ts | /moderation | 6 | bearer 6 |
| server/routes/stream-summary.route.ts | /stream-summaries | 2 | bearer 2 |
| server/routes/clip-recommendations.route.ts | /clip-recommendations | 6 | bearer 6 |
| server/routes/dimafx.route.ts | /extensions/dimafx | 14 | bearer 6, service token 8 |
| server/routes/admin_site.route.ts | /admin-site | 12 | admin 12 |
| **Total** | | **321** | |

Totals by auth kind: bearer session 230, oauth access token 16, admin 14, service token 8, signed webhook 2, other 18, none 33.

The 33 unauthenticated routes are listed in `http.json` (`auth: "none"`). Ones worth a second look during the port, because they change state or expose account data without a token: `POST /auth/login` (trusts `body.id`, `auth.route.ts:968`), `GET /auth/mock-register` (no env gate, `auth.route.ts:1283`), `POST /users/premium` (`user.route.ts:142`), `POST /speech/:channelID` (called by the bot over `INTERNAL_API_URL`, `speech.route.ts:423`), `POST /overlays/furry/:channelID` (`overlay.route.ts:64`).

Response kinds (a route can have several): JSON envelope `{error, message, status, data}` 284, other JSON 42, file/stream 17, HTML (`sendFile` pages and `res.send(string)`) 9, redirect 7, SSE 3, empty 3.

## Socket.IO namespaces

Server: `new Server(httpServer, { connectionStateRecovery: {}, adapter: petSocketAdapter, destroyUpgrade: false })` at `server/websocket.ts:47`. Defaults otherwise: path `/socket.io`, `serveClient` on, no CORS, ping 25 s / timeout 20 s, `maxHttpBufferSize` 1 MB, polling + websocket, `cleanupEmptyChildNamespaces` off. There is no cluster or Redis adapter: every emit is process-local to the API.

| Namespace | Registered at | Handshake / auth | Client → server | Server → client | Per-connection or namespace timers | Recovery |
|---|---|---|---|---|---|---|
| `/^\/clip\/\w+$/` | server/websocket.ts:65 | none; unknown channel → `error` {404} | `clip-ended`, `ping` | `error`, `play-clip` (namespace broadcast from handlers/clip_queue.handler.ts:219) | 30 s disconnect grace | SessionAware |
| `/^\/site\/analytics\/[\w-]+$/` | server/websocket.ts:154 | none | – | `live-channels` / `active-channels` / `registered-channels` (once) | – | SessionAware |
| `/^\/dashboard\/\w+$/` | server/websocket.ts:178 | none | `dashboard-ping` | `error`, `dashboard-snapshot`, `stream-status`, `dashboard-pong` | `stream-status` interval per socket (≥1 s) | SessionAware |
| `/^\/overlays\/triggers\/\w+$/` | server/websocket.ts:230 | none | `ping` | `error`, `trigger` (broadcast from server/routes/trigger.route.ts:1653) | 10 s disconnect grace | SessionAware |
| `/^\/speech\/\w+$/` | server/websocket.ts:283 | none | `speech-playback`, `speech-ended` | `error`, `speech-reset`, `speech` (to the single lowest-id ready socket) | 5 s disconnect grace | SessionAware |
| `/^\/speech-preview\/\d+$/` | server/services/tts/voice_preview.service.ts:46 | single-use Redis ticket (GETDEL) | `preview` (ack required, base64 audio in ack) | – | 5 min expiry; 30 s lock renewal | SessionAware |
| `/^\/overlays\/roulette\/[\w-]+$/` | server/services/roulette-overlay.service.ts:13 | overlay token (`auth.token`) | – | `roulette-state`, `roulette-error` | 500 ms Mongo poll per channel | disabled |
| `/^\/overlays\/widgets\/[\w-]+$/` | server/services/widgets-overlay.service.ts:14 | overlay token | – | `widgets-catalog`, `widgets-state`, `widgets-error` | 500 ms Mongo poll per channel | disabled |
| `/^\/overlays\/duel\/[0-9]{1,30}$/` | server/services/duel-overlay.service.ts:10 | duel token; `auth.view` | `duel-ready` | `duel-leaderboard`, `duel-state`, `duel-error` | 500 ms poll + Redis presence | disabled |
| `/^\/overlays\/dimafx\/\w+$/` | server/services/dimafx-overlay.service.ts:25 | HMAC token (`auth.token`) | `dimafx-ready`, `dimafx-ended` | `dimafx-play` | 2 s poll per socket | disabled |
| `/^\/overlay-studio\/[a-f0-9]{48}$/` | overlays/live.ts:650 | `auth.clientId` + publicId | 7 events, `overlay-widget-rpc` requires an ack, `overlay-ended` takes an optional ack | 12 events | one 1 s namespace poller | disabled (own Mongo leases) |
| `/desktop` | pets/socket.ts:48 | OAuth access token in `auth`, scopes, connection caps | `desktop:features`, `desktop:reauth`, `pet:ready`, `pet:lease`, `pet:playback`, `pet:mouth` (all ack `{ok,data|error}`) | `desktop:hello`, `pet:snapshot`, `pet:request`, `pet:stop`, `pet:play`, `pet:follow`, `pet:follow-end`, `pet:mouth` | 15 s revalidation; per-socket rate window | never (plain Adapter) |
| `/pet` | pets/socket.ts:48 | pet capability in `auth` | `pet:ready`, `pet:lease`, `pet:playback`, `pet:mouth` | `pet:snapshot`, `pet:request`, `pet:stop`, `pet:play`, `pet:follow`, `pet:follow-end` | as above | never |
| `/desktop-ai` | desktop_ai/activity.ts:292 | OAuth access token, optional `features` | – | `speech:snapshot`, `speech:prepare` (server→client `emitWithAck`, 2 s timeout), `speech:started`, `speech:ended`, `ai:turn-updated` | 15 s revalidation, slot expiry timers | never |
| `/overlays/furry/<id>` | server/routes/overlay.route.ts:87 | none; exists only after the first POST emit | – | `furry` | – | SessionAware |
| `/` | server/websocket.ts:47 | none | – | – | – | SessionAware |

Server-level timer: a 30 s stale-flag sweep (`server/websocket.ts:344`) calls `io.of()` and `fetchSockets()` for the clip, speech and trigger namespaces of every cached channel.

Cross-process delivery: there is no Socket.IO adapter between processes. Bot, cron and the DimaFX server reach sockets through the API process: Redis pub/sub (`twitch:<id>:clip:request`, `TTS_SESSION_ENDED`, `WIDGET_FEED_CHANNEL`, pet wakeups, turn updates), Mongo revision polling (roulette, widgets, duel, Overlay Studio, domain events), and internal HTTP (`POST /speech/:channelID`, `/extensions/dimafx/internal/*`).

What `pets/socket_adapter.ts` does: it is an adapter *factory* passed as `adapter`. `/desktop`, `/desktop-ai` and `/pet` get the base in-memory `Adapter`, which has no session store, so connection-state recovery can never skip their auth middleware (they also reject `socket.recovered`). Every other namespace, including dynamic children, gets `SessionAwareAdapter`. That adapter keeps broadcast packets with offsets for 2 minutes so a reconnecting client can recover its session and missed packets. Five overlay families then disable persistence per child with `io.on('new_namespace', child => child.adapter.persistSession = () => {})`.

## Raw WebSocket and SSE

- `GET /v1/desktop/ws` (server/oauth/desktop-websocket.ts:7): manual `server.on('upgrade')`. It needs subprotocol `dima.desktop.v1`, rejects any query string or foreign Origin, takes the Bearer access token from the `Authorization` header, and rejects with raw `HTTP/1.1 <code> Rejected` lines (400/401/403/404/426/429). The protocol is JSON text frames: `hello` from the server, then client `ping` → server `pong` or `error`. The server closes with codes 4400, 4401 and 4429 and sends ping/pong plus token revalidation every 15 s. Every non-`/socket.io/` upgrade on port 3000 gets a raw 404.
- SSE `GET /config/site/analytics/stream` (server/server.ts:215): unnamed `data:` snapshot every 500 ms and `: keep-alive` every 30 s. No auth.
- SSE `POST /docs-assistant/ask` (server/routes/docs-assistant.route.ts:72): named events `start`, `status`, `text`, `reset`, `done`, `error` and `: ping` every 15 s. A client disconnect aborts the LLM call.
- SSE `GET /agent/:channelID/turns/:turnId/events` (server/routes/site-agent.route.ts:200): `id:` + `event:` + `data:` frames from a Redis stream, replayed from `?after=` (the `Last-Event-ID` header is ignored), then live from an in-process EventEmitter. Sends `event: resync` on gaps and closes after `done`.

## Hard to reproduce: behaviours a Rust (axum + socketioxide) stack must match

### Express routing

1. **Case-insensitive, non-strict routing everywhere.** No `app.set('case sensitive routing')` or `strict routing`, and `express.Router()` is created without options (`server/server.ts:54`, every router file). `/USERS/123/` matches `/users/:channelID`. axum matches case-sensitively and treats a trailing slash as a different path. Risk: OBS browser-source URLs and bot-built URLs with stray slashes or casing.
2. **`app.use(prefix)` is segment-prefix matching and strips the prefix.** `overlayRoute` is mounted at `/` (`server/server.ts:134`). `/email` has two routers (`:102`, `:105`). `stream_timeline.route.ts` is attached with a pathless `router.use` inside `/analytics` (`analytics.route.ts:56`). `duelWidgetRoute` is nested under `/widgets/:channelID/duel` with `mergeParams: true` (`widgets.route.ts:28`, `duel-widget.route.ts:8`).
3. **Router-level `authMiddleware` shadows 404s.** A pathless `router.use(authMiddleware)` returns 401 JSON for every unmatched path under `/agent`, `/bits-rules`, `/pets` (after its public routes), `/roulettes`, `/widgets`, `/goals`, `/overlay-studio` and `/asset-library` (e.g. `site-agent.route.ts:25`, `goals.route.ts:15`, `pet.route.ts:58`). Public routes in those routers work only because they are registered first (`roulette.route.ts:15` before `:21`, `widgets.route.ts:14` before `:18`, `overlay-studio.route.ts:33-59` before `:82`, `asset-library.route.ts:27` before `:36`, `pet.route.ts:28-50` before `:58`).
4. **JSON 404 catch-alls on `/oauth/*` and `/v1/*`** (`oauth/routes.ts:172`, `:261`), so those prefixes never fall through. Everything else unmatched gets Express finalhandler's HTML `Cannot GET /x` 404.
5. **Middleware order defines CORS coverage.** Order: `express.static` (`server.ts:73`), then `cors()` (`:74`). Before both: the body parsers (`:60-68`), `/oauth`, `/v1` and `/.well-known` (`:70-72`). Static files, body-parser errors and `/.well-known/oauth-authorization-server` therefore carry no `Access-Control-Allow-Origin`. Everything mounted after `:74` gets `ACAO: *`, and `cors()` answers every preflight with 204. `/oauth` and `/v1` use their own reflective origin check (`oauthBoundary`, `oauth/routes.ts:22`). `/docs-assistant` has its own allowlist (`docs-assistant.route.ts:41`).
6. **Static before routers.** `express.static` at `server.ts:73` serves `public/` ahead of every router. It redirects a directory path without a trailing slash with a 301 (serve-static default). Runtime TTS output lives in `public/speech/<channelID>/`, so `GET /speech/<channelID>` (the OBS TTS page, `speech.route.ts:369`) becomes `301 → /speech/<channelID>/` once that directory exists. The router then serves `speech.html` at the slash form. Runtime files `/downloads/<id>-clip.mp4` and `/speech/<id>/<speechID>.wav|mp3` are publicly served by static with ETag, Last-Modified and Range.
7. **GET routes answer HEAD automatically.** Express 4 (and axum `get`) do this. `serveAsset` has an explicit HEAD branch (`assets/http.ts:5`).
8. **Query parser `extended` (qs).** `req.query` can hold nested objects and arrays. Handlers typically guard with `typeof === 'string'`. `oauth/routes.ts:67` rejects any query key at all, and `pet.route.ts:51` allows only `ticket`.
9. **`trust proxy` is false.** `req.ip` is the socket peer (the reverse proxy), so the OAuth rate limits `oauth:<ip>` 600/min and `desktop:<ip>` 1200/min are effectively global buckets (`oauth/routes.ts:83`, `:178`). `/docs-assistant` reads `cf-connecting-ip` / `x-forwarded-for` itself (`docs-assistant.route.ts:51`).

### Body parsing (body-parser 1.20.6)

10. **Per-prefix JSON limits**, applied before the global parser and short-circuiting it via `req._body`: `/overlay-studio` 5 MB, `/commands` 1 MB, `/roulettes` 4 MB, `/docs-assistant` 256 KB, default 100 KB (`server.ts:60-67`, `docs-assistant.route.ts:46`). Raw-body routes: `/polar/webhook` (`polarsh.webhook.ts:14`, 100 KB) and the EventSub app (`eventsub.twitch.ts:79`, 100 KB). Both need the exact bytes for signature checks.
11. **Strict JSON** (only an object or array at the top level). Malformed JSON → 400, oversize → 413, unsupported charset or encoding → 415. Errors go to `next(err)` and then to finalhandler: an HTML body that is just the status text under `NODE_ENV=production`, with `Content-Security-Policy: default-src 'none'` and nosniff, and no CORS headers. No route renders a JSON envelope for parser errors, so a drop-in must not either.
12. **urlencoded `extended: true`** on every route (`server.ts:68`): qs nesting with depth limit 32 (400 when exceeded), 1000-parameter limit (413). `/oauth/token` and `/oauth/revoke` accept form posts. Duplicate keys become arrays and are rejected as `invalid_request` (`oauth/routes.ts:40`).
13. **Non-matching content types leave `req.body = {}`, not undefined.** Many handlers destructure `req.body` without checks. In the EventSub app a non-`application/json` POST makes `getHmac` call `update({})` (`eventsub.twitch.ts:112`), which throws inside the async handler (see 16).

### Default headers and conditional requests

14. **`X-Powered-By: Express`** is on (no `app.disable`). **Weak ETags** on every `res.json` / `res.send` body (`etag fn` default), so any GET JSON endpoint answers `304 Not Modified` to a matching `If-None-Match`. Browsers send that automatically for cached dashboard GETs. A Rust port must generate the same `W/"<len hex>-<sha1 base64[0..27]>"` tag or accept that clients re-download. `res.json` sets `Content-Type: application/json; charset=utf-8`. `res.send(string)` defaults to `text/html; charset=utf-8` (used for error bodies in `auth.route.ts:521-745` and `overlay.route.ts:19`).
15. **File responses** via `res.sendFile` (send 0.19): Range, `Accept-Ranges`, `Last-Modified`, ETag, `Cache-Control: public, max-age=0` (`clip.route.ts:23`, `speech.route.ts:351`, `overlay.route.ts:12-47`, `oauth/routes.ts:214`, `overlay-studio.route.ts:61`). There are also three hand-written Range implementations with slightly different 416 behaviour: `file.route.ts:38` (416 JSON, no validation of malformed ranges), `overlay-studio.route.ts:47` (416 empty with `Content-Range: bytes */N`), `assets/http.ts:5` (416 via AssetError JSON, plus an explicit `ETag: "asset-<id>"` and 304 on `req.fresh`).

### Errors and unhandled rejections

16. **No process-level `unhandledRejection` handler**, and Express 4 does not catch async errors. A throw that escapes an inline async handler leaves the request hanging and, under Node 24, terminates the process. `http.json → asyncErrorExposure` lists 37 handlers with an `await` or `throw` outside any `try` (mostly `await error(...)` logging inside `catch`). Wrapped routers (`wrap`, `asyncRoute`, `route`, `run`) forward to router error handlers instead. A drop-in should map these to 500 rather than reproduce crashes, but must keep the error-handler JSON shapes: `goals.route.ts:46`, `roulette.route.ts:69` / `widgets.route.ts:42` (`{error, status, code, message[, row]}`), `bits-rules.route.ts:86`, `asset-library.route.ts:91` (MulterError → 413 `file_size`), `overlay-studio.route.ts:251`, `oauth/routes.ts:71` (`{error: <code>}` with `WWW-Authenticate` on 401 and `Retry-After: 60` on 429, unknown → 503), and `pet.route.ts:20` (headers already sent → socket destroyed).
17. **HTTP status and envelope status can disagree.** Several legacy handlers send `res.json({... status: 4xx})` without `res.status()`, and `res.status(201)` is combined with body `status: 200` (`overlay-studio.route.ts:134`). Some 400s omit `status` from the body (`user.route.ts:152`). Records carry `notes` where the analyzer saw this. Clients read both.
18. **`optionalAuthMiddleware`** (`middleware/optional.middleware.ts:5`) is unused by any route today. If it is reused, note that it would write a 401 and still call `next()`.

### Multer

19. `POST /triggers/library/:channelID/upload` (`trigger.route.ts:482`): `single('trigger')`, disk storage in `os.tmpdir()/dimabot-trigger-uploads`, size limit by plan (free 5 MB, premium 25 MB, pro 100 MB; `media_library.service.ts:21`). The mimetype allowlist (`trigger.route.ts:87`) *silently drops* disallowed files (→ 400 "No file uploaded…"). Every multer error maps to 400. Text fields `name` / `triggerName` arrive in `req.body`.
20. `POST /asset-library/:channelID` (`asset-library.route.ts:53`): `single('file')`, custom streaming storage engine, limits `fileSize 50_000_000, files 1, fields 0, parts 2`, a 120 s hard deadline that destroys the request, and in-process concurrency caps (4 global, 1 per owner → 429).

### Socket.IO features relied on

21. **Connection state recovery** (`websocket.ts:48`) with a per-namespace opt-out through the custom adapter factory (`pets/socket_adapter.ts:8`) and `persistSession` overrides (`dimafx-overlay.service.ts:22`, `roulette-overlay.service.ts:10`, `widgets-overlay.service.ts:11`, `duel-overlay.service.ts:9`, `overlays/live.ts:649`). Recovery stays active for clip, speech, triggers, dashboard, analytics, preview and furry, where broadcast packets (`play-clip`, `trigger`, `speech-reset`, `furry`) are replayed after short disconnects and the recovered socket skips middleware but still runs the `connection` handler. The desktop and pet namespaces depend on `socket.recovered` being false. socketioxide has no session-recovery equivalent, so this is the largest behavioural gap.
22. **Dynamic regex namespaces** via `io.of(RegExp)` (11 of them). The handlers read the channel from `socket.nsp.name`. `io.of(string)` on a matching name creates a child that inherits the parent's middleware (`websocket.ts:127, 263, 325, 353-396`, `clip_queue.handler.ts:219`, `trigger.route.ts:1628`, `tts_queue.handler.ts:157-1147`). `/overlays/furry/<id>` has no parent: it exists only after the first emit (`overlay.route.ts:87`), and clients get `Invalid namespace` before that. Children are never cleaned up.
23. **Acks in both directions.** Client→server: required for `preview` (`voice_preview.service.ts:63`), `overlay-widget-rpc` (`live.ts:682`) and all pet/desktop events (`pets/socket.ts:120`); optional, with no arguments, for `overlay-ended` (`live.ts:716`). Server→client: `socket.timeout(2000).emitWithAck('speech:prepare')` (`desktop_ai/activity.ts:204`), where a missing or wrong ack disconnects the client.
24. **Middleware errors with `data`.** `next(err)` where `err.data = {code}` is delivered to the client as a `connect_error` with `data` (`pets/socket.ts:100`, `desktop_ai/activity.ts:304`). Overlay namespaces send plain messages ("Invalid overlay token", etc.).
25. **Handshake fields:** `socket.handshake.auth` (tokens, `clientId`, `view`, `features`, `v`) and `socket.handshake.query` (`timeout` for clip, and auth keys forbidden for desktop/pet). The ws/engine.io upgrade co-exists with the manual raw-WS upgrade listener because of `destroyUpgrade: false` (`websocket.ts:50`, `oauth/desktop-websocket.ts:10`).
26. **Internals used:** `io._nsps` iteration (`tts_queue.handler.ts:825`), `namespace.sockets` map and `socket.data` (`ttsReady`, `dimafxReady`, revisions), `fetchSockets()` on child namespaces, and selecting one socket by lowest `socket.id` (`tts_queue.handler.ts:641`, `:961`). Binary payloads: none (audio goes as base64 in an ack). No `volatile`, rooms or `compress` are used. Reserved-looking custom events: clients emit a custom `ping` event on `/clip/*` and `/overlays/triggers/*` (`websocket.ts:117`, `:255`). `serveClient` serves `/socket.io/socket.io.js` for `public/dimafx.html`.

## Unresolved / out of scope

- `server/routes/observability.route.ts:6`: a regex-dispatched `router.use` proxy, recorded under `terminalUse`, not `routes`.
- `server/routes/twitch.route.ts` and `server/routes/validation.route.ts` define routers that nothing mounts (listed in `verification.unmountedRouters`).
- `PUT /users/active/:channelID` calls `http://localhost:3355/user/active` (`user.route.ts:251`). No listener on 3355 exists in this repo, so that call always fails and is only logged.
- Status codes thrown from shared service code are attributed through error classes (`errorClassStatus`). The literal 4xx values come from every `new X(…)` site in the codebase, so a route's `viaErrorClasses` set is an upper bound.
