# Piper TTS rollout plan

## Goal

Add a server-owned TTS pipeline in `dimabot` that:

- uses Piper now for local VPS synthesis
- keeps FIFO ordering per channel
- rejects requests when the speech overlay is offline
- lets the bot sanitize/format text before enqueueing
- lets the server own queueing, synthesis, cleanup, and websocket delivery
- stays modular for future `tts.ai` and `tts.clone` providers/features

## Product surface

### V1 user-facing behavior

- Default provider: `piper`
- Default voices:
  - English: `en_US-ryan-medium`
  - Spanish: `es_MX-ald-medium`
- Overlay disconnected: reject immediately
- Queue model: FIFO, one active item per channel
- Default text filters:
  - skip emotes: `true`
  - strip links: `true`
  - normalize whitespace: `true`
  - cap length: `280` normalized characters
- Storage/output format: `wav`

### Command / AST surface

#### Chat commands

- Canonical command: `!tts <message>`
- Compatibility alias: keep existing `!s <message>` working during migration
- Future reserved commands:
  - `!ttsai <message>` or `!tts ai <message>`
  - `!ttsclone <clone_name> <message>` or `!tts clone <clone_name> <message>`

#### AST functions

- V1 default TTS:
  - `$(tts message)`
  - `$(tts.speak message)`
- Reserved future AST functions:
  - `$(tts.ai message)`
  - `$(tts.clone clone_name message)`

#### Tier behavior

- `tts` / `tts.speak`: available for all tiers when feature enabled
- `tts.ai`: reserved for `premium` and `pro`
- `tts.clone`: reserved for `pro`
- In V1, `tts.ai` and `tts.clone` should exist as recognized entry points but return a clean feature-not-available message until their providers are implemented

## Architecture

### Ownership split

- Bot:
  - parse command or AST function
  - sanitize message according to channel settings
  - resolve target mode (`speak`, `ai`, `clone`)
  - submit normalized request to server
- Server:
  - validate settings, tier, and overlay connection
  - enqueue request
  - synthesize audio with provider
  - serve audio URL
  - emit websocket playback event
  - cleanup files and queue state on finish/timeout/error
- Overlay:
  - connect to `/speech/:channelID`
  - receive playback payload
  - play `audioUrl`
  - emit `speech-ended`

### Provider abstraction

Create a provider interface first so future Runpod support does not change queue logic.

Suggested contract:

```ts
interface TtsSynthesisRequest {
  channelID: string;
  speechID: string;
  mode: 'speak' | 'ai' | 'clone';
  text: string;
  language: 'en' | 'es';
  voice: string;
  cloneName?: string;
}

interface TtsSynthesisResult {
  error: boolean;
  message: string;
  outputPath?: string;
  publicPath?: string;
  mimeType?: 'audio/wav';
  durationMs?: number;
}
```

Initial providers:

- `PiperTtsService`
- future placeholders:
  - `RunpodAiTtsService`
  - `RunpodCloneTtsService`

## Redis contract

Per channel keys:

- connection:
  - `twitch:${channelID}:tts:connected`
- processing:
  - `twitch:${channelID}:tts:processing`
- queue:
  - `twitch:${channelID}:tts:queue`
- queue item data:
  - `twitch:${channelID}:tts:queue:data:${speechID}`
- queue cleanup timestamp:
  - `twitch:${channelID}:tts:last_cleanup`
- optional settings cache later:
  - `twitch:${channelID}:tts:settings`

Queue item payload:

```ts
interface TtsQueueItem {
  speechID: string;
  channelID: string;
  source: 'chat-command' | 'ast';
  mode: 'speak' | 'ai' | 'clone';
  text: string;
  language: 'en' | 'es';
  voice: string;
  cloneName?: string;
  requestedBy?: {
    userID?: string;
    userLogin?: string;
    userName?: string;
    userLevel?: number;
  };
  meta?: {
    originalText?: string;
    skipEmotes?: boolean;
    stripLinks?: boolean;
  };
  timestamp: number;
}
```

## HTTP/API contract

### New server routes

#### `POST /speech/:channelID`

Purpose:

- accept bot-side normalized TTS requests

Request body:

```json
{
  "mode": "speak",
  "text": "hello chat",
  "language": "en",
  "requestedBy": {
    "userID": "123",
    "userLogin": "viewer",
    "userName": "Viewer",
    "userLevel": 1
  },
  "meta": {
    "source": "chat-command",
    "originalText": "Kappa hello",
    "skipEmotes": true,
    "stripLinks": true
  }
}
```

V1 accepted modes:

- `speak`
- `ai` and `clone` accepted structurally but return gated/unavailable until implemented

Success response:

