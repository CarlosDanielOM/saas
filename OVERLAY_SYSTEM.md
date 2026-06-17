# Custom Overlay System — Specification

## Overview

A modular overlay system with **standalone modules** (Clips, Triggers, Chat, Alerts) that each work independently OR can be linked together inside a **Custom Overlay** scene for a single combined OBS URL. Users build visual scenes with a drag-and-drop editor, configure event-driven hooks, and access via OBS browser source (copy URL → paste in OBS).

---

## Architecture Summary

### Module Types

The overlay system is built from **4 standalone modules** plus a **Custom Overlay** scene builder:

| Module | Standalone URL | Purpose | Has Own Canvas |
|--------|---------------|---------|----------------|
| Clips | `/overlays/clips/:channelID` | Clip queue display | No (simple player) |
| Triggers | `/overlays/triggers/:channelID` | Media trigger overlays | No (file-based) |
| Chat | `/overlays/chat/:channelID` | Chat overlay | Yes (full layered canvas) |
| Alerts | `/overlays/alerts/:channelID` | Follow/sub/cheer/raid alerts | Yes (full layered canvas) |
| **Custom Overlay** | `/overlays/custom/:channelID/scene/:sceneId` | User-built scene | Yes (drag-drop canvas) |

Each module has:
- **Own WebSocket namespace** for real-time updates
- **Own overlay HTML renderer** served publicly
- **Own hook engine integration** (subscribes to events it cares about)
- **Own scene builder UI** (for Chat and Alerts)

### Two Ways to Use Modules

**1. Standalone (independent OBS URL)**
```
User's OBS → /overlays/alerts/123 → Full alerts module, no custom scene
```
Each module runs independently with its own URL, own canvas, own hooks.

**2. Linked into Custom Overlay (combined URL)**
```
User's OBS → /overlays/custom/123/scene/main
                      │
                      ├── Linked: Alerts module (iframe reference)
                      ├── Linked: Chat module (iframe reference)
                      └── Custom: Text component (user-created)
```
A Custom Overlay scene can link to any combination of standalone modules, plus add custom components.

### Module Link Modes (inside Custom Overlay)

When a module is linked into a Custom Overlay scene, it works in one of two modes:

| Mode | How It Works | Use Case |
|------|-------------|-----------|
| **Iframe reference** | Custom Overlay renders `<iframe>` to the module's standalone URL | User wants module's full built-in UI, styling, and logic |
| **Data source** | Module emits events via hook engine → Custom Overlay components consume them | User wants full control over layout/styling of that module's content |

Example — Chat module:
- **Iframe:** Chat module renders its own styled message list in a frame
- **Data source:** Chat module emits `chat.message` events → Custom Overlay text components render messages with user-defined styling

Both modes can coexist in the same Custom Overlay scene.

### Module Transparency Rules

All modules (Clips, Triggers, Alerts, Chat) must render with **zero background** when idle — no white bars, no translucent containers, nothing visible when there's no active content. This allows proper z-index layering in Custom Overlay scenes.

**Key rules:**
1. **No default background** — module containers are transparent at all times
2. **Idle state = fully invisible** — OBS browser source sees through to layers below
3. **Active state = media only** — clip, trigger, or alert appears at its position without any wrapper or container background
4. **Overlapping modules** — since modules can be any size and position, users can overlap them intentionally (e.g., clips at top, triggers at bottom). Transparency ensures idle modules don't block content from modules below.

**Example layering in Custom Overlay:**
```
z-index 1:   Custom Text component (e.g., stream info)
z-index 5:   Clips module (iframe, 1920x200 at top) — shows clip when playing, invisible when idle
z-index 10:  Triggers module (iframe, 1920x400 at bottom) — shows trigger at defined position, invisible when idle
z-index 15:  Chat module (data-source) — text components consume chat events

When idle: z5 and z10 are completely invisible, z1 text shows through
When clip plays: z5 shows clip, rest stays invisible
When trigger fires: z10 shows trigger at its configured position, rest stays invisible
```

