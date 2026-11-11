# Satellite services — Rust port inventory

Read-only inventory of the four small Node services outside `dimabot/` that are planned for a Rust port. Source: branch `rust-v2`, read on 2026-11-11. All `file:line` references are relative to the repository root. Nothing was built, run or deployed to produce this file.

| Service | Source (lines) | HTTP routes | Data access | Tests today | Compose `command`/healthcheck use `node` |
|---|---|---|---|---|---|
| `dimafx/server` | 451 TS (`src/**`) | 8 (`/health` + 7 under `/v1`) | none (HTTP proxy to dimabot) | none in project; 1 ops behaviour check | no / no healthcheck |
| `dima-hoststats` | 428 JS (`src/**`) + 111 test | 2 | `/proc`, `statfs`, Docker socket (GET allowlist) | 6 pure unit/e2e tests | **yes / yes** |
| `dima-analytics` | 742 JS (`src/**`, very dense) + 224 test | 11 (`/health` + 10 `/api/*`) | PostgreSQL, Redis/Dragonfly, MongoDB, Qdrant + hoststats over HTTP, Twitch | 12 tests (8 pure, 4 need PG/Redis[/Mongo]) | **yes / yes** |
| `dimadb/server` | 1,327 JS (`server/*.mjs`) | 27 under `/api` + static SPA | JSON files in `/data`, any Redis/Dragonfly, any MongoDB | none for the server (one Angular smoke spec) | no / no healthcheck |

Cross-cutting facts that affect every port:

- **`saas-ops` assumes Node inside the candidate.** Readiness runs `docker exec <candidate> node -e "fetch(...)"` unless `Target.runtime == "python3"` (`ops/saas_ops.py:709-737`, esp. `:722-725`). The behaviour check is copied into the candidate and run with `node`/`python3`/`sh` inside it (`ops/saas_ops.py:855-865`); with no `--dependencies` the candidate runs on `--network none` (`ops/saas_ops.py:808-822`), so a check can only reach the service from inside the candidate's network namespace. A Node-free Rust image therefore needs a `saas_ops.py` change first (e.g. a `runtime="native"` mode that runs readiness and the check from a pinned helper container joined with `--network container:<candidate>`). That is an ops-code change, not a Compose change.
- **Compose `command:` and healthchecks** that call `node` (hoststats `dima-hoststats/docker-compose.yaml:10,25-29`; analytics `dima-analytics/docker-compose.yaml:6,17-21`) are part of the Compose config. `saas-ops build` refuses when the deployed config hash differs from the file (`ops/saas_ops.py:256-263`), and README rule says Compose changes need a separately reviewed procedure (`ops/README.md:16`). `Target.command` for those two is `("node","src/index.mjs")` (`ops/saas_ops.py:111,119`). `dimafx-server` and `dimadb` have no `command` override and no healthcheck, so their image `CMD` can change freely.
- **JSON number formatting.** JS prints integral numbers without `.0`; `serde_json` prints an `f64` 26.0 as `26.0`. Values parse identically in every consumer here, but byte-level diff tests must normalise, or the Rust side must serialise integral `f64` as integers.
- **Dates.** JS `Date#toISOString()` always emits millisecond precision and `Z` (`2026-11-11T10:00:00.123Z`). PostgreSQL `timestamptz` and chrono carry microseconds; Rust must format with exactly 3 fractional digits wherever JS serialised a `Date`.
- **Express/Node defaults** that are part of current behaviour: `X-Powered-By: Express` (dimafx-server only; analytics disables it at `dima-analytics/src/index.mjs:18`), weak `ETag` + `304` on JSON GETs, HTML error pages for body-parser errors and unmatched routes.

---

## 1. `dimafx/server` — Twitch Extension backend

### Purpose and callers

Verifies the Twitch Extension JWT sent by the viewer panel and proxies a fixed set of viewer actions to dimabot's internal DimaFX API with a shared service token. It holds no state.

- Viewer panel/mobile page: `dimafx/panel.js:28` (`API_BASE = ${origin}/api/v1`), `dimafx/panel.js:404-417` (`apiFetch`, sends `Authorization: Bearer <Twitch JWT>`; treats `!response.ok || payload.error` as failure and reads `payload.data`/`payload.message`). Calls: overlay-status `:428`, `/me` `:498`, `:1265`, items `:499`, purchase `:1181`, `:1201`, use-credit `:1229`, redeem `:1252`, config `:1322`. `dimafx/config.html` does not call this server.
- Path rewrite: the `dimafx` nginx container proxies `/api/` to `http://dimafx-server:8080/` and strips `/api` (`dimafx/nginx.conf:21-28`). The server therefore sees `/v1/...` and `/health`.
- Upstream it calls: `dimabot/src/server/routes/dimafx.route.ts` mounted at `/extensions/dimafx` (`dimabot/src/server/server.ts:169`); service-token check `dimafx.route.ts:248-266` (accepts `x-dimafx-service-token` or `Authorization: Bearer`; plain `!==` compare); internal routes `:618` overlay-status, `:628` items, `:652` viewer init, `:699` viewer config, `:726` purchase, `:830` use-credit, `:928` redeem.

### Routes (8)

