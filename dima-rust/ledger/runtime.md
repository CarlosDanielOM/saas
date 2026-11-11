# Runtime contract of the Node services (dimabot API, bot, cron) — inventory for the Rust port

Generated 2026-11-11 from branch `rust-v2` by read-only analysis. Paths are relative to `dimabot/` unless they start
with another project name. `api` = `dist/server/index.js` (container `dima-server`), `bot` = `dist/bot/index.js`
(`dima-bot`), `cron` = `dist/workers/cron.index.js` (`dima-cron`, TS workers + Rust `cron_index`). Machine-readable
environment data: [`env.json`](env.json).

**Process attribution method.** A static + dynamic import graph (`import … from`, `import()`, `new URL('./x.worker…')`)
was built over the 757 non-test `.ts` files and walked from each entrypoint (`server/index.ts`, `bot/index.ts`,
`workers/cron.index.ts`, every `workers/*.worker.ts`). "Loaded in" means the module is reachable there. It does not mean
every function runs there. Where the difference matters, the text says which process actually runs it.

---

## 0. The three things that matter most

1. **The production secret set does not match what the code reads.** 15 of the 43 names in production `.env` are never
   read anywhere (§1.3), including `JWT_SECRET`, `DB_NAME` and the Dragonfly/Qdrant username/password pairs.
   `EMAIL_AUTH_JWT_SECRET` *is* read but is **unset in production**. Activation-email JWTs are therefore signed and
   verified with the literal `"dev-insecure-do-not-use-in-prod"` (`utils/email/email-activation-token.ts:3-8`). The
   existing Rust helper `dima-rust/src/utils/jwt.rs:65` refuses to run without the variable, so a drop-in port would
   break every outstanding activation link. Decide deliberately: keep the literal for compatibility or rotate it.
   `MOCK_LOGIN_TOKEN` **is set in production**, so `POST /auth/mock-login` is live and returns decrypted Twitch tokens
   (§4.6).
2. **Several byte formats must be reproduced exactly**, and two of them are quirky (§4):
   - The AES-256-CTR key is `SECRET_KEY` right-padded with spaces to 32 characters, IV 16 bytes, hex `{iv, content}`,
     no authentication tag.
   - Polar webhooks use standardwebhooks with key = the raw UTF-8 bytes of the secret.
   - Twitch EventSub uses `sha256=` + hex.
   - Several Dragonfly keys embed the raw bearer token (`token:<twitch access token>`). dima-analytics reads that key too.
3. **Lifecycle is mostly undefined, and Rust must choose deliberately:**
   - API and bot have no signal handlers and no `unhandledRejection` handler. Node 24 default: an unhandled rejection
     crashes the process with exit 1, and Docker `restart: always` restarts it.
   - The bot installs SIGTERM/SIGINT listeners that only flush metrics, which *suppresses* the default exit. A
     `docker stop` therefore always waits the full 10 s and then SIGKILLs (§6.2).
   - Startup is a strict sequence of top-level `await`s with side effects (§6.4).
   - Files are not shared between containers: the cron `clearSpeechFiles` deletes nothing real; the API reacts through
     pub/sub (§3).

---

## 1. Environment variables (summary of env.json)

### 1.1 Coverage

| Source of names | Count |
|---|---|
| Distinct `process.env.NAME` in non-test `src/**/*.ts` (grep `process\.env\.[A-Za-z_][A-Za-z0-9_]*`) | 177 |
| Dynamic `process.env[name]` resolved through call sites: `setting('DOMAIN_EVENTS_*')` ×8 (`workers/domain_events.worker.ts:16-30`), `BILLING_SUCCESS_URL` / `BILLING_RETURN_URL` / `BILLING_PORTAL_RETURN_URL` (`utils/billing.ts:525` via 959/960/1084/1085/1183; `utils/credit_gifts.ts:69` via 141/144) | 11 |
| `env.X` on a `ProcessEnv` parameter: `CRON_WORKER_RESTART_DELAY_MS`, `CRON_WORKER_RUNTIME` (`workers/cron.index.ts:275,277`) | 2 |
| Never read by TS but forwarded to the Rust `cron_index` child (`workers/cron_native_bridge.ts:8-17,42`): TZ, LANG, LC_ALL, SSL_CERT_FILE, SSL_CERT_DIR, 8 proxy variables, 5 `AI_USAGE_RECEIPTS_*` | 18 |
| Written into TS worker children, never read: `CRON_SUPERVISOR`, `CRON_WORKER_NAME` (`workers/cron.index.ts:136`) | 2 |
| **Total recorded in env.json** | **210** |

- **Accesses checked and found absent:** no destructuring of `process.env`; `...process.env` appears only in
  `cron.index.ts:136` (child env); `Object.entries(process.env)` appears only in dimadb.
- **Excluded:** 4 names that appear only in tests: `COMMAND_DEFAULTS_TEST_MONGO_URI`, `DIMA032_TEST_REDIS_URL`, `PIN_OUT`
  and `FOLLOW_DEFENSE_BAN_DELAY_MS`. The last is set by `utils/follow_defense.test.ts:144` but never read by source.
- **The env-object strings in `utils/ai/tools/code_execution.tool.ts`** (`env.CHANNEL_ID`, `env.AUTH_TOKEN`) belong to
  the Deno sandbox's injected `env` object. They are not process environment (§2).
- **Per-variable data:** every consumer site with its code line, read timing (`import` = module-level constant,
  `per-use` = read on each call), the processes that load it, default, parse/clamp, secret flag, production status per
  container, and effect.

### 1.2 Parsing patterns a Rust port must reproduce bit-for-bit

| Pattern (verbatim JS) | Unset or `""` | Non-numeric (e.g. `"abc"`) | Sites |
|---|---|---|---|
| `Math.max(MIN, Number(env.X \|\| DEF))` | DEF | **NaN**: `Math.max` returns NaN, so `setInterval(fn, NaN)` fires every 1 ms and TTLs become NaN | most worker and eventsub settings |
| `Math.max(MIN, Number(env.X) \|\| DEF)` | DEF | DEF (NaN and 0 fall back) | clip recommendation settings, `TWITCH_GOALS_RESYNC_MS`, `OVERLAY_HYPE_RESYNC_MS` |
| `Number(env.X \|\| DEF)` with no clamp | DEF | NaN | `FOLLOW_LEDGER_LOCK_TTL_SECONDS`, `LFM2_EMBEDDINGS_TIMEOUT_MS`, `AI_USAGE_QUEUE_*` |
| `readNumberSetting(raw, def, min)` = `Number(raw ?? def)`; finite ? `max(min, n)` : def | DEF (`""` gives 0, then clamped to min) | DEF | `workers/timer.worker.ts:14-23` |
| `setting(name, def, min, max)` = `Number(env[name] ?? def)`, must be a safe integer within range | DEF (`""` gives 0, which throws when min > 0) | **throws at import**, so the worker crash-loops under the supervisor | `workers/domain_events.worker.ts:15-30` |
| `x !== 'false'` | true | true (only the exact string `false` disables) | `*_RUN_ON_START`, `*_ENABLED`, worker gates |
| `x === 'true'` | false | false | `FOLLOW_LEDGER_RUN_ON_START`, `TIMER_WORKER_RUN_ON_START`, `STREAM_ANALYTICS_INLINE`, `OBSERVABILITY_DISABLED` |
| `x?.toLowerCase() !== 'false'` | true | true | `DOMAIN_EVENTS_WAKEUPS_ENABLED` (`utils/domain_event_wakeups.ts:6`) |
| `Number.isFinite(Number(x)) ? Number(x) : 2` | 2 (unset); **0 for `""`** | 2 | `LFM2_EMBEDDINGS_RETRIES` |
| `x!` (non-null assertion) | the string `"undefined"` reaches the header or URL | — | `CLIENT_ID` headers, `S3_*` |

- **Read timing.** Module-level reads happen once, when the module is first imported. The same name can be read at both
  import and per-use time, for example `SECRET_KEY` (import in `crypto.ts:4-5`; per-use in `dimafx-overlay.service.ts`
  and `telemetry.ts`). env.json lists both.

### 1.3 Set in production, never read by any code (15)

- `User_Token_Auth`, `TWITCH_USERNAME` (=DomDimaBot), `PRODUCTION` (=1), `TEST_CHANNELS` (=cdom201), `UNIX_TOKEN`
- `JWT_SECRET`, `GOOGLE_GEMINI_API_KEY`, `XAI_API_KEY`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`
- `DB_NAME` (=domdimabot): the database name comes from the `MONGO_URI` path
- `DRAGONFLY_USERNAME`, `DRAGONFLY_PASSWORD`: the connection is `redis://HOST:PORT` with no auth
  (`utils/databases/dragonfly.database.ts:40`, `telemetry.ts:181`, `domain_event_wakeups.ts:72`)
- `QDRANT_USERNAME`, `QDRANT_PASSWORD`

