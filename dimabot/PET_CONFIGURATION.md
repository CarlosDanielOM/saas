# Pet configuration

The Alpha pet module stores a channel owner's pet preferences and exposes a read-only view to authorized desktop applications. It is available to Premium and Pro channels. Free-tier access is rejected with HTTP `403` and `plan_required`. This is a configuration API only: it does not start a pet, synthesize speech, create billing activity, or process interactions. Runtime playback is currently unavailable (`playbackAvailable: false`).

The dashboard editor is at `/:streamer/modules/pet`. It is restricted to the channel owner. The authenticated API is `GET` and `PUT /pets/:channelID/settings`; it also checks that the requested Twitch channel belongs to the authenticated user. Delegated channel managers cannot read or change this configuration.

## Dashboard API

Both methods require the existing Dima/Twitch bearer authentication used by the dashboard API, a Premium or Pro channel plan, and return `Cache-Control: no-store`. A successful response is wrapped in `{ "error": false, "data": ... }`. A free-tier channel receives HTTP `403` with `{ "error": true, "message": "plan_required" }`. If no pet record exists, `GET` returns defaults with `revision: 0` and `updatedAt: null`; it does not create a record.

`PUT` replaces the complete settings object and requires the revision returned by the latest read. The first save sends revision `0`; successful saves increment the revision and return the saved configuration. A stale revision returns HTTP `409` with `{ "error": true, "message": "settings_conflict" }`. A selected profile that no longer exists returns `personality_unavailable`. Invalid settings, rules, or voices return `invalid_settings`, `invalid_rules`, or `invalid_voice` respectively. These validation errors use HTTP `400`; an unavailable profile uses the default `400` status. Missing/invalid auth is rejected by the shared auth middleware, and owner mismatch returns `403 access_denied`.

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
      "maxReplyLength": 280
    }
  }
}
```

The returned `data` contains `schemaVersion: 1`, `revision`, `updatedAt`, the saved `settings`, the channel's available `profiles`, the supported `voices`, and a resolved `runtime` view. The accepted providers are `piper`, `kokoro`, and `fish`; language is `en` or `es`. Fish voice values may be public reference IDs matching 32 hexadecimal characters. Other provider/voice/language combinations must match the advertised voice list. Names are limited to 40 characters, custom prompts to 4,000, profile IDs to 100, and there may be at most 20 additional rules of up to 300 characters each. Cooldown is an integer from 0 to 3,600 seconds; maximum reply length is an integer from 30 to 500.

`personality.source` selects either the supplied custom `prompt` or an existing AI personality profile by `profileId`. The runtime resolver copies only explicit profile persona fields (prompt, persona mode/reference, tone preset, voice profile) and combines the profile's rules followed by the pet's additional `settings.rules`. It does not expose or reuse AI memories, known users, or moderation tools. If a profile selected in a saved configuration later disappears, the response reports `runtime.issues: ["personality_unavailable"]` and sets `runtime.enabled` to `false`. The profile list and voice catalog are provided to the dashboard editor.

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
  "schemaVersion": 1,
  "revision": 0,
  "updatedAt": null,
  "settings": {
    "enabled": false,
    "name": "Dima",
    "tts": { "enabled": true, "provider": "piper", "language": "es", "voice": "es_MX-ald-medium" },
    "personality": {
      "source": "custom",
      "profileId": "",
      "prompt": "You are a friendly, playful virtual companion. Keep replies short and respectful."
    },
    "rules": [],
    "behavior": { "respondToChat": true, "respondToEvents": true, "cooldownSeconds": 15, "maxReplyLength": 280 }
  },
  "runtime": {
    "enabled": false,
    "issues": [],
    "personality": {
      "prompt": "You are a friendly, playful virtual companion. Keep replies short and respectful.",
      "rules": []
    },
    "playbackAvailable": false
  }
}
```

OAuth errors use `{ "error": "..." }`; a missing/invalid token returns `401 invalid_token`, a valid token without `pet:read` returns `403 insufficient_scope`, and a free-tier channel receives `403 plan_required`. A `pet:read` grant does not bypass the channel's Premium or Pro plan requirement. See [OAUTH_BETA.md](./OAUTH_BETA.md) for authorization, token handling, and the other desktop resources. Existing desktop grants and sessions keep the scopes they already have: a user must authorize again with `pet:read` to grant this resource. Initialization adds `pet:read` to the built-in `dima-desktop` client's allowed scope list; this does not add the scope to existing grants or to separately registered clients.

The broader pet integration is not implemented: there is no synthesis, billing, chat/event interaction, control, or playback behavior. Other pet scopes remain planned and unavailable. In particular, the desktop WebSocket continues to report `pet_available: false`.

## DIMA-032 schema v3 (candidate, not deployed by this worker)

Settings add `sources:{independent:boolean,readTts:boolean}` and `ttsAudio:'pet'|'overlay'`. Defaults are independent=true, readTts=false, ttsAudio=pet, including legacy records normalized without writes. `enabled` remains the master switch. Normal TTS retains its normal queue, configured voice and billing; pet voice/personality and `tts.enabled` apply only to independent speech. Read-TTS-only PNG works without a desktop and ignores an unavailable independent personality. Configuration includes `runtime.readTtsEnabled`; snapshots include `sources` and `ttsAudio`. See [PET_RUNTIME.md](PET_RUNTIME.md#dima-032-candidate-contract-2026-10-23-release-owned-by-manager) for frozen Studio caption/report/media correlation and follow contracts, ownership policy and no-replay guarantees.