```json
{
  "error": false,
  "message": "TTS queued successfully",
  "status": 200,
  "data": {
    "speechID": "A1B2C3",
    "mode": "speak",
    "queueLength": 2
  }
}
```

Common failure responses:

- `409` overlay offline
- `429` queue full
- `403` feature gated by tier
- `400` invalid request

#### `GET /speech/:channelID`

Purpose:

- serve speech overlay HTML page

#### `GET /speech/audio/:channelID/:speechID`

Purpose:

- serve generated audio file by `speechID`

Response:

- `audio/wav`

### Mounting

Add in `dimabot/src/server/server.ts`:

- `app.use('/speech', speechRoute);`

## Websocket contract

Namespace:

- `/speech/:channelID`

Server -> overlay event:

- `speech`

Payload:

```json
{
  "speechID": "A1B2C3",
  "audioUrl": "/speech/audio/123/A1B2C3",
  "mimeType": "audio/wav",
  "mode": "speak",
  "durationMs": 4200,
  "text": "hello chat"
}
```

Overlay -> server events:

- `speech-ended`
  - `{ "channelID": "123", "speechID": "A1B2C3" }`
- optional later `speech-error`
  - `{ "channelID": "123", "speechID": "A1B2C3", "reason": "playback_failed" }`

Connection behavior:

- websocket namespace owns only connection state and playback completion ack
- queue/pubsub ownership must not live inside the socket connection callback

## Queue lifecycle

### Request flow

1. Bot or AST path normalizes text
2. Bot calls `POST /speech/:channelID`
3. Server loads channel TTS settings
4. Server verifies:
   - channel exists
   - feature enabled
   - overlay connected
   - queue not full
   - tier allows requested mode
5. Server generates `speechID`
6. Server stores queue item in Redis sorted set + data key
7. If channel is idle, server starts processing immediately

### Processing flow

1. Pop oldest queue item
2. Mark `twitch:${channelID}:tts:processing`
3. Synthesize audio with provider
4. Emit `speech` payload to `/speech/:channelID`
5. Wait for `speech-ended` or timeout
6. Cleanup file + Redis item + processing flag
7. Process next item

### Timeout behavior

- Add a per-active-item timeout in handler
- Suggested V1 timeout: `durationMs + 5000` fallback, or fixed `30s` if duration unavailable
- On timeout:
  - cleanup item
  - continue queue

## Data model

### New schema

Add `dimabot/src/schemas/channel_tts_settings.schema.ts`

Suggested shape:

```ts
interface IChannelTtsSettings {
  channelID: string;
  channel: string;
  enabled: boolean;
  provider: 'piper';
  defaultLanguage: 'en' | 'es';
  voices: {
    en: string;
    es: string;
    aiDefault?: string | null;
  };
  filters: {
    skipEmotes: boolean;
    stripLinks: boolean;
    normalizeWhitespace: boolean;
    maxLength: number;
  };
  queue: {
    maxItems: number;
  };
  createdAt: Date;
  updatedAt: Date;
}
```

V1 defaults:

- `enabled: true`
- `provider: 'piper'`
- `defaultLanguage: 'es'`
- `voices.en: 'en_US-ryan-medium'`
- `voices.es: 'es_MX-ald-medium'`
- `filters.skipEmotes: true`
- `filters.stripLinks: true`
- `filters.normalizeWhitespace: true`
- `filters.maxLength: 280`
- `queue.maxItems: 5`

## File layout

### New backend files

- `dimabot/src/handlers/tts_queue.handler.ts`
- `dimabot/src/server/routes/speech.route.ts`
- `dimabot/src/server/services/tts/tts_provider.interface.ts`
- `dimabot/src/server/services/tts/piper_tts.service.ts`
- `dimabot/src/schemas/channel_tts_settings.schema.ts`
- `dimabot/src/utils/tts/normalize_tts_message.util.ts`
- `dimabot/src/utils/tts/generate_speech_id.util.ts`

### Existing backend files to update

- `dimabot/src/server/index.ts`
- `dimabot/src/server/server.ts`
- `dimabot/src/server/websocket.ts`
- `dimabot/src/classes/pubsub_manager.class.ts`
- `dimabot/src/commands/speech.command.ts`
- `dimabot/src/functions/chats/speech.chat.ts`
- `dimabot/src/config/commands/commands.json`
- `dimabot/src/config/commands/reservedcommands.json`
- `dimabot/src/utils/ast_parser/functions/index.ts`
- `dimabot/src/utils/ast_parser/functions/tts.functions.ts`
- `dimabot/src/utils/speech.ts`
- `dimabot/src/server/routes/public/speech.html`

### Existing frontend files to update later