```
┌─────────────────────────────────────────────────────────────────────────┐
│  User's OBS Browser Source                                               │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  /overlays/custom/:channelID/scene/:sceneId  (served HTML)       │    │
│  │  ↕ Socket.IO WebSocket (auth on connect)                          │    │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────────┐  │    │
│  │  │  Iframe: Chat   │  │ Iframe: Alerts  │  │ Custom Text      │  │    │
│  │  │  (own canvas)   │  │  (own canvas)   │  │ Component        │  │    │
│  │  └─────────────────┘  └─────────────────┘  └──────────────────┘  │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  dimabot Backend                                                         │
│                                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────────┐  │
│  │ WebSocket    │  │ Hook Engine  │  │ Event Bus (all bot events)   │  │
│  │ Namespaces   │◄─┤              │◄─┤                              │  │
│  │ (per module) │  │ Rules → emit │  │ - EventSub (Twitch)          │  │
│  └──────────────┘  └──────────────┘  │ - Commands                   │  │
│                                      │ - Rewards                     │  │
│  ┌──────────────┐  ┌──────────────┐  │ - Triggers                   │  │
│  │ Route Layer  │  │ Scene Store  │  │ - TTS                        │  │
│  │ CRUD APIs    │─►│ (MongoDB)    │  │ - Chat messages              │  │
│  └──────────────┘  └──────────────┘  │ - Variable changes           │  │
│                                      └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Data Models

### OverlayScene

```typescript
interface OverlayScene {
  _id: ObjectId;
  channelID: string;
  name: string;
  slug: string;                    // URL-safe identifier
  components: OverlayComponent[]; // embedded component list
  moduleLinks: ModuleLink[];       // references to standalone modules
  isActive: boolean;
  visibility: 'private' | 'public';
  planTier: 'free' | 'premium' | 'pro';
  dimensions: { width: number; height: number };  // user-defined canvas size
  backgroundColor: string;
  createdAt: Date;
  updatedAt: Date;
}
```

### ModuleLink

```typescript
interface ModuleLink {
  id: string;                      // UUID
  moduleType: 'chat' | 'clips' | 'alerts' | 'triggers' | 'tts';
  linkMode: 'iframe' | 'data-source';  // iframe = embed module UI; data-source = consume module events
  
  // For iframe mode: optional position override (if null, module fills its container)
  position?: { x: number; y: number; width: number; height: number };
  zIndex: number;
  
  // For data-source mode: which event types to consume from this module
  consumedEvents?: string[];       // e.g., ['chat.message', 'chat.delete']
  
  // Module-specific scene to use (e.g., which alert layout)
  moduleSceneId?: string;
  
  // Module-specific config overrides when embedded
  config?: Record<string, any>;
}
```

**Example — Linking Alerts to Custom Overlay:**
```typescript
// Iframe mode: embed full Alerts module UI
{
  moduleType: 'alerts',
  linkMode: 'iframe',
  position: { x: 0, y: 0, width: 1920, height: 1080 },
  zIndex: 10,
  moduleSceneId: 'my-alert-layout',  // user's pre-built alert layout
}

// Data-source mode: consume follow events in custom components
{
  moduleType: 'alerts',
  linkMode: 'data-source',
  consumedEvents: ['channel.follow', 'channel.subscribe', 'channel.cheer'],
}
```

### OverlayComponent

```typescript
interface OverlayComponent {
  id: string;                      // UUID
  type: ComponentType;
  name: string;                    // human-readable label for editor
  position: { x: number; y: number; width: number; height: number };
  rotation?: number;
  scale?: { x: number; y: number };
  opacity?: number;
  zIndex: number;
  flip?: { horizontal: boolean; vertical: boolean };

  // Content/styling
  content: ComponentContent;
  style: Record<string, string>;   // CSS properties

  // Behavior
  persistenceMode: 'persistent' | 'ephemeral';
  ephemeralDuration?: number;       // ms before auto-hide
  transition?: {
    enter: string;
    enterDuration: number;
    exit: string;
    exitDuration: number;
  };

  // Data binding
  binding?: {
    eventType: string;             // e.g., 'follow', 'reward_redeem'
    fieldPath: string;            // e.g., 'data.displayName'
    template?: string;             // e.g., 'Thanks {{displayName}}!'
  };
}

type ComponentType =
  | 'text'
  | 'image'
  | 'video'
  | 'gif'
  | 'audio'
  | 'alert'
  | 'timer'
  | 'counter'
  | 'leaderboard'
  | 'tts-reader'
  | 'custom-html'
  | 'module-link';

type ComponentContent =
  | TextContent
  | ImageContent
  | VideoContent
  | GifContent
  | AlertContent
  | TimerContent
  | CounterContent
  | LeaderboardContent
  | TtsReaderContent
  | CustomHtmlContent;
```

### Component Content Types

```typescript
interface TextContent {
  text: string;
  fontSize: number;
  fontFamily: string;
  fontWeight: number;
  color: string;
  backgroundColor?: string;
  textAlign: 'left' | 'center' | 'right';
  verticalAlign: 'top' | 'middle' | 'bottom';
  lineHeight?: number;
  letterSpacing?: number;
  textShadow?: string;
  borderRadius?: number;
  padding?: number;
  overflow: 'hidden' | 'visible';
}

interface ImageContent {
  imageUrl: string;
  fit: 'cover' | 'contain' | 'fill';
  borderRadius?: number;
}

interface VideoContent {
  videoUrl: string;
  loop: boolean;
  muted: boolean;
  borderRadius?: number;
}

interface GifContent {
  gifUrl: string;
  fit: 'cover' | 'contain' | 'fill';
}

interface AlertContent {
  iconUrl?: string;
  titleTemplate: string;
  messageTemplate: string;
  backgroundColor: string;
  borderColor: string;
  textColor: string;
  borderRadius: number;
  iconPosition: 'left' | 'right';
  layout: 'horizontal' | 'vertical';
}

