import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import TwitchStreamers from '../../../classes/twitch_streamers.class.js';
import { ChannelAIMemorySchema, type MemorySource, type MemorySubjectScope, type MemoryStatus, type MemoryType, type MemoryRisk, type IMemorySubject, type IMemoryEvidence, type IMemoryActor, type IChannelAIMemory } from '../../../schemas/channel_ai_memory.schema.js';
import { ChannelAIPersonalitySchema } from '../../../schemas/channel_ai_personality.schema.js';
import { deleteChannelMemoryEmbedding, upsertChannelMemoryEmbedding } from '../../qdrant/functions/memory/sync_memory.qdrant.js';
import { generateQdrantPointId } from '../../qdrant/qdrant_point_id.js';
import { error, warn } from '../../logger.js';
import {
    getMemoryPolicyViolation,
    selectValidatedChannelMemories,
    type IMemoryCandidate,
    type IMemoryPolicySettings,
    type IValidatedMemoryContextItem
} from './memory_policy.js';

const DEFAULT_AUTO_CONFIRM_THRESHOLD = 0.82;
const DEFAULT_MAX_PENDING = 250;
const DEFAULT_MAX_CONFIRMED = 2000;

function normalizeText(value: unknown): string {
    return String(value ?? '').trim();
}

function clampConfidence(value: unknown): number {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0.5;
    return Math.max(0, Math.min(1, num));
}

function normalizeSummary(content: string, summary?: string): string {
    const normalizedSummary = normalizeText(summary);
    if (normalizedSummary) {
        return normalizedSummary.length <= 180
            ? normalizedSummary
            : `${normalizedSummary.slice(0, 177)}...`;
    }
    const normalizedContent = normalizeText(content);
    if (normalizedContent.length <= 180) return normalizedContent;
    return `${normalizedContent.slice(0, 177)}...`;
}

interface BuildFingerprintInput {
    channelID: string;
    type: string;
    subject: {
        scope: string;
        username: string;
    };
    summary: string;
}

function buildFingerprint(input: BuildFingerprintInput): string {
    const subjectScope = normalizeText(input.subject.scope || 'channel').toLowerCase();
    const subjectUsername = normalizeText(input.subject.username).toLowerCase();
    const digestInput = [
        normalizeText(input.channelID),
        normalizeText(input.type),
        subjectScope,
        subjectUsername,
        normalizeText(input.summary).toLowerCase()
    ].join('|');
    return createHash('sha256').update(digestInput).digest('hex');
}

export interface ILearningConfig {
    enabled: boolean;
    autoConfirmEnabled: boolean;
    autoConfirmThreshold: number;
    maxPendingMemories: number;
    maxConfirmedMemories: number;
}

interface IPersonalityWithLearningConfig {
    learningConfig?: {
        enabled?: unknown;
        autoConfirmEnabled?: unknown;
        autoConfirmThreshold?: unknown;
        maxPendingMemories?: unknown;
        maxConfirmedMemories?: unknown;
    };
}

async function resolveLearningConfig(channelID: string): Promise<ILearningConfig> {
    const personality = await ChannelAIPersonalitySchema.findOne({ channelID }).select('learningConfig').lean() as IPersonalityWithLearningConfig | null;
    const config = personality?.learningConfig;
    return {
        enabled: Boolean(config?.enabled ?? true),
        autoConfirmEnabled: Boolean(config?.autoConfirmEnabled ?? true),
        autoConfirmThreshold: Number(config?.autoConfirmThreshold ?? DEFAULT_AUTO_CONFIRM_THRESHOLD),
        maxPendingMemories: Number(config?.maxPendingMemories ?? DEFAULT_MAX_PENDING),
        maxConfirmedMemories: Number(config?.maxConfirmedMemories ?? DEFAULT_MAX_CONFIRMED)
    };
}

async function resolveMemoryPolicy(channelID: string): Promise<IMemoryPolicySettings> {
    const personality = await ChannelAIPersonalitySchema.findOne({ channelID })
        .select('memoryPolicy')
        .lean();
    return {
        allowSensitiveMemories: Boolean(personality?.memoryPolicy?.allowSensitiveMemories ?? false),
        allowUserPreferenceMemories: Boolean(personality?.memoryPolicy?.allowUserPreferenceMemories ?? true),
        allowRunningJokes: Boolean(personality?.memoryPolicy?.allowRunningJokes ?? true)
    };
}

