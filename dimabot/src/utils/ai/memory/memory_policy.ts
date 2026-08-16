import type { MemoryRisk, MemoryStatus, MemorySubjectScope, MemoryType } from '../../../schemas/channel_ai_memory.schema.js';

export interface IMemoryPolicySettings {
    allowSensitiveMemories: boolean;
    allowUserPreferenceMemories: boolean;
    allowRunningJokes: boolean;
}

export interface IChatMemorySubjectResult {
    error?: string;
    subject?: {
        scope: MemorySubjectScope;
        username: string;
        userID: string;
    };
}

export interface IMemoryCandidate {
    memory_id: string;
    score: number;
}

export interface IMemoryValidationRecord {
    memoryID: string;
    channelID: string;
    status: MemoryStatus;
    type: MemoryType;
    risk: MemoryRisk;
    subjectScope: MemorySubjectScope;
    summary: string;
    expiresAt?: Date | null;
}

export interface IValidatedMemoryContextItem {
    memory_id: string;
    memory_type: MemoryType;
    risk: MemoryRisk;
    summary: string;
    score: number;
}

function normalize(value: unknown): string {
    return String(value ?? '').trim();
}

export function resolveChatMemorySubject(params: {
    type: MemoryType;
    requestedUsername?: string;
    triggeringUsername?: string;
    triggeringUserID?: string;
}): IChatMemorySubjectResult {
    const requestedUsername = normalize(params.requestedUsername);
    const triggeringUsername = normalize(params.triggeringUsername);
    const triggeringUserID = normalize(params.triggeringUserID);
    const requiresUserSubject = params.type === 'known_user_fact' || Boolean(requestedUsername);

    if (!requiresUserSubject) {
        return {
            subject: { scope: 'channel', username: '', userID: '' }
        };
    }
    if (!triggeringUsername || !triggeringUserID) {
        return { error: 'A stable Twitch user identity is required for user-scoped memories' };
    }
    if (requestedUsername && requestedUsername.toLowerCase() !== triggeringUsername.toLowerCase()) {
        return { error: 'Chat users can only create memories about themselves' };
    }

    return {
        subject: {
            scope: 'user',
            username: triggeringUsername,
            userID: triggeringUserID
        }
    };
}

export function getMemoryPolicyViolation(
    type: MemoryType,
    risk: MemoryRisk,
    subjectScope: MemorySubjectScope,
    policy: IMemoryPolicySettings
): string | null {
    if (risk !== 'low' && !policy.allowSensitiveMemories) {
        return 'Sensitive memories are disabled for this channel';
    }
    if (type === 'running_joke' && !policy.allowRunningJokes) {
        return 'Running joke memories are disabled for this channel';
    }
    if ((type === 'known_user_fact' || subjectScope === 'user') && !policy.allowUserPreferenceMemories) {
        return 'User memories are disabled for this channel';
    }
    return null;
}

export function selectValidatedChannelMemories(params: {
    channelID: string;
    candidates: IMemoryCandidate[];
    records: IMemoryValidationRecord[];
    policy: IMemoryPolicySettings;
    limit: number;
    now?: Date;
}): IValidatedMemoryContextItem[] {
    const now = params.now || new Date();
    const recordsByID = new Map(params.records.map((record) => [record.memoryID, record]));

    return params.candidates.flatMap((candidate) => {
        const record = recordsByID.get(candidate.memory_id);
        if (!record ||
            record.channelID !== params.channelID ||
            record.status !== 'confirmed' ||
            record.subjectScope !== 'channel' ||
            (record.expiresAt instanceof Date && record.expiresAt <= now) ||
            getMemoryPolicyViolation(record.type, record.risk, record.subjectScope, params.policy)) {
            return [];
        }
        return [{
            memory_id: record.memoryID,
            memory_type: record.type,
            risk: record.risk,
            summary: record.summary,
            score: candidate.score
        }];
    }).slice(0, Math.max(0, params.limit));
}
