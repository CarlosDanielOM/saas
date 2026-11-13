/**
 * Expert answers that Anthropic's (or OpenRouter's) safety filter declined. The step reruns on Standard; this
 * record is for the owner to see what was asked and figure out why it was declined: admin site → Review →
 * Assistant refusals (owner only; raw docs in Mongo `site_agent_refusals`). Kept 90 days, removed with the account.
 * Never shown to the person.
 */
import { Schema, model } from 'mongoose';
import { error as logError, warn } from '../utils/logger.js';
import type { AgentLevel } from './config.js';
import type { RefusalDetail } from './llm/openrouter.js';
import type { ContextItem, PlanTier } from './types.js';

export const SITE_AGENT_REFUSAL_TTL_DAYS = 90;
const ITEM_CHARS = 2_000;
const RECENT_ITEMS = 8;

export interface ISiteAgentRefusal {
    channelId: string;
    channelLogin: string;
    userId: string;
    userLogin: string;
    sessionId: string;
    turnId: string;
    /** Model step of the turn (0 = first). */
    step: number;
    plan: PlanTier;
    level: AgentLevel;
    model: string;
    fallbackModel: string;
    /** How it was declined: a 'content_filter' reply, or an error (403 / mid-stream). */
    source: 'reply' | 'error';
    finishReason: string | null;
    nativeFinishReason: string | null;
    /** Refusal text from the reply, or the error message. */
    refusal: string | null;
    detail: RefusalDetail | null;
    /** The person's message for this turn, and what they added while it ran. */
    message: string;
    steers: string[];
    /** The last items the model saw before declining (clipped), oldest first. */
    recent: { role: string; name?: string; text: string }[];
    /** Text the model had already written in the declined step. */
    partial: string | null;
    at: Date;
    expiresAt: Date;
}

const siteAgentRefusalSchema = new Schema<ISiteAgentRefusal>({
    channelId: { type: String, required: true },
    channelLogin: { type: String, default: '' },
    userId: { type: String, required: true },
    userLogin: { type: String, default: '' },
    sessionId: { type: String, required: true },
    turnId: { type: String, required: true },
    step: { type: Number, default: 0 },
    plan: { type: String, required: true },
    level: { type: String, required: true },
    model: { type: String, required: true },
    fallbackModel: { type: String, required: true },
    source: { type: String, required: true },
    finishReason: { type: String, default: null },
    nativeFinishReason: { type: String, default: null },
    refusal: { type: String, default: null },
    detail: { type: Schema.Types.Mixed, default: null },
    message: { type: String, default: '' },
    steers: { type: [String], default: [] },
    recent: { type: [new Schema({ role: String, name: String, text: String }, { _id: false })], default: [] },
    partial: { type: String, default: null },
    at: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
}, { versionKey: false });

siteAgentRefusalSchema.index({ channelId: 1, at: -1 });
siteAgentRefusalSchema.index({ at: -1 });
siteAgentRefusalSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const SiteAgentRefusalSchema = model<ISiteAgentRefusal>('site_agent_refusals', siteAgentRefusalSchema, 'site_agent_refusals');

const clip = (text: string | null | undefined, max = ITEM_CHARS): string => {
    const value = String(text ?? '');
    return value.length > max ? `${value.slice(0, max)}…[cut]` : value;
};

/** The last context items, clipped, in a shape that reads well in the DB console. */
export function recentItems(items: readonly ContextItem[], count = RECENT_ITEMS): ISiteAgentRefusal['recent'] {
    return items.slice(-count).map((item) => {
        if (item.role === 'tool') return { role: 'tool', name: item.name, text: clip(item.content) };
        if (item.role === 'assistant') {
            const calls = (item.toolCalls ?? []).map((call) => `→ ${call.name}(${clip(call.arguments, 400)})`).join('\n');
            return { role: 'assistant', text: clip([item.content ?? '', calls].filter(Boolean).join('\n')) };
        }
        return { role: item.role, text: clip(item.content) };
    });
}

export type RefusalInput = Omit<ISiteAgentRefusal, 'at' | 'expiresAt' | 'recent' | 'message' | 'steers' | 'partial' | 'refusal'> & {
    message: string;
    steers: string[];
    items: readonly ContextItem[];
    partial: string | null;
    refusal: string | null;
};

export interface RefusalPage {
    rows: (Omit<ISiteAgentRefusal, 'at' | 'expiresAt'> & { id: string; at: string })[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
    /** Records in the last 7 days and in all (≤ 90 days), across channels. */
    counts: { week: number; total: number };
}

/** Newest first, optionally for one channel (admin site, owner only). */
export async function listRefusals(page: number, limit: number, channelId?: string): Promise<RefusalPage> {
    const filter = channelId ? { channelId } : {};
    const weekAgo = new Date(Date.now() - 7 * 86_400_000);
    const [docs, total, week, all] = await Promise.all([
        SiteAgentRefusalSchema.find(filter).sort({ at: -1 }).skip((page - 1) * limit).limit(limit).lean().maxTimeMS(5_000),
        SiteAgentRefusalSchema.countDocuments(filter).maxTimeMS(5_000),
        SiteAgentRefusalSchema.countDocuments({ at: { $gte: weekAgo } }).maxTimeMS(5_000),
        SiteAgentRefusalSchema.estimatedDocumentCount(),
    ]);
    return {
        rows: docs.map(({ _id, at, expiresAt: _expires, ...rest }) => ({ ...(rest as Omit<ISiteAgentRefusal, 'at' | 'expiresAt'>), id: String(_id), at: new Date(at).toISOString() })),
        pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
        counts: { week, total: all },
    };
}

/** Saves the record and logs one line. Never throws: a missing record must not break the fallback. */
export async function recordRefusal(input: RefusalInput): Promise<void> {
    const at = new Date();
    const { items, ...rest } = input;
    const doc: ISiteAgentRefusal = {
        ...rest,
        message: clip(input.message, 4_000),
        steers: input.steers.slice(-10).map((text) => clip(text)),
        recent: recentItems(items),
        partial: input.partial ? clip(input.partial) : null,
        refusal: input.refusal ? clip(input.refusal) : null,
        at,
        expiresAt: new Date(at.getTime() + SITE_AGENT_REFUSAL_TTL_DAYS * 86_400_000),
    };
    try {
        await SiteAgentRefusalSchema.create(doc);
    } catch (err) {
        await logError({ function: 'siteAgent.recordRefusal', turnId: input.turnId, error: err instanceof Error ? err.message : String(err) }, { destination: 'console' }).catch(() => {});
    }
    await warn({
        function: 'siteAgent.refusal', channelId: input.channelId, turnId: input.turnId, step: input.step, model: input.model,
        source: input.source, finishReason: input.finishReason, nativeFinishReason: input.nativeFinishReason, errorType: input.detail?.errorType ?? null,
    }, { destination: 'console' }).catch(() => {});
}
