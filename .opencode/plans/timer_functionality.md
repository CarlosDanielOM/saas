# Timer Functionality Implementation Plan

## Overview

Custom timers that send messages every X minutes (5-minute increments) when the streamer is live. Supports command references via `#(commandName)` syntax with optional arguments.

## Architecture

### 1. Database Schema

**File**: `dimabot/src/schemas/custom_timer.schema.ts`

```typescript
interface ICustomTimer {
    _id: Types.ObjectId;
    name: string;              // Timer name (unique per channel)
    message: string;           // Message with optional #(cmd) references
    frequency: number;         // Heartbeats (1 = 5min, 6 = 30min, 12 = 60min)
    channel: string;           // Streamer login
    channelID: string;         // Streamer ID
    created_at: Date;
    updated_at: Date;
    active: boolean;           // If false, won't load on stream online
}
```

### 2. Plan Tier Limits

| Tier   | Min Frequency | Max Frequency | Max Timers |
|--------|---------------|---------------|------------|
| Free   | 1 (5 min)     | 12 (60 min)   | 5          |
| Premium| 1 (5 min)     | 72 (360 min)  | 15         |
| Pro    | 1 (5 min)     | 288 (1440 min)| 50         |

### 3. Command Reference System `#()`

**Parser Logic**:
- Pattern: `#(commandName)` or `#(commandName arg1 arg2 ...)`
- Replace with the command's response
- Arguments passed to the command as if user typed `!commandName arg1 arg2`
- **If command not found**: Skip silently (remove the #() reference, keep rest of text)

**Examples**:
- `#(rewards)` → executes rewards command, returns response
- `#(shoutout someuser)` → executes shoutout with argument
- `#(shoutout channel) Because we love him.` → command response + custom text
- `#(nonexistent) Hello!` → `Hello!` (command not found, skipped silently)

### 4. Cron Worker Architecture

**File**: `dimabot/src/workers/timer.worker.ts`

**Heartbeat System**:
- Runs every 5 minutes
- Each timer has a `heartbeat` counter stored in Redis
- On each tick: increment heartbeat
- When heartbeat >= frequency: send message, reset heartbeat to 0

**Redis Keys**:
- `timer:active` - Set of channelIDs with active timers in memory
- `timer:channel:{channelID}:timers` - Hash of timerID -> timer data
- `timer:channel:{channelID}:heartbeat:{timerID}` - Current heartbeat count

**Flow**:
1. On startup: do NOT load any timers (wait for stream online events)
2. Every 5 minutes:
   - For each channel in `timer:active`:
     - For each timer in channel's timer set:
       - Increment heartbeat
       - If heartbeat >= frequency:
         - Parse message, resolve `#()` references
         - Send chat message
         - Reset heartbeat to 0

### 5. Stream Event Integration

**File**: `dimabot/src/handlers/stream_online.handler.ts`

Add after existing logic:
```typescript
await loadChannelTimersIntoCache(broadcaster_user_id);
```

**File**: `dimabot/src/handlers/stream_offline.handler.ts`

Add after existing logic:
```typescript
await unloadChannelTimersFromCache(broadcaster_user_id);
```

### 6. Chat Commands

#### `!cct` - Create Custom Timer
**Usage**: `!cct <name> <frequency> <message>`

**Example**: `!cct mytimer 6 This runs every 30 minutes!`
**Example with command**: `!cct shoutoutTimer 12 #(shoutout cdom201) Check him out!`

**Validation**:
- Name: alphanumeric, underscores, max 30 chars
- Frequency: integer within tier limits
- Message: max 350 characters
- Enforce max timers per tier

#### `!ect` - Edit Custom Timer
**Usage**: `!ect <name> [frequency] [message]`

**Variants**:
- `!ect mytimer 10` → Change frequency only (50 min)
- `!ect mytimer New message text` → Change message only (first arg is not a number)
- `!ect mytimer 5 New message` → Change both (first arg is number)

**Detection**: If first argument after name is a valid number, treat as frequency, rest is message.

#### `!dct` - Delete Custom Timer
**Usage**: `!dct <name>`

#### `!lt` - List Timers
**Usage**: `!lt` → Lists all timers for the channel

### 7. HTTP API Routes

**File**: `dimabot/src/server/routes/timer.route.ts`

All routes require auth middleware.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/timers/:channelID` | List all timers for channel |
| POST | `/timers/:channelID` | Create new timer |
| PATCH | `/timers/:channelID/:timerID` | Update timer (partial) |
| DELETE | `/timers/:channelID/:timerID` | Delete timer |
| PATCH | `/timers/:channelID/:timerID/toggle` | Toggle active status |

**Request/Response Bodies**:
```typescript
// POST /timers/:channelID
{
    name: string;
    message: string;
    frequency: number;
    active?: boolean;
}

// Response
{
    error: boolean;
    message: string;
    status: number;
    data?: ICustomTimer;
}
```

## Implementation Order

### Phase 1: Core Schema & Command Reference Parser
1. Create `custom_timer.schema.ts`
2. Create `#()` parser utility in `src/utils/timer_reference_parser.ts`

### Phase 2: Timer Manager Functions
1. Create `src/commands/timer_manager.command.ts` with:
   - `createTimer(channelID, name, frequency, message)`
   - `editTimer(channelID, name, frequency?, message?)`
   - `deleteTimer(channelID, name)`
   - `listTimers(channelID)`

### Phase 3: HTTP API Routes
1. Create `timer.route.ts`
2. Register in `server.ts`

### Phase 4: Cron Worker
1. Create `src/workers/timer.worker.ts`
2. Register in `src/workers/cron.index.ts`
3. Implement heartbeat logic
4. Implement message sending with `#()` resolution

### Phase 5: Stream Event Integration
1. Modify `stream_online.handler.ts` to load timers
2. Modify `stream_offline.handler.ts` to unload timers
3. Create utility functions for cache management

### Phase 6: Chat Commands
1. Add reserved commands in config:
   - `!cct` → `createCustomTimer`
   - `!ect` → `editCustomTimer`
   - `!dct` → `deleteCustomTimer`
   - `!lt` → `listTimers`
2. Add handlers in `message.handler.ts`

## Files to Create/Modify

### New Files
- `src/schemas/custom_timer.schema.ts`
- `src/utils/timer_reference_parser.ts`
- `src/commands/timer_manager.command.ts`
- `src/workers/timer.worker.ts`
- `src/server/routes/timer.route.ts`

### Modified Files
- `src/workers/cron.index.ts` - Register timer worker
- `src/handlers/stream_online.handler.ts` - Load timers
- `src/handlers/stream_offline.handler.ts` - Unload timers
- `src/handlers/message.handler.ts` - Add command handlers
- `src/config/commands/default.commands.json` - Add reserved commands
- `src/config/commands/reservedcommands.json` - Add reserved commands
- `src/server/server.ts` - Mount timer routes

## Edge Cases & Considerations

1. **Timer name collision**: Enforce unique names per channel
2. **Command not found in #()**: Skip silently, keep remaining text
3. **Circular command references**: Commands shouldn't reference timers (no risk)
4. **Stream goes offline mid-heartbeat**: Heartbeat persists but won't execute until online
5. **Timer disabled while live**: Remove from cache, re-add if re-enabled
6. **Multiple timers same frequency**: Each has independent heartbeat
7. **Bot restart during stream**: Need to check live status on startup and load timers

## Testing Checklist

- [ ] Create timer with valid data
- [ ] Create timer with invalid frequency (tier limits)
- [ ] Create timer when at max limit (should fail)
- [ ] Edit timer frequency only
- [ ] Edit timer message only  
- [ ] Edit both frequency and message
- [ ] Delete timer
- [ ] List timers
- [ ] `#(command)` resolution
- [ ] `#(command args)` resolution with arguments
- [ ] `#(nonexistent)` skipped silently
- [ ] Mixed `#()` and plain text
- [ ] Timer doesn't fire when stream offline
- [ ] Timer fires at correct frequency when live
- [ ] Multiple timers with different frequencies
- [ ] Plan tier limits enforced
- [ ] Active/inactive toggle behavior
- [ ] API routes return correct responses