/**
 * Get the full learning config for a channel (includes all fields like createMinConfidence)
 */
export async function getChannelLearningConfig(channelID: string): Promise<{
    autoConfirmThreshold: number;
    createMinConfidence: number;
    autoConfirmEnabled: boolean;
}> {
    const personality = await ChannelAIPersonalitySchema.findOne({ channelID }).select('learningConfig').lean();
    const config = personality?.learningConfig;
    return {
        autoConfirmThreshold: Number(config?.autoConfirmThreshold ?? 0.82),
        createMinConfidence: Number(config?.createMinConfidence ?? 0.72),
        autoConfirmEnabled: Boolean(config?.autoConfirmEnabled ?? true)
    };
}

function shouldAutoConfirm(
    risk: MemoryRisk,
    confidence: number,
    config: ILearningConfig
): boolean {
    if (!config.autoConfirmEnabled) return false;
    if (risk !== 'low') return false;
    return confidence >= config.autoConfirmThreshold;
}

interface ISyncMemoryToQdrantParams {
    qdrantPointID: number;
    memoryId: string;
    channelID: string;
    memoryType?: string;
    status?: string;
    risk?: string;
    confidence?: number;
    subjectScope?: string;
    subjectUsername?: string;
    subjectUserID?: string;
    content: string;
    summary: string;
    createdAtUnix?: number;
    updatedAtUnix?: number;
}

function resolveMemoryQdrantPointID(memory: IChannelAIMemory): number {
    if (Number.isInteger(memory.qdrantPointID) && Number(memory.qdrantPointID) >= 0) {
        return Number(memory.qdrantPointID);
    }

    const createdAt = memory.createdAt instanceof Date
        ? Math.floor(memory.createdAt.getTime() / 1000)
        : Math.floor(memory._id.getTimestamp().getTime() / 1000);
    return generateQdrantPointId(memory.channelID, String(memory._id), createdAt);
}

export async function syncMemoryToQdrant(memory: IChannelAIMemory): Promise<void> {
    const qdrantPointID = resolveMemoryQdrantPointID(memory);
    if (memory.qdrantPointID !== qdrantPointID) {
        memory.qdrantPointID = qdrantPointID;
        await ChannelAIMemorySchema.updateOne(
            { _id: memory._id },
            { $set: { qdrantPointID } }
        );
    }

    if (memory.status === 'confirmed') {
        const syncResult = await upsertChannelMemoryEmbedding({
            qdrantPointID,
            memoryId: String(memory._id),
            channelID: memory.channelID,
            memoryType: memory.type,
            status: memory.status,
            risk: memory.risk,
            confidence: memory.confidence,
            subjectScope: memory.subject.scope,
            subjectUsername: memory.subject.username,
            subjectUserID: memory.subject.userID,
            content: memory.content,
            summary: memory.summary,
            createdAtUnix: Math.floor(memory.createdAt.getTime() / 1000),
            updatedAtUnix: Math.floor(memory.updatedAt.getTime() / 1000)
        } as ISyncMemoryToQdrantParams);
        if (syncResult.error) {
            throw new Error(syncResult.message || 'Failed to sync memory to Qdrant');
        }
    } else {
        const deleteResult = await deleteChannelMemoryEmbedding(
            qdrantPointID,
            memory.channelID,
            String(memory._id)
        );
        if (deleteResult.error) {
            throw new Error(deleteResult.message || 'Failed to remove memory from Qdrant');
        }
    }
}

async function enforceMemoryLimit(channelID: string, status: string, limit: number): Promise<boolean> {
    if (limit <= 0) return true;
    const count = await ChannelAIMemorySchema.countDocuments({ channelID, status });
    return count < limit;
}

export interface ICreateOrUpdateChannelMemoryInput {
    channelID: string;
    channelName?: string;
    type: MemoryType;
    risk?: MemoryRisk;
    confidence?: number;
    subject?: {
        scope?: MemorySubjectScope;
        username?: string;
        userID?: string;
    };
    content: string;
    summary?: string;
    evidence?: Array<{
        source?: MemorySource;
        username?: string;
        userID?: string;
        message?: string;
        messageId?: string;
        timestamp?: number;
    }>;
    createdBy?: {
        source?: MemorySource;
        username?: string;
        userID?: string;
    };
    forceStatus?: MemoryStatus;
    bypassLearningConfig?: boolean;
    bypassMemoryPolicy?: boolean;
    preserveConfirmed?: boolean;
}

