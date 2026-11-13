import { Schema, model } from 'mongoose';
import type { AgentLevel } from './config.js';
import type { PlanTier, TurnStatus } from './types.js';

/**
 * One row per finished assistant turn, kept after the 72-hour chat itself is gone, so the operator can see
 * how the assistant is used and help when it goes wrong: who asked what, which level and model, which tools
 * ran with what, what it answered, how long it took, what it cost, how it ended.
 *
 * It holds the conversation text for `TURN_LOG_TEXT_DAYS` days, then only the numbers. Chats are private
 * between the person and DomDimaBot's operators: nobody else on the channel can read them, the operator
 * can (admin site, owner only). Text is clipped so one
 * long turn cannot make a huge row, and credentials and e-mail addresses are masked before it is stored
 * (`utils/scrub_text.ts`): a tool can read a command that holds an API key, or chat with someone's address.
 */
export const TURN_LOG_RETENTION_DAYS = 90;
/**
 * The conversation text is only kept as long as the dashboard promises the person their chat is kept
 * ("Chats are kept for 3 days"): after that the row stays for its numbers, with the text cleared.
 */
export const TURN_LOG_TEXT_DAYS = 3;
export const TURN_LOG_MAX_TOOLS = 60;
export const TURN_LOG_MESSAGE_MAX = 4000;
export const TURN_LOG_ANSWER_MAX = 12000;
export const TURN_LOG_STEERS_MAX = 10;
export const TURN_LOG_STEER_MAX = 2000;
export const TURN_LOG_TOOL_TEXT_MAX = 2000;

export interface ISiteAgentTurnLog {
    /** The turn id. */
    _id: string;
    /** When the person sent the message. */
    at: Date;
    endedAt: Date | null;
    channelId: string;
    channelLogin: string;
    user: { id: string; login: string; name: string; role: 'owner' | 'admin' };
    plan: PlanTier;
    level: AgentLevel;
    /** Expert was declined by the safety filter and Standard finished the turn. */
    fellBack: boolean;
    /** Models that answered a step, in order of first use. */
    models: string[];
    /** What each model cost in this turn (a turn that fell back ran two). Sums to `costUsd` apart from steps whose cost is unknown. */
    modelCosts: { model: string; steps: number; costUsd: number }[];
    status: TurnStatus;
    /** '' when the turn ended normally. */
    errorCode: string;
    lang: string;
    /** Dashboard route the person was on (no titles, no ids). */
    pageRoute: string;
    /** What the person wrote (clipped to `TURN_LOG_MESSAGE_MAX`). */
    message: string;
    /** What they added while it was working, oldest first (at most `TURN_LOG_STEERS_MAX`, each clipped). */
    steers: string[];
    /** Everything the assistant wrote back in this turn, in order, joined with blank lines (clipped to `TURN_LOG_ANSWER_MAX`). */
    answer: string;
    steps: number;
    /** Each tool call in order: its name, how it ended, and its arguments and result as text (each clipped to `TURN_LOG_TOOL_TEXT_MAX`). */
    tools: { name: string; state: string; ms: number | null; approval: string | null; args: string; result: string }[];
    /** Daily messages this turn used: its own price, move fee, steers and fallback included. 0 when not counted or refunded. */
    units: number;
    promptTokens: number;
    cachedTokens: number;
    completionTokens: number;
    reasoningTokens: number;
    /** What the provider charged, in USD. Steps whose cost was never reported are counted in `unknownCostSteps`. */
    costUsd: number;
    unknownCostSteps: number;
    /** Keys of the steps whose late-reported cost has been added, so the same step is never added twice. */
    reconciledSteps: string[];
    /** Wall time from the message to the end, and the part the model and tools were working (waits for approval excluded). */
    durationMs: number;
    activeMs: number;
    feedback: 'helpful' | 'unhelpful' | null;
    /** The text (message, steers, answer, tool arguments and results) was removed after `TURN_LOG_TEXT_DAYS` days. */
    textCleared: boolean;
    expiresAt: Date;
}

const schema = new Schema<ISiteAgentTurnLog>({
    _id: String,
    at: { type: Date, required: true },
    endedAt: { type: Date, default: null },
    channelId: { type: String, required: true },
    channelLogin: { type: String, default: '' },
    user: { _id: false, id: { type: String, default: '' }, login: { type: String, default: '' }, name: { type: String, default: '' }, role: { type: String, default: 'owner' } },
    plan: { type: String, default: 'free' },
    level: { type: String, default: 'standard' },
    fellBack: { type: Boolean, default: false },
    models: { type: [String], default: [] },
    modelCosts: { type: [{ _id: false, model: String, steps: { type: Number, default: 0 }, costUsd: { type: Number, default: 0 } }], default: [] },
    status: { type: String, required: true },
    errorCode: { type: String, default: '' },
    lang: { type: String, default: 'en' },
    pageRoute: { type: String, default: '' },
    message: { type: String, default: '' },
    steers: { type: [String], default: [] },
    answer: { type: String, default: '' },
    steps: { type: Number, default: 0 },
    tools: { type: [{ _id: false, name: String, state: String, ms: { type: Number, default: null }, approval: { type: String, default: null },
        args: { type: String, default: '' }, result: { type: String, default: '' } }], default: [] },
    units: { type: Number, default: 0 },
    promptTokens: { type: Number, default: 0 },
    cachedTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    reasoningTokens: { type: Number, default: 0 },
    costUsd: { type: Number, default: 0 },
    unknownCostSteps: { type: Number, default: 0 },
    reconciledSteps: { type: [String], default: [] },
    durationMs: { type: Number, default: 0 },
    activeMs: { type: Number, default: 0 },
    feedback: { type: String, default: null },
    textCleared: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true }
}, { versionKey: false, collection: 'site_agent_turn_logs' });

schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
schema.index({ at: -1, _id: -1 });
schema.index({ channelId: 1, at: -1, _id: -1 });
schema.index({ 'user.id': 1, at: -1, _id: -1 });
// Rows whose text is still to be cleared, oldest first: the sweep reads only these.
schema.index({ at: 1 }, { name: 'text_pending_at', partialFilterExpression: { textCleared: false } });

export const SiteAgentTurnLog = model<ISiteAgentTurnLog>('site_agent_turn_log', schema);
