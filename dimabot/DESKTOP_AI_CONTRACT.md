# Desktop AI turns: v1 wire contract

All HTTP resources below are on the OAuth issuer origin under `/v1`. They accept the existing Dima OAuth Bearer access token, return unwrapped JSON, use `Cache-Control: no-store`, and do not accept client-supplied channel, actor, permission level, voice, persona or tool lists. All times are Unix milliseconds unless noted. The server derives the owner, own Twitch channel and broadcaster authority from the authenticated session. `source` describes input origin only. The following is the implementation contract, not a claim that a deployed server already supports it.

## Discovery and consent

`GET /v1/me/ai/capabilities` requires `profile:read` and returns:

```json
{"version":1,"permission_profile_version":2,"available":true,"supported_scopes":["ai:interact","pet:interact"],"required_scopes":{"bot":["ai:interact"],"pet":["pet:interact"]},"granted_scopes":["profile:read"]}
```

`supported_scopes` lists the two interaction scopes for this feature; it is not a list of all OAuth scopes. The client compares actual grants with its own trusted scope allowlist. New scopes require fresh OAuth browser consent. The consent flow discloses streamer-level actions, memory behavior and credit spending. Existing seven-scope tokens and `/desktop` hello remain unchanged. Credential replacement follows validation of the same owner and channel; output selection is never transferred automatically.

The two feature scopes are `ai:interact` (Bot turns) and `pet:interact` (Pet turns). The existing seven-scope grant becomes eight when either interaction scope is added, or nine when both are added. `desktop:connect` is a separate grant used by the `/desktop-ai` activity namespace. Capabilities discovery reports only the two interaction scopes in `supported_scopes`; `granted_scopes` reports the complete actual grant. Feature routes derive the Twitch channel and broadcaster identity from the OAuth session. A desktop client cannot select a different channel, permission level, persona, voice, or tool list, and this feature does not execute commands on the user's PC.

## Submit, recover and inspect

`POST /v1/me/ai/turns` requires `ai:interact` for Bot and `pet:interact` for Pet:

```json
{"request_id":"1c3f2a4b-5c6d-4a7b-8c9d-001122334455","target":"bot","text":"Hey Dima, how are you?","source":"asr","silent":false}
```

Fields are exactly `request_id` (UUID), `target` (`bot` or `pet`), nonblank `text` (at most 2000 UTF-16 code units, preserved exactly), `source` (`asr` or `typed`), required `silent` boolean, and optional server-issued `conversation_id`. A successful admission is durably recorded before execution and returns HTTP 202 and the snapshot below. The fingerprint includes target, exact text, source, silent, and whether/conversation ID was supplied. Owner + client + request ID is unique for seven days. Same ID and fingerprint returns the existing snapshot; a different fingerprint returns HTTP 409 `idempotency_conflict`. If the 202 is lost, recover with `GET /v1/me/ai/turns/by-request/:request_id`; do not submit another ID or automatically replay on reconnect. Unknown or expired is not authorization to generate again. `GET /v1/me/ai/turns/:turn_id` returns the same authorized snapshot. The corresponding target interaction grant is required for reads and cancellation.

```json
{"request_id":"1c3f2a4b-5c6d-4a7b-8c9d-001122334455","turn_id":"846da0ad-82b5-4403-b150-7b08dfb309fb","target":"bot","conversation_id":"58d161a9-8b61-4a55-ae47-c4bb9a528add","status":"queued","revision":1,"poll_after_ms":1000}
```

`status` is `queued`, `running`, `completed`, `failed`, `cancelled`, or `indeterminate`. `revision` is monotonic; treat it as an opaque value for comparing snapshots, not as a count. Optional `reply_text` is bounded to 500 UTF-16 units; `error` has shape `{ "code": "..." }` with a bounded, stable code; `pet_request_id` links the existing pet request. Optional `actions` contains at most 16 bounded `{ "operation_id": "tool:1", "tool": "AST_PARSER", "status": "pending" | "completed" | "failed" | "indeterminate" }` summaries; tool arguments and raw provider errors are not included. JSON snapshots remain below 32 KiB. Poll only while work or speech is outstanding, starting at 1 second and backing off to at most 5 seconds; respect `Retry-After`. An ended foreground wait can be refreshed explicitly. An answer/action `completed` status does not imply that speech finished.

The server runs one normal AI turn through the existing shared chat and action pipeline. It uses the streamer's existing memory, tools, and credit rules; tool actions use broadcaster identity at level 10 and the existing broadcaster cooldown bypass. Pet replies are submitted through the existing Pet `talk` request path. Bot replies use the existing TTS provider and queue/accounting path, without starting Pet animation. This feature's hands-free owner submits each final transcript after wake detection, whether the intended target is Bot or Pet; there is no separate Send confirmation, extra parser, or bouncer stage.

A conversation is bound to owner, channel, target and desktop namespace, independent of access-token refresh. Omission creates a new conversation; reuse its returned ID for follow-up turns. The desktop thread window is 24 hours. Existing owner memory and fact policies still apply.

## Speech

