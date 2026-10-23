# Shared pet runtime (DIMA-030)

Status: the shared PNG/VTS pet implementation is deployed across API, cron, bot and website. The parent promoted the exact accepted artifacts through `saas-ops` on 2026-10-22 at 23:02–23:05 UTC. Isolated runtime, producer and API/Rust acceptance remains valid; production account/provider playback, real audio/VTS hardware and platform acceptance remain limited as described below. No microphone, universal plugin system, additional service or Rust server migration is introduced.

## Current deployment (2026-10-22)

| Service | Deployed run | Exact artifact SHA-256 |
| --- | --- | --- |
| API | `api-cadd5748cb9c` | image `09beb3a509cb3ed8fb4bb60643f405bbb42fc2fe7d7ac0290a53594918031ee1` |
| Cron | `cron-ea507552f33d` | image `46706ffeb3c55bfcaf67964675d3fc6404dc965a52b55009c787f1a8b1c328c5` |
| Bot | `bot-d3f31c3ea2b9` | image `9e3be00a7f82221f149cb2f2daaae806e666d4e78112e390de4ea1bb976c5e41` |
| Website | `site-d67dd0f4094a` | bundle `3b18c6da664258323e3af84bf332ab21b0dc143e42c1b09096f75bdacb3763d9` |

API rollback is `scripts/saas-ops rollback api-cadd5748cb9c`, with prior image `sha256:e35327bf7532b8b33d955ac5466062cbed28315dcb9f5077c86d8221e5b854c1` retained by the helper. All four receipts are `deployed` with `resources: []`; parent cleanup completed at 23:07:27 UTC, preserving rollback artifacts. Superseded `api-ae3fc72dfb9f` and `api-0031d7119456` images were cleaned through the helper without removing a serving container; their logs/receipts remain.

Parent production evidence checked at 23:06:12 UTC records public `/.well-known/oauth-authorization-server` HTTP 200 with seven active scopes and `socket_io: {path:'/socket.io/',namespace:'/desktop',protocol_version:1}`, anonymous identity HTTP 401, and a synthetic public pet-page HEAD HTTP 200. Existing API/site routing, URI-preserving reverse proxy and WebSocket upgrade handling remain in place. Native `/v1/desktop/ws` heartbeat/advertisement remains during the coordinated migration; the pet client does not fall back to it.

The parent's startup inspection found zero restarts and no fatal startup diagnostics in the last 500 log lines for all four services. The production cron index supervised seven native children at UID 65534, with all eight binary hashes matching its receipt. These are startup/snapshot observations. Public checks were anonymous and unpaid: no production account, paid provider or hardware playback was exercised, and a synthetic page HEAD does not establish capability validity, private-media delivery or browser autoplay. The desktop remains the same local debug instance, PID `1129545`, not a distributable release.

Source: [production-release.json](/root/projects/dima_app/target/pet-coordination/production-release.json) and selected private receipt metadata. The evidence and verification commands below preserve earlier candidate history, including then-current `verified` statuses and temporary image retention. Use a fresh candidate for future verification; deployed or cleaned receipts are not reusable candidate checks.

The existing TypeScript API owns processing and Socket.IO. Bot/cron may import `src/pets/admission.ts` and call `admitPetAction`; importing it starts no runtime, subscriber, provider or interval. Only API `registerPetSockets` starts the runtime. Current production has one API process; Mongo compare-and-set fences requests/leases if another executor appears, but distributing socket delivery across API replicas is outside this implementation.

## Configuration and HTTP

`getPetConfiguration`/`savePetConfiguration` remain the single configuration boundary. Responses use `schemaVersion: 2`; all old fields remain. Missing legacy appearance/playback normalize on read without writing:

```ts
appearance: { kind: 'png' | 'vts', idleAssetId: string | null, talkingAssetId: string | null }
playback: { target: 'browser' | 'desktop', desktopSessionId: string | null, vtsSessionId: string | null }
```

Default target is browser, kind PNG, IDs null. PNG uses two original image/animation uploads from the private Asset Library. Images must belong to the channel owner, be ready and have PNG/JPEG/GIF/WebP MIME. Referenced images cannot be deleted. Existing saved offline desktop selections may remain; new selections must name a connected, freshly authenticated session owned by the same account. Audio and VTS selections are independent. Effective personality reads only explicitly selected persona/rules; no moderation tools or bot memory/known-user context is shared. Changes to the selected profile/rules invalidate active work, as do settings saves and output changes. Required appearance is checked again before admission and each provider dispatch: PNG requires owner-valid ready image references (`appearance_unavailable`), VTS requires a selected freshly authenticated connected ready controller (`vts_unavailable`). Bot/cron admission reads an API-authored `pet_readiness` row keyed by owner, matching generation, settings revision and selected session. Its expiry is at most 15 seconds after successful validation and never exceeds OAuth access/session expiry. A single API boot-identity record in that collection fences cross-process reads against prior-process proofs. API restart changes that identity and clears owner rows; ready-false, disconnect, selection/generation changes and revocation clear or invalidate them. The API refreshes previously validated owners every five seconds, comfortably before the 15-second proof expiry, and coalesces concurrent refreshes through one in-flight owner observation. An older ready-false/disconnect clear cannot land after a newer ready write. Refreshes neither change settings revision nor broadcast unchanged state. Producers do not publish readiness. API dispatch still requires the actual authorized local VTS peer immediately before each provider call. Browser audio election in PNG mode additionally requires renderReady. Losing the selected VTS controller invalidates active work and playback.

Dashboard paths retain `{error:false,data:...}` / `{error:true,message:stable_code}` envelopes:

- `GET/PUT /pets/:channelID/settings` (PUT `{revision,settings}` optimistic concurrency).
- `GET /pets/:channelID/runtime` returns data `{v:1,generation,active,sessions:[{sessionId,label,audioReady,vtsReady}]}`. Only connected authenticated desktops belonging to this owner appear. Same-session sockets aggregate readiness with boolean OR; they remain one candidate.
- `GET /pets/:channelID/overlay-token`; `POST` with `{}`, `{rotate:true,version}` or `{token}` return `{token,exists,version}` using the shared encrypted overlay-token utility. Creation is idempotent; stale-version rotation conflicts.
- `POST /pets/:channelID/requests/:requestId/cancel` with `{commandId}` is terminal/idempotent. It does not promise a refund.
- `GET /pets/public/:capability` returns `{appearance,playback,runtime,assets}` within the dashboard envelope. It exposes no prompt, credit balance or session list. `playback` here discloses only the target. `GET .../assets/:assetId` authorizes current configured images then streams original private bytes, with no-store.
- `GET /pets/playback/:requestId/audio?ticket=...` streams private WAV/MP3 with no-store. A five-second opaque ticket is bound to owner, connected peer/session or capability version, request, generation and lease. Each fetch revalidates current authority; it is unusable after cancellation, rotation, expiry or disconnect. Audio files live in task-created directories outside served public speech paths; terminal/recovery cleanup removes them.

