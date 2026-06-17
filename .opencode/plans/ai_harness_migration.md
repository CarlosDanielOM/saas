# AI Harness Architecture Migration Plan

## Overview

Replace the two-stage router pipeline with a unified AI harness using OpenAI-compatible tool_calling.

## Current Architecture

```
router.ai.ts (decides action) → tool execution → messages.ai.ts (generates response)
     ↑                              ↑                        ↑
  1st AI call              search/code execution          2nd AI call
```

## New Architecture

```
ai.ts (harness)
├── Single AI call with tools parameter
├── Tool execution loop (if AI calls tool → execute → continue)
└── Returns final response
    ↑
User message → tools.json (tool definitions) → tools/*.ts (tool implementations)
```

## File Structure

```
dimabot/src/utils/ai/
├── tools.json                    # Tool definitions (schema)
├── tools/
│   ├── index.ts                  # Tool registry/loader
│   ├── search.tool.ts            # Web search implementation
│   └── code_execution.tool.ts    # Sandbox code execution
├── ai.ts                         # NEW: Main harness entry point
├── messages.ai.ts                # KEPT: Personality/context helpers
├── router.ai.ts                  # DELETED: Replaced by ai.ts
└── ...
```

## Implementation Steps

### Step 1: Create tools.json

Define tool schemas in OpenAI-compatible format:

```json
{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "search",
        "description": "Search the web for information",
        "parameters": {
          "type": "object",
          "properties": {
            "query": { "type": "string", "description": "The search query" }
          },
          "required": ["query"]
        }
      }
    },
    {
      "type": "function",
      "function": {
        "name": "code_execution",
        "description": "Execute JavaScript code in a sandbox",
        "parameters": {
          "type": "object",
          "properties": {
            "code": { "type": "string" },
            "request": { "type": "string", "description": "What the user wants" }
          },
          "required": ["code", "request"]
        }
      }
    }
  ]
}
```

### Step 2: Create tools/*.ts

Each tool is a module with:
- `name`: string matching the schema
- `execute(args)`: async function returning result

**tools/search.tool.ts** - Web search (from router.ai.ts search logic)
**tools/code_execution.tool.ts** - Sandbox execution (from router.ai.ts code logic)

### Step 3: Create tools/index.ts

- Loads tools.json
- Exports tool registry map
- Provides `executeTool(name, args)` function

### Step 4: Create ai.ts (THE HARNESS)

```typescript
export interface AIHarnessOptions {
  channelID: string;
  message: string;
  streamer: IStreamerData;
  history?: IChatHistoryMessage[];
  tags?: IChatMessageTags;
}

export async function chat(options: AIHarnessOptions): Promise<IRouterResponse> {
  // 1. Load tools from tools.json
  // 2. Build system message (from messages.ai.ts logic)
  // 3. Call OpenRouter with tools parameter
  // 4. If tool_calls in response → execute tool → add tool result to messages → continue
  // 5. Return final text response
}
```

Key features:
- Single API call with `tools` parameter
- Tool loop: execute tools when AI requests them
- Cost tracking via Polar.sh
- Model selection by tier
- Exhausted user handling

### Step 5: Update index.ts

Update exports to point to new ai.ts harness.

### Step 6: Update message.handler.ts

Change import from `router as aiRouter` to new `ai.chat()`.

### Step 7: Delete router.ai.ts

All logic moved to ai.ts.

## API Changes

### Old (router.ai.ts)
```typescript
const aiResponse = await aiRouter(
  channelID,
  message,
  '@preset/router',
  history,
  tags,
  [],
  streamer
);
```

### New (ai.ts)
```typescript
const aiResponse = await chat({
  channelID,
  message,
  streamer,
  history,
  tags
});
```

## Backward Compatibility

- `$(ai)` commands use `command.ai.ts` - separate path, no tools needed
- `messages.ai.ts` kept for helper functions (personality retrieval, system message building)

## Tool Schema Separation

Keeping schema (tools.json) separate from implementation (tools/*.ts) allows:
- Easy tool addition without code changes
- Schema validation
- Clear contract between AI and tool execution