A non-silent turn includes a separate `speech` object from admission onward, initially `queued`, so speech-only cancellation also works while the answer is being generated:

```json
{"playback_id":"c0cb342e-efcc-4358-a630-b585231803a2","output_generation":1,"status":"ready","destination":"desktop","animate_pet":false,"transport":"http","audio_url":"/v1/me/ai/turns/846da0ad-82b5-4403-b150-7b08dfb309fb/speech/audio","ticket":"opaque","ticket_expires_at":1793459000000,"start_before":1793459000000,"mime_type":"audio/wav","duration_ms":4000}
```

`status` is `queued`, `preparing`, `ready`, `delivering`, `playing`, `completed`, `cancelled`, `failed`, `expired`, or `indeterminate`. `transport` is `http` for Bot and `pet_socket` for Pet. Pet has `animate_pet:true` and uses only the existing elected pet Socket.IO player; it is never fetched or played again through the new HTTP audio resource. That player must be the initiating desktop session. Bot has `animate_pet:false`, works independently of pet configuration, and uses the HTTP resource only. A silent turn has no `speech` object, incurs no TTS synthesis charge, and retains its text/actions.

For Bot, once `ready`, fetch the relative same-origin `audio_url` with the existing Bearer token and `X-Dima-Audio-Ticket: <ticket>`. Both the ticket and `start_before` expire no later than 15 seconds after readiness. Audio GET is one-fetch: it atomically claims delivery and must not be retried automatically after an uncertain outcome. The app fetches and decodes the audio, then POSTs `started` and waits for HTTP 200 with a `playing` snapshot before beginning audible playback. The pre-play coordination barrier is complete before the audio becomes `ready`. No redirects, output stealing, duplicate playback, or local synthesis. POST `/:turn_id/speech/events` with `{ "playback_id": "...", "output_generation": 1, "event": "started" | "ended" | "failed" }` returns `{ "snapshot": <snapshot> }`. Only the initiating authorized session may receive/control that turn's speech. Existing Pet RequestView values and legacy `/desktop` event vocabulary are unchanged. If the selected Pet player is not the initiating desktop, the speech reports `output_unavailable`; the server does not change selection.

## Cancellation

`POST /v1/me/ai/turns/:turn_id/cancel` accepts an empty object and returns `{ "accepted": boolean, "too_late": boolean, "snapshot": <snapshot> }`. `POST /v1/me/ai/turns/:turn_id/speech/cancel` accepts `{ "playback_id": "...", "output_generation": 1 }` and returns the same shape. Speech-only cancellation is fenced to that playback and leaves the AI turn/actions running. Both operations are idempotent. Stop listening cancels local capture only; disconnect or closing a window is not cancellation. Already performed actions and charges are not assumed undone or refunded. Unmuting never resynthesizes or replays a turn.

For whole-turn cancellation, `accepted` and `too_late` describe cancellation of AI generation and actions. The server also attempts to stop speech linked to that turn, even when an action makes AI/action cancellation too late; the response does not include a separate result for that speech attempt. An accepted cancellation does not reverse an action or charge that already completed.

## Hands-free playback coordination

The new opt-in Socket.IO namespace `/desktop-ai` uses auth `{ "v": 1, "accessToken": "..." }` with the `desktop:connect` grant. Authentication failure is emitted as a Socket.IO connect error with message `unauthorized` and `data: { "code": "unauthorized" }`. It informs updated app clients of actual Bot, Pet and normal TTS audio, including output through a browser. `speech:snapshot` carries `{ "v":1, "revision":number, "server_time":number, "active":[activity] }` (at most one activity). `speech:prepare` and `speech:started` carry `{ "v":1, "revision":number, "server_time":number, ...activity }`; `speech:ended` adds `reason`. Each activity has `{ "playback_id":string, "output_generation":number, "source":"bot"|"pet"|"tts", "phase":"preparing"|"playing", "expires_at":number }`. The `speech:prepare` acknowledgement is `{ "v":1, "playback_id":string, "output_generation":number, "paused":true }`. Reset the revision baseline on the authoritative initial snapshot after each connection; socket recovery is disabled. No new event names are sent to old `/desktop` clients. An app using wake auto-submit must maintain this connection and fail closed on disconnect, reconnect, or a missing authoritative snapshot. It pauses microphone capture for all normal TTS, Pet, Bot, and browser audio at `speech:prepare`, then resumes only when the active set is empty and listening is still enabled, after a 300 ms tail. A 2-second preparation acknowledgement deadline applies; an unacknowledged subscriber prevents that playback. The server coordinates a single output owner; failure is reported rather than silently playing twice or changing the selected Pet player. No microphone audio is uploaded.

## Errors and uncertainty

Errors use `{ "error": "stable_code" }` and normal HTTP status codes, including `invalid_request`, `invalid_token`, `insufficient_scope`, `not_found`, `idempotency_conflict`, `output_unavailable`, and `temporarily_unavailable`; 429 carries `Retry-After`. Durable operation receipts fence provider calls, tools and billing. An unknown provider, billing, or external tool outcome is `indeterminate`; clients must not blindly retry it. This does not promise universal exactly-once behavior for external services.