OAuth resource responses are unwrapped:

- `GET /v1/me/pet`: configuration without dashboard profile/voice pickers; requires `pet:read`.
- `GET /v1/me/pet/runtime`: same inner runtime shape; requires `pet:read`.
- `PUT /v1/me/pet/playback`: `{commandId,revision,roles:['audio'|'vts',...]}` requires `pet:playback:select`. Selects the caller's own connected OAuth session; caller-supplied session/account IDs are rejected. Returns configuration. A retried save whose revision already advanced once and whose requested selections match is harmless.
- `POST /v1/me/pet/requests/:id/cancel` with `{commandId}` requires `pet:control`.

Active OAuth permissions are the original `profile:read credits:read desktop:connect` plus `pet:read pet:receive pet:control pet:playback:select`. Existing grants/sessions never gain scopes; fresh explicit consent is required. `pet:interact`, `pet:write`, `usage:read` remain inactive. Metadata adds `beta.socket_io:{path:'/socket.io/',namespace:'/desktop',protocol_version:1}`. `/v1/desktop/session` retains identity/device/expiry fields and `protocol_version:1`, sets `pet_available` from `pet:receive`, and adds the same `socket_io` object.

Migration overlap: native `/v1/desktop/ws` heartbeat and its metadata advertisement are retained while the new desktop is integrated and accepted. The new pet path never falls back to it. Parent owns review/removal after coordinated Socket.IO acceptance; indefinite dual-protocol operation is not the product goal.

## Socket.IO v1

Path `/socket.io/`; static namespaces `/desktop` (auth `{v:1,accessToken}`) and `/pet` (auth `{v:1,capability}`). No token/capability URL query authentication, recovery, packet replay or resumed playback. Server construction now selects the ordinary exported `socket.io-adapter` `Adapter` for exactly these two names. No session/packet retention buffer or recovery timer is constructed for them; reliable events remain exactly `[event, object]` with no recovery offset. Other namespaces still receive the same `SessionAwareAdapter` as before. Global Socket.IO recovery and all other site/overlay policies remain as before. Pet attempts to provide recovery pid/offset must authenticate afresh and are rejected by the exact auth schema. Desktop pet sockets require `desktop:connect pet:read pet:receive`. Maximum two sockets per OAuth session, 16 peers per owner, 1024 total. Revocation/access expiry/plan changes are revalidated on messages, renewals, media requests and at most every 15 seconds while idle.

All `serverTime`, `expiresAt` and `startBefore` wire values are **numeric epoch milliseconds**. Lease duration values/positions are numeric milliseconds. Desktop hello is `{v:1,sessionId,channelId,scopes}`.

```ts
RequestView = { requestId, operation: 'talk'|'ask', status, version, text?, errorCode? }
// status: accepted|generating|synthesizing|ready|playing|completed|cancelled|failed|expired
pet:snapshot = { v:1,serverTime,peerId,generation,settingsRevision,appearance,playback,
  assets:{idleUrl:string|null,talkingUrl:string|null},active:RequestView|null,
  lease:{leaseId,holderPeerId,expiresAt}|null }
pet:request = {v:1,generation,request:RequestView}
pet:play = {v:1,requestId,generation,leaseId,startBefore,
  audio:{url,mimeType:'audio/wav'|'audio/mpeg',durationMs}}
pet:stop = {v:1,requestId,generation,reason}
```

Clients send `pet:ready {v:1,audioReady,renderReady,vtsReady}`, `pet:lease {v:1,action:'acquire'}` or `{v:1,action:'renew',leaseId,generation}`, `pet:playback {v:1,requestId,leaseId,generation,seq,phase,positionMs,errorCode?}` with phase started/progress/ended/stopped/error, and `pet:mouth` with the same identity/seq/positionMs plus finite value 0..1. Playback and mouth each use strictly increasing **request-scoped** sequence counters. Mouth input is at most 25 samples/second while actually playing; progress is at most five samples/second and never rebroadcasts unchanged renderer state. Only the elected audio peer may report either stream. Exactly one eligible selected VTS peer (lexicographically smallest server peer ID) receives mouth values, including when multiple sockets use one session.

Acks: `{ok:true,data:T}` or `{ok:false,error:{code,retryAfterMs?}}`. Lease data: `{leaseId,generation,serverTime,expiresAt,ttlMs:15000}`. Renew every five seconds. Clients stop on disconnect/local conservative expiry. A previous lease's full conservative expiry forms the new-generation handover barrier even when the old socket was disconnected. Only the elected peer receives one play emission after synthesis; reconnect snapshots never re-emit play. A client must never queue/replay a duplicate request. Server limits audio to **60 seconds / 8,000,000 bytes**, stricter than any defensive client ceiling.

Ready messages that change no state publish nothing. A bounded per-socket control queue admits ordered bursts such as ready/acquire. Mouth/progress samples are lossy/coalesced by dropping obsolete busy telemetry with `{ok:true,data:{dropped:true}}`; they never create an unbounded promise queue or force an audio stop. One queue slot is reserved for a terminal acknowledgement. The elected peer receives a ready `pet:request` immediately followed by its sole `pet:play`, synchronously on the same socket. Per-peer read serials invalidate snapshots assembled before this delivery; request versions and bounded retired identities reject regressions and terminal resurrection. These server guards complement the real client’s monotonic guards. Owner wake notifications coalesce through a dirty flag while a broadcast runs; snapshots are serialized by owner. Generating/ready/playing and terminal request changes are persisted and broadcast. Public PNG rendering follows actual authorized playback started/end/error/stopped, independently of which browser/desktop owns audio.

## Internal production trigger boundary