interface TimerContent {
  startTime?: number;             // Unix ms, null = manual start
  countDown: boolean;
  format: string;                  // e.g., 'HH:MM:SS'
  fontSize: number;
  fontFamily: string;
  color: string;
}

interface CounterContent {
  startValue: number;
  increment: number;
  label: string;
  fontSize: number;
  fontFamily: string;
  color: string;
  backgroundColor?: string;
  borderRadius?: number;
}

interface LeaderboardContent {
  source: string;                  // e.g., 'bits', 'subs', 'points'
  limit: number;
  title: string;
  fontSize: number;
  fontFamily: string;
  textColor: string;
  backgroundColor?: string;
  borderRadius?: number;
}

interface TtsReaderContent {
  maxLines: number;
  fontSize: number;
  fontFamily: string;
  color: string;
  backgroundColor?: string;
  borderRadius?: number;
  avatarUrl?: string;
}

interface CustomHtmlContent {
  html: string;                    // Pro only; sandboxed via iframe
  sandboxed: boolean;             // always true for security
}
```

### OverlayHook

```typescript
interface OverlayHook {
  _id: ObjectId;
  channelID: string;
  sceneId: ObjectId;

  name: string;
  isEnabled: boolean;
  priority: number;                // execution order

  trigger: {
    source: 'twitch' | 'bot' | 'custom';
    eventType: string;
    condition?: {
      field: string;
      operator: 'eq' | 'neq' | 'gt' | 'lt' | 'contains';
      value: any;
    };
  };

  actions: HookAction[];
}

interface HookAction {
  type: 'update-component' | 'show-component' | 'hide-component' | 'play-media' | 'trigger-tts' | 'reset-counter';
  targetComponentId?: string;
  payload?: Record<string, any>;
}
```

---

## Component Limits (Plan Tier)

| Tier | Max Components | Max Hooks | Custom HTML | Chat/Clips Module Links |
|------|---------------|-----------|-------------|------------------------|
| Free | 5 | 3 | No | No |
| Premium | 20 | 15 | No | Yes |
| Pro | Unlimited | Unlimited | Yes | Yes |

---

## Event Types & Hook Sources

### Free Tier — Twitch EventSub (webhook-based)
Published to `overlay:twitch:{channelId}:{eventType}`
- `channel.follow`
- `channel.subscribe`
- `channel.subscription.gift`
- `channel.cheer`
- `channel.raid`
- `channel.channel_points_custom_reward_redemption` (reward redemption = EventSub webhook)

### Premium/Pro — Bot Internal Events
Published to `overlay:bot:{channelId}:{eventType}`
- `custom.command` — custom command fired
- `trigger.activated` — media trigger activated
- `tts.started` — TTS playback began
- `tts.completed` — TTS playback ended
- `reward.created` — channel reward created
- `reward.updated` — channel reward updated
- `chat.message` — chat message (high-volume; Pro only for hooks)

### Premium/Pro — Variable Change Events
Published to `overlay:custom:{channelId}:variable.{storage}.{name}` and `overlay:custom:{channelId}:variable.{name}`

| Event Type | Trigger |
|-----------|---------|
| `variable.{name}` | Any storage change (memory, cache, or db) |
| `variable.memory.{name}` | Memory ($) variables only |
| `variable.cache.{name}` | Cache (#) variables only |
| `variable.db.{name}` | DB (*) variables only |

Examples: `variable.wins`, `variable.cache.wins`, `variable.db.wins`

### Pro Only — Custom Events
Published to `overlay:manual:{channelId}:{eventType}`
- `custom.{name}` — user-defined, pushed via `POST /overlay-events/:channelID/:sceneId/send`

---

## WebSocket Architecture

### Namespace: `/overlays/custom/:channelID`

**Connection flow:**
1. Client connects to `/overlays/custom/:channelID`
2. Client sends `authenticate` event with `{ sceneId, token? }`
3. Server validates:
   - Scene exists and belongs to channel
   - If scene is paywalled (premium/pro), user has appropriate tier
4. On success: server emits `scene-config` with full scene data
5. On failure: server emits `auth-error` and disconnects

**Client → Server events:**
- `authenticate` — `{ sceneId, token? }`
- `ping` — heartbeat
- `component-update` — live editor sync (optional)

**Server → Client events:**
- `scene-config` — full scene with components and module links
- `hook-triggered` — `{ hookId, eventType, eventData, actions }` — client updates components
- `pong` — heartbeat response

### OBS URL Format

```
http://localhost:3000/overlays/custom/:channelID/scene/:sceneId
```

URL is **public** (no token in URL). Auth happens inside the WebSocket connection via the `authenticate` event, which validates the user's session/tier server-side.

---

## Module Integration (Chat & Clips)

### Linked Reference Mode
- User adds a **ModuleLink** component to their scene
- The overlay HTML renders an `<iframe>` pointing to the module's own overlay URL
- The module runs independently with its own customization
- **Example:** User links the Chat module → chat renders in its own styled frame within the custom overlay

### Data Source Mode
- Chat module emits structured events via the hook engine
- Custom overlay text components bind to `chat.message` events
- User controls how messages are displayed (own styling, list layout, etc.)
- **Example:** User creates a text component bound to `chat.message` with template `{{username}}: {{message}}`

Both modes can be used in the same scene.

---

## API Routes

### Scene Management

| Method | Path | Description |
|--------|------|-------------|
| GET | `/overlay-scenes/:channelID` | List all scenes for channel |
| GET | `/overlay-scenes/:channelID/:sceneId` | Get single scene |
| POST | `/overlay-scenes/:channelID` | Create scene |
| PUT | `/overlay-scenes/:channelID/:sceneId` | Update scene |
| DELETE | `/overlay-scenes/:channelID/:sceneId` | Delete scene |
| POST | `/overlay-scenes/:channelID/:sceneId/duplicate` | Duplicate scene |

### Component Management

| Method | Path | Description |
|--------|------|-------------|
| POST | `/overlay-scenes/:channelID/:sceneId/components` | Add component |
| PUT | `/overlay-scenes/:channelID/:sceneId/components/:componentId` | Update component |
| DELETE | `/overlay-scenes/:channelID/:sceneId/components/:componentId` | Delete component |
| PUT | `/overlay-scenes/:channelID/:sceneId/components/reorder` | Reorder components (z-index) |

### Hook Management

| Method | Path | Description |
|--------|------|-------------|
| GET | `/overlay-hooks/:channelID/:sceneId` | List hooks for scene |
| POST | `/overlay-hooks/:channelID/:sceneId` | Create hook |
| PUT | `/overlay-hooks/:channelID/:sceneId/:hookId` | Update hook |
| DELETE | `/overlay-hooks/:channelID/:sceneId/:hookId` | Delete hook |

### Event Push (Manual / Custom)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/overlay-events/:channelID/:sceneId/send` | Push custom event to hook engine |