export interface ICreateOrUpdateChannelMemoryResult {
    error: boolean;
    message?: string;
    memory?: IChannelAIMemory;
}

export async function createOrUpdateChannelMemory(
    input: ICreateOrUpdateChannelMemoryInput
): Promise<ICreateOrUpdateChannelMemoryResult> {
    try {
        const channelID = normalizeText(input.channelID);
        const content = normalizeText(input.content);
        const confidence = clampConfidence(input.confidence);
        const summary = normalizeSummary(content, input.summary);
        if (!channelID || !content) {
            return {
                error: true,
                message: 'channelID and content are required'
            };
        }
        const subject: IMemorySubject = {
            scope: (input.subject?.scope === 'user' ? 'user' : 'channel') as MemorySubjectScope,
            username: normalizeText(input.subject?.username),
            userID: normalizeText(input.subject?.userID)
        };
        if ((subject.scope === 'user' || input.type === 'known_user_fact') && !subject.userID) {
            return {
                error: true,
                message: 'User-scoped memories require a stable Twitch user ID'
            };
        }
        if (input.type === 'known_user_fact' && subject.scope !== 'user') {
            return {
                error: true,
                message: 'Known user facts require a user subject'
            };
        }
        const fingerprint = buildFingerprint({
            channelID,
            type: input.type,
            subject,
            summary
        });
        const learningConfig = await resolveLearningConfig(channelID);
        if (!learningConfig.enabled && !input.bypassLearningConfig) {
            return {
                error: false,
                message: 'Learning disabled for this channel'
            };
        }
        const memoryPolicy = await resolveMemoryPolicy(channelID);
        const policyViolation = getMemoryPolicyViolation(
            input.type,
            input.risk || 'low',
            subject.scope,
            memoryPolicy
        );
        if (policyViolation && !input.bypassMemoryPolicy) {
            return {
                error: true,
                message: policyViolation
            };
        }
        let targetStatus: MemoryStatus;
        if (input.forceStatus) {
            targetStatus = input.forceStatus;
        } else {
            targetStatus = shouldAutoConfirm(input.risk || 'low', confidence, learningConfig)
                ? 'confirmed'
                : 'pending_review';
        }
        const existing = await ChannelAIMemorySchema.findOne({ channelID, fingerprint });
        if (existing) {
            if (input.preserveConfirmed && existing.status === 'confirmed') {
                return {
                    error: false,
                    memory: existing
                };
            }
            let nextStatus = existing.status;
            if (input.forceStatus) {
                nextStatus = targetStatus;
            } else if (existing.status !== 'confirmed') {
                nextStatus = shouldAutoConfirm(
                    input.risk || existing.risk,
                    Math.max(existing.confidence || 0, confidence),
                    learningConfig
                )
                    ? 'confirmed'
                    : targetStatus;
            }
            existing.qdrantPointID = resolveMemoryQdrantPointID(existing);
            if (nextStatus !== 'confirmed') {
                const deleteResult = await deleteChannelMemoryEmbedding(
                    existing.qdrantPointID,
                    existing.channelID,
                    String(existing._id)
                );
                if (deleteResult.error) {
                    throw new Error(deleteResult.message || 'Failed to remove memory from Qdrant');
                }
            }
            existing.content = content;
            existing.summary = summary;
            existing.risk = input.risk || existing.risk;
            existing.confidence = Math.max(existing.confidence || 0, confidence);
            existing.type = input.type;
            existing.subject = subject;
            existing.status = nextStatus;
            existing.reviewReason = nextStatus === 'confirmed'
                ? 'auto_confirm_threshold_met'
                : (input.forceStatus ? 'manual_status_set' : 'awaiting_review');
            const evidence = Array.isArray(input.evidence) ? input.evidence : [];
            if (evidence.length > 0) {
                const existingEvidence = Array.isArray(existing.sourceEvidence) ? existing.sourceEvidence : [];
                existing.sourceEvidence = [...existingEvidence, ...evidence]
                    .slice(-25)
                    .map((item): IMemoryEvidence => ({
                        source: (item.source || 'chat') as MemorySource,
                        username: normalizeText(item.username),
                        userID: normalizeText(item.userID),
                        message: normalizeText(item.message),
                        messageId: normalizeText(item.messageId),
                        timestamp: Number(item.timestamp || Math.floor(Date.now() / 1000))
                    }));
            }
            existing.updatedAt = new Date();
            if (existing.status === 'confirmed') {
                await syncMemoryToQdrant(existing);
            }
            await existing.save();
            return {
                error: false,
                memory: existing
            };
        }
        if (targetStatus === 'pending_review') {
            const allowPending = await enforceMemoryLimit(channelID, 'pending_review', learningConfig.maxPendingMemories);
            if (!allowPending) {
                return {
                    error: true,
                    message: 'Pending memory limit reached for this channel'
                };
            }
        }
        if (targetStatus === 'confirmed') {
            const allowConfirmed = await enforceMemoryLimit(channelID, 'confirmed', learningConfig.maxConfirmedMemories);
            if (!allowConfirmed) {
                return {
                    error: true,
                    message: 'Confirmed memory limit reached for this channel'
                };
            }
        }
        const streamer = await TwitchStreamers.getTwitchAccountById(channelID);
        const memoryID = new Types.ObjectId();
        const qdrantPointID = generateQdrantPointId(
            channelID,
            String(memoryID),
            Math.floor(memoryID.getTimestamp().getTime() / 1000)
        );
        const memory = new ChannelAIMemorySchema({
            _id: memoryID,
            qdrantPointID,
            channelID,
            channel: normalizeText(input.channelName) || streamer?.name || 'Unknown',
            type: input.type,
            status: targetStatus,
            risk: input.risk || 'low',
            confidence,
            subject,
            content,
            summary,
            fingerprint,
            sourceEvidence: (input.evidence || []).slice(-25).map((item): IMemoryEvidence => ({
                source: (item.source || 'chat') as MemorySource,
                username: normalizeText(item.username),
                userID: normalizeText(item.userID),
                message: normalizeText(item.message),
                messageId: normalizeText(item.messageId),
                timestamp: Number(item.timestamp || Math.floor(Date.now() / 1000))
            })),
            createdBy: {
                source: (input.createdBy?.source || 'system') as MemorySource,
                username: normalizeText(input.createdBy?.username),
                userID: normalizeText(input.createdBy?.userID)
            } as IMemoryActor,
            reviewReason: input.forceStatus ? 'manual_status_set' : (targetStatus === 'confirmed' ? 'auto_confirm_threshold_met' : 'awaiting_review')
        });
        if (memory.status === 'confirmed') {
            await syncMemoryToQdrant(memory);
        }
        try {
            await memory.save();
        } catch (saveError) {
            if (memory.status === 'confirmed') {
                await deleteChannelMemoryEmbedding(qdrantPointID, channelID, String(memory._id));
            }
            throw saveError;
        }
        return {
            error: false,
            memory: memory
        };
    } catch (err) {
        await error({
            function: 'createOrUpdateChannelMemory',
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            channelID: input.channelID
        }, { channelId: input.channelID, destination: 'both' });
        return {
            error: true,
            message: 'Failed to create or update memory'
        };
    }
}