```ts
import { admitPetAction, type AdmitPetActionInput } from './pets/admission.js';
interface AdmitPetActionInput {
  channelId: string; operation: 'talk'|'ask'; text: string;
  origin: {kind:'chat-command'|'twitch-event';id:string;occurredAt:string};
  actionKey: string; actor:{userId:string;displayName:string};
}
// => Promise<{requestId:string,status:string}>
```

The configured AST integration derives identity from the real command/event effect context, not user text: Twitch message_id/eventKey, stable engine actionKey, server account/channel and actor. Missing identity rejects. Configured chat/event actions are gated by respondToChat/respondToEvents; there is no unconditional chat listener. The configured tags are `$(pet.talk supplied text)` (direct TTS) and `$(pet.ask supplied prompt)` (no-tool LLM then TTS). Tags return empty text on admission and bounded errors on rejection; LLM output is never AST-evaluated. Producers admit durable state + Redis wake only; no provider work runs in bot/cron.

One active request per pet, no backlog. Mongo has a unique `(ownerId,origin.kind,origin.id,actionKey)` index. Identical payloads reuse one request; changed payload conflicts. An explicit admitted flag closes the insert/runtime-CAS gap: creators/duplicates may resolve the same sole slot, but none returns accepted before durable linkage. If a duplicate read admitted=false and the winner already advanced, the loser rereads and returns the admitted generating/terminal outcome instead of falsely expiring it. A runtime claim carries a unique internal claim ID and captures the atomic runtime preimage. If a delayed duplicate successfully reclaims an already terminal request, it conditionally clears only its own slot and restores the preimage cooldown. The predicate uses the immutable lease identity, never its renewable expiry; lease renewals survive cleanup. Replacement requests and same-millisecond competing claims remain untouched. Normal acceptance and active-pointer invalidation clear claim ownership. Rejection CAS only touches an unadmitted accepted row. Request-specific cancellation compares expected request ID and generation atomically; completion/replacement of A cannot invalidate B or its lease/readiness. Recovery never synthesizes unadmitted rows. Active phases are persisted before provider calls. Unknown provider outcomes after crash become terminal `provider_outcome_unknown`; reconnect/recovery never regenerate them. Dedupe records expire after seven days, which bounds replay protection to that retention window.

The existing no-tool `generateStandaloneText`, model policy, verified `getAiCredits(...,{requireVerified:true})` and exhausted/unavailable TTS fallback rules are reused. Paid calls are single-attempt for pets; private provider options do not change default normal-TTS output/fallback behavior. Stable separate usage IDs are `requestId:llm` and `requestId:tts`, source pet, using existing durable usage ingest/debit idempotency. LLM/TTS usage failures end the request rather than rerun providers. Cancellation aborts supported provider work and invalidates playback, without promising refunds for work already accepted upstream.

Redis hints use the existing `DomainEventWakeups` lifecycle through a pet-topic adapter: producer notification only schedules work; it never awaits connection/publication. One client/command, one pending bit and at most 64 coalesced owner IDs are retained. Dedicated hint clients use 500 ms connect/command deadlines, disable offline queues/automatic reconnect and destroy failed clients to flush commands. API subscriber startup is also asynchronous; failed hints are dropped and bounded Mongo recovery remains authoritative. The shared `DOMAIN_EVENTS_WAKEUPS_ENABLED=false` switch also disables these reused hint clients. Redis hints are advisory after durable admission. API recovery uses one guarded 15-second timer, indexed/limited 64-row expiry/accepted/cleanup scans and one indexed runtime-header read for at most 64 rotating connected owners to repair missed selection/terminal hints; unchanged idle owners do not generate snapshots, no idle high-frequency polling. At most four provider tasks run at once across owners. Files/directories for completed requests are removed on bounded recovery. Real API-replica distribution, real browser autoplay/audio, desktop platforms and real VTS still need acceptance; no provider was invoked with real credentials during implementation.

## Verification recipe

### Final generated-metadata API candidate (2026-10-22)

Clean isolated source `/tmp/dima-pet-producer-11c4a73c` at `63e99b5c412e68001481c29ebb0a8958edc4de5d` produced final API run `api-cadd5748cb9c`, image `sha256:09beb3a509cb3ed8fb4bb60643f405bbb42fc2fe7d7ac0290a53594918031ee1`, source snapshot digest `aa2b6d8f7d85b22b90d1007e5c1fb6cd1986eb3988cbb4bcaefefbaba925bbdd`. No unrelated dirty Rust/cron/docs/image changes were copied. Compared bytewise to accepted runtime source `336b0190`, only this evidence document, `src/utils/ai/ast_catalog/ast-catalog.json`, and `src/utils/ai/sandbox/doc-ast.txt` differ. TypeScript/TSX, dependencies/lockfile and Dockerfile are unchanged. The generated catalog advances `e585b9e5fefe` → `d2bd1b95bef8`, 113 → 115 entries, adding exactly `pet.ask` and `pet.talk`, both `planTier: premium` and `surfaces: [authoring]`.

The normal `saas-ops` build succeeded, reusing the existing compilation layer. The owner explicitly authorized this remaining serial API/cron image-build work on the existing production Docker daemon outside the aggregate task cap; this exception covers only those builds. This worker performed no infrastructure/isolated-builder changes and no Rust compilation. The required outer `/tmp/sam-host-slot.lock`, source isolation, fresh production baseline, ownership and cleanup safeguards remained in force. Disposable verification retained normal limits: API/check 2 CPUs/3 GiB/512 PIDs, Mongo and Redis each 1 CPU/1 GiB/256 PIDs on an internal network with dummy credentials/provider mocks.

| Final exact-image check | Result |
| --- | --- |
| `pet-metadata.mjs` | PASS version/count/two Premium authoring-only entries, generated syntax/examples/text and existing compiled get/find/search interfaces; default/action lookups exclude pet entries; zero provider or billing calls; natural exit |
| Latest `pet-runtime.mjs` | PASS once: exact Socket.IO event arity, preserved unrelated recovery, owner/scopes, sole playback, private audio/asset authorization, stable durable usage IDs/counts/replay suppression, playback/terminal transitions, readiness cancellation and unknown-outcome recovery |

