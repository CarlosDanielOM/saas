import type { PlanTier } from './types.js';

/**
 * Channels that see the assistant before it is published. Publishing = set to '*'.
 * Kept in code (not env) so turning it on for everyone is a reviewed code release.
 */
export const SITE_AGENT_CHANNELS: readonly string[] | '*' = ['533538623'];

export function isSiteAgentEnabled(channelId: string): boolean {
    return SITE_AGENT_CHANNELS === '*' || SITE_AGENT_CHANNELS.includes(channelId);
}

export interface PlanModelConfig {
    model: string;
    effort: 'low' | 'medium' | 'high' | 'xhigh';
    /** Total prompt budget (system + tools + history), tokens. */
    contextLimit: number;
    /** Compact when the prompt reaches this share of contextLimit. */
    compactAt: number;
    /** User messages per channel per UTC day (owner + admins share it). */
    dailyMessages: number;
}

/**
 * The same model for every plan for now (pro may move to another model later). Effort `high` since
 * 2026-11-11: as good as `xhigh` on normal requests and ~5× faster on big setups (owner's comparison).
 */
export const PLAN_MODELS: Record<PlanTier, PlanModelConfig> = {
    free: { model: 'openai/gpt-6-luna', effort: 'high', contextLimit: 100_000, compactAt: 0.9, dailyMessages: 20 },
    premium: { model: 'openai/gpt-6-luna', effort: 'high', contextLimit: 256_000, compactAt: 0.9, dailyMessages: 80 },
    pro: { model: 'openai/gpt-6-luna', effort: 'high', contextLimit: 256_000, compactAt: 0.9, dailyMessages: 400 },
};

/** Fallback prices (USD per token) when OpenRouter reports no upstream cost. */
export const MODEL_PRICES: Record<string, { input: number; cachedInput: number; output: number }> = {
    'openai/gpt-6-luna': { input: 0.10 / 1e6, cachedInput: 0.01 / 1e6, output: 0.50 / 1e6 },
};

/** Plans that can let the assistant answer in the channel's chat-bot personality (tone only). */
export const PERSONA_PLANS: readonly PlanTier[] = ['premium', 'pro'];

export const SITE_AGENT_LIMITS = {
    /** Per user message (turn). */
    maxModelSteps: 30,
    maxToolCalls: 40,
    activeMs: 10 * 60_000,
    /** Waiting for an approval or a form answer (not counted as active time). */
    waitMs: 15 * 60_000,
    /** Tool result text sent to the model. */
    toolResultBytes: 16_000,
    userMessageChars: 4_000,
    uiBlockBytes: 64_000,
    uiSubmitBytes: 16_000,
    sessionsPerUserChannel: 10,
    sessionTtlSeconds: 72 * 3600,
    concurrentPerUser: 2,
    concurrentTotal: 16,
    queuedInputsPerSession: 5,
    steerInputsPerTurn: 20,
    /** Requests per minute per user (anti-abuse, separate from the daily message limit). */
    requestsPerMinute: 60,
} as const;

export const SITE_AGENT_KEYS = {
    session: (id: string) => `site_agent:s:${id}`,
    sessionItems: (id: string) => `site_agent:s:${id}:items`,
    sessionContext: (id: string) => `site_agent:s:${id}:ctx`,
    sessionQueue: (id: string) => `site_agent:s:${id}:queue`,
    userSessions: (channelId: string, userId: string) => `site_agent:sessions:${channelId}:${userId}`,
    turn: (id: string) => `site_agent:t:${id}`,
    turnEvents: (id: string) => `site_agent:t:${id}:ev`,
    lease: (sessionId: string) => `site_agent:lease:${sessionId}`,
    activeTurns: 'site_agent:active',
    dailyCount: (channelId: string, day: string) => `site_agent:daily:${channelId}:${day}`,
    stats: (day: string) => `site_agent:stats:${day}`,
    reconcileQueue: 'site_agent:reconcile',
    /** Per person per channel preferences (no expiry): persona. */
    prefs: (channelId: string, userId: string) => `site_agent:prefs:${channelId}:${userId}`,
} as const;
