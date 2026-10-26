# Pet configuration

The DIMA-030 pet runtime is deployed across API, bot, cron, and site; the DIMA-032 Read-TTS integration is also deployed. The feature is available to Premium and Pro channels. Free-tier access is rejected with HTTP `403` and `plan_required`. The API supports configured `talk`/`ask` pet actions and normal-TTS Read-TTS handoff; current schema and runtime behavior are described below and in [PET_RUNTIME.md](PET_RUNTIME.md).

The dashboard editor is at `/:streamer/modules/pet`. It is restricted to the channel owner. The authenticated API is `GET` and `PUT /pets/:channelID/settings`; it also checks that the requested Twitch channel belongs to the authenticated user. Delegated channel managers cannot read or change this configuration.

## Dashboard API

Both methods require the existing Dima/Twitch bearer authentication used by the dashboard API, a Premium or Pro channel plan, and return `Cache-Control: no-store`. A successful response is wrapped in `{ "error": false, "data": ... }`. A free-tier channel receives HTTP `403` with `{ "error": true, "message": "plan_required" }`. If no pet record exists, `GET` returns defaults with `revision: 0` and `updatedAt: null`; it does not create a record.

`PUT` replaces the complete settings object and requires the revision returned by the latest read. The first save sends revision `0`; successful saves increment the revision and return the saved configuration. A stale revision returns HTTP `409` with `{ "error": true, "message": "settings_conflict" }`. When `settings.sources.independent` is true, a selected profile that no longer exists returns `personality_unavailable`; when it is false, that missing profile is not an independent-source validation failure. Invalid settings, rules, or voices return `invalid_settings`, `invalid_rules`, or `invalid_voice` respectively. These validation errors use HTTP `400`; an unavailable profile uses the default `400` status. Missing/invalid auth is rejected by the shared auth middleware, and owner mismatch returns `403 access_denied`.

Example replacement request:

```http
PUT /pets/123456789/settings
Authorization: Bearer <dashboard-token>
Content-Type: application/json

{
  "revision": 0,
  "settings": {
    "enabled": false,
    "name": "Dima",
    "sources": { "independent": true, "readTts": false },
    "ttsAudio": "pet",
    "appearance": { "kind": "png", "idleAssetId": null, "talkingAssetId": null },
    "playback": { "target": "browser", "desktopSessionId": null, "vtsSessionId": null },
    "tts": {
      "enabled": true,
      "provider": "piper",
      "language": "es",
      "voice": "es_MX-ald-medium"
    },
    "personality": {
      "source": "custom",
      "profileId": "",
      "prompt": "You are a friendly, playful virtual companion. Keep replies short and respectful."
    },
    "rules": ["Keep replies kind and concise."],
    "behavior": {
      "respondToChat": true,
      "respondToEvents": true,
      "cooldownSeconds": 15,
      "maxReplyLength": 280,
      "queueSize": 5,
      "askLane": "independent"
    }
  }
}
```

The returned `data` contains `schemaVersion: 3`, `revision`, `updatedAt`, the normalized saved `settings`, the channel's available `profiles`, the supported `voices`, and a resolved `runtime` view. Settings include `sources`, `ttsAudio`, `appearance`, and `playback`; missing legacy `sources` and `ttsAudio` normalize to `{ independent: true, readTts: false }` and `pet` without writing. Default PNG appearance has null asset IDs, so `runtime.issues` includes `appearance_unavailable` until valid images are selected. `runtime.enabled` reflects the master switch and all runtime issues. `runtime.readTtsEnabled` is false for unavailable appearance/VTS readiness but ignores `personality_unavailable`; `playbackAvailable` reflects an active unexpired lease. The accepted providers are `piper`, `kokoro`, and `fish`; language is `en` or `es`. Fish voice values may be public reference IDs matching 32 hexadecimal characters. Other provider/voice/language combinations must match the advertised voice list. Names are limited to 40 characters, custom prompts to 4,000, profile IDs to 100, and there may be at most 20 additional rules of up to 300 characters each. Cooldown is an integer from 0 to 3,600 seconds; maximum reply length is an integer from 30 to 500.

`personality.source` selects either the supplied custom `prompt` or an existing AI personality profile by `profileId`. The runtime resolver copies only explicit profile persona fields (prompt, persona mode/reference, tone preset, voice profile) and combines the profile's rules followed by the pet's additional `settings.rules`. It does not expose or reuse AI memories, known users, or moderation tools. If `settings.sources.independent` is true and a saved profile selection later disappears, the response reports `runtime.issues: ["personality_unavailable"]` and sets `runtime.enabled` to `false`. When `settings.sources.independent` is false, a missing profile does not add that issue; Read-TTS-only readiness ignores unavailable independent personality. The profile list and voice catalog are provided to the dashboard editor.

