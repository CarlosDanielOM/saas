import { Types } from 'mongoose';
import { ChannelAIMemorySchema, type MemoryRisk, type MemoryStatus, type MemorySubjectScope, type MemoryType } from '../../../schemas/channel_ai_memory.schema.js';
import { ChannelAIPersonalitySchema } from '../../../schemas/channel_ai_personality.schema.js';
import { selectValidatedRecallMemories, type IMemoryPolicySettings } from '../memory/memory_policy.js';
import { retrieveChannelMemoryContext } from '../../qdrant/functions/memory/retrieve_memory_context.qdrant.js';
import type { IStreamerData } from './code_execution.tool.js';

export interface RecallMemoryArgs {
    mode?: 'overview' | 'search';
    query?: string;
    username?: string;
}

export interface RecallMemoryToolResult {
    success: boolean;
    result?: {
        memories: Array<{ type: MemoryType; summary: string; content: string; subjectUsername?: string }>;
        note?: string;
    };
    error?: string;
}

interface RecallMemoryContext {
    channelID: string;
    streamer: IStreamerData;
}

interface MemoryRecord {
    _id: Types.ObjectId;
    channelID: string;
    status: MemoryStatus;
    type: MemoryType;
    risk: MemoryRisk;
    subject: { scope: MemorySubjectScope; username?: string };
    summary: string;
    content: string;
    confidence: number;
    expiresAt?: Date | null;
    updatedAt: Date;
}

type RecallCandidate = MemoryRecord & {
    memoryID: string;
    subjectScope: MemorySubjectScope;
};

function limitForTier(tier: string | undefined): number {
    if (tier === 'pro') return 8;
    if (tier === 'premium') return 5;
    return 3;
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toCandidate(record: MemoryRecord): RecallCandidate {
    return {
        ...record,
        memoryID: String(record._id),
        subjectScope: record.subject?.scope || 'channel'
    };
}

function cleanText(value: string, maxLength: number): string {
    return String(value || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function rankForQuestion(record: RecallCandidate, query: string, username: string): number {
    const terms = (query.toLocaleLowerCase().match(/[\p{L}\p{N}_]{4,}/gu) || [])
        .filter((term) => term !== username.toLocaleLowerCase())
        .map((term) => term.replace(/(?:ing|ed|es|s)$/u, ''));
    const text = `${record.summary} ${record.content}`.toLocaleLowerCase();
    const overlap = terms.filter((term) => term.length >= 3 && text.includes(term)).length;
    return overlap * 10 + Math.max(0, Math.min(1, Number(record.confidence || 0)));
}

export async function execute(args: RecallMemoryArgs, context: RecallMemoryContext): Promise<RecallMemoryToolResult> {
    const channelID = String(context.channelID || '').trim();
    if (!channelID) return { success: false, error: 'Channel ID is missing from context' };

    const query = String(args?.query || '').trim().slice(0, 300);
    const username = String(args?.username || '').trim().replace(/^@/, '').slice(0, 40);
    const mode = args?.mode === 'overview' || !query ? 'overview' : 'search';
    const limit = limitForTier(context.streamer?.plan_tier);

    try {
        const personality = await ChannelAIPersonalitySchema.findOne({ channelID }).select('memoryPolicy').lean();
        const policy: IMemoryPolicySettings = {
            allowSensitiveMemories: Boolean(personality?.memoryPolicy?.allowSensitiveMemories ?? false),
            allowUserPreferenceMemories: Boolean(personality?.memoryPolicy?.allowUserPreferenceMemories ?? true),
            allowRunningJokes: Boolean(personality?.memoryPolicy?.allowRunningJokes ?? true)
        };
        const now = new Date();
        const baseFilter: Record<string, unknown> = {
            channelID,
            status: 'confirmed',
            $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: now } }]
        };
        if (!policy.allowSensitiveMemories) baseFilter.risk = 'low';

        let records: MemoryRecord[];
        if (username) {
            const escaped = escapeRegex(username);
            const exact = new RegExp(`^${escaped}$`, 'i');
            const mention = new RegExp(`(^|[^a-zA-Z0-9_])${escaped}($|[^a-zA-Z0-9_])`, 'i');
            records = await ChannelAIMemorySchema.find({
                ...baseFilter,
                $and: [{ $or: [{ 'subject.username': exact }, { summary: mention }, { content: mention }] }]
            }).sort({ updatedAt: -1 }).limit(120)
                .select('_id channelID status type risk subject summary content confidence expiresAt updatedAt')
                .lean() as unknown as MemoryRecord[];
        } else if (mode === 'overview') {
            records = await ChannelAIMemorySchema.find(baseFilter)
                .sort({ updatedAt: -1 }).limit(100)
                .select('_id channelID status type risk subject summary content confidence expiresAt updatedAt')
                .lean() as unknown as MemoryRecord[];
        } else {
            const retrieved = await retrieveChannelMemoryContext({
                channelID, query, limit: limit * 5, mode: 'explicit', subjectScope: 'any'
            });
            if (retrieved.error) return { success: false, error: retrieved.message || 'Memory search failed' };
            const ids = retrieved.items.map((item) => item.memory_id).filter((id) => Types.ObjectId.isValid(id));
            if (ids.length === 0) records = [];
            else {
                const found = await ChannelAIMemorySchema.find({ ...baseFilter, _id: { $in: ids } })
                    .select('_id channelID status type risk subject summary content confidence expiresAt updatedAt')
                    .lean() as unknown as MemoryRecord[];
                const byID = new Map(found.map((record) => [String(record._id), record]));
                records = ids.flatMap((id) => {
                    const record = byID.get(id);
                    return record ? [record] : [];
                });
            }
        }

        let candidates = records.map(toCandidate);
        if (username && mode === 'search') {
            candidates = candidates.sort((a, b) =>
                rankForQuestion(b, query, username) - rankForQuestion(a, query, username) ||
                b.updatedAt.getTime() - a.updatedAt.getTime());
        }
        const selected = selectValidatedRecallMemories({
            channelID, records: candidates, policy, limit, now
        });
        const memories = selected.map((memory) => ({
            type: memory.type,
            summary: cleanText(memory.summary, 180),
            content: cleanText(memory.content, 400),
            ...(memory.subjectScope === 'user' && memory.subject?.username
                ? { subjectUsername: cleanText(memory.subject.username, 40) }
                : {})
        }));
        return {
            success: true,
            result: {
                memories,
                ...(memories.length === 0 ? { note: 'No matching confirmed memories in this channel.' } : {})
            }
        };
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
}