export interface ISetChannelMemoryStatusParams {
    channelID: string;
    memoryID: string;
    status: MemoryStatus;
    reviewReason?: string;
    reviewer?: {
        source?: MemorySource;
        username?: string;
        userID?: string;
    };
}

export interface ISetChannelMemoryStatusResult {
    error: boolean;
    message?: string;
    memory?: IChannelAIMemory;
}

export async function setChannelMemoryStatus(
    params: ISetChannelMemoryStatusParams
): Promise<ISetChannelMemoryStatusResult> {
    try {
        const memory = await ChannelAIMemorySchema.findOne({
            _id: params.memoryID,
            channelID: params.channelID
        });
        if (!memory) {
            return {
                error: true,
                message: 'Memory not found'
            };
        }
        if (params.status === 'confirmed') {
            if (memory.type === 'known_user_fact' &&
                (memory.subject.scope !== 'user' || !normalizeText(memory.subject.userID))) {
                return {
                    error: true,
                    message: 'Known user facts require a verified Twitch user ID before confirmation'
                };
            }
            const memoryPolicy = await resolveMemoryPolicy(params.channelID);
            const policyViolation = getMemoryPolicyViolation(
                memory.type,
                memory.risk,
                memory.subject.scope,
                memoryPolicy
            );
            if (policyViolation) {
                return { error: true, message: policyViolation };
            }
        } else {
            const qdrantPointID = resolveMemoryQdrantPointID(memory);
            const deleteResult = await deleteChannelMemoryEmbedding(
                qdrantPointID,
                memory.channelID,
                String(memory._id)
            );
            if (deleteResult.error) {
                return {
                    error: true,
                    message: deleteResult.message || 'Failed to remove memory from Qdrant'
                };
            }
            memory.qdrantPointID = qdrantPointID;
        }
        memory.status = params.status;
        memory.reviewReason = normalizeText(params.reviewReason);
        memory.reviewedAt = new Date();
        memory.reviewedBy = params.reviewer ? {
            source: (params.reviewer.source || 'system') as MemorySource,
            username: normalizeText(params.reviewer.username),
            userID: normalizeText(params.reviewer.userID)
        } as IMemoryActor : undefined;
        memory.updatedAt = new Date();
        if (memory.status === 'confirmed') {
            await syncMemoryToQdrant(memory);
        }
        await memory.save();
        return {
            error: false,
            memory: memory
        };
    } catch (err) {
        await error({
            function: 'setChannelMemoryStatus',
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            channelID: params.channelID,
            memoryID: params.memoryID
        }, { channelId: params.channelID, destination: 'both' });
        return {
            error: true,
            message: 'Failed to update memory status'
        };
    }
}

