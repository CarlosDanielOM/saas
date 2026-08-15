/**
 * Shared AI Constants
 *
 * Model tiers and token limits used across AI modules.
 */

export const MODELS = {
  free: "deepseek/deepseek-v4-flash-0731",
  exhausted: "sao10k/l3-lunaris-8b:nitro",
  premium: "deepseek/deepseek-v4-flash-0731",
  pro: "deepseek/deepseek-v4-flash-0731",
} as const;

// Background LLM models for stream summaries and weekly maintenance
// Free tier uses same as chat model, Premium/Pro use better models
export const BACKGROUND_MODELS = {
  free: "qwen/qwen3-235b-a22b-2507",
  premium: "deepseek/deepseek-v4-flash-0731",
  pro: "deepseek/deepseek-v4-pro",
} as const;

// Fallback model for pro users if v4-pro fails
export const BACKGROUND_MODEL_FALLBACK = "deepseek/deepseek-v4-flash-0731";

/**
 * Per-model upstream provider restrictions for OpenRouter.
 *
 * DeepSeek applied a permanent 75% price cut on v4 Pro on the deepseek provider,
 * while other OpenRouter providers (deepinfra, fireworks, digitalocean, etc.)
 * still charge the original list price — a 3-5x markup. Pinning v4 Pro to the
 * `deepseek` provider avoids that markup.
 *
 * v4-flash is intentionally NOT pinned here:
 *   - the cost gap does not exist for v4-flash across providers, and
 *   - v4-flash is used in user-facing chat where locking to a single upstream
 *     provider could add latency or reduce availability.
 *
 * Consumers that build an OpenRouter request body should call
 * `getProviderRestriction(model)` and, if it returns a value, attach
 * `body.provider = { only: [...restriction.only] }`.
 */
export const MODEL_PROVIDER_RESTRICTIONS: Readonly<Record<string, { only: readonly string[] }>> = {
    "deepseek/deepseek-v4-pro": { only: ["deepseek"] },
};

export function getProviderRestriction(model: string): { only: readonly string[] } | undefined {
    return MODEL_PROVIDER_RESTRICTIONS[model];
}

export const TOKEN_LIMITS = {
  default: 25000,
} as const;

export const CODING_MODELS = {
  pro: "google/gemini-2.5-flash-lite",
  premium: "google/gemini-2.5-flash-lite",
  free: "z-ai/glm-4.5-air:nitro",
  exhausted: "z-ai/glm-4.5-air",
} as const;

export const MINIMAX_MODEL = "MiniMax-M2.7-highspeed";
export const MINIMAX_BASE_URL = "https://api.minimax.io/anthropic";
export const MINIMAX_COST_PER_M_INPUT = 0.6;
export const MINIMAX_COST_PER_M_OUTPUT = 2.4;

export const DEFAULT_TIMEOUT_MS = 8000;

// Self-hosted LFM2.5-Embedding-350M is the only embedding model we use.
// It produces 1024-dim L2-normalized vectors served by the
// `lfm2.5-embeddings` container on the databases network.
export const EMBEDDING_MODELS = {
  default: "lfm2.5-embedding-350m",
  multilingual: "lfm2.5-embedding-350m",
} as const;

export const EMBEDDING_DIMENSIONS: Record<string, number> = {
  "lfm2.5-embedding-350m": 1024,
};
