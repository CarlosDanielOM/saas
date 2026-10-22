# Shared pet runtime (DIMA-030)

Status: source checkpoint for a narrowly scoped Socket.IO adapter correction, not yet compiled or executed. The prior candidate passed backend checks but failed actual Rust/API interoperability at desktop hello because a recovery offset added a third event argument. Not deployed or milestone accepted. This is the backend contract for the approved PNG/VTS pet slice. Backend runtime alone does not complete the milestone: command/EventSub AST tags, website renderer and desktop Socket.IO integration need their own integration/acceptance. No microphone, universal plugin system, additional service or Rust server migration is introduced.

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

The later AST integration derives identity from the real command/event effect context, not user text: Twitch message_id/eventKey, stable engine actionKey, server account/channel and actor. Missing identity rejects. Configured chat/event actions are gated by respondToChat/respondToEvents; there is no unconditional chat listener. Intended tags are `$(pet.talk supplied text)` (direct TTS) and `$(pet.ask supplied prompt)` (no-tool LLM then TTS). Tags return empty text on admission and bounded errors on rejection; LLM output is never AST-evaluated. Producers admit durable state + Redis wake only; no provider work runs in bot/cron.

One active request per pet, no backlog. Mongo has a unique `(ownerId,origin.kind,origin.id,actionKey)` index. Identical payloads reuse one request; changed payload conflicts. An explicit admitted flag closes the insert/runtime-CAS gap: creators/duplicates may resolve the same sole slot, but none returns accepted before durable linkage. If a duplicate read admitted=false and the winner already advanced, the loser rereads and returns the admitted generating/terminal outcome instead of falsely expiring it. A runtime claim carries a unique internal claim ID and captures the atomic runtime preimage. If a delayed duplicate successfully reclaims an already terminal request, it conditionally clears only its own slot and restores the preimage cooldown. The predicate uses the immutable lease identity, never its renewable expiry; lease renewals survive cleanup. Replacement requests and same-millisecond competing claims remain untouched. Normal acceptance and active-pointer invalidation clear claim ownership. Rejection CAS only touches an unadmitted accepted row. Request-specific cancellation compares expected request ID and generation atomically; completion/replacement of A cannot invalidate B or its lease/readiness. Recovery never synthesizes unadmitted rows. Active phases are persisted before provider calls. Unknown provider outcomes after crash become terminal `provider_outcome_unknown`; reconnect/recovery never regenerate them. Dedupe records expire after seven days, which bounds replay protection to that retention window.

The existing no-tool `generateStandaloneText`, model policy, verified `getAiCredits(...,{requireVerified:true})` and exhausted/unavailable TTS fallback rules are reused. Paid calls are single-attempt for pets; private provider options do not change default normal-TTS output/fallback behavior. Stable separate usage IDs are `requestId:llm` and `requestId:tts`, source pet, using existing durable usage ingest/debit idempotency. LLM/TTS usage failures end the request rather than rerun providers. Cancellation aborts supported provider work and invalidates playback, without promising refunds for work already accepted upstream.

Redis hints use the existing `DomainEventWakeups` lifecycle through a pet-topic adapter: producer notification only schedules work; it never awaits connection/publication. One client/command, one pending bit and at most 64 coalesced owner IDs are retained. Dedicated hint clients use 500 ms connect/command deadlines, disable offline queues/automatic reconnect and destroy failed clients to flush commands. API subscriber startup is also asynchronous; failed hints are dropped and bounded Mongo recovery remains authoritative. The shared `DOMAIN_EVENTS_WAKEUPS_ENABLED=false` switch also disables these reused hint clients. Redis hints are advisory after durable admission. API recovery uses one guarded 15-second timer, indexed/limited 64-row expiry/accepted/cleanup scans and one indexed runtime-header read for at most 64 rotating connected owners to repair missed selection/terminal hints; unchanged idle owners do not generate snapshots, no idle high-frequency polling. At most four provider tasks run at once across owners. Files/directories for completed requests are removed on bounded recovery. Real API-replica distribution, real browser autoplay/audio, desktop platforms and real VTS still need acceptance; no provider was invoked with real credentials during implementation.