export interface IUpdateChannelMemoryParams {
    channelID: string;
    memoryID: string;
    type?: MemoryType;
    risk?: MemoryRisk;
    confidence?: number;
    content?: string;
    summary?: string;
    subject?: {
        scope?: MemorySubjectScope;
        username?: string;
        userID?: string;
    };
}

export interface IUpdateChannelMemoryResult {
    error: boolean;
    message?: string;
    memory?: IChannelAIMemory;
}

export async function updateChannelMemory(
    params: IUpdateChannelMemoryParams
): Promise<IUpdateChannelMemoryResult> {
    try {
        const memory = await ChannelAIMemorySchema.findOne({
            _id: params.memoryID,
            channelID: params.channelID
        });
        if (!memory) {
            return {
                error: true,
                message: 'Memory not found'
            };
        }
        const nextType = params.type || memory.type;
        const nextRisk = params.risk || memory.risk;
        const nextSubject: IMemorySubject = params.subject ? {
            scope: (params.subject.scope === 'user' ? 'user' : 'channel') as MemorySubjectScope,
            username: normalizeText(params.subject.username),
            userID: normalizeText(params.subject.userID)
        } : memory.subject;
        if ((nextSubject.scope === 'user' || nextType === 'known_user_fact') && !nextSubject.userID) {
            return {
                error: true,
                message: 'User-scoped memories require a stable Twitch user ID'
            };
        }
        if (nextType === 'known_user_fact' && nextSubject.scope !== 'user') {
            return {
                error: true,
                message: 'Known user facts require a user subject'
            };
        }
        const memoryPolicy = await resolveMemoryPolicy(params.channelID);
        const policyViolation = getMemoryPolicyViolation(nextType, nextRisk, nextSubject.scope, memoryPolicy);
        if (policyViolation) {
            return { error: true, message: policyViolation };
        }
        if (memory.status !== 'confirmed') {
            const qdrantPointID = resolveMemoryQdrantPointID(memory);
            const deleteResult = await deleteChannelMemoryEmbedding(
                qdrantPointID,
                memory.channelID,
                String(memory._id)
            );
            if (deleteResult.error) {
                return {
                    error: true,
                    message: deleteResult.message || 'Failed to remove stale memory from Qdrant'
                };
            }
            memory.qdrantPointID = qdrantPointID;
        }
        if (params.type) memory.type = params.type;
        if (params.risk) memory.risk = params.risk;
        if (typeof params.confidence === 'number') memory.confidence = clampConfidence(params.confidence);
        if (typeof params.content === 'string') memory.content = normalizeText(params.content);
        if (typeof params.summary === 'string') memory.summary = normalizeSummary(memory.content, params.summary);
        if (params.subject) {
            memory.subject = nextSubject;
        }
        if (memory.content && !memory.summary) {
            memory.summary = normalizeSummary(memory.content);
        }
        memory.fingerprint = buildFingerprint({
            channelID: params.channelID,
            type: memory.type,
            subject: {
                scope: memory.subject.scope,
                username: memory.subject.username
            },
            summary: memory.summary
        });
        memory.updatedAt = new Date();
        if (memory.status === 'confirmed') {
            await syncMemoryToQdrant(memory);
        }
        await memory.save();
        return {
            error: false,
            memory: memory
        };
    } catch (err) {
        await error({
            function: 'updateChannelMemory',
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            channelID: params.channelID,
            memoryID: params.memoryID
        }, { channelId: params.channelID, destination: 'both' });
        return {
            error: true,
            message: 'Failed to update memory'
        };
    }
}