App setup `dimafx/server/src/server.ts:5-18`: `cors()` with defaults (any origin `*`, methods `GET,HEAD,PUT,PATCH,POST,DELETE`, preflight `204`, request headers echoed in `Access-Control-Allow-Headers`), then `express.json()` (default 100 kB limit, `strict` = only objects/arrays, only for `Content-Type: application/json`; a malformed body gives Express's default `400` HTML page because `NODE_ENV=production` in `Dockerfile:13`). No rate limiting. Unknown paths: Express `404` HTML `Cannot GET /x`; under `/v1` the auth middleware runs first, so no token → `401` JSON.

| # | Method + path | Source | Auth | Behaviour |
|---|---|---|---|---|
| 1 | `GET /health` | `server.ts:11-13` | none | `200 {"error":false,"status":200,"data":{"ok":true}}` |
| 2 | `GET /v1/channels/:channelID/overlay-status` | `extension.routes.ts:25-36` | JWT + channel match | Sets `Cache-Control: no-store` **after** the channel check (`:28`). Proxies `GET /extensions/dimafx/internal/channels/{enc(channelID)}/overlay-status`; returns envelope with `payload.status \|\| (error?500:200)` (`:19-21`). If the client throws: `503 {"error":true,"status":503,"message":"DimaFX connection status unavailable"}`. |
| 3 | `GET /v1/me` | `:38-79` | JWT | No `user_id` in JWT → `200 {error:false,status:200,data:{identityShared:false,platform:"twitch",opaqueUserID,channelID,balance:0,inventory:null}}` (no upstream call). Else `POST .../channels/{cid}/viewers/{uid}/init` with `{}` and responds `status = payload.status \|\| 200` with `{...payload, data:{identityShared:true,platform:"twitch",channelID,userID,inventory:payload.data,balance:Number(payload.data?.balance\|\|0)}}`. Quirk: an upstream error envelope without `status` is returned as HTTP 200 with `error:true`. Throw → `500 Internal server error`. |
| 4 | `GET /v1/channels/:channelID/items` | `:81-92` | JWT + channel match | Proxies `GET .../channels/{cid}/items`. |
| 5 | `PATCH /v1/channels/:channelID/me/config` | `:94-114` | JWT + channel match + `user_id` (else `403 "Share your Twitch identity to save DimaFX preferences"`) | Proxies `PATCH .../viewers/{uid}/config` body `{quickPurchasePriority, quickPurchaseAction}` copied from request body. |
| 6 | `POST /v1/channels/:channelID/items/:itemID/purchase` | `:116-137` | JWT + channel match (anonymous allowed) | Proxies `POST .../items/{iid}/purchase` body `{userID, opaqueUserID, displayName:undefined, sku, transactionID, action, ttsText}` — identity comes only from the JWT (`:11-17`). |
| 7 | `POST /v1/channels/:channelID/items/:itemID/use-credit` | `:139-157` | JWT + channel + `user_id` (else `403 "Share your Twitch identity to use DimaFX credits"`) | Body `{userID, opaqueUserID, action, ttsText}`. |
| 8 | `POST /v1/channels/:channelID/items/:itemID/redeem` | `:159-177` | JWT + channel + `user_id` (else `403 "Share your Twitch identity to redeem saved items"`) | Body `{userID, opaqueUserID}`. |

All error bodies are `{error:true,message,status}`. Every route catches exceptions as `500 {"error":true,"message":"Internal server error","status":500}` and logs to stderr.

Body forwarding semantics: `JSON.stringify` drops `undefined` but keeps `null`. A missing request field is omitted upstream; a field sent as `null` is forwarded as `null`; any JSON type is forwarded unchanged (no validation here; dimabot validates). Rust: `Option<serde_json::Value>` with `skip_serializing_if = Option::is_none`, distinguishing absent from `null`.

### Auth — Twitch Extension JWT (`dimafx/server/src/middleware/twitch-extension-auth.ts`)

- Token source (`:40-48`): `Authorization` beginning with exactly `Bearer ` (case-sensitive) → rest; otherwise `X-Extension-JWT` header; otherwise `401 "Missing Twitch Extension token"`.
- Signing keys (`:25-38`): from `TWITCH_EXTENSION_SECRET`, candidates are base64-decode, base64url-decode and raw UTF-8 bytes, non-empty and de-duplicated, tried in that order. Node's base64 decoders are lenient (skip invalid characters, accept missing padding); Rust must use a forgiving decoder or Twitch secrets must be confirmed to be canonical base64.
- Verify (`:67-89`): exactly 3 non-empty dot parts; header JSON `alg` must equal `"HS256"` (a header that is not JSON throws → caught at `:150-156` → `401`); HMAC-SHA256 over `"<part0>.<part1>"`; signature is base64url-decoded leniently (`:61-65`) and compared with `timingSafeEqual` only when lengths match. On success the payload is parsed; `exp` is checked only if truthy: rejected when `exp*1000 < Date.now()` (equal passes; a non-numeric `exp` string yields `NaN` and **passes**; `exp:0` means no expiry). No `nbf`/`iat`/`aud` checks.
- Unverified mode (`:119-127`): only when **no** secret is configured and `DIMAFX_ALLOW_UNVERIFIED_TWITCH_JWT === "true"` — payload decoded without a signature check. Production must keep this off; a Rust port should keep the exact gating (secret set ⇒ always verify).
- Missing `channel_id` → `401 "Invalid Twitch Extension token"`, with a diagnostic `console.warn` that never logs the token (`:91-110`, `:129-137`).
- Identity (`:140-147`): `channelID, userID?, opaqueUserID?, role?, token, identityShared = Boolean(user_id)`.
- Channel check (`:159-166`): Express-decoded `:channelID` must equal the JWT `channel_id` string → else `403 "Extension channel mismatch"`.

### Outbound HTTP (`dimafx/server/src/services/dimabot-client.ts`)

- Base URLs (`:10-12`): `DIMABOT_INTERNAL_API_URL` (default `http://dima-server:3000`), fallback `DIMABOT_PUBLIC_API_URL` (default `https://api.domdimabot.com`), token `DIMAFX_SERVICE_TOKEN` (default `''`). Read once at module load.
- No token → returns `{error:true,message:"DimaFX service token is not configured",status:503}` without calling (`:27-29`).
- Request (`:61-77`): `fetch(base+path)` with `Content-Type: application/json`, `x-dimafx-service-token: <token>`; **no timeout**. Non-JSON body → `{error:true,message:"Invalid API response"}` (no `status`). If `!response.ok` and the body has no truthy `error`, it returns `{...payload, error:true, status:response.status}`; if the body already says `error:true`, its own `status` (possibly missing) is kept.
- Fallback (`:31-58`): a network throw becomes `{error:true,status:503}`; if the primary result is an error with no status or `status >= 500`, the same request (with the service token) is repeated against the public URL. Note this sends the service token to the public API over HTTPS by design.

### Environment, startup, container

- Env: `PORT` (`Number(PORT||8080)`, `src/index.ts:3`), plus the five above (`dimafx/docker-compose.yml:20-26`). Listens on all interfaces (Express default). No signal handling, no background work, no caches.
- Dockerfile `dimafx/server/Dockerfile:1-18`: `node:22-alpine` multi-stage (`npm install`, `tsc`), **runs as root**, `EXPOSE 8080`, `CMD npm run start`, no `HEALTHCHECK`.
- Compose service `dimafx-server`, `container_name: dimafx-server`, `restart: unless-stopped`, `expose: 8080`, networks `dimafx-internal` (bridge, created by this project) + external `web-proxy`, no volumes, no resource limits (`dimafx/docker-compose.yml:15-37`). The sibling `dimafx` nginx service bind-mounts the whole `dimafx/` directory read-only (`:7-8`). Whether Nginx Proxy Manager also routes straight to `dimafx-server` on `web-proxy` is not visible in the repo.
- `saas-ops` target `dimafx-server` (`ops/saas_ops.py:117`): compose `docker-compose.yml`, context `server`, `Dockerfile`, port 8080, health `/health`, `runtime=node`.

### Tests and behaviour check

- No tests in the project. `ops/checks/dimafx-server.mjs` (104 lines) with `ops/checks/dimafx-server.test-env.json`: starts a stub dimabot on `127.0.0.1:4099` inside the candidate and checks health, overlay-status (200, `no-store`, service token forwarded, mismatch 403), purchase/credit forwarding of `userID`, `ttsText`, `transactionID`, refusal to trust body-supplied `userID`/`identityShared`/`displayName`, anonymous credit 403 without proxying, channel mismatch 403 without proxying, bad signature 401, expired 401. Pure (no databases); needs Node in the netns it runs in.
- Gaps to add for the port: `X-Extension-JWT` header path, `alg` ≠ HS256, base64url/UTF-8 secret candidates, missing-token 401, `PATCH me/config`, `redeem`, `/me` both branches, fallback-to-public on 5xx, missing service token → 503, CORS preflight.

### Security notes

- Keep: HS256-only, timing-safe compare, identity only from the JWT, channel match before any upstream call, unverified mode gated off when a secret exists.
- Tighten candidates (behaviour changes, need sign-off): outbound timeout (none today), a non-root image user, reject non-numeric `exp`, avoid the `/me` 200-with-error quirk.

### JS string semantics

None on user-visible text. `encodeURIComponent` on path segments (Rust: percent-encode with the same unreserved set `A-Za-z0-9-_.!~*'()`).

### Estimated Rust shape

~350-450 lines. Crates: `axum`, `tokio`, `tower-http` (CORS), `reqwest` (rustls), `hmac` + `sha2`, `base64` (with a lenient decode config), `subtle`, `serde_json`, `percent-encoding`. `dima-rust` already has `http` (axum/tower-http), `http-client` (reqwest) and `jwt` (jsonwebtoken + base64) features (`dima-rust/Cargo.toml` `[features]`); hand-rolled HMAC is closer to current semantics than `jsonwebtoken` (multi-key candidates, truthy-`exp` rule). Difficulties: lenient base64 parity; preserving envelope pass-through and status rules exactly; Express's HTML 400/404 pages (acceptable to replace with JSON only after sign-off, since `panel.js` only reads JSON).

---

## 2. `dima-hoststats` — host and container stats sidecar

### Purpose and callers

Samples host `/proc`, `statfs('/')` and the Docker Engine API every 15 s and serves the latest snapshot. Holds the Docker socket (root-equivalent), so the code enforces a GET allowlist.

- Only caller: `dima-analytics` collector, `fetchSnapshot(HOSTSTATS_URL)` → `GET /v1/snapshot` with 3 s timeout, `redirect: 'error'`, body ≤ 512,000 UTF-16 units, then field-by-field sanitising (`dima-analytics/src/infrastructure.mjs:88-94`, `:26-58`; called from `dima-analytics/src/collectors.mjs:58-64`). The admin "Servers" tab sees it only through analytics (`admin/src/app/pages/observability/observability-infra.ts:1`, `:129`).

### Routes (2) — `dima-hoststats/src/index.mjs:171-188`

Plain `node:http`. Every response: `Content-Type: application/json`, `Cache-Control: no-store`. No CORS, no auth (network isolation only), no body read.

1. Any method other than `GET` (including `HEAD`) → `405 {"message":"Read-only service"}` (`:177`).
2. `GET /health` (exact `req.url`, so `/health?x` is 404) → `200 {"status":"ok",...}` when `Date.now() - lastAttempt < sampleMs*4`, else `503 {"status":"stale",...}`; body `{status, sampledAt: latest.at|null, dockerReachable: latest.docker.reachable|false}` (`:178-181`). README says "200 while the sampler is running" — the 503-when-stale rule is the real contract.
3. `GET /v1/snapshot` → `200 <snapshot>` or `503 {"message":"No sample yet"}` (`:182-185`).
4. Anything else → `404 {"message":"Not found"}` (`:186`).

Snapshot shape (`:156-164`): `{version:1, at:ISO, sampleMs, host:{cpus, uptimeSec, cpuPct, iowaitPct, stealPct, load1, load5, load15, running, procs, memTotal, memAvailable, memUsed, memFree, memCache, memShared, swapTotal, swapUsed, diskTotal, diskFree, diskUsed, inodesTotal, inodesUsed, diskReadBps, diskWriteBps, netRxBps, netTxBps, netRx, netTx, pressure:{cpu,memory,io}}, docker:{reachable, version, df:{at, imagesCount, imagesBytes, imagesUnusedBytes, buildCacheBytes, buildCacheReclaimable, volumesCount, volumesBytes, containersBytes}|null}, containers:[containerView...], errors:[string]}`. Host keys from `parseLoadavg`/`parseMeminfo`/disk are **absent** (not null) when their source failed (`:91-93` spreads). `byImage/byContainer/byVolume` are stripped (`:155`). Each container row (`dima-hoststats/src/parse.mjs:160-193`) includes `volumes` (volume names, ≤128 chars each) — analytics drops it.

### Data access

- Files (all optional; a failed read becomes null/absent) `index.mjs:67-104`: `${HOSTSTATS_PROC}/stat`, `/meminfo`, `/loadavg`, `/uptime`, `/diskstats`, `/pressure/cpu|memory|io`, and `HOSTSTATS_NET_DEV` (default `/host/net_dev`, bind-mounted from host `/proc/1/net/dev`). `statfs(HOSTSTATS_DISK_PATH='/')`: `diskTotal=blocks*bsize`, `diskFree=bavail*bsize`, `diskUsed=total-bfree*bsize`, `inodesTotal=files`, `inodesUsed=files-ffree` (`:79-84`; Node `statfs` uses `f_bsize`, not `f_frsize`). `cpus = os.cpus().length` (`:86`): host logical CPUs, **not** the container's 0.25 CPU quota.
- Docker socket (`DOCKER_SOCKET`, default `/var/run/docker.sock`) `index.mjs:27-48`: HTTP/1.1 `GET` with `Host: docker`, unversioned paths, allowlist regex `^\/(version|system\/df|containers\/json\?all=1|containers\/[a-f0-9]{64}\/(json|stats\?stream=false&one-shot=true))$`; default timeout 5 s (120 s for `/system/df`, `:111`); response cap 16 MiB; non-200 → error; JSON parse. Calls per sample: `/containers/json?all=1`; `/version` at most hourly (`:126`); per allowlisted container (concurrency 4, `:50-60`, `:127`) `/containers/<id>/json`, and `/stats?stream=false&one-shot=true` only when running; `/system/df` in the background when the list succeeded and `df` is missing or older than `dfMs` (`:154`, `:106-116`; single-flight; on failure keeps the previous reading but still updates `dfAt`).
- Filtering (`parse.mjs:113-117`): container Id must be 64 lowercase hex, first name stripped of `/` must match `^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`, label `com.docker.compose.project` must be in `HOSTSTATS_PROJECTS`. Non-allowlisted containers are never inspected (tested).

### Parsers (`dima-hoststats/src/parse.mjs`)

`parseCpuStat` `:9-15` (first `cpu ` line, 8 jiffy fields); `cpuBetween` `:18-28` (busy = Δtotal − Δidle − Δiowait, clamped 0-100); `parseMeminfo` `:31-49` (kB ×1024; `memAvailable = MemAvailable ?? MemFree ?? 0`; `memCache = Cached+Buffers+SReclaimable`); `parseLoadavg` `:51-55`; `parseUptime` `:57-59`; `parseDiskstats` `:62-74` (whole disks only, regex `^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$`, sectors ×512, fields 5 and 9); `parseNetDev` `:77-91` (skip 2 header lines and virtual NICs `^(lo|docker\d*|br-|veth|virbr|cni|flannel|tunl|vxlan|wg|tailscale)`, rx field 0, tx field 8); `parsePressure` `:94-97` (`some avg10=`); `rate` `:100-103` (null on reset or non-positive interval); `statsCounters` `:120-146` (mem = usage − `inactive_file`/`total_inactive_file`; sums over `networks`; blkio `read`/`write` case-insensitive); `containerView` `:149-194` (CPU % of one core from `cpu_usage.total_usage` ns; `cpuLimit` from `NanoCpus` or `CpuQuota/CpuPeriod`; dates starting `0001-` → null; strings truncated with `slice`); `parseDf` `:197-221` (`LayersSize` preferred; unused images = not referenced by a container and `Containers` not > 0, size minus `SharedSize`; reclaimable build cache = `!InUse && !Shared`).

All arithmetic uses JS `Number` (f64) and `Number()` coercion (`""` → 0, non-numeric → NaN → filtered by `num()` at `:3-6`). Rust should use `f64` throughout to match, not `u64`.

### Environment, startup, intervals

`configFromEnv` `index.mjs:12-24`: `PORT` (3211), `DOCKER_SOCKET`, `HOSTSTATS_PROJECTS` (comma list, trimmed, empty dropped; default `dimabot,dimafx,admin,dimasite,dimadocs,dimadb,databases,dima-analytics,dima-hoststats,network`), `HOSTSTATS_SAMPLE_MS` (max(5000, n), default 15000), `HOSTSTATS_DF_MS` (max(60000, n), default 600000), `HOSTSTATS_PROC` (`/proc`), `HOSTSTATS_NET_DEV` (`/host/net_dev`), `HOSTSTATS_DISK_PATH` (`/`). `Number("abc")` → NaN → `Math.max(5000, NaN)` = NaN → `setInterval(NaN)` fires about every 1 ms: a Rust port should fall back to the default instead.

Startup `index.mjs:190-202`: one sample before listening, then `setInterval` every `sampleMs` with a busy guard, then listen on `0.0.0.0`. `SIGINT`/`SIGTERM` → clear timer, close server, exit 0 (`:204-207`). In-memory state: latest snapshot, previous host counters, per-container previous counters (pruned when a container disappears, `:142-143`), last `df`, Docker version (1 h cache).

### Container contract

- `dima-hoststats/dockerfile:1-8`: `node:24-alpine`, copies `src` and `test`, `USER node`, `EXPOSE 3211`, `CMD node src/index.mjs`. No dependencies (no `package-lock.json`).
- `dima-hoststats/docker-compose.yaml:4-32`: service `hoststats`, image `dima-hoststats:latest`, `container_name: dima-hoststats`, `restart: unless-stopped`, **`command: node src/index.mjs`**, env `HOSTSTATS_PROJECTS=...`, `group_add: ["983"]` (socket group on the prod host), volumes `/var/run/docker.sock:/var/run/docker.sock:ro` and `/proc/1/net/dev:/host/net_dev:ro`, `mem_limit: 128m`, `cpus: 0.25`, `pids_limit: 32`, `read_only: true`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, network external `databases` only, no published port, **healthcheck `node -e fetch('http://127.0.0.1:3211/health')`** every 30 s, timeout 5 s, retries 3.
- `saas-ops` target `hoststats` (`ops/saas_ops.py:119`): command `node src/index.mjs`, port 3211, health `/health`. Verify candidate has no socket and no host mounts (`ops/README.md:51`). Check `ops/checks/hoststats.mjs` (12 lines): runs `node --test test/hoststats.test.mjs` inside the candidate, then asserts `/v1/snapshot` has `host.memTotal`, `diskTotal`, `cpus` > 0, `docker.reachable == false`, `containers == []`, and `POST` → 405.

### Tests

`dima-hoststats/test/hoststats.test.mjs`, 6 tests, all pure (fake Docker, fake files), run with `npm test` = `node --test test/hoststats.test.mjs`: `/proc` parsers (`:8-23`), project allowlist (`:25-32`), container view rates/limits/stopped/cache-excluded memory (`:34-55`), `df` summary (`:57-66`), Docker client refuses non-allowlisted paths (`:68-72`), sampler + server end to end incl. 405/404 and stripped lookup maps (`:74-111`). All portable to Rust unit tests with fixtures copied verbatim.

### Security notes

- Preserve: GET-only allowlist enforced in code before any socket I/O (a read-only bind mount does not restrict the Docker API); compose-project filter before inspect; only selected numeric/state fields leave the process; no exec/logs/env passthrough; no published port; non-root user + socket group; read-only rootfs; caps dropped; 16 MiB response cap.
- Do **not** use a full Docker SDK (`bollard`): it exposes write APIs. A ~80-line `hyper` client over `tokio::net::UnixStream` with the same regex guard keeps the boundary auditable. Docker may answer with chunked encoding; `hyper` handles it.
- A Rust image on `scratch`/distroless must run as a numeric non-root UID with `group_add` still effective; `/proc` and `statfs` work without capabilities.

### JS string semantics

- Container list sorted with `a.name.localeCompare(b.name)` (`index.mjs:146`): ICU collation. Names are `[a-zA-Z0-9_.-]`; ICU and byte order differ for upper vs lower case and for `_`/`.`/`-` against letters. Production names are lowercase, but the Rust port should either use `icu_collator` (already a `dima-rust` feature, `unicode-collation`) or document the order change.
- `slice(0, n)` truncation of Docker strings (`parse.mjs:106`, `:192`) and error messages (`index.mjs:123`) counts UTF-16 units; Docker values are ASCII in practice.

### Estimated Rust shape

~500-650 lines + ~250 lines of tests. Crates: `tokio`, `hyper` + `hyper-util` + `http-body-util` (Unix socket client), `axum` or plain `hyper` server, `serde_json`, `regex`, `libc` (or `nix`) for `statfs` and CPU count (count `cpuN` lines in `/proc/stat`, or `sysconf(_SC_NPROCESSORS_ONLN)`; **not** `std::thread::available_parallelism`, which honours the cgroup quota and would report 1). Difficulties: f64 arithmetic parity; absent-vs-null keys in `host`; the Compose `command` and healthcheck both call `node` → a reviewed Compose change (e.g. `command: ["/app/dima-hoststats"]` and `healthcheck: ["CMD","/app/dima-hoststats","--healthcheck"]`) plus `saas_ops.py` target changes are required before the first deploy.

---

## 3. `dima-analytics` — observability API, telemetry ingestion, collectors

### Purpose and callers

Private service on the `databases` network. Serves the admin "Analytics/Observability" UI (via dimabot), consumes telemetry batches that dimabot and the Rust cron supervisor push to Dragonfly, stores metrics/spans/logs/resources in a dedicated PostgreSQL database, runs resource collectors and retention.

- HTTP: only through dimabot's proxy `dimabot/src/server/routes/observability.route.ts:6-22`, mounted at `/observability` (`dimabot/src/server/server.ts:75`). It allows only `^/api/(session|overview|resources|traces(?:/[a-f0-9]{32})?|logs|grants(?:/\d{1,30})?)$` and `GET|PUT|DELETE` (`:7-8`), forwards `Authorization` and the raw query string to `http://dima-analytics:3210${req.url}` with a 12 s timeout, `redirect:'error'`, re-serialised JSON body for PUT, and passes status + body through (`:12-20`); failures → `503`. So `/health` is not reachable from outside.
- Admin UI: `admin/src/app/pages/observability/observability-page.component.ts:226` (base), `:745` session, `:841` grants, `:847` traces, `:854` logs, `:870` overview, `:872` resources, `:934` trace detail; `admin/src/app/pages/observability/observability-access.component.ts:52`, `:200` PUT grant, `:210` DELETE grant; `admin/src/app/guards/analytics-auth.guard.ts:20` session.
- Telemetry producers (Redis contract): `dimabot/src/utils/observability/telemetry.ts:11` (`observability:v1:inbox`), `:173` Lua `ENQUEUE` (LPUSH, LTRIM 0 99, INCRBY `observability:v1:overflow` by dropped count, EXPIRE 3600), `:198-201`; Rust `dima-rust/src/supervisor/telemetry.rs:25`. Batch validator `dima-analytics/src/store.mjs` is also copied into cron fixture checks (`ops/README.md:104`, `:121`, `:144`, `:164`), so its contract is shared with the cron release workflow.

### Routes (11) — `dima-analytics/src/index.mjs:16-122`

Middleware order: `x-powered-by` off (`:18`); `express.json({limit:'16kb'})` (`:19`); `Cache-Control: no-store` on everything (`:20`); `/health` (`:21-24`); then the auth + rate-limit middleware for every other path (`:25-52`); routes; `404 {"message":"Analytics endpoint not found"}` (`:120`); error handler (`:121`): `error.status` in 400-499 → that status with `error.message` (body-parser parse errors therefore echo V8's `JSON.parse` message text; 413 for >16 kB), anything else → `503 {"message":"Analytics is temporarily unavailable"}`. No CORS. All error bodies are `{message}`.

Auth (`:26-52`):
- Token = `Authorization` header with a leading `Bearer ` removed by regex (`/^Bearer /`); a header without the prefix is used whole. Empty or `token.length > 2048` (UTF-16 units) → `401 "Sign in to view analytics"`.
- Rate limit (in-memory `Map`, key = SHA-256 hex of the token): 120 requests per key per 60 s window (`count++ >= 120` → `429 "Too many analytics queries"`); when the map exceeds 2000 entries expired ones are swept, and a new key while ≥ 2000 → `429 "Try again shortly"`. The window is set on first use and not reset until expiry.
- Identity: `HGETALL token:<raw token>` (shared SaaS session cache) → `{id, login}`; else `GET observability:v1:identity:<sha256>` (JSON); else `GET https://id.twitch.tv/oauth2/validate` with `Authorization: OAuth <token>`, 3 s timeout; non-OK or no `user_id` → `401 "Session expired"`; cached with `SET ... EX max(1, min(60, Number(expires_in)||60))`. A Twitch network error throws → 503.
- Grant: `user.id === OWNER_TWITCH_ID` → `{role:'owner',channels:[],services:[]}` (no `expires_at` key); else `SELECT role,channels,services,expires_at FROM analytics_grants WHERE user_id=$1 AND (expires_at IS NULL OR expires_at>now())`; none → `403 "Analytics access has not been granted to your account"`.

| # | Route | Source | Access | Response |
|---|---|---|---|---|
| 1 | `GET /health` | `:21-24` | none | `SELECT 1`; `200 {status:"ok",service:"analytics",bufferReady:redis.isReady,ingestedAt}`; PG failure → 503 via error handler. |
| 2 | `GET /api/session` | `:53` | any grant | `{user:{id,login}, grant, channelNames}` |
| 3 | `GET /api/overview` | `:54-58`, `store.mjs:154-198` | any grant | `{minutes,resolution,generatedAt,lastAt,http,chat,timeline,groups,measured,channelNames}`. Query: `minutes` ∈ {15,60,360,1440,10080,43200,525600} (`store.mjs:135-140`, else `400 "Unsupported time range"`), `channel`, `service`, `kind`. |
| 4 | `GET /api/resources` | `:59-77` | grants without channel restriction (else `403 "System resources require a system-wide grant"`) | `{samples (≤20000), limited, status:<health counters>, infrastructure?}`. `include=snapshot\|infra` adds `infrastructure:{receivedAt,snapshot,series,container,slotSeconds?}` only when the grant has no service restriction; `container` must match `^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$` else null. |
| 5 | `GET /api/traces` | `:79-84` | not `viewer` (`:78`, `403 "Investigator access is required"`) | `{spans (≤100), channelNames}`; `minutes` capped at 4320. |
| 6 | `GET /api/traces/:id` | `:85-91` | not viewer | id `^[a-f0-9]{32}$` else `400 "Invalid trace ID"`; none → `404 "Trace not found in your scope"`; `{spans (≤500), channelNames, partial}`. |
| 7 | `GET /api/logs` | `:92-98` | not viewer | `{logs (≤100), channelNames}`; `minutes` capped at 10080; `search` → `name ILIKE '%…%'` with `\ % _` escaped, sliced to 80 UTF-16 units. |
| 8 | `GET /api/grants` | `:100-103` | owner only (`:99`, `403 "Only the owner can manage analytics access"`) | `{grants (≤500, by updated_at DESC), channelNames}` (names resolved for user IDs and channels). |
| 9 | `PUT /api/grants/:id` | `:104-114` | owner | Body `{role∈viewer\|investigator, channels[], services[] (≤100 each, items ^[a-zA-Z0-9_.:-]{1,80}$), expiresAt: null \| Date.parse-able future}`; id `^\d{1,30}$` and ≠ owner; else `400 "Invalid access grant"`. Transaction: upsert into `analytics_grants` + insert `analytics_audit(actor,'grant',subject)`. `{saved:true}`. `expiresAt` is validated by JS `Date.parse` but stored by PostgreSQL parsing the raw string. |
| 10 | `DELETE /api/grants/:id` | `:115-119` | owner | No id validation; `DELETE` + audit `'revoke'` (not in one transaction). `{revoked:true}`. |
| 11 | catch-all | `:120` | after auth | `404` |

Row serialisation: `timestamptz` → JS `Date` → ISO with milliseconds; `bigint`/`numeric` (e.g. `sum(count)`) come back from `pg` as **strings** and are converted with `Number()` where used; `text[]` → arrays; `jsonb` → objects; `double precision` → numbers. `/api/resources` `status` exposes the live counters object `{ingestedAt, invalidBatches, ingestionErrors, collectorError}`.

Query-string parsing uses Express `qs`: repeated keys become arrays and `scopeSql` applies `String(...)` → `"a,b"`; bracket keys become objects → `"[object Object]"`. `Number(minutes)` accepts `" 60 "`, `"6e1"`, `"0x3c"`. These only narrow results; a Rust port can take the first value and parse decimals, documented as a deliberate difference.

### PostgreSQL

Pool (`store.mjs:39-43`): max 5, connect timeout 3 s, idle 30 s, `statement_timeout` 8000 ms.

Schema at startup (`store.mjs:45-81`, one multi-statement query, then `partitions`):
- `analytics_batches(id uuid PK, received_at timestamptz default now())`
- `analytics_metrics(resolution int, at timestamptz, service, kind, name, channel, outcome text, count bigint, sum float8, max float8, histogram bigint[]; PK (resolution, at, service, kind, name, channel, outcome)) PARTITION BY RANGE (at)`
- `analytics_spans(at, trace_id, span_id, parent_id, service, channel, kind, name, outcome, duration float8, partial bool; PK(at, span_id)) PARTITION BY RANGE (at)`; indexes `analytics_spans_lookup(trace_id, at)`, `analytics_spans_scope(channel, at)`
- `analytics_logs(at, service, channel, level, name, trace_id, fields jsonb) PARTITION BY RANGE (at)`; index `analytics_logs_scope(channel, at)`
- `analytics_resources(at, service, name, value float8; PK(at, service, name)) PARTITION BY RANGE (at)`
- `analytics_grants(user_id text PK, role CHECK IN ('viewer','investigator'), channels text[] default '{}', services text[] default '{}', expires_at, granted_by, updated_at default now())`
- `analytics_audit(at default now(), actor, action, subject)`

Partitions (`store.mjs:82-90`): for UTC days −1..+2, `CREATE TABLE IF NOT EXISTS analytics_<t>_<YYYYMMDD> PARTITION OF analytics_<t> FOR VALUES FROM ('<date>') TO ('<next>')` for metrics, spans, logs, resources (identifiers generated locally).

Retention, hourly (`store.mjs:91-104`, timer `index.mjs:159`): partitions; delete batches > 2 days; delete metrics (res 10 > 2 days, res 60 > 30 days); list `pg_class` children matching `^analytics_(metrics|spans|logs|resources)_[0-9]{8}$` and `DROP TABLE` when day+1 is older than 365/3/7/30 days; delete audit > 365 days.

Ingestion (`store.mjs:106-133`): `validateBatch` (`:5-22`: version 1, id `^[a-f0-9-]{36}$`, `service` ≤ 50, `instance` ≤ 100, metrics ≤ 100 / spans ≤ 50 / logs ≤ 25, timestamps within −1 h/+60 s, histograms of 16 safe integers summing to `count`, text without control chars and length limits in UTF-16 units, log `fields` JSON ≤ 2000 UTF-16 units); transaction: `INSERT INTO analytics_batches ... ON CONFLICT DO NOTHING RETURNING id` (replay → rollback, `false`); metrics via `jsonb_to_recordset` × resolutions (10, 60, 3600) upsert summing count/sum/histogram elementwise and `greatest` max; spans via `jsonb_to_recordset ... ON CONFLICT DO NOTHING`; logs via `jsonb_to_recordset`.

Queries: overview totals/timeline/recent (`store.mjs:160-172`, `array_agg(sum/count ORDER BY at DESC)`, timeline bucket `floor(epoch/step)*step*1000`, step 60 or 3600); resources `DISTINCT ON (service,name,floor(epoch/slot))` excluding `host` and `container:%` (`index.mjs:64-65`); traces/logs (`:82`, `:88`, `:96`); grants (`:49`, `:101`, `:109-111`, `:116-117`); collector stats (`collectors.mjs:44-47`: `pg_database_size`, `pg_stat_activity` count, `sum(pg_database_size)` over connectable databases, `sum(pg_total_relation_size)` in `public`); resources insert (`collectors.mjs:105`); rollups (`infrastructure.mjs:110-117` hourly `avg`/`max` rows named `<name>.h_avg`/`.h_max`; `:120-136` find missing hours within 48 h); infra series (`infrastructure.mjs:180-193`). `scopeSql` (`store.mjs:141-151`) appends grant filters first (`channel = ANY`, `service = ANY`) and then user filters, all as parameters — the only interpolated SQL fragments are local constants and locally generated dates/steps.

### Redis / Dragonfly

Client (`index.mjs:128-130`): `REDIS_URL`, `disableOfflineQueue`, 3 s connect timeout, errors ignored, must connect at startup.
- Sessions: `HGETALL token:<token>`; identity cache `GET`/`SET EX` `observability:v1:identity:<sha256>`.
- Consumer (`index.mjs:137-156`, every 1 s, busy guard, ≤ 10 batches per tick): `LINDEX observability:v1:processing 0`, else `LMOVE observability:v1:inbox observability:v1:processing RIGHT LEFT`; > 256,000 bytes or bad JSON → `LREM processing 1 raw` and `invalidBatches++`; `ingest`; an `Invalid…` error → drop as invalid; other errors → `ingestionErrors++` and stop the tick (batch stays in `processing` for retry); success → `LREM processing 1 raw`, `ingestedAt` updated.
- Collectors (`collectors.mjs:37-44`): `INFO` (parsed `key:value`), `LLEN observability:v1:inbox`, `GET observability:v1:overflow`; `SET observability:v1:infra:latest <json> EX 300` (`:62`); queue discovery `SCAN cursor MATCH twitch:*:*:queue COUNT 100` up to 4 pages per sample with a persistent cursor (`:84-95`), for keys matching `^twitch:([a-zA-Z0-9_-]+):(tts|clips):queue$`: `ZCARD`, `ZRANGE 0 0 WITHSCORES`; `EXISTS` for remembered queues (`:97-102`, ≤ 1000 tracked, first 100 checked).
- Channel names (`channel-names.mjs:23-31`): `MULTI` of `HGET accounts:twitch:<id>:data name` in chunks of 50.
- Resources read: `GET observability:v1:infra:latest` (`index.mjs:70`).

### MongoDB

- Channel-name fallback (`channel-names.mjs:9-12`, `:33-44`): `MONGO_METRICS_URI`, pool 1, 1.5 s timeouts; `users.find({accounts:{$elemMatch:{type:'twitch',id:{$in:ids}}}}, {projection:{_id:0,'accounts.type':1,'accounts.id':1,'accounts.name':1}, maxTimeMS:1000}).limit(500)`. Names accepted only if `^[a-zA-Z0-9_]{1,25}$`. IDs must match `^[a-zA-Z0-9_-]{1,80}$`, ≤ 500 per response. In-memory cache ≤ 1000 entries, 60 s for found names / 15 s for misses, FIFO eviction (`:45-49`).
- Collector (`collectors.mjs:23-24`, `:65-75`): second client (pool 2, 2.5/2.5/3 s timeouts): `admin.serverStatus` (`mem.resident`, `wiredTiger.cache` bytes, `connections.current`) and `dbStats {scale:1}` (`dataSize`, `storageSize`, `indexSize`).

### Outbound HTTP

`https://id.twitch.tv/oauth2/validate` (above); `${QDRANT_URL}/metrics` with optional `api-key` header, 3 s timeout, allowlisted OpenMetrics names summed across labels (`collectors.mjs:9-18`, `:51-57`); `${HOSTSTATS_URL}/v1/snapshot` (above).

### Environment, startup, timers, caches

`configFromEnv` `index.mjs:10-14`: `DATABASE_URL` (required), `OWNER_TWITCH_ID` (required, `^\d+$`, `:126`), `REDIS_URL` (`redis://dragonfly:6379`), `MONGO_METRICS_URI`, `QDRANT_URL`, `QDRANT_API_KEY`, `HOSTSTATS_URL` (unset → `http://dima-hoststats:3211`; `off` → disabled), `PORT` (3210), `COLLECTORS_DISABLED` (`'true'` disables). Values come from `dima-analytics/.env` (generated by `ops/bootstrap_analytics.py`, mode 0600).

Startup (`:125-162`): validate env → pool → Redis connect → migrate → listen `0.0.0.0` → timers: drain 1 s; collectors 30 s plus one immediate run (unless disabled); retention 1 h. Shutdown on `SIGINT`/`SIGTERM` (`:163-166`): stop timers, close server, Mongo clients, `QUIT` Redis, end pool, exit 0. Collector cadence: host rows every sample, container rows every other sample (`collectors.mjs:32`); hourly rollup attempt when the hour changes (`:107-108`). In-memory: rate-limit map, channel-name cache, infra-series cache (≤ 200 keys, TTL 15 s-5 min, `infrastructure.mjs:102`, `:167-170`, `:206-207`), queue map, SCAN cursor.

Number formatting: `round = Number(v.toPrecision(4))` (`infrastructure.mjs:139`) — Rust needs an equivalent 4-significant-digit rounding (`format!("{:.3e}")` then parse; ties may differ in the last digit).

### Container contract

- `dima-analytics/dockerfile:1-9`: `node:24-alpine`, `npm ci --omit=dev` (express, pg, redis, mongodb), copies `src` + `test`, `USER node`, `EXPOSE 3210`, `CMD node src/index.mjs`.
- `dima-analytics/docker-compose.yaml:1-24`: service `analytics`, image `dima-analytics:latest`, `container_name: dima-analytics`, `restart: unless-stopped`, **`command: node src/index.mjs`**, `env_file: .env`, `mem_limit: 512m`, `cpus: 1.0`, `pids_limit: 128`, `read_only: true`, `tmpfs: /tmp:size=16m`, `cap_drop: [ALL]`, `no-new-privileges`, network external `databases`, no published port, **healthcheck `node -e fetch('http://127.0.0.1:3210/health')`** 30 s / 5 s / 3.
- `saas-ops` target `analytics` (`ops/saas_ops.py:111`): command `node src/index.mjs`, port 3210, health `/health`; verify dependencies `postgres` (pgvector pg17, trust auth, db `observability_test`), `redis` (Dragonfly), `mongo` (`ops/saas_ops.py:122-126`). First install is a separate script `ops/bootstrap_analytics.py` (136 lines; runs `node --test` inside the candidate at `:67`).
- Behaviour checks (all run `node --test` against the **JS sources** inside the candidate and import `/app/src/*.mjs` or `/app/test/*.mjs`): `ops/checks/analytics-infrastructure.mjs`, `analytics-channel-names.mjs` (+ `analytics-channel-names-env.json`), `analytics-overview-aggregation.mjs`. These cannot be reused for a Rust image; they need black-box rewrites over HTTP + PG/Redis fixtures.

### Tests (12 cases; `npm test` = `node --test test/*.test.mjs`)

- `test/analytics.test.mjs`: batch validation (`:9`), percentile merging (`:10`), grant filters cannot widen (`:11`), resource parsers (`:12`) — pure; real PG/Redis persistence, replay, permissions, names privacy, Redis ingestion (`:13-36`) and long-range aggregation (`:37-53`) — need `ANALYTICS_TEST=1` + `observability_test` DB.
- `test/channel-names.test.mjs`: cache/rename/failure (`:7`), 500-ID bound (`:17`) — pure; Mongo fallback (`:22`) — needs services.
- `test/infrastructure.test.mjs`: sanitiser (`:11`) and `fetchSnapshot` limits (`:123`) — pure; collector/storage/API with mock sidecar and 30-day rollup performance (`:28-121`) — needs services.
- Fixture `test/infra-fixture.mjs`.

### Security notes

- Preserve: identity only from the bearer session (never browser IDs); grant filters always applied before user filters; channel-scoped grants denied resources; service-scoped grants denied host/container block; owner-only grant management with audit; 16 kB body limit; bounded SCAN (never `KEYS`); bounded batch sizes and payload sizes; names resolved only for already authorised IDs and only the public `name` field; `redirect:'error'` on sidecar fetch.
- Tighten candidates: validate `DELETE /api/grants/:id` like PUT; wrap revoke + audit in one transaction; validate `expiresAt` with the same parser PostgreSQL will use.

### JS string semantics

`.length` limits in UTF-16 units: token ≤ 2048, batch text fields, `JSON.stringify(fields).length ≤ 2000`, snapshot body ≤ 512,000. `slice(0,n)` in UTF-16 units: `search` 80, filters 80/50/30, sidecar errors 120. `Buffer.byteLength(raw) > 256000` is bytes. `/[\u0000-\u001f]/` control-char check. Regexes are ASCII-only. A faithful port counts `encode_utf16().count()` for limits and truncates on UTF-16 boundaries (or documents the switch to chars). `Date.parse` accepts more formats than RFC 3339.

### Estimated Rust shape

~1,400-1,900 lines + tests. Crates: `axum`, `tokio`, `sqlx` (postgres, chrono/time, json), `redis` (tokio, `aio`), `mongodb`, `reqwest`, `serde_json`, `sha2`/`hex`, `regex`, `uuid`, `chrono`. Difficulties: `numeric`/`bigint` result columns (sum over bigint is `NUMERIC`; add `::float8`/`::bigint` casts or decode `rust_decimal`) while keeping response numbers identical; millisecond ISO dates; dynamic `$n` SQL assembly (`scopeSql`) with sqlx (`QueryBuilder` or manual positional binds); multi-statement migration (`sqlx::raw_sql`); the consumer's at-least-once semantics; Express error-handler/body-parser status mapping; port of 3 node-only checks; the Compose `command` + healthcheck change. It is also a shared contract with telemetry producers in dimabot and `dima-rust/src/supervisor/telemetry.rs`.

---

## 4. `dimadb/server` — internal DB console backend

### Purpose and callers

Same-origin API and static file server for the Angular console (`dimadb/src`, stays as is) in one container. Users log in with local accounts and browse/edit any configured Redis/Dragonfly or MongoDB.

- Callers: `dimadb/src/app/interceptors/dimadb-header.interceptor.ts:6` (adds `X-Dimadb: 1`); `dimadb/src/app/services/auth.service.ts:34` setup, `:45` login, `:54` logout, `:59` users GET, `:68` users POST, `:78` setup status, `:83` me; `connections.service.ts:25` list, `:37` add, `:47` delete, `:59` ping; `mongo.service.ts:19` dbs, `:26` collections, `:41` docs, `:50` doc GET, `:65` PUT, `:77` POST, `:88` DELETE; `redis.service.ts:20` tree, `:29` keys, `:38` key GET, `:47` PUT, `:54` POST, `:61` PATCH, `:68` DELETE, `:77` command. The console page re-sends with `confirm:true` after a `409` (`dimadb/src/app/pages/console-page.component.ts:46-55`).
- Reached through Nginx Proxy Manager on `web-proxy` (`dimadb/AGENTS.md:7`).

### HTTP surface (`dimadb/server/index.mjs`, plain `node:http`)

- Request URL is parsed with `new URL(req.url, 'http://' + host)` (`:369`) **outside any try/catch**; `/api` and `/api/*` go to the API, everything else to static files.
- Static (`:376-395`, `:44-60`): `/` → `index.html`; path is `decodeURIComponent`'d and resolved under `PUBLIC_DIR`; must `startsWith(PUBLIC_DIR)` else `400` empty; existing file → `200` with MIME table (`:24-36`, unknown → `application/octet-stream`), `index.html` gets `no-cache, no-store, must-revalidate`, other files `public, max-age=2592000, immutable`; missing → SPA fallback `index.html` (no cache header); no `index.html` → `503 text/plain "dimadb public assets missing"`. No `HEAD`/method checks (any method gets the file).
- API envelope (`dimadb/server/http-util.mjs:1-16`): `content-type: application/json; charset=utf-8`, `cache-control: no-store`; success `200 {error:false,status:200,data}`; failure `{error:true,status,message}`.
- CSRF gate (`index.mjs:62-71`): every `/api` path except `/api/health` requires header `X-Dimadb` exactly `1` → else `403 "Missing X-Dimadb header"` (checked before routing, so unknown paths without the header are 403).
- Body (`http-util.mjs:18-35`): whole body buffered, **no size limit**; empty → `{}`; invalid JSON → `Error('Invalid JSON')` without status → **500**. Any `Content-Type` accepted.
- Errors (`index.mjs:359-365`): `error.status || 500`, message passed through (Redis/Mongo driver messages included); ≥ 500 logged.
- No CORS headers, no rate limiting. Listens `0.0.0.0:PORT` (`:398`). No shutdown handling.

Session auth (`dimadb/server/auth.mjs`): cookie `dimadb_session=<uuid>` parsed by splitting on `;`/`=` with `decodeURIComponent` (`:89-100`); session looked up in `sessions.json` after pruning expired rows (written back when pruned, `:14-21`, `:31-42`); `401 "Not authenticated"` (`index.mjs:73-80`). Cookie (`http-util.mjs:50-76`): `Path=/; HttpOnly; SameSite=Strict; Max-Age=1209600` plus `Secure` when the first `X-Forwarded-Proto` value is `https` (`:78-81`). Sessions last 14 days (`auth.mjs:3`), not renewed.

| # | Route | Source | Auth | Behaviour |
|---|---|---|---|---|
| 1 | `GET /api/health` | `:92-95` | none (no CSRF) | `{ok:true,service:"dimadb",dataDir}` (other methods → 404) |
| 2 | `GET /api/setup/status` | `:97-100` | CSRF | `{needsSetup}` (no users) |
| 3 | `POST /api/setup` | `:102-116` | CSRF; only while no users (`409 "Setup already completed"`) | Creates admin, logs in, sets cookie; `{user}` |
| 4 | `POST /api/login` | `:118-123` | CSRF | `401 "Invalid username or password"`; sets cookie; `{user}` |
| 5 | `POST /api/logout` | `:125-129` | CSRF | Removes session, clears cookie; `{ok:true}` |
| 6 | `GET /api/me` | `:131-138` | session | `{user:{id,username,role}}` |
| 7 | `GET /api/users` | `:140-151` | session + admin (`403 "Admin only"`) | `[{id,username,role}]` |
| 8 | `POST /api/users` | `:153-170` | session + admin | `role = body.role==='user' ? 'user' : 'admin'`; returns public user |
| 9 | `GET /api/connections` | `:172-178` | session | `[{id,name,url (password masked as ***),source,engine}]` |
| 10 | `POST /api/connections` | `:180-187` | session | `{name,url,engine}` → stored with password split out and AES-GCM encrypted |
| 11 | `DELETE /api/connections/:id` | `:189-200` | session | drops cached clients, removes a local row (`404 "Local connection not found"` for env rows) |
| 12 | `POST /api/connections/:id/ping` | `:202-206` | session | `{ok:true,pong}` (`PONG` or Mongo result JSON) |
| 13 | `GET /api/mongo/:id/dbs` | `:218-221`, `mongo.mjs:39-47` | session | `[{name,sizeOnDisk,empty}]` |
| 14 | `GET /api/mongo/:id/collections?db=` | `:223-226`, `mongo.mjs:48-53` | session | `[{name,type}]` |
| 15 | `GET /api/mongo/:id/docs?db&collection&skip&limit&filter` | `:228-237`, `mongo.mjs:54-77` | session | `{db,collection,skip,limit (1-100, default 50),total,docs:[{id,document}]}`; total = `countDocuments(filter)` or `estimatedDocumentCount()` for `{}` |
| 16 | `GET /api/mongo/:id/doc?db&collection&id` | `:239-246`, `mongo.mjs:78-93` | session | `{db,collection,id,document}`; `404 "Document not found"` |
| 17 | `POST /api/mongo/:id/doc` | `:248-252`, `mongo.mjs:106-113` | session | body `{db,collection,document}` → `insertOne` → inspect |
| 18 | `PUT /api/mongo/:id/doc` | `:254-258`, `mongo.mjs:94-105` | session | body `{db,collection,docId,document}` → `replaceOne` → inspect |
| 19 | `DELETE /api/mongo/:id/doc?db&collection&id` | `:260-267`, `mongo.mjs:114-121` | session | `{deleted}` |
| 20 | `GET /api/redis/:id/tree?prefix&query&cursor` | `:278-285`, `redis.mjs:55-97` | session | `{prefix,match,cursor,folders:[{prefix,label,seen}],keys:[{name}],scanned}` |
| 21 | `GET /api/redis/:id/keys?cursor&match&count` | `:287-294`, `redis.mjs:42-54` | session | `{cursor,keys:[{name,type,ttl}]}`; COUNT ≤ 200 |
| 22 | `GET /api/redis/:id/key?key=` | `:296-304`, `redis.mjs:98-107` | session | `{key,type,ttl,value}`; `404 "Key not found"` |
| 23 | `PUT /api/redis/:id/key` | `:306-314`, `redis.mjs:108-120` | session | string set (KEEPTTL if it was a string; `409` for other types) |
| 24 | `POST /api/redis/:id/key` | `:316-324`, `redis.mjs:121-160` | session | create `string\|hash\|list\|set\|zset`; `409 "Key already exists"` |
| 25 | `PATCH /api/redis/:id/key` | `:326-334`, `redis.mjs:161-177`, `:234-328` | session | ops `ttl,hset(+renameFrom),hdel,lset,lpush,rpush,ldel,sadd,srem,zadd,zrem`; returns key or `{key,type:"none",ttl:-2,value:null}` |
| 26 | `DELETE /api/redis/:id/key?key=` | `:336-344` | session | `{deleted:<int>}` |
| 27 | `POST /api/redis/:id/command` | `:346-355`, `redis.mjs:182-189` | session | `args[]` or `command` split on `/\s+/`; dangerous set (`FLUSHALL FLUSHDB EVAL EVALSHA CONFIG DEBUG SHUTDOWN REPLICAOF SLAVEOF MODULE ACL SWAPDB MIGRATE RESTORE`) needs `confirm:true` else `409 "<CMD> needs confirm: true"`; `{result}` = raw reply |
| — | anything else under `/api` | `:358` | CSRF | `404 "Not found"` (also any connection/mongo/redis path with a wrong method, after the session check) |

`:id` path segments are `decodeURIComponent`'d (`:194`, `:215`, `:275`); a bad escape throws `URIError` inside the try → 500.

### Data access

Files in `DATA_DIR` (`dimadb/server/store.mjs:5-33`): `users.json`, `sessions.json`, `connections.json` (pretty JSON arrays, written via `<file>.tmp` + `rename`; unreadable/invalid → `[]`, silently), `secret` (32 random bytes hex, mode 0600, created on first start unless `DIMADB_SECRET` is set; `:82-92`). Every request re-reads the files (no cache); concurrent writes are last-writer-wins.
- Password hash (`:43-56`): `scrypt:<salt>:<hash>`, salt = 16 random bytes as a 32-char **hex string used as the ASCII salt bytes**, Node `scryptSync` defaults N=16384, r=8, p=1, keylen 64; verify with `timingSafeEqual`.
- Connection passwords (`:57-78`, `:94-96`): AES-256-GCM, key = SHA-256 of the secret string (UTF-8, file content trimmed), 12-byte IV; stored `ivhex:taghex:datahex`.
- Users: `{id (uuid), username (lowercased, ^[a-z0-9._-]{2,32}$), passwordHash, role, createdAt}`; password ≥ 8 UTF-16 units (`auth.mjs:43-63`). Sessions: `{id, userId, createdAt, expiresAt}`.
- Connections (`dimadb/server/connections.mjs`): env rows from every non-empty `DIMADB_REDIS_*` (id `env:<suffix lowercased>`) and `DIMADB_MONGO_*` (id `env:mongo:<suffix lowercased>`), name = suffix lowercased with `_` → space, in `process.env` order (`:4-21`); local rows from `connections.json` (`:23-29`). Add (`:75-95`): WHATWG `URL` parse; protocol must be `redis:`, `rediss:`, `mongodb:` or `mongodb+srv:` and match the requested engine; password removed from the URL and encrypted. Public URL masks the password as `***` (`:121-131`).

Redis (`dimadb/server/redis.mjs`, node-redis v5, one cached client per connection, auto-reconnect, errors logged): `SCAN`, `TYPE`, `TTL`, `GET`, `HGETALL`, `LRANGE 0 199`, `SMEMBERS`, `ZRANGE 0 199 WITHSCORES`, `XRANGE - + COUNT 50` (`:330-347`), `SET` (with `KEEPTTL`), `HSET`, `RPUSH`, `LPUSH`, `SADD`, `ZADD`, `PERSIST`, `EXPIRE`, `HDEL`, `LSET`, `LREM` (list delete via a unique marker, `:289-299`), `SREM`, `ZREM`, `DEL`, `PING`, and arbitrary `sendCommand`. Tree scan: up to 120 rounds of `COUNT 1000` or 40,000 keys (`:55-97`); match = `<prefix>*`, or the query as is if it contains `*`, else `*<query>*` (`:193-205`). Values are returned as UTF-8 strings (binary values lose bytes); zset entries as `{value, score}`; streams as `{id, message}`; `sendCommand` replies map RESP2 → JS (integers as JS numbers, nil → null, errors → thrown → **500**).

MongoDB (`dimadb/server/mongo.mjs`, via `mongoose.createConnection(url, {serverSelectionTimeoutMS: 8000})`, cached per connection): `admin.ping`, `listDatabases`, `listCollections({}, {nameOnly:true})`, `find(filter).skip().limit()`, `countDocuments`, `estimatedDocumentCount`, `findOne`, `replaceOne`, `insertOne`, `deleteOne`. The filter is any JSON parsed with relaxed EJSON (`:131-138`), so any query operator is accepted, including `$where`/`$expr`. Documents are returned with `EJSON.serialize` (relaxed: plain numbers, `{$oid}`, `{$date: ISO}`), and written back with relaxed `EJSON.deserialize` — JS numbers then become Int32 or Double, so saving a document through the console converts `Int64` fields to Int32/Double today. `_id` lookup (`:157-163`): a 24-char lowercase hex string becomes an `ObjectId`, anything else a string.

### Environment, startup, container

- Env: `PORT` (80), `PUBLIC_DIR` (`../public` relative to the server file, image sets `/app/public`), `DATA_DIR` (`/data`), `DIMADB_SECRET` (optional), `DIMADB_REDIS_*`, `DIMADB_MONGO_*` (`index.mjs:19-21`; compose `dimadb/docker-compose.yaml:9-14` sets `DIMADB_REDIS_DRAGONFLY` default `redis://dragonfly:6379`, `DIMADB_MONGO_DIMABOT` default empty).
- Startup creates `DATA_DIR`, loads or creates the secret, then listens. No background work. Caches: Redis clients and Mongo connections per connection id (never evicted except on delete).
- `dimadb/dockerfile:1-22`: stage 1 `node:22-alpine` builds Angular (`npm ci`, `npm run build`); stage 2 `node:22-alpine`, `npm ci --omit=dev --prefix server` (mongoose, redis), copies `server/*.mjs` and `dist/dimadb/browser` to `/app/public`, `mkdir /data`, `EXPOSE 80`, `CMD node server/index.mjs`. Runs as **root**, no `HEALTHCHECK`.
- `dimadb/docker-compose.yaml:1-25`: service `dimadb`, image `dimadb:latest`, `container_name: dimadb`, `restart: unless-stopped`, volume `./data:/data` (read-write, persistent production data), external networks `web-proxy` + `databases`, no published port, no limits, no `command`, no healthcheck.
- `saas-ops` target `dimadb` (`ops/saas_ops.py:118`): port 80, health `/api/health`; verify overrides `DIMADB_REDIS_DRAGONFLY=""`, `DIMADB_MONGO_DIMABOT=""`, `DATA_DIR=/tmp/saas-data` (`:824-834`). Baseline check `ops/checks/dimadb.mjs` (9 lines): `/api/health` 200 JSON and `/` contains `<html`.
- Coupling: `ops/tests/docker_smoke.py:3`, `:43` uses the local `dimadb:latest` image **as a Node base image** (`FROM dimadb:latest` + `node /ops-probe.mjs`), and `ops/tests/test_ops.py` uses `dimadb` as its fixture target. A Node-free dimadb image breaks `docker_smoke.py`; it must switch to another base first.

### Tests

None for the server. `dimadb/src/app/app.spec.ts` is a single Angular "should create the app" test. Parity must come from a new differential check (same requests against the Node and Rust images with disposable Redis + Mongo), which the `redis` and `mongo` verify dependencies already support (`ops/saas_ops.py:122-126`).

### Security notes

Preserve: CSRF header on every API call except health; `HttpOnly; SameSite=Strict` cookie (+`Secure` behind HTTPS); scrypt verification with constant-time compare; AES-GCM at rest for connection passwords and masking in responses; admin-only user management; setup only while no users exist; confirmation gate for dangerous Redis commands; data files written atomically; existing `users.json`, `sessions.json`, `connections.json` and `secret` must keep working unchanged (format and crypto parameters above).

Bugs and hardening to decide on (behaviour changes need sign-off):
- **Crash on malformed URL**: `new URL(...)` (`index.mjs:369`) with a bad `Host` header and `decodeURIComponent` in `safePublicPath` (`:57`, e.g. `GET /%`) throw in the request handler outside any try → uncaught exception → process exit (Docker restarts it). Rust must return 400.
- Static path guard uses `startsWith(PUBLIC_DIR)` without a separator (`:59`): `/../public-x/...` would pass for a sibling `/app/public-x`. Use a component-wise check.
- No request body limit (`http-util.mjs:18-35`), reachable before authentication on `/api/login` and `/api/setup`: add a cap (Mongo documents can be up to 16 MB).
- No login throttling, and `scryptSync` blocks the event loop per attempt; in Rust run scrypt on a blocking thread and add a limiter.
- Invalid JSON returns 500 instead of 400.
- Any logged-in `user`-role account can run arbitrary Redis commands and Mongo writes (only user management is admin-only). Mongo filters accept `$where`. That is the console's purpose; keep, but document.
- Image runs as root; `/data` ownership must be kept compatible if a non-root UID is introduced.
- Session ID is a UUIDv4 (122 random bits) — acceptable; keep the same format so existing cookies stay valid.

### JS string semantics

- Tree output: folders sorted with `localeCompare` (ICU) and keys with default `Array#sort` (UTF-16 code-unit order) (`redis.mjs:93-94`). Rust byte order equals UTF-16 order except for supplementary-plane vs U+E000-U+FFFF characters; `localeCompare` needs `icu_collator` (or a documented change).
- `splitTreeNode` uses `indexOf(':')`/`slice` (`:207-215`) — safe on `char` boundaries in Rust because `:` is ASCII.
- Console command split on JS `\s+` (`index.mjs:348`): includes U+FEFF, which Rust's `split_whitespace` does not.
- Username lowercasing `toLowerCase()` then ASCII regex; password length in UTF-16 units.
- Relaxed EJSON number mapping (above): Rust `bson` relaxed Extended JSON prints doubles like `1.0` where JS prints `1`, and maps JSON integers to Int32/Int64 instead of JS's Int32/Double. Values shown in the UI and types written back can therefore differ; this needs an explicit decision (match JS, or preserve BSON types better).
- Redis integer replies above 2^53 lose precision in JS; Rust would print them exactly.

### Estimated Rust shape

~1,500-2,000 lines + a differential test harness. Crates: `axum` (or `hyper`) + `tower-http` (`ServeDir` with an SPA fallback, custom cache headers), `tokio`, `redis` (aio, `redis::cmd` for raw commands, `Value` → JSON mapping), `mongodb` + `bson` (Extended JSON), `scrypt`, `aes-gcm`, `sha2`, `hex`, `uuid`, `url`, `serde_json`, `percent-encoding`, `rand`. Difficulties: EJSON parity (biggest); RESP → JSON mapping parity for `sendCommand`; reading existing data files and crypto byte-for-byte; static serving rules; the Angular build stage stays Node (only the runtime stage changes); `docker_smoke.py` dependency on `dimadb:latest` as a Node base.

---

## Recommendation

**Pilot: `dimadb/server`.**

It is the smallest port that covers everything the pilot has to prove:
- **HTTP:** 27 routes, cookie sessions and static SPA serving.
- **Configuration:** environment variables, including the prefix-scanned `DIMADB_*` connections.
- **Data stores:** Redis and MongoDB through disposable verify dependencies (`--dependencies redis,mongo`, `ops/saas_ops.py:122-126`), plus JSON files and crypto that must stay compatible.
- **Docker packaging:** a multi-stage image with a Node build stage and a Rust runtime stage.
- **Behaviour check:** a new differential check, Node image against Rust image on the same fixtures, which can run on this laptop.

Why this one first:
- It uses the same stores as `dimabot` (Mongo and Dragonfly), so the BSON/EJSON and RESP-to-JSON work carries over to the main port. The Postgres work in analytics does not.
- The blast radius is small: an internal console used only by its operators, with no viewer traffic or payments.
- Its Compose file has no `command` and no healthcheck, so the release needs no Compose configuration change.

The workflow fixes it forces are needed for every later port anyway:
- a Node-free readiness and check mode in `saas_ops.py`;
- moving `ops/tests/docker_smoke.py` off `dimadb:latest`.

Before writing code, decide two things:
- the EJSON number policy (copy JS's lossy Int64 → Int32/Double conversion, or keep BSON types);
- the hardening items listed above.

Fallback: if the pilot does not need to touch a data store, `dimafx-server` is a smaller pilot (about 450 lines, 8 routes, existing behaviour check). It sits on the viewer payment path, though, so I would port it second.

**Order for the other three:**
1. **`dimafx-server`.** Smallest surface, no Compose change, and an existing behaviour check that a helper container can run unchanged. Its JWT and fallback edge cases need new tests. Do it once the workflow is proven, because Bits purchases go through it.
2. **`dima-hoststats`.** Small, with pure tests that port directly. But its Compose `command` and healthcheck call `node`, so it needs a reviewed Compose change, and it holds the root-equivalent Docker socket. Port it before analytics so the snapshot contract that analytics checks is settled.
3. **`dima-analytics`.** Largest and densest: PostgreSQL schema, partitions and aggregation, Redis consumer semantics, Mongo, Twitch, Qdrant and hoststats. It also needs the same Compose change, and all three of its ops checks import the JS sources, so they must be rewritten. Its batch contract is shared with dimabot's and the Rust cron supervisor's telemetry producers.