These were checked across every `.ts/.mjs/.js/.rs/.yaml` file outside node_modules/dist/target. The only hit is a test
fixture string, `DRAGONFLY_PASSWORD`, in `workers/cron_native_bridge.test.ts`.

### 1.4 Read by code but unset in production, so the default applies

180 names are unset in at least one container that loads them. Most are tuning knobs at their defaults; env.json lists
them all. These are the ones that switch behaviour on or off:

| Variable | Effective production behaviour |
|---|---|
| `EMAIL_AUTH_JWT_SECRET` | Literal fallback secret `dev-insecure-do-not-use-in-prod`, plus `console.warn` on every sign and verify. Used by api and cron:activation-reminder, cron:stream_memory and cron:vod_clip_recommender. |
| `STREAM_ANALYTICS_INLINE` | false: the API does **not** run the stream analytics loop; only the cron worker does (`server/index.ts:116`). |
| `FREE_CREDIT_RESET_ENABLED`, `AI_USAGE_BACKFILL_ENABLED` | true: both TS workers are spawned by the cron host. |
| `EVENTSUB_RECONCILIATION_ENABLED` | **Set to `false`**: the worker is never spawned (`cron.index.ts:168`). |
| `AI_USAGE_RECEIPTS_ENABLED` (Rust) | Unset, so `dima-rust/src/supervisor/registry.rs:165-168` enables it (only `"false"` disables). |
| `DOMAIN_EVENTS_WAKEUPS_ENABLED` | true: pub/sub wakeups are on. |
| `OBSERVABILITY_DISABLED` | false: in-process telemetry is on in all processes (it also needs `DRAGONFLY_HOST`, which is set). |
| `PIPER_HTTP_URL` | Set only for **api**. In bot and cron the Piper provider would spawn `python3 -m piper`, which is not installed in the image (only `yt-dlp` is pip-installed), so it would return an error. In practice only the API synthesizes speech. |
| `BILLING_ALLOWED_REDIRECT_HOSTS` | Subscription checkout and portal accept **any host** for user-supplied success/return URLs (`billing.ts:536-538`). Credit gifts fall back to `domdimabot.com,www.domdimabot.com` and https only (`credit_gifts.ts:72-73`). |
| `BILLING_SUCCESS_URL` / `BILLING_RETURN_URL` / `BILLING_PORTAL_RETURN_URL` | Billing fallback is `null`. Credit-gift fallback is `https://domdimabot.com`. |
| `POLARSH_WINBACK/UPGRADE/CHANGE_DISCOUNT_ID` | No scenario discounts. `POLARSH_REFERRAL_DISCOUNT_ID` *is* set. |
| `POLARSH_API_BASE_URL`, `POLARSH_ENVIRONMENT` | `https://api.polar.sh`. |
| `S3_ENDPOINT_URL`, `S3_PUBLIC_URL` | Endpoint `https://{S3_REGION}.{S3_ENDPOINT}` with virtual-host style; public URL `https://{S3_BUCKET}.{S3_REGION}.{S3_ENDPOINT}`. |
| `INTERNAL_API_URL` (api, cron) | `NODE_ENV==='production'`, so `http://dima-server:3000`. |
| `PUBLIC_API_URL` (cron) | `https://api.domdimabot.com`. |
| `MOCK_LOGIN_TWITCH_ID` | Mock login targets the numeric suffix of the token after its last `-`. |
| `DIMAFX_SKU_MAP` | `DEFAULT_SKU_MAP` in `server/services/dimafx.service.ts`. |
| `CLIP_RECOMMENDATION_MODEL_ID` | `meta/muse-spark-1.2-contributor`. |
| `ENVIRONMENT` | No effect in production. Only `utils/dev.ts:getUrl()` reads it, and only when `NODE_ENV!=='production'` and `INTERNAL_API_URL` is unset. |
| `EMAIL_FROM`, `ACTIVATION_URL`, `DASHBOARD_URL`, `EMAIL_AUTH_BASE_URL`, `DOCS_ASSISTANT_SOURCE_URL`, `OPENROUTER_BASE_URL`, `MINIMAX_BASE_URL`, `LFM2_*` (these are set) | Hardcoded production defaults; see env.json. |

### 1.5 Behaviour that differs by `NODE_ENV` / `ENVIRONMENT` / `PRODUCTION`

- **`PRODUCTION` is never read.**
- **`NODE_ENV`** comes from the image `ENV NODE_ENV=production` (dockerfile `ARG NODE_ENV=production`), not from compose
  `environment`. It affects:
  1. dotenv loads `.env.local` first when not production (§1.6);
  2. internal API fallback `http://dima-server:3000` vs `getUrl()` (`functions/chats/speech.chat.ts:38-39`,
     `control_tts.chat.ts:12,30`, `utils/ast_parser/functions/overlay.functions.ts:25`);
  3. Piper public URL fallback `https://api.domdimabot.com` vs `http://localhost:3000`
     (`server/services/tts/piper_tts.service.ts:40`);
  4. the startup log in `bot/index.ts:24` and the config dumps in workers.
- **`ENVIRONMENT`**: `utils/dev.ts:1-12`. `getUrl()` returns `https://api.domdimabot.com` only when
  `ENVIRONMENT==='production'`; otherwise `http://localhost:3000`. `getApiUrl()` is hardcoded to production. The
  `test-bot` npm script sets `ENVIRONMENT=test`; nothing else reads it.
- **Telemetry service name** is derived from `process.argv[1]`, not from env: path contains `/workers/` gives `cron`,
  `/bot/` gives `bot`, otherwise `api` (`utils/observability/telemetry.ts:24`).

### 1.6 dotenv loading order

- **Not production.** Each entrypoint calls `dotenv.config({path: cwd/.env.local})` then `dotenv.config({path: cwd/.env})`.
  dotenv never overrides existing variables, so precedence is real env > `.env.local` > `.env`. Sites:
  `server/index.ts:7-11`, `bot/index.ts:25-30`, `workers/cron.index.ts:347-348`, and every `workers/*.worker.ts`
  (lines 2-11). `follow_defense_actions.worker.ts:1-2` uses `dotenv.config()` (cwd `.env` only). goals, duel, widgets,
  credit_gifts and roulette-actions use `import 'dotenv/config'` as their first import. `classes/twitch_streamers.class.ts:1`
  also imports `dotenv/config`, so any process loading it reads cwd `.env` at that point in the import order.
- **Production.** No `.env` file exists inside the image, because `dimabot/.dockerignore` excludes `.env*`. All values
  come from compose `env_file: .env`, compose `environment`, and the image `ENV`.
- **ESM hoisting caveat.** `server/index.ts` and `bot/index.ts` call dotenv *after* all their static imports have run.
  Every import-time env read in imported modules (e.g. `utils/crypto.ts:4`, `utils/s3.ts:6-16`,
  `utils/email/email.service.ts:13-22`, the LFM2 constants) therefore sees only the real process environment. In local
  dev, putting `SECRET_KEY` only in `.env` still crashes at import, unless `twitch_streamers.class.ts` (with its
  `dotenv/config`) happens to be evaluated first in the graph. A Rust port should load the environment once, before
  anything else.

---

## 2. Child processes and worker threads

All `spawn`/`exec`/`execFile`/`fork`/`Worker` sites in non-test source. Scripts under `src/scripts` are manual CLIs.