export interface IListChannelMemoriesParams {
    channelID: string;
    statuses?: MemoryStatus[];
    type?: MemoryType;
    limit?: number;
    skip?: number;
}

export interface IMemoryLean {
    _id: string;
    qdrantPointID?: number;
    channelID: string;
    channel: string;
    type: MemoryType;
    status: MemoryStatus;
    risk: MemoryRisk;
    confidence: number;
    subject: IMemorySubject;
    content: string;
    summary: string;
    fingerprint: string;
    sourceEvidence: IMemoryEvidence[];
    createdBy: IMemoryActor;
    reviewedBy?: IMemoryActor;
    reviewReason: string;
    reviewedAt?: Date;
    useCount: number;
    lastUsedAt?: Date;
    expiresAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}

export interface IListChannelMemoriesResult {
    error: boolean;
    items: IMemoryLean[];
    total: number;
    message?: string;
}

export interface IKnownUserMemoryContextItem {
    memory_id: string;
    memory_type: MemoryType;
    risk: MemoryRisk;
    confidence: number;
    summary: string;
    updated_at: number;
}

export interface IGetKnownUserMemoryContextParams {
    channelID: string;
    userID: string;
    limit: number;
    allowSensitiveMemories?: boolean;
}

export async function getKnownUserMemoryContext(
    params: IGetKnownUserMemoryContextParams
): Promise<IKnownUserMemoryContextItem[]> {
    const channelID = normalizeText(params.channelID);
    const userID = normalizeText(params.userID);
    const limit = Math.max(1, Math.min(10, Number(params.limit || 1)));
    if (!channelID || !userID) {
        return [];
    }

    try {
        const query: Record<string, unknown> = {
            channelID,
            status: 'confirmed',
            type: 'known_user_fact',
            'subject.scope': 'user',
            'subject.userID': userID,
            $and: [
                {
                    $or: [
                        { expiresAt: { $exists: false } },
                        { expiresAt: null },
                        { expiresAt: { $gt: new Date() } }
                    ]
                }
            ]
        };
        if (!params.allowSensitiveMemories) {
            query.risk = 'low';
        }

        const memories = await ChannelAIMemorySchema.find(query)
            .sort({ confidence: -1, lastUsedAt: -1, updatedAt: -1 })
            .limit(limit)
            .select('_id type risk confidence summary updatedAt')
            .lean();

        return memories.map((memory) => ({
            memory_id: String(memory._id),
            memory_type: memory.type,
            risk: memory.risk,
            confidence: Number(memory.confidence || 0),
            summary: memory.summary,
            updated_at: memory.updatedAt instanceof Date
                ? Math.floor(memory.updatedAt.getTime() / 1000)
                : 0
        }));
    } catch (err) {
        await warn({
            function: 'getKnownUserMemoryContext',
            error: err instanceof Error ? err.message : String(err),
            channelID
        }, { channelId: channelID, destination: 'console' });
        return [];
    }
}

export interface IValidateChannelMemoryContextParams {
    channelID: string;
    candidates: IMemoryCandidate[];
    limit: number;
    policy: IMemoryPolicySettings;
}

export async function validateChannelMemoryContext(
    params: IValidateChannelMemoryContextParams
): Promise<IValidatedMemoryContextItem[]> {
    const candidates = params.candidates.filter((candidate) => Types.ObjectId.isValid(candidate.memory_id));
    if (!params.channelID || candidates.length === 0 || params.limit <= 0) {
        return [];
    }

    try {
        const memories = await ChannelAIMemorySchema.find({
            _id: { $in: candidates.map((candidate) => candidate.memory_id) },
            channelID: params.channelID
        })
            .select('_id channelID status type risk subject summary expiresAt')
            .lean();

        return selectValidatedChannelMemories({
            channelID: params.channelID,
            candidates,
            records: memories.map((memory) => ({
                memoryID: String(memory._id),
                channelID: memory.channelID,
                status: memory.status,
                type: memory.type,
                risk: memory.risk,
                subjectScope: memory.subject.scope,
                summary: memory.summary,
                expiresAt: memory.expiresAt
            })),
            policy: params.policy,
            limit: params.limit
        });
    } catch (err) {
        await warn({
            function: 'validateChannelMemoryContext',
            error: err instanceof Error ? err.message : String(err),
            channelID: params.channelID,
            candidateCount: candidates.length
        }, { channelId: params.channelID, destination: 'console' });
        return [];
    }
}

