import type { PlanTier } from './types.js';

/**
 * Channels that have the assistant. '*' = everyone (published 2026-11-11, labelled "Experimental" in
 * the panel). A list limits it to those channels again (dark launch), e.g. to pull it back.
 * Kept in code (not env) so the switch is a reviewed code release.
 */
export const SITE_AGENT_CHANNELS: readonly string[] | '*' = '*';

export function isSiteAgentEnabled(channelId: string): boolean {
    return SITE_AGENT_CHANNELS === '*' || SITE_AGENT_CHANNELS.includes(channelId);
}

/** What the person picks in the panel: "Standard" or "Expert" (model names are never shown). */
export type AgentLevel = 'standard' | 'expert';
export const AGENT_LEVELS: readonly AgentLevel[] = ['standard', 'expert'];

export interface LevelConfig {
    model: string;
    effort: 'low' | 'medium' | 'high' | 'xhigh';
    /** Total prompt budget (system + tools + history), in the model's tokens. */
    contextLimit: number;
    /** Compact when the prompt reaches this share of contextLimit. */
    compactAt: number;
    /** Daily messages one user message uses (new, steer or queued). */
    cost: number;
}

export interface PlanConfig {
    /** Daily messages per channel per UTC day (owner + admins share them). */
    dailyMessages: number;
    levels: { standard: LevelConfig; expert?: LevelConfig };
}

const LUNA = 'openai/gpt-6-luna';
const HAIKU = 'anthropic/claude-haiku-5.5';

/**
 * Owner decisions (2026-11-13). Standard = GPT-6 Luna on the owner's OpenAI key; Expert = Claude Haiku 5.5 on the
 * owner's Anthropic key (both BYOK through OpenRouter), 2 messages each: Premium 100 Standard or 50 Expert, Pro 400
 * or 200. Compaction starts at the limit itself; Anthropic bills prompts over 100k at 5×, accepted on Pro Expert.
 * Effort `high` since 2026-11-11 (owner's comparisons; Haiku `xhigh` gave the same answers on 2026-11-13).
 */
export const SITE_AGENT_PLANS: Record<PlanTier, PlanConfig> = {
    free: { dailyMessages: 20, levels: { standard: { model: LUNA, effort: 'high', contextLimit: 100_000, compactAt: 1, cost: 1 } } },
    premium: {
        dailyMessages: 100,
        levels: {
            standard: { model: LUNA, effort: 'high', contextLimit: 256_000, compactAt: 1, cost: 1 },
            expert: { model: HAIKU, effort: 'high', contextLimit: 100_000, compactAt: 1, cost: 2 },
        },
    },
    pro: {
        dailyMessages: 400,
        levels: {
            standard: { model: LUNA, effort: 'high', contextLimit: 256_000, compactAt: 1, cost: 1 },
            expert: { model: HAIKU, effort: 'high', contextLimit: 256_000, compactAt: 1, cost: 2 },
        },
    },
};

export const isAgentLevel = (value: unknown): value is AgentLevel => value === 'standard' || value === 'expert';

export function levelAvailable(plan: PlanTier, level: AgentLevel): boolean {
    return !!SITE_AGENT_PLANS[plan].levels[level];
}

/** The level a turn runs on: the wanted one when the plan has it, otherwise Standard. */
export function effectiveLevel(plan: PlanTier, wanted: AgentLevel | null | undefined): AgentLevel {
    return wanted && levelAvailable(plan, wanted) ? wanted : 'standard';
}

export function levelConfig(plan: PlanTier, level: AgentLevel | null | undefined): LevelConfig {
    return SITE_AGENT_PLANS[plan].levels[effectiveLevel(plan, level)] ?? SITE_AGENT_PLANS[plan].levels.standard;
}

/**
 * Owner decisions (2026-11-13): moving a chat to the other level loses its prompt cache, so the message that moves
 * it pays a move fee on top of its level; later messages pay their level only. A new chat never pays to move.
 */