`revision` and `updatedAt` track writes to the pet settings record; changes to a linked AI profile do not increment them. App consumers should read and apply the resolved `runtime` on each refresh, even when the pet revision is unchanged, because linked profile edits can change the resolved runtime.

## Desktop OAuth read API

`GET https://api.domdimabot.com/v1/me/pet` requires an access token with the `pet:read` Dima OAuth scope:

```http
GET /v1/me/pet
Authorization: Bearer <access_token>
```

This route is bound to the Twitch account that approved the OAuth grant; it takes no channel or account selector. It returns the pet configuration and resolved runtime view directly as JSON (the OAuth API does not use the dashboard `{ error, data }` envelope). It omits the dashboard-only `profiles` and `voices` catalogs. For example, before a configuration has been saved:

```json
{
  "schemaVersion": 3,
  "revision": 0,
  "updatedAt": null,
  "settings": {
    "enabled": false,
    "name": "Dima",
    "sources": { "independent": true, "readTts": false },
    "ttsAudio": "pet",
    "appearance": { "kind": "png", "idleAssetId": null, "talkingAssetId": null },
    "playback": { "target": "browser", "desktopSessionId": null, "vtsSessionId": null },
    "tts": { "enabled": true, "provider": "piper", "language": "es", "voice": "es_MX-ald-medium" },
    "personality": {
      "source": "custom",
      "profileId": "",
      "prompt": "You are a friendly, playful virtual companion. Keep replies short and respectful."
    },
    "rules": [],
    "behavior": { "respondToChat": true, "respondToEvents": true, "cooldownSeconds": 15, "maxReplyLength": 280, "queueSize": 5, "askLane": "independent" }
  },
  "runtime": {
    "enabled": false,
    "issues": ["appearance_unavailable"],
    "readTtsEnabled": false,
    "personality": {
      "prompt": "You are a friendly, playful virtual companion. Keep replies short and respectful.",
      "rules": []
    },
    "playbackAvailable": false
  }
}
```

OAuth errors use `{ "error": "..." }`; a missing/invalid token returns `401 invalid_token`, a valid token without `pet:read` returns `403 insufficient_scope`, and a free-tier channel receives `403 plan_required`. A `pet:read` grant does not bypass the channel's Premium or Pro plan requirement. See [OAUTH_BETA.md](./OAUTH_BETA.md) for authorization, token handling, and the other desktop resources. Existing desktop grants and sessions keep the scopes they already have: a user must authorize again with `pet:read` to grant this resource. Initialization adds `pet:read` to the built-in `dima-desktop` client's allowed scope list; this does not add the scope to existing grants or to separately registered clients.

DIMA-030 pet actions are admitted from configured command/event effects and run through the API pet runtime; they are not unconditional chat listeners. The OAuth scope catalog exposes `pet:read`, `pet:receive`, `pet:control`, and `pet:playback:select`; existing grants do not gain scopes without renewed consent. `GET /v1/desktop/session` sets `pet_available` from the grant's `pet:receive` scope and advertises Socket.IO. The retained native `/v1/desktop/ws` is a separate heartbeat-only protocol whose hello still reports `pet_available: false`; active pet sockets use Socket.IO `/desktop` and `/pet`. DIMA-032 Read-TTS is deployed; [PET_RUNTIME.md](PET_RUNTIME.md) records release artifacts and runtime contract.

## DIMA-032 schema v3 (deployed 2026-10-23)

Settings add `sources:{independent:boolean,readTts:boolean}` and `ttsAudio:'pet'|'overlay'`. Defaults are independent=true, readTts=false, ttsAudio=pet, including legacy records normalized without writes. `enabled` remains the master switch. Normal TTS retains its normal queue, configured voice and billing; pet voice/personality and `tts.enabled` apply only to independent speech. With valid configured PNG image references, Read-TTS-only operation needs no desktop and ignores an unavailable independent personality. Missing or unavailable PNG images produce `appearance_unavailable` and make both `runtime.enabled` and `runtime.readTtsEnabled` false. Configuration includes `runtime.readTtsEnabled`; snapshots include `sources` and `ttsAudio`. See [PET_RUNTIME.md](PET_RUNTIME.md#dima-032-candidate-contract-2026-10-23-release-owned-by-manager) for frozen Studio caption/report/media correlation and follow contracts, ownership policy and no-replay guarantees.


The owner selected session-only retention for DIMA-032: generated unheard normal speech waits behind one queue head until an output becomes eligible, but stream end or API restart may discard it. Waiting keeps the same file/speech/usage identity, releases transient pet arbitration and does not synthesize or debit again. Disabling read-TTS or the pet master switch while such a head waits preserves its single elected normal-overlay fallback, without pet audio or follow animation. No additional setting, durable-storage collection or wire field is introduced. The runtime lifecycle and capacity/cleanup limits are documented in [PET_RUNTIME.md](PET_RUNTIME.md#dima-032-candidate-contract-2026-10-23-release-owned-by-manager).