No broad 111-assertion/OAuth/configuration/hints-disabled suite was repeated for this metadata-only delta. Those runtime checks and the parent's actual API/Rust acceptance remain prior evidence, rather than being presented as freshly rerun tests. Parent-reviewed interop on `api-ae3fc72dfb9f` passed the real transport/parser/coordinator ignored regression: two same-generation admissions, naturally adjacent ready/play pairs, deliberate stale-event guards and private WAV decoding to a fake output sink, with two provider calls and matching mocked ingests. Its receipt check digest was `73bba72aa392bc63b61b094e05200585c3b271bae3424ec86a6299b85f5209c9`. This was not the full application session loop or real audio/VTS hardware.

Exact generated artifact SHA-256 values:

- Source catalog: `97e3b47776e97352733da9f589ffd9e8300f85f99bb6872a53deeacc503d5fb4`.
- Compiled catalog: `5f7bfb21f1f682df9562b4e51b25fe3a92dc435c65e72432aa9af1fc9466b6f9` (parsed contents equal the source catalog).
- Authoring reference: `8a199d72469f0b950e8273253527073ecb428eb0b3cf99d95c917f8bc7cd6418`.
- Metadata check: `75f24fa2054840391ab07f9fd02049d213a201ffa2b5b857de26a11d131a9fe3`.
- Runtime check: `22546d67b002c48754db28bd3c570cc0150d1192c81d76314848aadf2eba1c19`.

The authoring interface is the existing compiled catalog module consumed by `AST_DOCS`; there is no public HTTP catalog route. The generated text is present at the actual read-only path used by `code_execution.tool`. No new endpoint or external embedding/model request was used. Staged runtime fixtures `/tmp/pet-final-api-fixtures-63e99b5c` have tree digest `ffd56c0dd51375c5583026c4350697ed1f250503176e26042cc189249b6687d0`; provider mock digest remains `f6f0a0a33e76dddb4818870fae9ff65f9a81b17875193575d3b2ffc15ba8c214`.

The final receipt is `verified`, `resources: []`; generated candidate container/network filters are empty. No failed intermediate run was created. Production API container `562613a373a4241676463f6425014416398cf3d5e8bdf0a64ad2001a00e73be6` and baseline image `sha256:e35327bf7532b8b33d955ac5466062cbed28315dcb9f5077c86d8221e5b854c1` remained unchanged; its existing readiness endpoint returned HTTP 200. The managed desktop PID `1129545` still points to the unchanged `cd2a230...` snapshot; no app operation occurred. Exact candidate image/receipt are retained for parent-coordinated release; no serving candidate, own test/compiler/watcher, production messages, deployment or real provider/credit spend remains. Private receipt and latest server log: `/root/.local/state/saas-ops/649a957c15888e53/api-cadd5748cb9c/{receipt.json,test.log}`. The helper retains only the latest check/log, so metadata result identities are recorded above.

Reproduce these two scoped checks against this retained run, after obtaining the shared execution turn:

```sh
PET_FIXTURES=$(mktemp -d /tmp/pet-final-api-fixtures.XXXXXX)
cp ops/checks/pet-runtime-fixtures/*.mjs "$PET_FIXTURES/"
cp ops/checks/oauth-beta-fixtures/providers.mjs "$PET_FIXTURES/oauth-providers.mjs"
flock --close -w 60 /tmp/sam-host-slot.lock scripts/saas-ops verify api-cadd5748cb9c --dependency mongo --dependency redis \
  --test-env ops/checks/pet-runtime-fixtures/test-env.json --fixtures "$PET_FIXTURES" --check ops/checks/pet-metadata.mjs
flock --close -w 60 /tmp/sam-host-slot.lock scripts/saas-ops verify api-cadd5748cb9c --dependency mongo --dependency redis \
  --test-env ops/checks/pet-runtime-fixtures/test-env.json --fixtures "$PET_FIXTURES" --check ops/checks/pet-runtime.mjs
rm -rf -- "$PET_FIXTURES"
```

### Prior adapter-correction evidence

Adapter-correction investigation: actual Rust/API execution against source `74e52320` / candidate `api-0031d7119456` rejected `desktop:hello` before admission. Installed Socket.IO **4.8.3** routes `Socket.emit` through adapter broadcast when global recovery is configured; installed socket.io-adapter **2.5.8** `SessionAwareAdapter.broadcast` appends an offset and records the packet independently of its `persistSession` / `restoreSession` methods. The earlier method overrides therefore left a third event argument on both pet namespaces. Its constructor also creates a private 60-second unref interval, and the inherited `close()` does not clear it. Replacing an already constructed adapter cannot clean up that closure through the exported API.

The correction passes `petSocketAdapter` to the existing `SocketIOServer` constructor before any namespace exists. The factory returns an ordinary `Adapter` for `/desktop` and `/pet`, and the existing `SessionAwareAdapter` for every other namespace. It removes the old method overrides, preserves global recovery configuration, and does not change client parsing, event schemas or reliable delivery. Installed source inspected: `socket.io/dist/{index,namespace,socket}.js` and `socket.io-adapter/dist/in-memory-adapter.js`. No initialized adapter is replaced, so this correction strands no pet timer, listeners or buffers.

New authored `src/pets/socket_adapter.test.ts` uses real Socket.IO and raw Engine.IO WebSocket frames. It checks exact two-element event arrays on both pet namespaces, ordinary adapter identity, no session/packet structures, null restore/no replay after disconnect, no pet recovery-interval construction, and actual restoration/missed-event replay on an unrelated namespace. It explicitly terminates clients, closes its server and clears its test-owned unrelated recovery intervals. The full API fixture now validates exact event arity/object payloads for both names and rejects browser recovery authentication too; the prior fixture silently ignored a third offset. The compiled adapter regression and strengthened full API fixture passed on the new candidate recorded below.

New candidate `api-ae3fc72dfb9f` was rebuilt from clean isolated source `336b0190` (`/tmp/dima-pet-adapter-336b0190`), source snapshot digest `9fafd2e40b65337fe0076c266fc86db2e1d36dbbf10a43f70fe9c32c3fdcd6f0`, image `sha256:b3764ae4385cb6b199415f4590ebd0acd94309e191910a08d98cdc1d86a8ddf9`. Compilation passed without errors. The 16-file compiled regression runner passed **111/111**, including the real adapter regression, in **4.72 seconds** with natural exit. Full API runtime passed exact two-element pet event arity for desktop and browser while preserving actual site namespace recovery. Every requested same-image check passed:

| Corrected exact-image check | Result |
| --- | --- |
| Compilation | PASS, no compiler errors |
| `pet-provider-regressions.mjs` | 111/111 across 16 serial files, including real raw-wire adapter/recovery regression; 4.72 seconds; natural exit |
| Full `pet-runtime.mjs` | PASS strict desktop/browser event arity, preserved site recovery, normal runtime, billing, cancellation and private delivery |
| Runtime with `test-env-mongo-only.json` | PASS separate-process producer, no hints/manual wake, bounded Mongo-only play/terminal recovery and no replay |
| `oauth-beta.mjs` | PASS |
| `pet-configuration.mjs` | PASS |
| `tts-durable-accounting.mjs` | PASS normal local debit/retained idempotent event after mocked HTTP 403 |

The final receipt is `verified` with `resources: []`; scoped Docker container/network filters are empty. No test, compiler or watcher remains. Every execution held the required outer lock and used normal helper limits: API/check 2 CPUs/3 GiB/512 PIDs; each disposable Mongo/Redis dependency 1 CPU/1 GiB/256 PIDs. The exact image is retained for the parent, with no serving container. Source `336b0190` excludes subsequent producer fixture `f8885605` and unrelated dirty files. No Rust interop, deployment, live credential use, real provider requests or credit spending occurred in this worker.

The new candidate's first full-runtime attempt (`pet-runtime.mjs` SHA-256 `b32c7fbfca6fbd914e1150ff09097498fa8383118df09db8d03c4971e01967e4`) reached VTS-loss testing but timed out on its exact cancellation row. That fixture observed the persisted synthesizing phase, which precedes provider dispatch; the durable terminal row from the failed attempt was not captured before disposable cleanup. A fixture-only barrier now waits for the mock's actual provider invocation, asserts the ready acknowledgement, and reports durable state on any subsequent timeout. The unchanged product image then passed; the exact `cancelled/vts_unavailable` assertion remains intact. This synchronizes the intended in-flight cancellation scenario without claiming the failed attempt's terminal outcome was proven. No product workaround was added.

Current full-runtime check SHA-256: `22546d67b002c48754db28bd3c570cc0150d1192c81d76314848aadf2eba1c19`; compiled runner: `2d3d5ec51e67d7d33c3c586ee33896efba1aa806afd3134c25c05d45322f2a15`. Staged fixtures `/tmp/pet-adapter-fixtures-336b0190` retain tree digest `ffd56c0dd51375c5583026c4350697ed1f250503176e26042cc189249b6687d0` and provider digest `f6f0a0a33e76dddb4818870fae9ff65f9a81b17875193575d3b2ffc15ba8c214`. Checks use the same outer lock and normal helper limits described below. The shared helper's held cron-only CPU-option edits were inspected and parsed before execution; its SHA-256 stayed `288e4c413b635cad6d7f337a48a4f2d13c7c2502e41ec354337e56d068c9985b`. This worker did not edit or stage the helper or its tests. Retain this exact image for a new parent-coordinated actual Rust/API run; no serving candidate is retained at handoff.

Prior candidate history follows. Those results apply only to the old image and the checks then authored; they do not establish corrected wire compatibility.

2026-10-22 evidence: isolated API candidate `api-0031d7119456` built from application source at `74e52320` (snapshot digest `ccd89af830be1feedaecc38ff395af96c8800ead29a993b2162f7e357874fe09`), image `sha256:5a0c22f3b9496f8fcff0b84979d09604d4cf5df30dff8223a1dea667cec38de8`. Its software source excludes unrelated dirty Rust/cron/roulette files. Later fixture and evidence edits do not alter the compiled application.

| Exact-image check | Result |
| --- | --- |
| `pet-provider-regressions.mjs` | 110/110 compiled assertions, 15 serial files, 4.38 seconds, natural exit without force-exit |
| `pet-runtime.mjs` | PASS full Socket.IO runtime, separate-process VTS admission, private delivery, terminal transitions, usage attribution/dedupe and unknown-outcome recovery |
| Same runtime check with `test-env-mongo-only.json` | PASS: separate producer, all hints disabled, no manual wake; play and terminal recovery each bounded to 25 seconds; one synthesis/play |
| `oauth-beta.mjs` | PASS PKCE/races/expiry, consent/scopes, refresh rotation/reuse, revocation and retained native-WS overlap |
| `pet-configuration.mjs` | PASS settings persistence/revision races, owner isolation, plan gates, consent/revocation and persona resolution |
| `tts-durable-accounting.mjs` | PASS normal Fish TTS local debit and retained idempotent Polar event after mocked HTTP 403 |

Every execution acquired `flock --close -w 60 /tmp/sam-host-slot.lock`. Standard `saas-ops` verify limits were 2 CPUs/3 GiB/512 PIDs for API and its check, plus one CPU/1 GiB/256 PIDs for each disposable Mongo/Redis dependency, on an internal network with no production environment. The helper removed test containers/networks after each completed attempt; the final receipt has an empty resource list. The configuration invocation initially timed out acquiring the shared outer lock before the helper or tests started; it resumed only after an explicit coordinated SAM handoff, then both remaining checks passed. No deployment, live credentials, real provider work or credit spending occurred. Actual Rust client/API ordering, producer catalog/integration acceptance, real browser media/VTS and Windows/Linux desktop acceptance remain separate requirements.

First compile runs `api-4a1d35f2c45a` and `api-57221dad0350` failed on owned optional-value types; follow-up guards/default normalization fixed them and the failed runs were cleaned through the helper. The first compiled test run on intermediate `api-67a2ded5e159` passed 87 and failed one outdated standalone billing mock; the corrected fixture additionally verifies explicit credit validation, stable pet usage IDs, durable ingest failure and normal standalone behavior. Mocking the existing queue fixture's PostHog dependency removed its network retry delay; no force-exit or production timer workaround is used.

The final image's first runtime attempt exposed an absent Polar-ingest mock; durable usage correctly prevented playback. Its check SHA-256 was `28242c21a49642124a15ee377f41381dd6d99b20eb9b455626009e4721692188`. After mocking ingest, the next check (`286a95c59d27361e9e60984623667d08bdf31e58f4df8c397ef1278171c1d9bf`) exposed the fixture's camel-case assertion against the SDK's `external_id` wire field. The third check (`acc4c8b578a767992fdd17edf627b7e4dd3a93b09186f625c39772931e4c3753`) restored paid Fish during an admission-only case even though that mock deliberately returns 503. The final fixture keeps the Piper fallback during that case and inspects successful mock ingest with exact request IDs/counts/source, without changing product billing policy.