export const LEVEL_SWITCH = {
    /** Standard → Expert: 2, or 4 when the chat is over `largeTokens` in Claude's tokens (billed at 5× there). */
    toExpert: 2,
    toExpertLarge: 4,
    largeTokens: 100_000,
    /** Expert → Standard. */
    toStandard: 1,
    /** Expert declined by the safety filter: 1 for the switch + 1 for Standard's answer, on top of the Expert message. */
    fallback: 2,
    /** Claude tokens per Luna token for the same text (system prompt + tools: 32.2k vs 17.6k, measured 2026-11-13). */
    claudePerLuna: 1.8,
} as const;

/** What a chat last ran on (session meta). */
export interface ChatState {
    lastLevel?: AgentLevel;
    contextTokens?: number;
    contextModel?: string;
}

export interface MessageCost {
    /** Daily messages this message uses. */
    total: number;
    /** Its level's price (what a steer into it pays). */
    level: number;
    /** Fee for moving the chat to this level (0 when it is already there, or the chat is new). */
    move: number;
}

/** Cost of the next message at `level` in a chat (null = a new chat). */
export function messageCost(plan: PlanTier, wanted: AgentLevel | null | undefined, chat: ChatState | null): MessageCost {
    const level = effectiveLevel(plan, wanted);
    const price = levelConfig(plan, level).cost;
    const from = chat?.lastLevel;
    if (!from || from === level || !chat?.contextTokens || chat.contextTokens <= 0) return { total: price, level: price, move: 0 };
    let move: number = LEVEL_SWITCH.toStandard;
    if (level === 'expert') {
        const claudeTokens = chat.contextModel && modelTraits(chat.contextModel).anthropic ? chat.contextTokens : chat.contextTokens * LEVEL_SWITCH.claudePerLuna;
        move = claudeTokens > LEVEL_SWITCH.largeTokens ? LEVEL_SWITCH.toExpertLarge : LEVEL_SWITCH.toExpert;
    }
    return { total: price + move, level: price, move };
}

/** Next-message cost of each level in a chat, for the panel (null = not on this plan). */
export function nextCosts(plan: PlanTier, chat: ChatState | null): Record<AgentLevel, MessageCost | null> {
    return {
        standard: messageCost(plan, 'standard', chat),
        expert: levelAvailable(plan, 'expert') ? messageCost(plan, 'expert', chat) : null,
    };
}

/**
 * Fallback prices (USD per token) when OpenRouter reports no upstream cost. `cacheWrite` = prompt-cache
 * writes (Anthropic bills them at 1.25× input). `longPrompt`: every price × `factor` once the prompt is over
 * `over` tokens (Haiku: 5× over 100k, on every rate). Luna's limits stay below its own 272k step.
 */
export const MODEL_PRICES: Record<string, { input: number; cachedInput: number; cacheWrite?: number; output: number; longPrompt?: { over: number; factor: number } }> = {
    'openai/gpt-6-luna': { input: 0.10 / 1e6, cachedInput: 0.01 / 1e6, output: 0.50 / 1e6 },
    'anthropic/claude-haiku-5.5': { input: 0.10 / 1e6, cachedInput: 0.01 / 1e6, cacheWrite: 0.125 / 1e6, output: 0.50 / 1e6, longPrompt: { over: 100_000, factor: 5 } },
};

export interface ModelTraits {
    /**
     * Claude through OpenRouter: the prompt cache needs explicit breakpoints, and a replayed thinking block is
     * only valid while everything sent before it is unchanged (Anthropic's history-editing check).
     */
    anthropic: boolean;
    /**
     * Real prompt tokens per `estimateTokens` token. Measured on 2026-11-13 with the real system prompt + tools:
     * Haiku 5.5 counted 1.38× our estimate (Luna 0.75×). 1.5 keeps compaction below Haiku's 100k price step.
     */
    tokenFactor: number;
}

export function modelTraits(model: string): ModelTraits {
    const anthropic = model.startsWith('anthropic/');
    return { anthropic, tokenFactor: anthropic ? 1.5 : 1 };
}

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