- `dimasite/src/app/features/settings/settings-page.component.ts`
- add a TTS settings service and UI section

## AST implementation contract

### New AST registration file

- `dimabot/src/utils/ast_parser/functions/tts.functions.ts`

### Functions

#### `tts`

- Alias of `tts.speak`
- Usage: `$(tts hello world)`

#### `tts.speak`

- Usage: `$(tts.speak hello world)`
- Behavior:
  - submit default TTS request
  - return empty string on success so it acts like trigger/clip side-effect functions
  - return error message string on failure if needed

#### `tts.ai`

- Usage: `$(tts.ai hello world)`
- V1 behavior:
  - validate tier
  - return feature-not-available message until implemented

#### `tts.clone`

- Usage: `$(tts.clone narrator hello world)`
- V1 behavior:
  - validate tier
  - return feature-not-available message until implemented

### AST result style

- Follow `trigger.send` style in `dimabot/src/utils/ast_parser/functions/trigger.functions.ts`
- Return `''` on successful side-effect submission
- Return short human-readable string on failure

## Chat command implementation contract

### V1 command behavior

- `!tts hello world`
  - submit default `speak` mode
- `!s hello world`
  - compatibility alias to same handler

### Future command behavior

- `!tts ai hello world`
  - maps to mode `ai`
- `!tts clone narrator hello world`
  - maps to mode `clone` with `cloneName=narrator`

### Parsing rule

- If first arg after `tts` is `ai`, use mode `ai`
- If first arg after `tts` is `clone`, next token is clone name and rest is message
- Otherwise default to `speak`

## Sanitization contract

Bot-side normalizer should be reusable by command and AST callers.

Suggested steps:

1. trim
2. optionally remove emote tokens
3. replace URLs with `[link]`
4. collapse whitespace
5. remove control characters
6. cap to `maxLength`
7. if empty after cleanup, reject

Language selection rule:

- V1 default:
  - use channel/user preferred language if available
  - fallback to channel TTS default language
- Future:
  - optional auto language detection

## Overlay contract

### New speech overlay page

Replace legacy `speach.html` with `speech.html`.

Behavior:

- connect to `/speech/:channelID`
- on `speech`:
  - create audio element
  - set `src` to `audioUrl`
  - play
  - on `ended`, emit `speech-ended`
  - on `error`, emit `speech-ended` so queue keeps moving

No local synthesis, no queue logic in overlay.

## Cleanup contract

### File cleanup

- Generated files should live under a compiled/public-safe directory, for example:
  - `dist/server/routes/public/speech/`
- On normal completion:
  - delete file
- On timeout/error:
  - delete file
- On stream offline:
  - delete channel speech directory/files and queue data

### Replace legacy cleanup

Update `dimabot/src/utils/speech.ts` to:

- use new Redis key namespace `twitch:${channelID}:tts:*`
- remove dependency on legacy `src-js` path
- remove old `speach` typo usage

## Implementation phases

### Phase 1: Foundation

- add TTS settings schema
- add provider interface
- add Piper provider
- add speech ID generator and text normalizer

### Phase 2: Server queue

- add `tts_queue.handler`
- add pub/sub helpers
- initialize in `server/index.ts`
- add cleanup/timeouts

### Phase 3: API + websocket

- add `speech.route.ts`
- mount route
- refactor websocket `/speech/:channelID` to connection/ack only
- add audio serving endpoint

### Phase 4: Command + AST

- update `speech.command.ts` into canonical TTS handler flow
- repoint `speech.chat.ts` to new request contract
- add `tts.functions.ts`
- reserve `tts.ai` and `tts.clone`
- update command metadata JSON

### Phase 5: Overlay + cleanup

- replace speech overlay HTML
- update cleanup utility
- remove legacy event name mismatches

### Phase 6: Settings UI

- add backend settings endpoints
- add frontend settings UI for:
  - enabled
  - default language
  - English voice
  - Spanish voice
  - skip emotes
  - strip links
  - max length

## Risks / notes

- Do not subscribe to TTS pub/sub inside a websocket connection callback; that risks duplicate subscriptions.
- Keep queue ownership in one startup-initialized handler, mirroring clip queue architecture.
- Avoid serving stale files by rejecting requests when overlay is offline.
- Preserve compatibility with existing `!s` command while introducing `!tts` as the canonical command.
- `tts.ai` and `tts.clone` should be wired now at the API/AST layer but clearly marked unavailable until their providers exist.

## Recommended first build slice

Build in this order:

1. provider interface + Piper service
2. TTS queue handler
3. speech route + audio serving
4. websocket refactor + overlay page
5. command + AST integration
6. settings persistence and UI