export async function listChannelMemories(
    params: IListChannelMemoriesParams
): Promise<IListChannelMemoriesResult> {
    try {
        const query: Record<string, unknown> = {
            channelID: params.channelID
        };
        if (params.statuses && params.statuses.length > 0) {
            query.status = { $in: params.statuses };
        }
        if (params.type) {
            query.type = params.type;
        }
        const limit = Math.max(1, Math.min(200, Number(params.limit || 50)));
        const skip = Math.max(0, Number(params.skip || 0));
        const [items, total] = await Promise.all([
            ChannelAIMemorySchema.find(query)
                .sort({ updatedAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            ChannelAIMemorySchema.countDocuments(query)
        ]);
        return {
            error: false,
            items: items as unknown as IMemoryLean[],
            total
        };
    } catch (err) {
        await error({
            function: 'listChannelMemories',
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            channelID: params.channelID
        }, { channelId: params.channelID, destination: 'both' });
        return {
            error: true,
            items: [],
            total: 0,
            message: 'Failed to list memories'
        };
    }
}

export async function getChannelMemoryPendingCount(channelID: string): Promise<number> {
    try {
        return await ChannelAIMemorySchema.countDocuments({
            channelID,
            status: 'pending_review'
        });
    } catch (err) {
        await warn({
            function: 'getChannelMemoryPendingCount',
            error: err instanceof Error ? err.message : String(err),
            channelID
        }, { channelId: channelID, destination: 'console' });
        return 0;
    }
}

export interface IRecordChannelMemoryUsageParams {
    channelID: string;
    memoryIDs: string[];
}

export async function recordChannelMemoryUsage(
    channelID: string,
    memoryIDs: string[]
): Promise<void> {
    try {
        const ids = memoryIDs.filter(Boolean);
        if (!channelID || ids.length === 0) {
            return;
        }
        await ChannelAIMemorySchema.updateMany({
            channelID,
            _id: { $in: ids }
        }, {
            $inc: { useCount: 1 },
            $set: { lastUsedAt: new Date(), updatedAt: new Date() }
        });
    } catch (err) {
        await warn({
            function: 'recordChannelMemoryUsage',
            error: err instanceof Error ? err.message : String(err),
            channelID,
            memoryCount: memoryIDs.length
        }, { channelId: channelID, destination: 'console' });
    }
}

export interface IDeleteChannelMemoryPermanentlyParams {
    channelID: string;
    memoryID: string;
}

export interface IDeleteChannelMemoryPermanentlyResult {
    error: boolean;
    message?: string;
    deleted?: boolean;
}

export async function deleteChannelMemoryPermanently(
    params: IDeleteChannelMemoryPermanentlyParams
): Promise<IDeleteChannelMemoryPermanentlyResult> {
    try {
        const memory = await ChannelAIMemorySchema.findOne({
            _id: params.memoryID,
            channelID: params.channelID
        });
        if (!memory) {
            return {
                error: true,
                message: 'Memory not found'
            };
        }
        const deleteResult = await deleteChannelMemoryEmbedding(
            resolveMemoryQdrantPointID(memory),
            params.channelID,
            String(memory._id)
        );
        if (deleteResult.error) {
            return {
                error: true,
                message: deleteResult.message || 'Failed to remove memory embedding'
            };
        }
        await ChannelAIMemorySchema.deleteOne({
            _id: params.memoryID,
            channelID: params.channelID
        });
        return {
            error: false,
            deleted: true
        };
    } catch (err) {
        await error({
            function: 'deleteChannelMemoryPermanently',
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            channelID: params.channelID,
            memoryID: params.memoryID
        }, { channelId: params.channelID, destination: 'both' });
        return {
            error: true,
            message: 'Failed to permanently delete memory'
        };
    }
}