| # | File:line | Process | Binary and argument template | I/O protocol | Timeout and kill | cwd and env |
|---|---|---|---|---|---|---|
| 1 | `utils/video.ts:29-30` (`downloadClip`), called by `handlers/clip_queue.handler.ts:174` | api | **Shell string**: `yt-dlp --no-progress -S "res:480" -o "${cwd}/dist/server/routes/public/downloads/${channelID}-clip.mp4" "${clipUrl}"`, run via `exec` (`/bin/sh -c`). The URL is interpolated inside double quotes (shell-injection surface). | stdout and stderr accumulated without a bound, logged on failure; exit 0 plus the file existing means success | 60 s `setTimeout`, then `kill()` (SIGTERM) and resolve with an error. The clip-level safety timeout is (`twitch:{ch}:clips:timeouts:default` or 60) + 65 s (`clip_queue.handler.ts:150-164`). | inherited |
| 2 | `overlays/test-playback.ts:53` | api | `execFile('yt-dlp', ['--no-playlist','--no-progress','--max-filesize','100M','-S','res:480','-o', <mkdtemp overlay-test-*/clip.mp4>, '--', url])`; the URL must be https on host `clips.twitch.tv`, `www.twitch.tv` or `twitch.tv` | buffered, `maxBuffer` 1 MiB | `timeout` 60000 (SIGTERM); the directory is removed on failure | inherited |
| 3 | `utils/ai/clip_recommendations/vod_clip_recommendation_runner.ts:110-134` (`runCommand`) | cron:vod_clip_recommender (the module is also reachable in api) | `yt-dlp --no-progress -S res:720 -o <tmp>/clip-recommendations-<uuid>/vod.mp4 <vodUrl>` (line 138); `ffmpeg -y -ss <int s> -i vod.mp4 -t <int s> -vn -ac 1 -ar 16000 -b:a 12k segment-N.mp3` (142-152); `ffmpeg -y -ss <s> -i vod.mp4 -t <5..60> -c:v libx264 -preset veryfast -c:a aac -movflags +faststart candidate-cN.mp4` (157-168) | stdio `['ignore','pipe','pipe']`, unbounded accumulation; the error message keeps the last 4000 chars of stderr and last 1000 of stdout | yt-dlp: `CLIP_RECOMMENDATION_DOWNLOAD_TIMEOUT_MS` (default 3 h, min 60 s); ffmpeg: `CLIP_RECOMMENDATION_FFMPEG_TIMEOUT_MS` (default 30 min). On timeout: `kill('SIGKILL')` and reject. | inherited |
| 4 | `utils/thumbnail_generator.ts:12-23,92` | api | Video: `ffmpeg -y -ss 00:00:01 -i <tmp>/dima-in-<12hex> -vframes 1 -vf scale=480:-1 -q:v 5 <tmp>/dima-out-<12hex>.jpg`. Image/GIF: the same without `-ss`/`-vframes`. | `execFile`, `maxBuffer` 8 MiB; output must be ≥256 bytes | `timeout` 30000; concurrency capped by `pLimit(2)` | inherited |
| 5 | `pets/tts_envelope.ts:36` | api (pets, desktop AI, read TTS) | `ffmpeg -nostdin -v error -protocol_whitelist file,pipe -i <file> -map 0:a:0 -vn -t 60 -f f32le pipe:1` | **stdout = raw little-endian float32 PCM, interleaved**, `encoding:'buffer'`; `maxBuffer = min(64 MiB, sampleRate*channels*60*4) + 4096` | `timeout` 5000, AbortSignal | inherited |
| 6 | `pets/tts_envelope.ts:52` | api | `ffprobe -v error -protocol_whitelist file -select_streams a:0 -show_entries format=duration:stream=sample_rate,channels -of json <file>`; file must be ≤8,000,000 bytes, duration in (0, 60 s] | JSON on stdout, `maxBuffer` 4096 | 5000 ms, signal | inherited |
| 7 | `pets/runtime.ts:253`, `desktop_ai/execution.ts:186` | api | `ffprobe -v error -protocol_whitelist file -show_entries format=duration -of json <audioPath>` | JSON, `maxBuffer` 4096 | 5000 ms | inherited |
| 8 | `assets/library.ts:105` (audio), `:113` (image/video) | api (any process that uploads an asset; in practice api, including custom-widget media copy) | Audio: `ffprobe -v error -protocol_whitelist file -show_entries stream=codec_type,codec_name:format=duration -of json <path>`. Visual: `ffprobe -v error -protocol_whitelist file -select_streams v:0 -show_entries stream=width,height,codec_name -of json <path>`. | JSON, `maxBuffer` 65536 | 10000 ms | inherited |
| 9 | `server/services/tts/piper_tts.service.ts:60-105` | api in practice (the module is reachable in bot and cron) | Only when `PIPER_HTTP_URL` is unset: `${PIPER_PYTHON_BIN:-python3} -m piper -m <voice> -f <outputPath> [--data-dir <PIPER_DATA_DIR>] -- <text>` | stdio `['ignore','ignore','pipe']`; stderr tail of 4096 chars is the error message | `spawn` option `timeout: 30000` plus the request AbortSignal | inherited |
| 10 | `utils/ai/sandbox/execute_sandbox.ai.ts:105-113` | api, bot (AI code-execution tool) | `deno run --no-prompt --allow-net --no-allow-read --no-allow-write --no-allow-env -` | Script on **stdin**: `const env = { K: "v", … }` (values `String(v)` with `"` escaped as `\"`; nothing else is escaped), then an async IIFE wrapping the AI code. The result is `console.log(JSON.stringify(__result))` when the return value is not undefined; runtime errors are `console.error("RUNTIME_ERROR: " + msg)`. Parent logic: if the combined output contains `RUNTIME_ERROR:` → `{error}`; else if exit≠0 and no output → `{error:"Script crashed (Exit Code N)"}`; else if the output parses as JSON → raw; else `{status:"done", logs}`. | 8000 ms default timer, then `kill()` (SIGTERM) → `{error:"Execution Timed Out"}`. The timer is never cleared after exit (harmless). Concurrency: `pLimit(25)`. | Injected env: `CHANNEL_ID`, `CHANNEL_NAME`, `AUTH_TOKEN` = the streamer's **bot_token** (`code_execution.tool.ts:383-387`). |
| 11 | `utils/domain_event_execution.ts:62-68` | cron:domain_events | `fork(<domain_events.worker.js>, ['--consumer=<id>', ('--once')], {execArgv: process.execArgv, stdio: ['ignore','inherit','inherit','ipc']})` | IPC messages child→parent: `claimed{lease{lockedUntil,leaseToken}}`, `renewed{lease}`, `finished`, `drained`, `polling`, `draining`, `beforeClaim`. Parent→child: `{type:'wake'}`. | Supervisor `tick()` every 100 ms; a slot is SIGTERMed (`:252`) when the operation, execution, lease or shutdown deadline passes | inherited env |
| 12 | `workers/cron.index.ts:130-137,195` | cron host | `process.execPath <dist>/workers/<name>.worker.js [--dry-run] [--once]` (or `tsx <src path>`) for the 19 TS workers in `WORKERS` (`cron.index.ts:39-127`; 18 spawned in production because eventsub-reconciliation is disabled) | `stdio: 'inherit'`; env = all of `process.env` plus `CRON_SUPERVISOR=true` and `CRON_WORKER_NAME` | Restart after `CRON_WORKER_RESTART_DELAY_MS` (≥1000, default 5000). Shutdown: SIGTERM, up to 25 s, then SIGKILL. | cwd inherited (/app) |
| 13 | `workers/cron_native_bridge.ts:39-48,77` | cron host | `/usr/local/bin/cron_index [--dry-run] [--once]` (Rust), `detached: true` (own process group) | `stdio ['ignore','inherit','inherit']`; env = allow-list `NATIVE_INDEX_ENV_KEYS` only; runs as uid/gid 65534 when the parent is root | Shutdown: SIGTERM to the process group, 28 s grace (`NATIVE_BRIDGE_SHUTDOWN_MS`) | — |
| 14 | `utils/observability/native_worker_metrics.ts:176` | none (not reachable from any entrypoint; used by `ops/checks/dashboard-activity-rust.mjs`) | `getconf CLK_TCK` | stdout integer, `maxBuffer` 128 | 1000 ms; env `{PATH}` only | — |
| 15 | `scripts/backup_full_database.script.ts:52` | manual script | `mongodump --uri=$MONGO_URI …` | — | — | — |