Passing runtime check SHA-256: `7c044690d6e0992a2a539bafad61411a24fef26d5bebb39d4b0bcba57f0363c4`. Updated provider mock: `f6f0a0a33e76dddb4818870fae9ff65f9a81b17875193575d3b2ffc15ba8c214` (original failed-attempt provider: `1c41cc6e4705e9f74d6299854892484b06fd630cb4a3e1110ff77bc4b667e63c`). Staged pet fixture tree (same `tree_hash` algorithm as saas-ops): `ffd56c0dd51375c5583026c4350697ed1f250503176e26042cc189249b6687d0`. Compiled regression runner: `59b4da043ce40129676094b5824c1718f337c1d4b66eaa5c794c0655644cc1d1`. Both successful runtime variants used exactly these fixtures/checks. Full run receipts and latest server logs are private beneath `/root/.local/state/saas-ops/649a957c15888e53/`; the helper retains only the latest verification check/log per candidate, so the prior-attempt hashes above preserve its check identity. OAuth check SHA-256: `33b26f90b558783d3148dd262050b8f5d8ef4ac75b437b41ed93972961e1b85f`; configuration check: `dd1bbebc4f4a85e714addc27a8a37bedbed49b7f6382b32e0b313163f551e3cc`; normal TTS check: `7db2a1ff40cb8a0b35e9fb4e4460de460b352ab5ebd2edad7aa1aee900b572d9`. At that earlier handoff the old API image was retained for parent-coordinated interop, which subsequently failed as described above; no serving container was retained. Failed/intermediate candidate images were cleaned through the helper. No deployment is authorized.

For a later source change, rebuild and rerun the relevant checks serially through the agreed helper. Parent owns deployment and slot coordination. Use the existing `saas-ops` workflow with an isolated source snapshot if unrelated changes remain:

```sh
scripts/saas-ops plan api
flock --close -w 60 /tmp/sam-host-slot.lock scripts/saas-ops build api --source-dir /path/to/isolated-pet-worktree
PET_FIXTURES=$(mktemp -d /tmp/pet-runtime-fixtures.XXXXXX)
cp ops/checks/pet-runtime-fixtures/*.mjs "$PET_FIXTURES/"
cp ops/checks/oauth-beta-fixtures/providers.mjs "$PET_FIXTURES/oauth-providers.mjs"
flock --close -w 60 /tmp/sam-host-slot.lock scripts/saas-ops verify api-<run-id> --dependency mongo --dependency redis \
  --test-env ops/checks/pet-runtime-fixtures/test-env.json --fixtures "$PET_FIXTURES" \
  --check ops/checks/pet-runtime.mjs
flock --close -w 60 /tmp/sam-host-slot.lock scripts/saas-ops verify api-<run-id> --dependency mongo --dependency redis \
  --test-env ops/checks/pet-runtime-fixtures/test-env.json --fixtures "$PET_FIXTURES" \
  --check ops/checks/pet-provider-regressions.mjs
# Repeat the same check against fresh dependencies with all hints disabled:
flock --close -w 60 /tmp/sam-host-slot.lock scripts/saas-ops verify api-<run-id> --dependency mongo --dependency redis \
  --test-env ops/checks/pet-runtime-fixtures/test-env-mongo-only.json --fixtures "$PET_FIXTURES" \
  --check ops/checks/pet-runtime.mjs
rm -rf -- "$PET_FIXTURES"
# Same exact candidate; the helper creates fresh dependencies per invocation.
flock --close -w 60 /tmp/sam-host-slot.lock scripts/saas-ops verify api-<run-id> --dependency mongo --dependency redis \
  --test-env ops/checks/oauth-beta-fixtures/test-env.json --fixtures ops/checks/oauth-beta-fixtures \
  --check ops/checks/oauth-beta.mjs
flock --close -w 60 /tmp/sam-host-slot.lock scripts/saas-ops verify api-<run-id> --dependency mongo --dependency redis \
  --test-env ops/checks/oauth-beta-fixtures/test-env.json --fixtures ops/checks/oauth-beta-fixtures \
  --check ops/checks/pet-configuration.mjs
flock --close -w 60 /tmp/sam-host-slot.lock scripts/saas-ops verify api-<run-id> --dependency mongo --dependency redis \
  --test-env ops/checks/tts-durable-fixtures/test-env.json --fixtures ops/checks/tts-durable-fixtures \
  --check ops/checks/tts-durable-accounting.mjs
```

Run the existing OAuth beta and pet-configuration checks separately with their original oauth-beta fixtures against the **same candidate** (each verification uses fresh disposable dependencies). Include focused normal AI/TTS regression suites for changed shared provider helpers. Authored deterministic backend race/outage tests are `node --experimental-test-module-mocks --import tsx --test src/pets/admission.test.ts src/pets/state.test.ts src/pets/delivery.test.ts src/pets/wakeups.test.ts src/pets/readiness.test.ts` from `dimabot` under the parent-granted execution limits. Their compiled versions passed on the exact candidate above. Admission fixtures force a successful stale reclaim, replacement B, same-millisecond competing claims and benign lease renewal. Every compiling/test/preview invocation must also hold the shared outer `/tmp/sam-host-slot.lock`; retain normal saas-ops resource limits. The hints-disabled runtime variant admits through a separate producer process with no manual notification and allows 25 seconds for each 15-second recovery phase plus mocked provider/scheduling overhead. The delivery unit fixture mimics Rust’s ready prerequisite; an actual Rust client against the API candidate remains required, not established by that model. The authored pet runtime check covers Socket.IO authentication/scopes/owner isolation; duplicate desktop/browser peers; readiness/control bursts; one lease; request sequence reset; duplicate/conflicting admission and partial-admission recovery; busy-before-provider; private media authorization; actual playback/terminal broadcast; no-tool prompt/usage IDs; unverified-credit fallback; original GIF bytes/deletion guard; capability rotation; unknown-outcome recovery and revoked candidate sessions. A real separate Node producer process with an empty peer map admits VTS work from the shared fenced readiness projection, and the fixture also checks mismatched/expired projections and Redis hint outage acknowledgement. Packet assertions require the selected socket’s ready event immediately before play. The executed backend checks are recorded above. Real client/platform and AST-producer acceptance remain required before milestone completion.

