# OAuth Failure Request Caching Plan

## Objective
Cache full request options (URL, headers, body) to Redis when OAuth errors occur, enabling post-mortem debugging of "invalid oauth" errors even when the bot claims to have a valid token.

## Scope
- **API Call Failures**: When 401 persists after all retry attempts in `twitch_helix_retry.ts`
- **Token Refresh Failures**: When `refreshTwitchToken()` fails permanently or transiently

## Redis Configuration
- **Backend**: DragonflyDB (same as existing token cache)
- **TTL**: 24 hours (86400 seconds) for all failure entries
- **Key Prefix**: `oauth:failures:api:` and `oauth:failures:token_refresh:`

---

## Files to Create

### 1. `src/utils/oauth_debug_cache.ts` (NEW)

Purpose: Centralized utility for caching OAuth failures to Redis.

```typescript
interface OAuthAPIFailureData {
  timestamp: string;
  endpoint: string;           // e.g., "channels/followers"
  url: string;                // full URL with query params
  method: string;             // GET, POST, etc.
  headers: Record<string, string>;  // Authorization header VALUE ONLY (not full Bearer token)
  clientId: string;
  responseStatus: number;
  responseBody: string;        // truncated if large
  worker?: string;
  operation?: string;
  channelID?: string;
  context?: Record<string, unknown>;
}

interface OAuthTokenRefreshFailureData {
  timestamp: string;
  userID: string;
  refreshTokenPrefix: string;  // first 8 chars of refresh token for identification
  failureKind: 'permanent_failure' | 'transient_failure';
  failureReason: string;
  status: number;
  responseBody: string;
  endpoint: string;            // what API call triggered this refresh
  url: string;
}

// Functions:
// - cacheOAuthAPIFailure(failure: OAuthAPIFailureData): Promise<void>
// - cacheOAuthTokenRefreshFailure(failure: OAuthTokenRefreshFailureData): Promise<void>
```

Redis keys:
- API failures: `oauth:failures:api:{timestamp_ms}`
- Token refresh failures: `oauth:failures:token_refresh:{timestamp_ms}`

---

## Files to Modify

### 2. `src/utils/twitch_helix_retry.ts`

**Changes:**
- Add optional `requestUrl?: string` field to `HelixRetryOptions`
- Add optional `requestMethod?: string` field (default `'GET'`)
- When 401 persists after all retries (line 58-66):
  - Extract URL and method from the wrapped `executeRequest`
  - Capture response status and body text
  - Call `cacheOAuthAPIFailure()` with full details

**Interface Changes:**

```typescript
interface HelixRetryOptions {
  worker?: string;
  operation?: string;
  context?: Record<string, unknown>;
  retryDelaysMs?: number[];
  executeRequest: () => Promise<Response>;
  onUnauthorized: (attempt: number) => Promise<void>;
  requestUrl?: string;       // NEW
  requestMethod?: string;     // NEW, default 'GET'
}
```

**Updated Call Sites in same file:**
- `executeHelixAppRequestWith401Retry` - pass through `requestUrl`/`requestMethod`
- `executeHelixBotRequestWith401Retry` - pass through `requestUrl`/`requestMethod`
- `executeHelixStreamerRequestWith401Retry` - pass through `requestUrl`/`requestMethod`

### 3. `src/utils/tokens.ts`

**Changes:**
- Add optional `context?: { endpoint?: string; url?: string }` parameter to `refreshTwitchToken`
- When refresh fails (lines 165-191):
  - Call `cacheOAuthTokenRefreshFailure()` with failure details
  - Include the endpoint/URL that triggered this refresh if provided

```typescript
export const refreshTwitchToken = async (
  refresh_token: string,
  user_id: string,
  context?: { endpoint?: string; url?: string }
): Promise<RefreshTwitchTokenResult>
```

### 4. `src/classes/twitch_streamers.class.ts`

**Changes:**
- Update call to `refreshTwitchToken` at line 170 to pass endpoint context:
  ```typescript
  const refreshResult = await refreshTwitchToken(refreshToken, id, {
    endpoint: 'token_refresh',
    url: 'https://id.twitch.tv/oauth2/token'
  });
  ```

