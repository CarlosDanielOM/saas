# AI Fetch Utilities - Timeout & Retry Plan

## Goal

Add timeout and retry logic to all AI API calls (OpenRouter + MiniMax) to handle transient failures gracefully.

## Timeouts (per client)

| Client | Timeout |
|--------|---------|
| OpenRouter | 30s |
| MiniMax | 60s |
| Embeddings | 20s |

## Retry Policy

- **Delays:** 1s → 3s → 5s (3 attempts total)
- **Retry on:** HTTP 429, 5xx
- **Do NOT retry on:** HTTP 400, 401, 403, 4xx client errors
- **Network errors** (ECONNRESET, ETIMEDOUT) count as retryable

## Files

### Create

**`src/utils/ai/fetch.utils.ts`**

```typescript
export interface RetryOptions {
  retries: number;           // number of retries (default: 3)
  delays: number[];          // backoff delays in ms (default: [1000, 3000, 5000])
  timeout: number;           // fetch timeout in ms
  retryOn: number[];         // HTTP status codes to retry on (default: [429, 500, 502, 503, 504])
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  retries: 3,
  delays: [1000, 3000, 5000],
  timeout: 30000,
  retryOn: [429, 500, 502, 503, 504]
};

export function createFetchWithRetry(options: Partial<RetryOptions>) {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  
  return async function fetchWithRetry(
    url: string,
    init?: RequestInit
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), opts.timeout);
    
    let lastError: Error;
    
    for (let attempt = 0; attempt <= opts.retries; attempt++) {
      try {
        const response = await fetch(url, {
          ...init,
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (attempt === opts.retries || !opts.retryOn.includes(response.status)) {
          return response;
        }
        
        // Retry on 429/5xx
        const delay = opts.delays[attempt] ?? opts.delays[opts.delays.length - 1];
        await sleep(delay);
        
      } catch (err) {
        lastError = err as Error;
        
        // AbortError means timeout - don't retry
        if (err instanceof DOMException && err.name === 'AbortError') {
          clearTimeout(timeoutId);
          throw new Error(`Request timed out after ${opts.timeout}ms`);
        }
        
        // Network errors are retryable
        if (attempt < opts.retries) {
          const delay = opts.delays[attempt] ?? opts.delays[opts.delays.length - 1];
          await sleep(delay);
        }
      }
    }
    
    clearTimeout(timeoutId);
    throw lastError!;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

### Modify

**1. `src/utils/ai/minimax/minimax_client.ts`**
- Import `createFetchWithRetry`
- Wrap the `fetch` call in `minimaxChat()`
- Pass `{ timeout: 60000, retries: 3 }`

**2. `src/utils/ai/openrouter/embeddings.ai.ts`**
- Import `createFetchWithRetry`
- Wrap fetch in `generateEmbedding()` and `generateEmbeddings()`
- Pass `{ timeout: 20000, retries: 3 }`

**3. `src/utils/ai/openrouter/messages.ai.ts`**
- Import `createFetchWithRetry`
- Wrap the OpenRouter fetch in `AiResponse()` (non-MiniMax path)
- Pass `{ timeout: 30000, retries: 3 }`

**4. `src/utils/ai/openrouter/command.ai.ts`**
- Import `createFetchWithRetry`
- Wrap the OpenRouter fetch in `executeAiCommand()` (non-MiniMax path)
- Pass `{ timeout: 30000, retries: 3 }`

**5. `src/utils/ai/openrouter/router.ai.ts`**
- Import `createFetchWithRetry`
- Wrap the OpenRouter fetch in `router()` for AI decision
- Pass `{ timeout: 30000, retries: 3 }`

## Implementation Order

1. Create `src/utils/ai/fetch.utils.ts`
2. Test utility in isolation (optional)
3. Update `minimax_client.ts` (simplest, most critical)
4. Update `embeddings.ai.ts` (two call sites)
5. Update `messages.ai.ts` (OpenRouter path only)
6. Update `command.ai.ts` (OpenRouter path only)
7. Update `router.ai.ts` (decision fetch)

## Verification

After each file:
- [x] Build passes (`npm run build` in dimabot)
- [x] No TypeScript errors
- [x] Existing tests pass (if any)

Final:
- [x] Full build passes
- [ ] Test manually with a mock/simulated timeout scenario

## Completed

- [x] Create `src/utils/ai/fetch.utils.ts`
- [x] Update `minimax_client.ts`
- [x] Update `embeddings.ai.ts`
- [x] Update `messages.ai.ts`
- [x] Update `command.ai.ts`
- [x] Update `router.ai.ts`