## DIMA-032 candidate contract (2026-10-23; release owned by manager)

This section describes source changes awaiting the manager's isolated candidate verification and release. The DIMA-030 deployment receipts above do not establish DIMA-032 acceptance.

Configuration schema v3 adds `sources:{independent:true,readTts:false}` and `ttsAudio:'pet'|'overlay'` (default `pet`). Missing legacy fields normalize on reads without writes. `enabled` remains the master switch. Independent admission returns `pet_source_disabled` when disabled; only independent synthesis uses the pet voice, `tts.enabled`, persona/profile and credit gates. Normal TTS retains its existing voice, account-credit verification, synthesis, usage IDs and debit. Read-TTS readiness ignores unavailable independent personality and disabled independent TTS; PNG needs valid configured images and no desktop. Snapshots add `sources` and `ttsAudio`; configuration runtime adds `readTtsEnabled` independently of independent-personality validity. Selected-player lease eligibility accepts either usable independent speech or usable read-TTS.

`PetRuntime.ttsReservation:{speechId,token,expiresAt}` is shared Mongo state, covering pending and active TTS turns. Independent admission's final atomic runtime claim checks reservation expiry as well as its existing active request/lease/cooldown fences. Bot and cron therefore cannot bypass a pending API handoff. Reservation acquisition precedes normal synthesis and usage; contention waits before provider work. A delayed cancelled acquisition token-cleans its Mongo result and cannot replace a newer local turn. A pending handoff waits up to the current independent phase deadline, capped at 120 seconds, using owner notifications and one deadline timer. Expiry parks generated unheard speech without discarding or billing it again; explicit cancellation ends it. Reservation contention waits before provider work, bounded by the same 120-second window and authoritative lease/notBefore deadlines. The initial pre-synthesis reservation is 240 seconds. After synthesis its protection grows to at least the full normal playback watchdog plus 180 seconds (independent-wait and safety allowance), so 300-second normal media queued in paused Studio remains protected past its 330-second watchdog. Renewal never shortens that proof. No playback watchdog starts before a proved audio-owner emission; a local proof must cover the full new deadline before any emission. API startup reconciles orphan reservations before accepting socket work, using the exact old runtime/request/generation/lease with existing invalidation semantics. It cancels orphan private requests, retains the old conservative lease expiry in `notBefore`, and clears only the matched token in the new generation. New reservations wait behind that barrier; startup never replays a possibly heard item. Settings/generation changes detach Path B animation while preserving the queue and reservation through normal audio completion. Path A invalidation after a possible play stops its private player and releases its normal queue item. Automatic invalidation before the sole play detaches/cancels only the unheard private identity and falls back with the same normal file; explicit pet cancellation still ends the normal queue item. Controls stop the elected legacy socket and expire Studio deliveries before the next queue item.

Path A copies the already synthesized normal-TTS file into private `dima-pet-*` storage and creates a ready `operation:'tts'` request with `origin.kind:'tts-queue'` and origin ID equal to `speechID`. Each safe attempt has a fresh request ID and internal `actionKey:tts:<attempt epoch>` under the same speech origin, preserving the existing unique origin/action index. Preparation creates no play emission; the queue's final fenced claim authorizes the single synchronous ready/play send. It uses existing lease, tickets, playback and mouth reporting. It calls no pet provider, credit check or usage recorder. Private audio is limited to 60 seconds and 8,000,000 bytes. A failed pre-delivery readiness/ticket/CAS check falls back to the original unmodified normal file. A durable `deliveryAttempted` fence precedes the sole play emission; an authorized audio fetch also records `audioFetched`. **Absence of a started ACK never proves unheard audio.** Once a play was emitted, timeout, ticket fetch, disconnect or an error ends the item without fallback/resynthesis/recharge/replay. A known synchronous refusal before any play emission permits same-file fallback. Reconnect snapshots contain state only, never playback commands.

Path B decodes at most 60 seconds of mono 8 kHz float PCM using ffmpeg (5-second timeout, bounded stdout), then computes RMS in 40 ms windows, scaled by four and clamped to 0..1, at most 1,500 values. Envelopes remain in memory. Envelope failure or files beyond pet limits retain the normal overlay file/audio path and omit animation. No follow acquires a lease, issues a ticket, exposes audio or creates usage. Follow goes to the selected authenticated VTS controller and ready public PNG peers. Initial envelope is required; later updates may omit it:

```ts
pet:follow = {v:1,followId,generation,envelope?:{stepMs:40,values:number[]},positionMs,serverTime}
pet:follow-end = {v:1,followId,generation}
```

Positions and server times advance monotonically; unchanged/backward progress sends no follow and does not refresh the client stall clock. Clients close locally after one second without advancing progress and may resume only on a later advancing update for that same active identity. End/generation/settings/local stop/disconnect closes the mouth. No replay or backward seeking is authorized.

### Overlay Studio delivery and reporting

Only read-TTS events gain `tts:{speechID:string,ownerClientId:string|null,durationMs:number}`. The hint is a positive integer 1..60000; unknown/oversized/long normal audio uses 60000 without modifying the file. Caption-only placements may expire at the hint. **Elected audio lifetime uses actual media metadata, terminal reports and the normal queue watchdog; the caption hint must never cut off normal audio.** Path A has `text` and `tts`, no media. Path B chooses one connected ready legacy speech socket first, otherwise one connected Studio TTS peer in stable key order. All other Studio recipients receive caption-only events without media and `ownerClientId:null`. Existing non-read-TTS delivery remains unchanged.

The existing authenticated capability namespace and `auth.clientId` identify Studio recipients. The read-TTS dispatch stores each exact recipient key `publicId:clientId` and its original `socket.id`. HTTP correlation is additional fencing under that capability, not a new authentication mechanism:

```
GET /overlay-studio/public/:publicId/events/:eventId?clientId=<auth.clientId>&socketId=<current socket.id>
```