---

## Caller Updates (Pass Request URL/Method)

### 5. `src/utils/follow_ledger.ts`

**Line ~195** - `executeHelixStreamerRequestWith401Retry` call:
```typescript
const request = await executeHelixStreamerRequestWith401Retry({
  worker: 'follow_ledger',
  operation: 'fetch_followers_page',
  channelID,
  context: { cursor },
  requestUrl: getTwitchHelixUrl('channels/followers', params.toString()),
  requestMethod: 'GET',
  executeRequest: async (headers) => fetch(...)
});
```

**Line ~256** - similar update for second call.

### 6. `src/utils/siteanalytics.ts`

**Line ~235** - `executeHelixAppRequestWith401Retry` for `fetch_live_streams_by_channel_ids`:
```typescript
requestUrl: getTwitchHelixUrl('streams', params.toString()),
requestMethod: 'GET',
```

**Line ~287** - `executeHelixAppRequestWith401Retry` for `fetch_profile_images_by_ids`:
```typescript
requestUrl: getTwitchHelixUrl('users', params.toString()),
requestMethod: 'GET',
```

### 7. `src/utils/ast_parser/functions/followage.functions.ts`

**Line ~33** - `executeHelixStreamerRequestWith401Retry`:
```typescript
requestUrl: getTwitchHelixUrl('channels/followers', params.toString()),
requestMethod: 'GET',
```

---

## Redis Data Shapes

### API Failure Entry
```json
{
  "timestamp": "2026-03-30T12:00:00.000Z",
  "endpoint": "channels/followers",
  "url": "https://api.twitch.tv/helix/channels/followers?broadcaster_id=123&user_id=456",
  "method": "GET",
  "headers": {
    "Client-Id": "abc123...",
    "Authorization": "Bearer <token_length:45>",
    "Content-Type": "application/json"
  },
  "responseStatus": 401,
  "responseBody": "{\"error\":\"Unauthorized\",\"message\":\"invalid oauth token\"}",
  "worker": "follow_ledger",
  "operation": "fetch_followers_page",
  "channelID": "123",
  "context": { "cursor": "abc" }
}
```

### Token Refresh Failure Entry
```json
{
  "timestamp": "2026-03-30T12:00:00.000Z",
  "userID": "123456",
  "refreshTokenPrefix": "abc12345",
  "failureKind": "permanent_failure",
  "failureReason": "invalid refresh token",
  "status": 400,
  "responseBody": "{\"error\":\"invalid_grant\",\"error_description\":\"invalid refresh token\"}",
  "endpoint": "channels/followers",
  "url": "https://id.twitch.tv/oauth2/token"
}
```

---

## Implementation Order

1. Create `src/utils/oauth_debug_cache.ts` (new utility)
2. Modify `src/utils/twitch_helix_retry.ts` (core retry + caching)
3. Modify `src/utils/tokens.ts` (token refresh failure caching)
4. Update `src/classes/twitch_streamers.class.ts` (pass context to refresh)
5. Update `src/utils/follow_ledger.ts` (pass URL/method)
6. Update `src/utils/siteanalytics.ts` (pass URL/method)
7. Update `src/utils/ast_parser/functions/followage.functions.ts` (pass URL/method)
8. Build and verify TypeScript compiles

---

## Debugging Commands (Post-Implementation)

```bash
# List all API failures
redis-cli KEYS "oauth:failures:api:*"

# List all token refresh failures
redis-cli KEYS "oauth:failures:token_refresh:*"

# Get a specific failure
redis-cli GET "oauth:failures:api:1743340800000"

# Get all failures from last hour
redis-cli --scan --pattern "oauth:failures:*" | head -20
```

---

## Notes

- Authorization header values are stored as `Bearer <length:XX>` to avoid logging actual tokens
- Response bodies are stored as-is but callers should be aware they may be truncated for very large responses
- The TTL is set to 24h - failures auto-expire to prevent Redis bloat
- No PII beyond user ID prefixes is stored