**Worker thread — pet mouth curves** (`pets/mouth_analysis.ts:58-91`, `pets/mouth_curves.worker.ts`), api:
- **Admission.** `MouthAnalysisQueue` runs at most 2 analyses at once with 8 queued; a queued job times out after 20 s.
  Each slot decodes with ffmpeg (#5) and then starts one short-lived `Worker`.
- **Worker options.** `new Worker(url, {workerData: {pcm: ArrayBuffer, sampleRate, channels}, transferList: [pcm],
  env: {}, execArgv: [], resourceLimits: {maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2}})`.
  The PCM buffer is transferred, not copied, unless it is pooled or sliced.
- **Input validation.** channels 1..32; sampleRate 8000..192000; length is a multiple of 4·channels; at most 64 MiB; at
  most 60 s of frames.
- **Protocol.** The worker posts exactly one message: `{ok:true, curves}` or `{ok:false, error:<≤80 chars>}`. Then
  `parentPort.close()`.
- **Parent.** A 5 s timeout (`mouth_analysis_timeout`) plus abort. Always `await worker.terminate()` before releasing
  the slot. An early exit rejects with `mouth_analysis_exit_<code>`.
- **Computation** is `computeMouthCurvesFromSamples` in `pets/mouth_curves.ts`; samples are read with `readFloatLE`.

**Runtime binaries the image must provide** (`dimabot/dockerfile`):
- `ffmpeg`/`ffprobe` (apk);
- `yt-dlp` (pip3, unpinned);
- `deno` (`COPY --from=denoland/deno:bin`, unpinned tag);
- `python3` (apk; there is no piper package in this image);
- `/usr/local/bin/cron_index` and 7 other Rust binaries (only when `.saas-native` is staged);
- `node` (base image `node:24-alpine`).

---

## 3. Filesystem

Containers do **not** share a volume. dima-server, dima-bot and dima-cron each have a private copy-on-write filesystem
of the image (`dimabot/docker-compose.yaml`). Only `piper-tts` (`piper-data:/voices`) and `lfm2.5-embeddings`
(`/data`) have volumes. Anything written by one Node process is invisible to the others; cross-process hand-off goes
through Dragonfly, MongoDB/GridFS or S3. The public directory is
`/app/dist/server/routes/public` (dockerfile copies `src/server/routes/public/` there; the comment says the API runs
as root and creates generated speech beneath it).

| Path | Written by (file:line) | Read or served by | Deleted by | Limits | Process |
|---|---|---|---|---|---|
| `dist/server/routes/public/**` static (`clip.html`, `dimafx.html`, `dimafx-player.js`, `furry.html`, `speach.html`, `speech.html`, `sumimetro.html`, `trigger.html`, `assets/`) | build (dockerfile `COPY`) | `express.static` `server/server.ts:73`; `sendFile` in `routes/overlay.route.ts:12,22,28,47`, `routes/clip.route.ts:23,26`, `routes/speech.route.ts:371` | — | — | api |
| `public/speech/<channelID>/<speechID>.wav` (Piper), `.mp3` (Kokoro, Fish) | `piper_tts.service.ts:49-57,145-147`; `kokoro_tts.service.ts:45-49`; `fish_tts.service.ts:30-33,112,137`. Overlay TTS test writes `overlay-test-<uuid>.wav` (`overlays/test-playback.ts:40`); voice preview writes `preview-<uuid>.*` (`voice_preview.service.ts:114-123`). | `speech.route.ts:351` `sendFile(audioPath)`; URL `${PUBLIC_API_URL}/speech/audio/<ch>/<id>` | Per-file timer 120 s after playback (`handlers/tts_queue.handler.ts:1336-1358`); whole channel dir `rm -r` on queue clear (`:1305-1331`); DimaFX TTS files unlinked 120 s after end (`handlers/dimafx_queue.handler.ts:337-347`); preview `rm` in finally (`voice_preview.service.ts:145`); overlay test via `cleanup()`. `utils/speech.ts:15-37` `clearSpeechFiles` deletes files observed before a session boundary, but it runs in **cron** (stream offline, via domain_events / stream_analytics), where the directory is empty. The real effect is the pub/sub `tts:session-ended:v1` that the API handles (`server/index.ts:99-102`). | `maxAudioBytes` per request: 8,000,000 for pet and desktop | api |
| `public/downloads/<channelID>-clip.mp4` | `utils/video.ts:18-30` (yt-dlp), dir created with `mkdirSync` | `routes/file.route.ts:9-64` (range requests via `createReadStream`, else `sendFile`); also copied to GridFS (`publishStudioMedia`) | `deleteOldClip` before the next download (`video.ts:114-132`); one file per channel, overwritten | — | api |
| `os.tmpdir()/dimabot-trigger-uploads/<ms>-<6 base36><ext>` | multer diskStorage `routes/trigger.route.ts:83-85,482-495`; dir created **at import** (`mkdirSync`) | streamed to S3 `trigger.route.ts:569` | `unlink` in finally `:647` | `fileSize = getPlanUploadLimitBytes(plan)`; mime filter | api (created at import in every process that loads the route: api) |
| `tmp/design-asset-XXXXXX/<file>` | multer custom storage `routes/asset-library.route.ts:61-71` (`createWriteStream` `wx`) | `assets/library.ts:140` streams to S3 | `rm -r` `asset-library.route.ts:84` | 50,000,000 bytes (`MAX_ASSET_BYTES`), 1 file, 0 fields, 2 parts; at most 4 concurrent uploads globally, 1 per owner | api |
| `tmp/widget-media-XXXXXX/<n>` | `custom_widgets/media.ts:95,108` | `uploadAsset` | per file and per directory `rm` (`:121,123`) | 50 MB each, 120 s fetch | api |
| `tmp/dima-in-<12hex>`, `tmp/dima-out-<12hex>.jpg` | `utils/thumbnail_generator.ts:69-83` | ffmpeg (#4) | `unlink` in finally `:160-161` | input ≤200 MiB by declared content-length | api |
| `tmp/clip-recommendations-<uuid>/{vod.mp4, segment-N.mp3, candidate-cN.mp4}` | `vod_clip_recommendation_runner.ts:418,605-606,623,703` | ffmpeg; uploaded to S3 `clip-recommendations/<ch>/<rec>/<cand>.mp4` `:170-179`; `openrouter_clip_recommendations.client.ts:270` reads audio | segments unlinked `:643`; dir `rm -r` in finally `:892` | VOD size is unbounded (720p) | cron:vod_clip_recommender |
| `tmp/overlay-test-XXXXXX/clip.mp4` | yt-dlp (#2) | GridFS copy | `rm -r` | 100 MB (`MAX_MEDIA_BYTES`) | api |
| `tmp/dima-pet-XXXXXX/speech.{wav,mp3}` | `pets/runtime.ts:239-245`, `pets/read_tts.ts:333` | `routes/pet.route.ts:56` (stream, ticket-gated), path persisted in Mongo `PetRequest.privateDir/audio.path` | finally `rm`; `cleanAudio` only removes dirs whose parent is `tmpdir()` and whose name starts with `dima-pet-` (`runtime.ts:295-300`, `read_tts.ts:190`) | 8,000,000 bytes, ≤60 s | api |
| `tmp/dima-desktop-ai-XXXXXX/speech.{wav,mp3}` | `desktop_ai/execution.ts:166-176` | `server/oauth/routes.ts:214` `sendFile`, path stored in `DesktopAiTurn.speech.privateDir/path` | finally `rm`; expiry cleanup `desktop_ai/service.ts:39-43` (`safeSpeechDirectory`) | 8,000,000 bytes, ≤60 s | api |
| GridFS bucket `overlay_media` (MongoDB) | `overlays/delivery-store.ts:20-26` (`retainFile` copies a local file) | `readFileStream` (range) | `sweepFiles` every ≥15 s from the overlay live loop (`overlays/live.ts:739-748`); `metadata.expiresAt` = now + 30 min | ≤100 MiB per file, 512 MiB per channel, 200 pending | api |
| `/app/src/utils/ai/sandbox/doc-llm.txt`, `doc-ast.txt` | image (`COPY . .`) | `readFileSync(path.join(process.cwd(), 'src/…'))` `code_execution.tool.ts:101,110` on every prompt build | — | — | api, bot (wherever the tool runs). **Depends on `src/` existing at runtime.** |
| arbitrary file under `/home/cdom/saas/dimabot` or `/home/cdom/saas/admin` | — | admin route `routes/admin-tools.route.ts:20-45` → `utils/fs.ts:6` (`MAX_FILE_SIZE` 1 MiB) | — | 1 MiB | api (the allowed roots do not exist in the container) |
| `/proc/<pid>/stat`, `/proc/<pid>/status` | — | `native_worker_metrics.ts:160-170` | — | bounded read | unreachable |
| `.env`, `.env.local` (cwd) | — | dotenv (§1.6) | — | — | all (absent in production) |

---

## 4. Cryptography, tokens, identifiers

### 4.1 Stored-secret cipher: `utils/crypto.ts`

- **Algorithm.** `aes-256-ctr`, no MAC.
- **Key.** `Buffer.from(SECRET_KEY.padEnd(32), 'utf-8')`: the JS string is right-padded with U+0020 to 32 UTF-16 code
  units, then UTF-8 encoded. If `SECRET_KEY` is longer than 32 bytes after encoding (or contains non-ASCII that expands
  past 32 bytes), `createCipheriv` throws `Invalid key length` on first use. The module **throws at import** if the
  variable is unset (`:4`).
- **IV.** `randomBytes(16)`, used as the full 128-bit initial counter block (big-endian increment, OpenSSL CTR).
- **Stored value.** `{ iv: <32 lowercase hex>, content: <hex ciphertext, same length as UTF-8 plaintext> }`. An empty
  plaintext gives `{iv:'', content:''}`. Decrypt returns `null` when `iv` or `content` is empty; otherwise UTF-8
  `toString()`.
- **Consumers:**
  - `users.accounts[].access_token` / `refresh_token`: `auth.route.ts:476-477,1058-1059`, `utils/tokens.ts:140-141,385-386`;
    decrypt at `classes/twitch_streamers.class.ts:136-137,430-431` and `auth.route.ts:1215-1216`.
  - Overlay tokens: `utils/overlay-token.ts:15,19`. Used for duel, roulette, widgets, pets and overlay studio documents
    with fields `tokenHash` and `overlayToken`.

### 4.2 Hashes stored as lookup keys (must match byte for byte)

| Value | Format | Site |
|---|---|---|
| Overlay/capability token | `randomBytes(32).toString('base64url')` (43 chars, regex `^[\w-]{43}$`); stored `tokenHash = sha256(token).hex` plus encrypted copy | `utils/overlay-token.ts:14,45`; `pets/tokens.ts:28` (`PetRuntime.tokenHash`) |
| Duel / widgets / roulette socket auth | `sha256(handshake.auth.token).hex` compared with `doc.tokenHash` | `duel/service.ts:18`, `widgets/service.ts:19`, `roulette/service.ts:22`, `server/services/{roulette,widgets}-overlay.service.ts:18-19` |
| Pet audio ticket | `randomBytes(32).base64url`; Redis `pet:audio:<sha256hex(ticket)>` = JSON, `EX 5` | `pets/tokens.ts:34-38` |
| Overlay studio scene `publicId` | `randomBytes(24).toString('hex')` (48 hex) | `overlays/store.ts:18` |
| Overlay test ticket | `randomBytes(24).hex` | `overlays/test-playback.ts:65` |
| Voice preview ticket | `randomBytes(32).hex`; Redis `tts:preview:ticket:<ticket>` = channelID, `EX 30` | `server/services/tts/voice_preview.service.ts:39-43` |
| Desktop AI speech ticket | `randomBytes(32).base64url`; stored `sha256(ticket).base64url` | `desktop_ai/service.ts:68-69` |
| OAuth (desktop beta) | §4.4 | `server/oauth/service.ts` |
| Rate-limit key | `ratelimit:<scope>:<sha256(subject).base64url>` | `utils/rate_limit.ts:16` |
| Billing context cache | `billing:credit-packs:context:v1:<sha256(customerId).hex[0:20]>` | `utils/billing.ts:362-363` |
| Credit gift id | `sha256("<userId>:<requestId lowercased>").hex`, must match `^[a-f0-9]{64}$` | `utils/credit_gifts.ts:140,61` |
| Many idempotency/receipt ids | `sha256(JSON.stringify([...])).hex` (JS `JSON.stringify` canonical form: no spaces, insertion order) | `goals/service.ts:36-37,208,245`; `utils/moderation/{decisions.ts:7, spam.ts:92, variations.ts:20,164, variation_jobs.ts:38}`; `utils/{raid_analytics.ts:20, raid_sessions.ts:17, stream_activity.ts:8, dashboard_activity.ts:8, follow_defense_actions.ts:21, ai_usage_lock.ts:5, ai_usage_queries.ts:39, ai_usage_dashboard.ts:94, ai_usage_receipts.ts:837-839, ai_usage_queue_health.ts:21,27}`; `utils/ast_parser/effects.ts:58,68,83`; `domain_events/{polar_entitlements.ts:44, goal_custom_events.ts:25}`; `desktop_ai/input.ts:19`; `overlays/recover.ts:11`; `pets/admission.ts:46`; `custom_widgets/files.ts:19,41` (content sha256); `site_agent/**` |
| Follow-defense log `_id` | `ObjectId(sha256(identity).hex[0:24])` | `utils/follow_defense.ts:303` |
| Qdrant point id | `parseInt(md5("<ns>:<entityID>:<timestamp>").hex[0:8], 16)` (u32) | `utils/qdrant/qdrant_point_id.ts:3-8` |
| Memory digest | sha256 hex | `utils/ai/memory/memory.service.ts:64` |
| Catalog digests | `sha256(JSON).hex[0:12]` / `[0:24]` | `utils/ai/ast_catalog/build_catalog.ts:9`, `index.ts:52` |

### 4.3 HMAC and webhook verification

- **Twitch EventSub** (bot, express on **port 3333**, `bot/eventsub.twitch.ts:22`):
  - Message: `HMAC-SHA256(key=TWITCH_EVENTSUB_SECRET as UTF-8, msg = messageId ‖ timestamp ‖ rawBody)` where messageId
    and timestamp come from the `Twitch-Eventsub-Message-Id` and `Twitch-Eventsub-Message-Timestamp` headers.
  - Expected value: `"sha256=" + hex` (`:76-77,112,280-286`). Compared with `timingSafeEqual` after an equal-length
    check (`:288-293`). Raw body via `express.raw({type:'application/json'})`.
  - Replay protection: dedupe TTL `TWITCH_EVENTSUB_MESSAGE_TTL_SECONDS`; max age 10 min, or 24 h for durable retries
    (`:16-20,29-38`).
- **Polar webhooks** (api, `server/routes/webhooks/polarsh.webhook.ts`):
  - `@polar-sh/sdk` 0.42.5 `validateEvent` calls `new Webhook(base64(utf8(POLARSH_WEBHOOK_SECRET)))` from
    standardwebhooks 1.0.0, so the HMAC key is the **raw UTF-8 bytes of the secret** (no `whsec_` decoding).
  - Signed content: `${webhook-id}.${webhook-timestamp}.${body}`. Header `webhook-signature` holds space-separated
    `v1,<base64 sig>` entries. Timestamp tolerance ±300 s.
  - Responses: 403 on `WebhookVerificationError`; 500 when the secret is unset; 202 after ingest.
- **DimaFX overlay token** (api, `server/services/dimafx-overlay.service.ts:5-13`): `HMAC-SHA256(SECRET_KEY,
  "dimafx-overlay:" + channelID).hex`. Verified with `/^[a-f0-9]{64}$/` and `timingSafeEqual` on the hex-decoded bytes.
  URL: `${PUBLIC_API_URL}/overlays/dimafx/<ch>?token=…`.
- **Traceparent signature** (all processes, `utils/observability/telemetry.ts:120-125,160-164`): when calling the
  internal API (hostname `dima-server` or `127.0.0.1`), send `traceparent: 00-<32hex>-<16hex>-<01|00>` and
  `x-observability-signature: HMAC-SHA256(SECRET_KEY, traceparent).hex`. The API trusts incoming trace context only when
  that signature matches (length check plus `timingSafeEqual`).
- **DimaFX service token** (api `server/routes/dimafx.route.ts:248-266`): `x-dimafx-service-token` header or
  `Bearer`, compared with `!==` against `DIMAFX_SERVICE_TOKEN`. **Not constant-time.**
- **DimaFX Twitch Extension JWT** (dimafx-server, `dimafx/server/src/middleware/twitch-extension-auth.ts:25-89`):
  - HS256 only, checked by hand. Candidate keys: `TWITCH_EXTENSION_SECRET` decoded as base64, then as base64url, then
    raw UTF-8 (deduplicated); any match is accepted, using `timingSafeEqual` on raw signature bytes.
  - `exp` is checked only if present. Token comes from `Authorization: Bearer` or `x-extension-jwt`.
  - `DIMAFX_ALLOW_UNVERIFIED_TWITCH_JWT==='true'` with no secret skips verification entirely.

### 4.4 JWT and OAuth

- **Activation email JWT** (`utils/email/email-activation-token.ts`), jsonwebtoken 9.0.3:
  - `jwt.sign({sub:<Mongo user _id>, login:<twitch login>}, secret, {expiresIn:'1h'})`, so HS256 (the default) with
    `iat` and `exp`.
  - `jwt.verify(token, secret)` with **no `algorithms` option**: jsonwebtoken 9 defaults to the HS family for a string
    secret.
  - Secret: `EMAIL_AUTH_JWT_SECRET` or the literal `"dev-insecure-do-not-use-in-prod"` (the production reality, §0).
  - Signed in api and cron (email.service is used by activation-reminder, stream_memory and vod_clip_recommender);
    verified in api (`/email/auth`).
- **Asset-library preview ticket** (api, `server/routes/asset-library.route.ts:25-33,48`):
  - `jwt.sign({owner:<channelID>}, SECRET_KEY, {algorithm:'HS256', audience:'asset-preview', subject:<assetId>,
    expiresIn: '12h' | '15m'})`. 12 h applies to custom-widget media.
  - Verify with `algorithms:['HS256'], audience:'asset-preview'`, plus `sub === :id` and `typeof owner === 'string'`.
- **There are no app session JWTs.** Dashboard "sessions" are the user's **Twitch access token** used as a bearer
  (`middleware/auth.middleware.ts`):
  1. Cache lookup `token:<raw token>` (hash fields `id`, `login`, `display_name`, `profile_image_url`, TTL 14000 s).
  2. On miss: `GET https://id.twitch.tv/oauth2/validate`, then Helix `/users` with `Client-Id`.
  3. Activity touch key `twitch:<id>:last_app_activity_touch`, 24 h.

  The raw token is the Redis key. dima-analytics reads the same `token:<token>` hash (`dima-analytics/src/index.mjs:36`).
- **OAuth 2 server for Dima Desktop** (api, `server/oauth/service.ts`, constants in `server/oauth/catalog.ts:17-22`):
  - `secret(prefix) = prefix + randomBytes(32).base64url` (43 chars plus prefix). Access tokens use `dima_at_`, refresh
    tokens `dima_rt_`; authorization request ids and codes have no prefix.
  - `hash(v) = sha256(v).base64url`.
  - Redis keys:
    - `oauth:request:<hash(id)>`, `EX 600`
    - `oauth:code:<hash(code)>`, `EX 60`, consumed with `GETDEL`
    - `oauth:access:<hash(access)>` = JSON identity, `EX 600`
    - `oauth:rate:<hash(bucket)>`, a Lua INCR+EXPIRE 60 counter
  - Mongo: `OAuthRefreshToken.token_hash = hash(refresh)`; `OAuthSession.current_refresh_hash`. Refresh idle window
    30 days, absolute 90 days.
  - PKCE is S256 only. The stored `code_challenge` (43 chars) is compared with `timingSafeEqual(hash(code_verifier),
    challenge)` (`:116-118`); the verifier must match `^[A-Za-z0-9._~-]{43,128}$`.
  - The browser approval step validates a fresh Twitch token whose `client_id === CLIENT_ID` (`server/oauth/routes.ts:46-60`).
  - Client `dima-desktop` is upserted at startup (`initializeOAuth`, `service.ts:26-36`) with redirect URIs
    `http://127.0.0.1/oauth/callback` and `http://[::1]/oauth/callback`.
- **Mock login** (api, `server/routes/auth.route.ts:351-360,1168-1265`): `timingSafeEqual` with an equal-length dummy
  compare on mismatch.

### 4.5 Random identifiers

| Generator | Format | Sites |
|---|---|---|
| `randomUUID()` (v4) | 161 call sites. Notable: lock values (`classes/twitch_streamers.class.ts:210`), usage request/entry ids (`handlers/tts_queue.handler.ts:238-378`), queue owners (`handlers/dimafx_queue.handler.ts:76`), clip recommendation id (`vod_clip_recommendation_runner.ts:417`), telemetry instance (`telemetry.ts:22`), domain-event lease tokens. The full list can be regenerated with `grep -rn randomUUID src`. | — |
| "UUIDv7" (hand-rolled, **not RFC-compliant**: variant bits are not set) | `hex(Date.now()).padStart(12)` sliced as `tttttttt-tttt-7` + 3 hex + `-` + 4 hex + `-` + 12 hex from `randomBytes(5)`/`randomBytes(6)` | `utils/ai/openrouter/ai.ts:58-69` |
| `randomBytes(6).hex` | `rule-<12hex>` bits-rule id | `server/routes/bits-rules.route.ts:47`, `site_agent/tools/write/settings/bits_rules.ts:91` |
| `randomBytes(6).hex` | media library hash id | `server/services/media_library.service.ts:105` |
| `randomBytes(8).hex` | `library/thumbnails/<16hex>.jpg` S3 key | `utils/thumbnail_generator.ts:102` |
| `randomBytes(16).hex` / `(8).hex` | trace id / span id | `telemetry.ts:27-28` |
| `Date.now() + '-' + Math.random().toString(36).substring(2,6)` | logger key suffix (not crypto) | `utils/logger.ts:37-41` |
| `Date.now()-<6 base36>` | multer temp filename | `routes/trigger.route.ts:486` |
| `randomInt` | game logic: duel rolls, widget picks/shuffle/weights, voice preview phrase | `duel/model.ts:135,231,238`; `widgets/model.ts:33-34,143,171`; `widgets/event-model.ts:79`; `voice_preview.service.ts:33` |
| roulette unbiased draw | `randomBytes(7)` → `(b[0]&31)·2^48 + readUIntBE(1,6)` (53-bit), rejection sampling against `limit` | `roulette/model.ts:60` |
| `Math.random()` | trace sampling 1% (`telemetry.ts:73,78`) | — |

### 4.6 Timing-safe comparisons (complete list)

| Comparison | Site |
|---|---|
| EventSub signature | `bot/eventsub.twitch.ts:292` |
| DimaFX overlay token | `server/services/dimafx-overlay.service.ts:12` |
| Mock login token | `server/routes/auth.route.ts:354,358` |
| OAuth PKCE | `server/oauth/service.ts:117` |
| Traceparent signature | `utils/observability/telemetry.ts:125` |
| Extension JWT | dimafx-server `twitch-extension-auth.ts:79` |
| dimadb store | `dimadb/server/store.mjs:55` |

Non-constant-time equality is used for `DIMAFX_SERVICE_TOKEN` (`dimafx.route.ts:261`) and for all `tokenHash` string
compares (hash vs hash, acceptable).

### 4.7 Other projects

- **dimadb store cipher** (`dimadb/server/store.mjs:57-75,82-96`): AES-256-GCM with key = `sha256(DIMADB_SECRET or
  DATA_DIR secret file)`. Format `"<iv 12B hex>:<tag 16B hex>:<ciphertext hex>"`. If no secret exists, it is generated
  on first boot as `randomBytes(32).hex` and written with mode 0600.
- **dima-analytics**: rate-limit key `sha256(token).hex`; identity cache `observability:v1:identity:<sha256hex>`,
  EX ≤60 s.

---

## 5. Timers and background loops in the API and bot (cron workers excluded)

Unless noted, a failing tick is caught and logged (or silently swallowed) and the loop continues. "unref" means the
timer does not keep the process alive.

### 5.1 API (`dima-server`)

| Timer | Period | Purpose | Started at | Error handling |
|---|---|---|---|---|
| `telemetry.ts:37` | 10 s, unref | Sample rss, heap, cpu and event-loop p99; flush metrics, spans and logs to Redis list `observability:v1:inbox` via Lua (LPUSH, LTRIM 0..99, overflow counter `observability:v1:overflow`, EXPIRE 3600) | `server/index.ts:34`, and lazily by the dragonfly/mongo connectors | flush errors count as dropped; 1.8 s connect deadline |
| `siteanalytics.ts:412` | 15 s (`LIVE_CHANNELS_REFRESH_MS`), unref | Refresh the live channels board | `startSiteAnalytics` (`server/index.ts:51`) | `console.error` |
| `siteanalytics.ts:465` | 1 h, unref | Persist the site analytics snapshot to Mongo | same | `console.error` |
| `server/websocket.ts:344-415` | 30 s, **not unref** | Stale clip/TTS/trigger connection cleanup across all channels (`fetchSockets`, Redis `last_activity` keys) | `websocket()` | try/catch per tick |
| `server/websocket.ts:203-214` | `DASHBOARD_LIVE_STATUS_INTERVAL_MS` (default 1 s), per dashboard socket | Push live status | socket connect | cleared on disconnect |
| `server/websocket.ts:125,262,324` | 5 s one-shot per namespace disconnect | Debounced disconnect cleanup (clip, speech, trigger) | socket disconnect | — |
| `server/server.ts:229,239` | 500 ms data + 30 s keep-alive, per SSE client | `GET /config/site/analytics/stream` | request | cleared on close |
| `routes/docs-assistant.route.ts:107`, `routes/site-agent.route.ts:236` | 15 s | SSE `: ping` | request | — |
| `services/dimafx-overlay.service.ts:52` | 2 s, per overlay socket | Poll the DimaFX queue and recover purchases | socket connect | `console.error` |
| `services/{widgets,roulette,duel}-overlay.service.ts:30/28/27` | 500 ms, per channel group | Overlay state poll | first socket | — |
| `handlers/dimafx_queue.handler.ts:150` | `LEASE_MS/3` = 5 s | Playback lease renewal (Mongo `leaseUntil`) | per job | `console.error` |
| `handlers/dimafx_queue.handler.ts:270` | 5 s | Overlay redelivery until acknowledged | per job | — |
| `handlers/tts_queue.handler.ts:1350` | 120 s one-shot per file | Delete speech file | after playback | ignore |
| `handlers/clip_queue.handler.ts:159` | (setting + 65) s one-shot | Clip safety timeout, then cleanup and next clip | per clip | — |
| `oauth/desktop-websocket.ts:66` | 15 s | Revalidate desktop sockets | per socket | — |
| `desktop_ai/service.ts:365` | 5 s, unref | Recover desktop AI turns | `startDesktopAiRuntime` (`server/index.ts:127`) | swallowed |
| `desktop_ai/service.ts:199` | 15 s | Turn lease heartbeat | per turn | — |
| `desktop_ai/activity.ts:333` | 15 s, unref | Validate desktop peers | runtime start | — |
| `pets/readiness.ts:25` | 5 s, unref | Refresh pet readiness proofs (15 s expiry) | `startPetRuntime` via `registerPetSockets` (`websocket.ts:54`) | swallowed |
| `pets/runtime.ts:463` | 15 s, unref | Recover pet requests | same | swallowed |
| `pets/socket.ts:284` | 15 s | Revalidate pet peers | same | — |
| `overlays/live.ts:736-839` | 1 s | Overlay live loop: restore deliveries; every ≥15 s sweep expired deliveries, leases and GridFS files; push revisions | websocket setup | per-peer try/catch |
| `site_agent/runner.ts:971` / `:973` | 10 s / 30 s, unref | Turn recovery / drain reconcile + Polar retries | `startSiteAgentRuntime` (`server/index.ts:128`) | swallowed |
| `site_agent/runner.ts:327` | 15 s | Turn lease heartbeat | per turn | lease loss aborts |
| `voice_preview.service.ts:95` | 30 s | Preview lock renewal | per preview | — |
| `utils/dashboard_activity.ts:26`, `utils/ai_usage_lock.ts:13`, `utils/domain_event_consumer.ts:250` | 10 s / 30 s / lease-derived | Lease heartbeats around single operations | per operation | lost flag |
| `ast_parser/functions/moderation.functions.ts:196` | 2 s, **not unref**, never stopped | Restore-moderator job loop: `ZRANGEBYSCORE` + `ZREM` claim | **lazily**, on the first AST evaluation in the process (`registerAllFunctions()` defaults to `startWorkers: true`, `functions/index.ts:31-35`) | `console.error` |
| `stream_analytics.ts:1486` | `STREAM_ANALYTICS_INTERVAL_MS` | Only when `STREAM_ANALYTICS_INLINE=true` (**off in production**) | — | — |

**Startup tasks in order** (`server/index.ts:34-137`, top-level `await` — §6.4): telemetry, Dragonfly, Mongo,
`initializeOAuth`, Qdrant, Polar client, pub/sub init, PostHog SDK start, `QdrantStartUp` (collections), load Twitch
accounts into cache, site analytics (with recovery), clip queue init, TTS queue init, subscribe `tts:session-ended:v1`,
release stale TTS locks, (inline analytics), `server()`, `websocket(app)` (pets, overlays, desktop), desktop AI
runtime, site agent runtime, `listen(3000)`. If websocket init fails: `process.exit(1)` (`:136`); any error in
`server()` also exits 1 (`server.ts:272`).

### 5.2 Bot (`dima-bot`)

| Timer | Period | Purpose | Started at | Error handling |
|---|---|---|---|---|
| `telemetry.ts:37` | 10 s, unref | As in the API | `bot/index.ts:32` | — |
| `bot_runtime_metrics.ts:574` | `BOT_METRICS_INTERVAL_MS` (≥5 s, default 30 s), unref | Flush runtime and EventSub counters to Redis `metrics:bot:*` (TTL ≥3600, default 172800 s; history list ≤5760) | `bot/index.ts:40` | `console.error` |
| `ast_timer_runtime.ts:87` | 2 s, unref; plus one `setTimeout` per due AST timer (`arm`, `:98-100`) | AST command timers ("Runs inside the bot") | `startAstTimerScheduler` (`bot/index.ts:48`) | — |
| `moderation.functions.ts:196` | 2 s | Restore-moderator loop (lazy, see above) | first command evaluation | — |
| `classes/embedding_batcher.class.ts:36,66,95` | 350 ms debounce, batch ≤500, 3 retries with backoff | Message embedding batches | on enqueue | retries |
| `utils/domain_event_wakeups.ts:103,113,144` | 30 s idle, connect deadline, retry backoff | Pub/sub wakeup client | on use | reconnect |

**Startup order** (`bot/index.ts:24-54`): log NODE_ENV, dotenv, telemetry and fetch instrumentation, Dragonfly, Mongo,
Qdrant, Polar, PostHog SDK start, metrics loop, pub/sub init, keyword cache subscription, load Twitch accounts, start AST
timer scheduler, `twitchEventsub()` (express listen **:3333**), then `void ensureAstCatalogVectors()` (background,
never awaited; it resolves a boolean and is retried after `RETRY_INTERVAL_MS` on later calls, `utils/ai/ast_catalog/index.ts:109-122`).

### 5.3 Unbounded `setTimeout` sites

80 `setTimeout` sites exist outside `src/workers/`. The rest are one-shot deadlines, sleeps or debounces; the largest
groups are in `site_agent/runner.ts` (5), `site_agent/llm/openrouter.ts` (4) and `pets/read_tts.ts` (4). None is a
self-rescheduling loop apart from those listed above. The Deno sandbox timer (`execute_sandbox.ai.ts:158`) is never
cleared.

---

## 6. Node-specific mechanisms that need a deliberate Rust design

### 6.1 AsyncLocalStorage

There is exactly one: `utils/observability/telemetry.ts:12` `context = new AsyncLocalStorage<TraceContext>()`.

- **TraceContext:** `{traceId: 32hex, spanId: 16hex, sampled: bool, channel: string, outcome?}`.
- **Entry points:**
  - `httpTelemetry` middleware (`:117-140`): adopts the signed traceparent, otherwise starts a fresh trace;
  - `beginSpan().run`: Dragonfly method proxy, Mongo command monitor, fetch wrapper, `traced()`;
  - `restoreContext()`: rehydrates a context saved in queue payloads (`:69-74`).
- **Mutation:** `bindChannel()` and `traceOutcome()` mutate the current store.
- **Sampling:** 1% via `Math.random()`. A span is exported if sampled, if it took ≥1 s, or if its outcome is error.
- **Buffer bounds:** metrics map ≤2000 keys (10 s buckets); spans ≤300; logs ≤100 (warn/error/fatal only, allow-listed
  fields); batches of 100 metrics, 50 spans and 25 logs; a payload >256000 bytes is dropped.
- **Rust equivalent:** a tokio task-local plus explicit propagation into spawned tasks.

### 6.2 Signals, shutdown, crashes, exits

- **API.** No signal handlers and no `unhandledRejection`/`uncaughtException` handlers. SIGTERM uses the default action
  (immediate exit): no draining of sockets, no lease release, no telemetry flush. A rejected top-level `await` during
  boot, or any unhandled promise rejection at runtime, crashes the process with exit 1 (Node 24 default
  `--unhandled-rejections=throw`), and Compose `restart: always` restarts it. Explicit exits: `server/index.ts:136`,
  `server/server.ts:272`.
- **Bot.** No crash handlers either. `bot_runtime_metrics.ts:578-583` registers `process.once('SIGTERM'|'SIGINT')`
  listeners that only flush metrics. Registering a listener removes Node's default exit, so the bot keeps running after
  `docker stop` until Docker SIGKILLs it after the default 10 s grace (no `stop_grace_period` is set for chat-bot). A
  second SIGTERM would exit.
- **Cron host** (`workers/cron.index.ts:345-367`):
  - SIGINT/SIGTERM trigger `host.shutdown`. TS children get SIGTERM, 25 s, then SIGKILL; concurrently the Rust group
    gets SIGTERM with a 28 s budget. Compose `stop_grace_period: 30s`.
  - The exit code is 1 if the native index failed or exited non-zero.
  - If the Rust index fails on its own, the whole cron host shuts down (`onFailure`, `:309-318`).
  - Each TS worker installs its own SIGTERM/SIGINT handlers and `process.exit` paths (grep finds 77 `process.exit(` /
    `process.on|once('SIG` sites across `workers/*.ts`). Watchdogs: `credit_gifts.worker.ts:14` (90 s) and
    `follow_defense_actions.worker.ts:22` (40 s) call `process.exit(1)`.
  - `domain_events.worker.ts:53,74,111` exits on IPC disconnect or after the shutdown grace.

### 6.3 Startup side-effects at import time

- `utils/crypto.ts:4` throws without `SECRET_KEY`.
- `routes/trigger.route.ts:85` runs `mkdirSync` on the upload temp dir.
- `telemetry.ts:22-24` computes the instance UUID and service name.
- `logger.ts:9` binds the OTel global logger.
- `utils/s3.ts:5-16` builds the S3 client.
- `utils/email/email.service.ts:13-22` and `email-activation-token.ts:3` capture env.
- The LFM2 client constants are captured.
- `domain_events.worker.ts:21-30` may throw on invalid settings.
- `classes/twitch_streamers.class.ts:1` imports `dotenv/config`.

### 6.4 Top-level await import order

Both `server/index.ts` and `bot/index.ts` are ES modules whose bodies are sequences of top-level `await`s (lines listed
in §5). Because of ESM hoisting, every imported module's top-level code runs **before** the first line of the entry
body, including before `dotenv.config()`. The connectors (`getDragonflyClient`, `getMongoDBConnection`) memoize one
promise per process. A connection failure clears the promise and rethrows, so a boot-time failure is fatal (unhandled
top-level rejection, exit 1, container restart).

### 6.5 In-memory state, caches and singletons

There are 140 module-level `new Map`/`new Set` singletons (the list can be regenerated with
`grep -rnE "^(export )?(const|let) \w+ .*= *new (Map|Set)" src`). Instance-level maps live in the handler singletons:
`ttsQueueHandler`, `clipQueueHandler`, `dimafxQueueHandler`, the overlay and pet peer registries. Every bounded cache is
listed here; all others grow with active channels or sockets and are cleaned by disconnect handlers.

| Cache | Bound or eviction |
|---|---|
| telemetry metrics / spans / logs | 2000 / 300 / 100, swapped on each flush |
| `server/services/tts/fish_voice_catalog.service.ts:58` | 100 entries, FIFO |
| `utils/moderation/advanced.ts:40` compiled patterns | clear at 1000 |
| `utils/moderation/variations.ts:127` | 1000, FIFO |
| `utils/permissions/error_rate_limit.ts:20` | `MAX_TRACKED_PERMISSION_ERRORS` |
| `custom_widgets/files.ts:30-45` content cache | 32,000,000 bytes, LRU by re-insert, content-addressed |
| `custom_widgets/store.ts:245,294` | 1000 channels / 5000 manifests, FIFO |
| `custom_widgets/session.ts:165` | 5000 |
| `goals/twitch-store.ts:41,76,103` | 5000 / 5000 / 2000 |
| `goals/monthly.ts:19,51` | 128 / 512, clear |
| `overlays/interactions.ts:102,135` | sweep expired above 2000 |
| `overlays/ad-schedule.ts:38` | sweep above 5000 |
| `desktop_ai/activity.ts:154,302` | 128 revisions; 1024 peers, ≤2 per session |
| `desktop_ai/updates.ts:29` | 128 pending |
| `pets/delivery.ts:6` | 8 retired ids per peer |
| `pets/mood_warnings.ts:21` | 128 |
| `site_agent/docs/vectors.ts:249` | `QUERY_CACHE_MAX`, FIFO |
| `utils/databases/dragonfly.database.ts:9` error-log suppression map | 30 s window, unbounded keys |
| Upload concurrency | `asset-library.route.ts:54-55` (4 global, 1 per owner); `custom_widgets/media.ts:104` (1 per owner) |
| Process-wide pLimits | thumbnails 2, Deno 25 |
| Mouth analysis | 2 active + 8 queued |
| desktop AI `MAX_CONCURRENT`; site agent `L.concurrentTotal` / `concurrentPerUser` | see the source constants |

Shared mutable singletons a Rust design must own:
- **Connection singletons:** Dragonfly client wrapped in a Proxy that instruments `get, set, hGet, hGetAll, hSet,
  exists, del, zAdd, zPopMin, zCard, lPush, rPush, lPop, rPop, eval`; Mongoose default connection; Qdrant client.
- **Pub/sub subscriber** (`classes/pubsub_manager.class.ts:9-10`, a `client.duplicate()` with a handler map).
- **Socket.IO server:** namespace registries; `getIO()`.
- **`TwitchStreamers` cache:** Redis `twitch:accounts` with version fences.
- **`globalThis.fetch`** is monkey-patched by `instrumentFetch()` (`telemetry.ts:143-170`): spans per provider plus the
  internal traceparent headers. PostHog and dima-analytics hosts are excluded.

### 6.6 Logging (`utils/logger.ts`)

- **API.** `trace|debug|info|warn|error|fatal(data, {destination='both', platform='twitch', channelId})`.
- **Every call does three things:**
  1. `recordLog` into telemetry (warn and above only);
  2. by destination:
     - `console`: `console.log/warn/error({level, timestamp, platform, channelId, data})`, Node `util.inspect` format,
       not JSON;
     - `cache`: Redis `SET logger:<platform>:<channelId|'global'>:<level>:<Date.now()>-<4 base36>` with value
       `JSON.stringify({data, timestamp, level, platform, channelId})` and a separate `EXPIRE 604800` (7 days; not
       atomic);
     - `both`: both of the above;
     - `timestamp` is `new Date().toLocaleString('en-US', {timeZone:'UTC'})`, e.g. `11/11/2026, 3:04:05 PM`;
  3. **always** `openLog.emit({severityText: level, body: data, attributes: options})` to the OpenTelemetry global
     logger.
- **Fire-and-forget calls.** Many callers never `await`, so a Redis failure only produces
  `console.error('Error logging to cache:')`.

### 6.7 OpenTelemetry and PostHog (`utils/opentelemetry_posthog.ts`)

- **Started in** api and bot only (`server/index.ts:44`, `bot/index.ts:39`), with `NodeSDK` 0.214.0.
- **Resource and exporter:** resource `service.name=DomDimaBot`; `BatchLogRecordProcessor(OTLPLogExporter)` to
  `https://us.i.posthog.com/i/v1/logs` with a **hardcoded** header `Authorization: Bearer phc_ApcLd2XbNHavPCcyD9fFDVHxs7cCBPozWmSBFTqugfP`
  (a public project key, but it lives in source).
- **Side effect:** because no `traceExporter`/`spanProcessors` are configured, the SDK also installs the default OTLP
  trace exporter from `OTEL_*` env (default `http://localhost:4318/v1/traces`). No code creates OTel spans, so in
  practice nothing is exported.
- **Implicit env:** the SDK reads `OTEL_*` variables (none set in production).
- **No shutdown:** `sdk.shutdown()` is never called, so buffered PostHog logs are lost on exit.
- **Cron:** cron processes have no OTel SDK, so their `openLog.emit` calls go to the no-op global logger.
- **The custom telemetry pipeline** (§6.1) is separate: Redis inbox, consumed by dima-analytics.

---

## 7. Other projects (short)

- **`dima-rust/src`.** Env names are listed in env.json under `other_projects`.
  - Divergences from TS to resolve:
    - `EMAIL_AUTH_JWT_SECRET` is required (TS falls back to a literal);
    - Qdrant is gRPC via `QDRANT_GRPC_PORT` (default 6334), not REST `QDRANT_PORT`;
    - S3 has no `S3_ENDPOINT_URL`/path-style support.
  - `cron_index` uses `env_clear()` and a per-worker allow-list (`supervisor/registry.rs:31-56`, `process.rs:404`).
  - The panic hook hides payloads (`bin/cron_index.rs:60-63`).
  - Native telemetry reads only `OBSERVABILITY_DISABLED`, `DRAGONFLY_HOST` and `DRAGONFLY_PORT`
    (`supervisor/telemetry.rs:117-125`).
  - Temp files: `std::env::temp_dir()/dima-rust-audio-<pid>-<name>` (`utils/audio.rs:112`).
- **`dimafx/server`.**
  - Env: `PORT` (8080), `DIMABOT_INTERNAL_API_URL`, `DIMABOT_PUBLIC_API_URL`, `DIMAFX_SERVICE_TOKEN`,
    `TWITCH_EXTENSION_SECRET`, `DIMAFX_ALLOW_UNVERIFIED_TWITCH_JWT` (all set through `dimafx/docker-compose.yml:20-26`).
  - Extension JWT: §4.3.
  - No child processes, timers or signal handlers.
- **`dima-analytics`.**
  - Env: `configFromEnv` `src/index.mjs:10-13` (see env.json).
  - Timers: 1 s drain of the telemetry inbox; a collector interval; 1 h retention (`:157-159`).
  - SIGINT/SIGTERM close and exit 0 (`:165`).
  - Reads dimabot's `token:<raw token>` session hash, so it depends on the auth middleware key format.
- **`dimadb/server`.**
  - Env: `PORT` (80), `PUBLIC_DIR`, `DATA_DIR` (/data), `DIMADB_SECRET`, plus the prefix scan of `DIMADB_REDIS_*` and
    `DIMADB_MONGO_*` (`connections.mjs:12`).
  - AES-256-GCM store (§4.7).
  - Persistent `/data`.
- **`dima-hoststats`.**
  - Env: `PORT` (3211), `DOCKER_SOCKET`, `HOSTSTATS_PROJECTS`, `HOSTSTATS_SAMPLE_MS` (≥5000, default 15000),
    `HOSTSTATS_DF_MS` (≥60000, default 600000), `HOSTSTATS_PROC`, `HOSTSTATS_NET_DEV`, `HOSTSTATS_DISK_PATH`
    (`src/index.mjs:12-24`).
  - Reads `/proc` and the Docker socket through a strict GET allow-list regex (`:27`). Docker responses are capped at
    16 MiB with a 5 s timeout.
  - Sampling interval `:199`. SIGINT/SIGTERM exit 0 (`:206`).

---

## 8. Verification notes and limits

- **Env coverage:** 177 grep-distinct `process.env.X` names, plus 11 dynamic, 2 parameter-based, 18 forward-only and 2
  child-only, give 210 = 210 records in env.json. That is 209 read by service code and 1 script-only
  (`CLIP_RECOMMENDATION_ORPHAN_STALE_HOURS`).
- **Production comparison:** 43 `.env` names plus 4 compose/image names. 15 are never read. 180 read names are unset
  in at least one container that loads them.
- **Process attribution** comes from import reachability. It over-approximates where a module is loaded but a function
  is only called in one process. Overrides were made by hand where it mattered: TTS synthesis, clip download,
  `clearSpeechFiles`, the restore-moderator loop.
- **Not verified at runtime.** No application, container or test was started, per the brief. Library behaviour was
  confirmed by reading installed package sources:
  - `@polar-sh/sdk/dist/esm/webhooks.js:110-123`;
  - `standardwebhooks/dist/index.js:7,87-98`;
  - `@opentelemetry/sdk-node/build/src/sdk.js:222-225` and `utils.js:110-131`.
- **Out of scope:** `src/scripts/*` is listed only where it reads env or spawns processes; the 80 one-shot
  `setTimeout` sites were counted, not individually tabulated.