## Verification recipe

Pending adapter-correction checkpoint: actual Rust/API execution against source `74e52320` / candidate `api-0031d7119456` rejected `desktop:hello` before admission. Installed Socket.IO **4.8.3** routes `Socket.emit` through adapter broadcast when global recovery is configured; installed socket.io-adapter **2.5.8** `SessionAwareAdapter.broadcast` appends an offset and records the packet independently of its `persistSession` / `restoreSession` methods. The earlier method overrides therefore left a third event argument on both pet namespaces. Its constructor also creates a private 60-second unref interval, and the inherited `close()` does not clear it. Replacing an already constructed adapter cannot clean up that closure through the exported API.

The correction passes `petSocketAdapter` to the existing `SocketIOServer` constructor before any namespace exists. The factory returns an ordinary `Adapter` for `/desktop` and `/pet`, and the existing `SessionAwareAdapter` for every other namespace. It removes the old method overrides, preserves global recovery configuration, and does not change client parsing, event schemas or reliable delivery. Installed source inspected: `socket.io/dist/{index,namespace,socket}.js` and `socket.io-adapter/dist/in-memory-adapter.js`. No initialized adapter is replaced, so this correction strands no pet timer, listeners or buffers.

New authored `src/pets/socket_adapter.test.ts` uses real Socket.IO and raw Engine.IO WebSocket frames. It checks exact two-element event arrays on both pet namespaces, ordinary adapter identity, no session/packet structures, null restore/no replay after disconnect, no pet recovery-interval construction, and actual restoration/missed-event replay on an unrelated namespace. It explicitly terminates clients, closes its server and clears its test-owned unrelated recovery intervals. The full API fixture now validates exact event arity/object payloads for both names and rejects browser recovery authentication too; the prior fixture silently ignored a third offset. These new checks have **not run** because SAM holds the shared execution turn.

Once the parent grants execution, rebuild a fresh isolated API candidate, then run `pet-provider-regressions.mjs` (now also includes the real adapter regression), full and hints-disabled `pet-runtime.mjs`, OAuth/configuration checks and the relevant normal TTS accounting regression with the commands below. Retain the resulting exact image for a new parent-coordinated actual Rust/API run. Prior results below apply only to the old image and the checks then authored; they do not establish corrected wire compatibility.

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

Passing runtime check SHA-256: `7c044690d6e0992a2a539bafad61411a24fef26d5bebb39d4b0bcba57f0363c4`. Updated provider mock: `f6f0a0a33e76dddb4818870fae9ff65f9a81b17875193575d3b2ffc15ba8c214` (original failed-attempt provider: `1c41cc6e4705e9f74d6299854892484b06fd630cb4a3e1110ff77bc4b667e63c`). Staged pet fixture tree (same `tree_hash` algorithm as saas-ops): `ffd56c0dd51375c5583026c4350697ed1f250503176e26042cc189249b6687d0`. Compiled regression runner: `59b4da043ce40129676094b5824c1718f337c1d4b66eaa5c794c0655644cc1d1`. Both successful runtime variants used exactly these fixtures/checks. Full run receipts and latest server logs are private beneath `/root/.local/state/saas-ops/649a957c15888e53/`; the helper retains only the latest verification check/log per candidate, so the prior-attempt hashes above preserve its check identity. OAuth check SHA-256: `33b26f90b558783d3148dd262050b8f5d8ef4ac75b437b41ed93972961e1b85f`; configuration check: `dd1bbebc4f4a85e714addc27a8a37bedbed49b7f6382b32e0b313163f551e3cc`; normal TTS check: `7db2a1ff40cb8a0b35e9fb4e4460de460b352ab5ebd2edad7aa1aee900b572d9`. The final API image is retained for parent-coordinated interop, with no serving container retained. Failed/intermediate candidate images were cleaned through the helper. No deployment is authorized.

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