### OBS Preview

| Method | Path | Description |
|--------|------|-------------|
| GET | `/overlays/custom/:channelID/scene/:sceneId` | Serve overlay HTML (public) |

---

## Standalone Modules

### Overview

Each standalone module operates independently with its own OBS URL, WebSocket namespace, and (for Chat/Alerts) scene builder. They can also be linked into Custom Overlay scenes via `ModuleLink`.

| Module | OBS URL | WebSocket Namespace | Scene Builder |
|--------|---------|--------------------|--------------|
| Clips | `/overlays/clips/:channelID` | `/clips/:channelID` | No (queue-based) |
| Triggers | `/overlays/triggers/:channelID` | `/overlays/triggers/:channelID` | No (file-based) |
| Chat | `/overlays/chat/:channelID` | `/chat/:channelID` | **Yes** |
| Alerts | `/overlays/alerts/:channelID` | `/alerts/:channelID` | **Yes** |

### Alerts Module (`/overlays/alerts/:channelID`)

A full-featured alert system for follows, subs, gifts, cheers, and raids.

**WebSocket Events (Server → Client):**
- `alert` — `{ type, data, duration, layout }` — fires when a hook-matched event arrives

**Data Model:**
```typescript
interface AlertScene {
  _id: ObjectId;
  channelID: string;
  name: string;
  layers: AlertLayer[];           // layered canvas (z-index ordered)
  defaultDuration: number;         // ms before auto-dismiss
  isActive: boolean;
  planTier: 'free' | 'premium' | 'pro';
  createdAt: Date;
  updatedAt: Date;
}

interface AlertLayer {
  id: string;
  zIndex: number;
  type: 'image' | 'video' | 'text' | 'gif' | 'audio' | 'html';
  position: { x: number; y: number; width: number; height: number };
  rotation?: number;
  opacity?: number;
  flip?: { horizontal: boolean; vertical: boolean };
  content: AlertLayerContent;
  style: Record<string, string>;    // CSS properties
  // For text layers: supports {{variable}} substitution
  // For audio layers: supports {{SOUND}} variable for per-event sound override
}

type AlertLayerContent =
  | { text: string; fontSize: number; fontFamily: string; color: string; textAlign: 'left' | 'center' | 'right'; verticalAlign: 'top' | 'middle' | 'bottom'; lineHeight?: number; letterSpacing?: number; textShadow?: string; borderRadius?: number; padding?: number; overflow: 'hidden' | 'visible' }
  | { imageUrl: string; fit: 'cover' | 'contain' | 'fill' }
  | { videoUrl: string; loop: boolean; muted: boolean }
  | { gifUrl: string; fit: 'cover' | 'contain' | 'fill' }
  | { audioUrl: string; volume: number }
  | { html: string };
```

**Alert Types:**
Each alert type maps to a Twitch EventSub event and has preset variable fields:

| Alert Type | Event Type | Available Variables |
|------------|-----------|---------------------|
| Follow | `channel.follow` | `{{displayName}}`, `{{userId}}` |
| Subscribe | `channel.subscribe` | `{{displayName}}`, `{{tier}}`, `{{months}}` |
| Gift | `channel.subscription.gift` | `{{displayName}}`, `{{recipientName}}`, `{{tier}}`, `{{count}}` |
| Cheer | `channel.chear` | `{{displayName}}`, `{{bits}}`, `{{message}}` |
| Raid | `channel.raid` | `{{displayName}}`, `{{viewerCount}}` |

**Hook Integration:**
The Alerts module has its own internal hook engine (same architecture as Custom Overlay hooks) that:
1. Listens to `overlay:twitch:{channelId}:*` events
2. Matches against alert rules (e.g., "on channel.follow, show alert with follower's name")
3. Emits `alert` event to WebSocket with full scene data

Users configure alert rules via the Alerts scene builder UI, NOT via the generic hook system. This is a simplified, purpose-built hook UI within the Alerts module.

**Alert Rule Example:**
```typescript
interface AlertRule {
  id: string;
  alertType: 'follow' | 'subscribe' | 'gift' | 'cheer' | 'raid';
  isEnabled: boolean;
  sceneId: ObjectId;          // which AlertScene to display
  condition?: {              // optional: e.g., bits > 100
    field: string;
    operator: string;
    value: any;
  };
}
```

**OBS URL:**
```
http://localhost:3000/overlays/alerts/:channelID?scene=:sceneId
```

---

## Frontend Pages

### `/overlay-editor`
Main overlay builder interface.

**Layout:**
```
┌──────────────────────────────────────────────────────────────────────┐
│  Top Bar: Scene name | Preview | OBS URL copy | Save | Settings     │
├────────────┬─────────────────────────────────────────┬───────────────┤
│            │                                         │               │
│  Scene     │         Canvas Area                     │  Properties   │
│  List      │         (drag-drop grid)                │  Panel        │
│  Sidebar   │         - Component handles             │               │
│            │         - Selection outlines            │  - Position   │
│  + New     │         - Resize corners                │  - Style      │
│            │         - Grid snapping                │  - Content    │
│            │                                         │  - Binding    │
│            │                                         │  - Behavior   │
├────────────┴─────────────────────────────────────────┴───────────────┤
│  Component Palette (horizontal toolbar)                               │
│  [Text] [Image] [Video] [Alert] [Timer] [Counter] [Leaderboard]      │
│  [TTS Reader] [Custom HTML*]                                        │
│  * Pro only                                                          │
├─────────────────────────────────────────────────────────────────────┤
│  Module Links: [+ Add Chat] [+ Add Clips] [+ Add TTS] [+ Add Triggers]│
└─────────────────────────────────────────────────────────────────────┘
```

### Hook Manager (accessible from scene settings or tab)
- List of hooks with enable/disable toggle
- Create/edit hook modal:
  - Trigger source dropdown (Twitch / Bot / Custom)
  - Event type dropdown (populated from field registry)
  - Condition builder (optional)
  - Action chain: add actions → select component → configure payload
- Field binding helper:
  - Dropdown of common fields per event type
  - Freeform override for advanced users

### Field Registry
A registry maps event types to their available fields:
```typescript
const EVENT_FIELDS: Record<string, { label: string; path: string; type: string }[]> = {
  'channel.follow': [
    { label: 'Display Name', path: 'data.displayName', type: 'string' },
    { label: 'User ID', path: 'data.userId', type: 'string' },
    { label: 'Streamer', path: 'data.broadcasterName', type: 'string' },
  ],
  // ...auto-generated from registry, extensible
};
```

---

## Hook Engine Architecture

### Overview

The hook engine is a **long-lived background service** that subscribes to Redis pub/sub channels and matches incoming events against user-defined hook rules. It runs as a per-channel singleton (or global with channel filtering), listening continuously without HTTP request overhead.

```
┌─────────────────────────────────────────────────────────────────┐
│  Redis Pub/Sub Channels (all publish to same pattern)           │
│                                                                  │
│  overlay:twitch:{channelId}:*    ← Twitch EventSub events      │
│  overlay:bot:{channelId}:*       ← Internal bot events          │
│  overlay:custom:{channelId}:*     ← DB + Cache variable changes │
│  overlay:manual:{channelId}:*     ← Manual push via API          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Hook Engine Service                                             │
│                                                                  │
│  Subscribes to: overlay:twitch:* + overlay:bot:* +               │
│                 overlay:custom:* + overlay:manual:*             │
│                                                                  │
│  On message:                                                     │
│  1. Parse { channelId, eventType, data, timestamp }             │
│  2. Fetch cached hooks for that channelId (refreshed every 60s)  │
│  3. Match: hook.trigger.eventType === eventType                 │
│  4. Evaluate optional hook.trigger.condition                     │
│  5. Execute matched actions → emit to Socket.IO                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Socket.IO Namespace: /overlays/custom/{channelId}              │
│                                                                  │
│  Emit: hook-triggered { hookId, eventType, eventData, actions }│
└─────────────────────────────────────────────────────────────────┘
```

### Redis Channel Naming