Missing, non-recipient, wrong-scene, replaced-socket and disconnected correlations return unavailable. A valid non-elected recipient gets captions without media. The elected response's media URL includes the same `clientId` and `socketId`; the media endpoint revalidates exact elected recipient key and original still-live socket. Every read-TTS pending ID/event is excluded from reconnect bootstrap; disconnect removes that recipient, terminalizes its elected delivery, and prevents the old URL from becoming authorized on reconnect. Restoring persisted read-TTS deliveries after API restart drops them instead of replaying them. Other Studio event/media requests retain their existing contract.

The elected audio source sends at most one report per 500 ms while playing:

```ts
overlay-speech-playback = {eventId,speechID,phase:'loading'|'playing'|'progress'|'recovering',position:number} // seconds
overlay-speech-ended = {eventId,speechID,reason:string}
```

The server requires the exact pending delivery, current elected peer/socket epoch and matching authoritative speech. It synchronously claims terminal reports before awaits. Generic `overlay-ended` remains delivery acknowledgement: caption ACKs cannot release the normal queue, and an elected generic ACK cannot discard correlation before `overlay-speech-ended` arrives. The authoritative TTS queue stays active for Studio-only playback. Legacy `speech-playback` now reports every 500 ms and is fenced to the elected legacy socket for read-TTS. Duplicate/stale speech IDs cannot release a newer item. Skip/clear/refresh preserve their existing non-read-TTS behavior.

Source target impact: API owns normal TTS queue/runtime/Studio delivery and the global stream-end notification listener; the TypeScript cron `domain_events` consumer invokes `clearSpeechFiles` on stream end, which atomically advances a Redis session marker and removes the old backlog, then publishes `tts:session-ended:v1`. The API cancels the old head/audio/follow and schedules original-file cleanup; its existing 15-second bounded recovery also repairs a lost session hint. No native worker behavior changes. `pets/admission.ts` is imported by AST `pet.functions.ts`, reached by bot command handlers and cron event-action execution. Deploy the updated admission/schema/settings consumers in API, bot and cron; no new service/container or provider configuration is required. The manager owns exact-candidate checks, release ordering, deployment and production acceptance.


DIMA-032 review corrections: configured participation (`enabled && sources.readTts` under the existing plan gate) is separate from appearance/player readiness. An unavailable VTS controller or invalid PNG appearance still reserves the normal-TTS turn and elects one overlay fallback owner. Config observations coalesce for five seconds with expired-entry pruning and a 1,024-entry bound; settings invalidation clears them. Private handoff checks the fresh configuration revision before request creation and again before delivery. Settings changes during synthesis preserve the generated file as detached overlay fallback. Studio publication receives an authoritative cancellation predicate across retention, pending insertion/persistence and emission, cleaning retained media on stale completion. Selected pet readiness/acquisition schedules a coalesced `setImmediate` wake after its lease ACK, with no polling, unchanged-ready wake or renew-triggered synthesis in the socket control queue.


Session-only generated-head lifecycle (owner decision, 2026-10-23): **retain generated unheard speech only within the current API session; stream end or API restart may lose it.** There is no durable generated-artifact store, new Mongo collection/index, volume, or migration. Original Redis request data alone cannot recover generated bytes after replacement. Startup still reconciles old reservations and honors the conservative old-player `notBefore` barrier; possibly heard private/Studio audio never replays.

One normal-queue head per channel holds the original payload/score, speech and usage identities, complete original file, MIME/duration, bounded optional envelope analysis, and attempt/control epoch. Its states distinguish preparation, generated/parked unheard audio, possible emission, and terminal cleanup. Later queue items cannot overtake a parked head or invoke providers. The head counts against queue admission while parked. At most 128 head/claim records and eight delivery pumps are admitted; initial dispatch and resumed dispatch share that limit. Capacity pressure holds ungenerated requests before provider work and never evicts an already-generated file. This bounds file count, not normal-media bytes: normal overlay fallback keeps the complete file without pet's 60-second/8MB limit.

If no eligible output remains, park immediately: release only this turn token and unsent private attempt, expire captions/follow, clear the transient execution/Redis processing lock and playback timer, and retain the original file/head. No 100ms polling, periodic turn renewal, or file cleanup runs while parked. A coalesced scheduled pump with a wake-version latch handles readiness arriving during async release. Actual ready changes, lease acquisition after its ACK, live Studio/legacy activation, settings invalidation, independent terminal changes and lease/phase deadlines resume work. Renewing unchanged readiness does not synthesize. The existing rotating recovery reads bounded runtime headers for lost cross-process hints; it does not probe every parked player's full configuration. Owner wait/history entries retire with their last logical head.

On a wake, reacquire current Mongo arbitration and prepare a fresh route from the original file. A selected pet reconnect can therefore receive speech whose earlier attempt found only an unavailable overlay. File inspection/envelope computation are reused across safe attempts. Disabling read-TTS/master while a head is parked detaches pet delivery/animation but preserves its one elected overlay fallback and turn protection. Publication returns `emitted|unavailable|cancelled`; any possible owner emission is terminal on failure and never retried. Lost started ACKs or media fetches cannot authorize another attempt. Local proof loss fences publication; authoritative advancing progress renews the full normal playback watchdog proof, including long paused audio.

Skip/clear/refresh capture the stable head/speech, cancel its epoch, and abort its pending reservation/independent wait synchronously before waiting for dispatch/Redis. Aborting one head wakes only its waiter; it does not stop independent audio or strand another channel sharing the owner notification. A final requeue-delete response cannot erase that captured control target. Every terminal path retires only the matching elected speech owner, resets its legacy player and expires Studio delivery before advancing; an older cleanup cannot retire a future owner. Park never schedules original-file deletion; terminal/control/stream-end cleanup uses the normal 120-second grace. Redis enqueue tags each payload with the current stream marker atomically with queue insertion. Dequeue atomically snapshots membership, payload and marker; legacy untagged requests adopt that snapshot, never a later marker. Stream end atomically changes the marker and removes the old queue/payload keys, so a new marker cannot expose old queued work. Post-boundary enqueues and files survive delayed cleanup of the previous session. Markers invalidate old in-memory heads even when the hint is lost or a provider/retention response arrives late. These additive Redis fields/scripts need no data migration; exact-candidate verification must exercise the actual Dragonfly implementation as well as mocked race tests. API restart intentionally loses generated unheard state; no automatic provider/usage reentry or playback recovery is promised. Death during provider execution retains the existing unknown-outcome boundary.