| Channel Pattern | Source | Example Event |
|-----------------|--------|---------------|
| `overlay:twitch:{channelId}:{eventType}` | Twitch EventSub webhooks | `overlay:twitch:123:channel.follow` |
| `overlay:bot:{channelId}:{eventType}` | Internal bot events | `overlay:bot:123:custom.command` |
| `overlay:custom:{channelId}:{eventType}` | DB + Cache variable changes | `overlay:custom:123:variable.counter` |
| `overlay:manual:{channelId}:{eventType}` | Manual push via API | `overlay:manual:123:custom.myaction` |

### Event Payload Shape

All events published to Redis follow this envelope:

```typescript
interface OverlayEvent {
    channelId: string;
    eventType: string;
    data: Record<string, unknown>;
    timestamp: number;
}
```

### Event Sources & Publishing Points

#### 1. Twitch EventSub (`overlay:twitch:{channelId}:*`)
Published in `eventsub.route.ts` POST handler when a webhook is received and validated.

```typescript
// In POST /eventsub handler:
await pubsub.publish(`overlay:twitch:${channelId}:${eventType}`, {
    channelId,
    eventType,
    data: eventPayload,
    timestamp: Date.now()
});
```

#### 2. Bot Internal Events (`overlay:bot:{channelId}:*`)
Published at emission points throughout bot code:

| Bot Event | Channel | Data Fields |
|-----------|---------|-------------|
| Custom command fired | `overlay:bot:{id}:custom.command` | `{ command, user, args, result }` |
| Trigger activated | `overlay:bot:{id}:trigger.activated` | `{ triggerName, triggerId, user }` |
| TTS started | `overlay:bot:{id}:tts.started` | `{ speechId, text, voice, requestedBy }` |
| TTS completed | `overlay:bot:{id}:tts.completed` | `{ speechId, text }` |
| Reward redeemed | `overlay:bot:{id}:reward.redeemed` | `{ rewardTitle, rewardId, user, cost }` |
| Reward created | `overlay:bot:{id}:reward.created` | `{ rewardTitle, rewardId, cost }` |
| Reward updated | `overlay:bot:{id}:reward.updated` | `{ rewardTitle, rewardId, cost }` |
| Variable changed | `overlay:bot:{id}:variable.{name}` | `{ variableName, oldValue, newValue }` |
| Chat message | `overlay:bot:{id}:chat.message` | `{ username, displayName, message, userId }` (Pro only for hooks) |

#### 3. Variable Changes (`overlay:custom:{channelId}:*`)
Published in `evaluator.ts` `setVariable` function after successful write. **Storage type is included in the event type** to differentiate same-name variables with different storages (e.g., `#wins` vs `*wins`).

```typescript
// In setVariable(), after each storage type write:
// Publish TWO events per change:
// 1. storage-specific: variable.cache.{name}, variable.db.{name}, variable.memory.{name}
// 2. general: variable.{name} (any storage)

function publishVariableEvent(channelId: string, strippedName: string, storage: string, value: unknown) {
    const baseData = { variableName: strippedName, storage, newValue: value };
    
    // Storage-specific event (e.g., variable.cache.wins vs variable.db.wins)
    pubsub.publish(`overlay:custom:${channelId}:variable.${storage}.${strippedName}`, {
        channelId,
        eventType: `variable.${storage}.${strippedName}`,
        data: baseData,
        timestamp: Date.now()
    });
    
    // General event (e.g., variable.wins — matches any storage)
    pubsub.publish(`overlay:custom:${channelId}:variable.${strippedName}`, {
        channelId,
        eventType: `variable.${strippedName}`,
        data: baseData,
        timestamp: Date.now()
    });
}

// Usage in each case:
case 'memory':
    context.variables.set(strippedName, value);
    publishVariableEvent(context.broadcasterId, strippedName, 'memory', value);
    break;

case 'cache':
    // ... redis.set(key, value) ...
    publishVariableEvent(context.broadcasterId, strippedName, 'cache', value);
    break;

case 'db':
    await context.saveChannelVariable(strippedName, value);
    context.commandVariables.set(strippedName, value);
    publishVariableEvent(context.broadcasterId, strippedName, 'db', value);
    break;
```

**User hook examples:**
- Listen to `variable.cache.wins` → only cache (#wins) changes
- Listen to `variable.db.wins` → only DB (*wins) changes
- Listen to `variable.wins` → any wins change (cache, db, or memory)

**Note:** Variable change events are Pro-only for the hook engine.

#### 4. Manual Event Push (`overlay:manual:{channelId}:*`)
For users who want to trigger hooks via custom code, chat commands, or external tools:

```typescript
// POST /overlay-events/:channelID/:sceneId/send
// Body: { eventType: 'custom.myaction', data: { ... } }
app.post('/overlay-events/:channelID/:sceneId/send', (req, res) => {
    const { eventType, data } = req.body;
    pubsub.publish(`overlay:manual:${channelId}:${eventType}`, {
        channelId,
        eventType,
        data,
        timestamp: Date.now()
    });
    res.json({ sent: true });
});
```

### Hook Engine Caching

The hook engine maintains an in-memory cache of hook rules per channel, refreshed from MongoDB:
- **On startup:** load all hooks for all channels
- **Every 60 seconds:** refresh hooks for channels with active flag
- **On hook CRUD:** immediately invalidate and refresh for that channel

```typescript
class HookEngine {
    private cache: Map<string, OverlayHook[]> = new Map();

    async getHooks(channelId: string): Promise<OverlayHook[]> {
        if (!this.cache.has(channelId)) {
            await this.refreshChannel(channelId);
        }
        return this.cache.get(channelId) ?? [];
    }

    async refreshChannel(channelId: string): Promise<void> {
        const hooks = await OverlayHookModel.find({ channelId, isEnabled: true });
        this.cache.set(channelId, hooks);
    }
}
```

### Performance Optimization: Subscriber-Side Gating

The hook engine subscribes to Redis pub/sub channels **only for channels that have active overlay clients**. Redis pub/sub is fire-and-forget — if no subscriber is listening, messages are dropped silently with zero overhead.

**Publisher side:** Always publishes freely. No flag checks.
**Subscriber side:** Only subscribes to active channels.

```typescript
class HookEngine {
    private activeChannels: Set<string> = new Set();

    async subscribeChannel(channelId: string): Promise<void> {
        if (this.activeChannels.has(channelId)) return;
        this.activeChannels.add(channelId);
        
        // Subscribe to all event types for this channel
        await this.psubscribe(`overlay:twitch:${channelId}:*`);
        await this.psubscribe(`overlay:bot:${channelId}:*`);
        await this.psubscribe(`overlay:custom:${channelId}:*`);
        await this.psubscribe(`overlay:manual:${channelId}:*`);
    }

    async unsubscribeChannel(channelId: string): Promise<void> {
        if (!this.activeChannels.has(channelId)) return;
        this.activeChannels.delete(channelId);
        
        // Unsubscribe from all event types for this channel
        await this.punsubscribe(`overlay:twitch:${channelId}:*`);
        await this.punsubscribe(`overlay:bot:${channelId}:*`);
        await this.punsubscribe(`overlay:custom:${channelId}:*`);
        await this.punsubscribe(`overlay:manual:${channelId}:*`);
    }
}
```

**When overlay client connects (WebSocket):**
```typescript
// Start listening to this channel's events
await hookEngine.subscribeChannel(channelId);
```

**When last overlay client disconnects (WebSocket):**
```typescript
// Stop listening - Redis will drop all messages for this channel
await hookEngine.unsubscribeChannel(channelId);
```

**Result:**
- 1000 follows/sec on channel 999 (no OBS connected) → Redis drops all 1000 silently
- Same channel with OBS connected → hook engine receives all 1000 events
- No per-event Redis GET calls, no flag checks on publisher side

**Impact:**
- No pub/sub traffic for channels with no hooks configured
- No pub/sub traffic when OBS/browser source is not connected
- Hook engine only subscribes to channels that have active flags (or wildcard-subscribes and filters)
- Flag check is a single fast Redis GET before each publish

**Connection tracking:**
```typescript
// On overlay client connect (WebSocket):
const hookCount = await OverlayHookModel.countDocuments({ channelId, isEnabled: true });
if (hookCount > 0) {
    await redis.set(`overlay:active:${channelId}`, '1');
}

// On overlay client disconnect (WebSocket):
const remaining = await getConnectedOverlayClientCount(channelId); // from existing connection tracking
if (remaining === 0) {
    await redis.del(`overlay:active:${channelId}`);
}
```

### Condition Evaluation

Hooks support optional conditions that filter when actions fire:

```typescript
interface HookCondition {
    field: string;       // e.g., 'data.bits' or 'data.variableName'
    operator: 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains';
    value: any;
}

function evaluateCondition(condition: HookCondition, eventData: Record<string, unknown>): boolean {
    const fieldValue = getNestedValue(eventData, condition.field);
    switch (condition.operator) {
        case 'eq': return fieldValue === condition.value;
        case 'neq': return fieldValue !== condition.value;
        case 'gt': return Number(fieldValue) > Number(condition.value);
        case 'lt': return Number(fieldValue) < Number(condition.value);
        case 'gte': return Number(fieldValue) >= Number(condition.value);
        case 'lte': return Number(fieldValue) <= Number(condition.value);
        case 'contains': return String(fieldValue).includes(String(condition.value));
    }
}
```

---

## Technical Stack

| Layer | Technology |
|-------|-----------|
| Backend WebSocket | Socket.IO (existing `getIO()` pattern) |
| Event Bus | `PubSubManager` (Redis pub/sub) + new overlay channels |
| Database | MongoDB (via existing Mongoose setup) |
| Frontend Framework | Angular v21 (Standalone, Signals) |
| Drag & Drop | `@angular/cdk/drag-drop` |
| Overlay Rendering | DOM-based HTML + CSS (OBS browser source compatible) |
| Real-time Preview | Socket.IO client in editor |

---

## Implementation Phases

### Phase 1: Foundation
- [ ] `overlay-scene.schema.ts` — MongoDB schema for scenes
- [ ] `overlay-scene.route.ts` — Scene CRUD API routes
- [ ] `websocket.ts` — Add `/overlays/custom/:channelID` namespace
- [ ] `overlay.html` — Base overlay HTML renderer (public, no auth on HTTP)
- [ ] WebSocket `authenticate` flow with tier validation
- [ ] Serve scene config on authenticated connection

### Phase 2: Component System
- [ ] Component CRUD API
- [ ] Angular component palette UI
- [ ] Drag-drop canvas with Angular CDK
- [ ] Properties panel (position, style, content, behavior, binding)
- [ ] Canvas renders components from scene config
- [ ] Component limit enforcement by plan tier

### Phase 3: Module Links + Alerts Module
- [ ] `module-link` component type in schema with `linkMode` (iframe/data-source)
- [ ] Module link picker UI (Chat, Clips, Alerts, TTS, Triggers)
- [ ] Overlay renderer handles `<iframe>` embedding for module links
- [ ] Module link positioning/sizing in canvas

#### Alerts Module (new standalone)
- [ ] `alert-scene.schema.ts` — MongoDB schema for alert scenes
- [ ] `alert-rule.schema.ts` — MongoDB schema for alert rules
- [ ] `alerts.route.ts` — Alert scene + rule CRUD API routes
- [ ] `websocket.ts` — Add `/alerts/:channelID` namespace
- [ ] `alerts.html` — Alerts overlay HTML renderer
- [ ] Alert internal hook engine (simplified, purpose-built for alert rules)
- [ ] Alert rule matcher: matches `overlay:twitch:*` events to alert rules
- [ ] Angular Alerts module editor (layered canvas, alert type picker, rule builder)

### Phase 4: Hook Engine
- [ ] `overlay-hook.schema.ts` — MongoDB schema for hooks
- [ ] `overlay-hook.route.ts` — Hook CRUD API routes
- [ ] `HookEngine` class — Redis pub/sub subscriber, matcher, action dispatcher
- [ ] Hook cache with 60s refresh + immediate invalidation on CRUD
- [ ] Condition evaluator (eq, neq, gt, lt, gte, lte, contains)
- [ ] Add `pubsub.publish()` to EventSub route for `overlay:twitch:*` channels
- [ ] Add `pubsub.publish()` to bot event emission points for `overlay:bot:*` channels
- [ ] Add `pubsub.publish()` to `setVariable()` in evaluator.ts for `overlay:custom:*` channels
- [ ] `POST /overlay-events/:channelID/:sceneId/send` for manual/custom event push

### Phase 5: Hook UI
- [ ] Hook manager UI in frontend
- [ ] Trigger source + event type selector
- [ ] Condition builder
- [ ] Action chain configurator
- [ ] Field registry with dropdown + freeform override
- [ ] Hook limit enforcement by plan tier

### Phase 6: Polish
- [ ] Scene duplication
- [ ] Scene import/export (JSON)
- [ ] Undo/redo in editor
- [ ] OBS URL copy with one-click
- [ ] Real-time preview in editor (Socket.IO connected)
- [ ] Template gallery (pre-built layouts)

---

## Open Questions (Deferred)

1. **Scene sharing / marketplace** — Not in scope initially. If added later:
   - Users can share scenes publicly
   - Marketplace for paid templates (30% platform cut)
   - Access control: free/premium/pro scene visibility

2. **Scene versioning** — Not planned initially. If needed, add `version` field and history array.

---

## Dependencies on Existing Code

### Backend (dimabot)
- `dimabot/src/server/websocket.ts` — Extend with new `/overlays/custom/:channelID` namespace
- `dimabot/src/server/server.ts` — Mount new overlay routes
- `dimabot/src/server/routes/` — New route files (`overlay-scene.route.ts`, `overlay-hook.route.ts`, `overlay-event.route.ts`)
- `dimabot/src/server/routes/eventsub.route.ts` — Add `pubsub.publish()` for Twitch EventSub events
- `dimabot/src/classes/PubSubManager.class.ts` — Add `publishOverlayEvent()` helper (or use existing `publish()`)
- `dimabot/src/utils/ast_parser/evaluator.ts` — Add `pubsub.publish()` in `setVariable()` for all storage types
- `dimabot/src/classes/` — Bot event emission points (command handler, trigger handler, TTS handler) for `overlay:bot:*` channels

### Frontend (dimasite)
- `dimasite/src/app/features/` — New `overlay-editor` module with scene manager, canvas, properties panel, hook manager
- `dimasite/src/assets/i18n/en.json` + `es.json` — Translation keys for overlay editor UI

---

## Out of Scope (v1)

- Native OBS WebSocket plugin (browser source only)
- Scene marketplace / public sharing
- Collaborative editing
- Server-side rendering of overlay (client-side DOM only)
- Video encoding / transcoding (links to existing media only)
