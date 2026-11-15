/**
 * One row per MCP tool call (`tools/call`), so the operator can see how AI apps use a channel and why calls were
 * refused or failed: which app, who it acts for, which tool, how it ended, how long it took, what it was charged.
 * Arguments and results are never stored; `reason` is DomDimaBot's own refusal or error message (it can quote a
 * name the app sent, e.g. a command that does not exist), clipped and scrubbed. Owner-only on the admin site
 * (admin feed kind `mcp_call`). Kept 90 days; account deletion removes the channel's rows and the person's rows on
 * other channels (`deleteMcpCallLogs`).
 *
 * Writing never delays or fails a tool call: `recordMcpCall` is fire-and-forget.
 */
import { Schema, model } from 'mongoose';
import { scrubSensitive } from '../utils/scrub_text.js';
import { warn } from '../utils/logger.js';
import type { ToolKind } from './types.js';

export const MCP_CALL_LOG_RETENTION_DAYS = 90;
export const MCP_CALL_REASON_MAX = 300;

export type McpCallOutcome = 'ok' | 'blocked' | 'failed';

export interface IMcpCallLog {
    /** Server operation id of the call (credits idempotency key, change-log call id). */
    _id: string;
    at: Date;
    /** Wall time of the call, from the start of the access check to the answer. */
    ms: number;
    channelId: string;
    channelLogin: string;
    user: { id: string; login: string; role: 'owner' | 'admin' | '' };
    client: { id: string; name: string };
    sessionId: string;
    tool: string;
    kind: ToolKind | 'unknown';
    outcome: McpCallOutcome;
    /** '' for a success, else the ExecuteOutcome code (e.g. unsafe_content, invalid_input, credits_exhausted). */
    code: string;
    /** Refusal or error message shown to the app ('' for a success). */
    reason: string;
    /** Admin console rule: failed, or blocked for any reason except permission_denied. */
    problem: boolean;
    charged: number;
    changeId: string | null;
    /** A write still running when the call answered `outcome_unknown`: 'pending', then 'applied' or 'failed'. */
    late: 'pending' | 'applied' | 'failed' | null;
    expiresAt: Date;
}

const schema = new Schema<IMcpCallLog>({
    _id: String,
    at: { type: Date, required: true },
    ms: { type: Number, default: 0 },
    channelId: { type: String, required: true },
    channelLogin: { type: String, default: '' },
    user: { _id: false, id: { type: String, default: '' }, login: { type: String, default: '' }, role: { type: String, default: '' } },
    client: { _id: false, id: { type: String, default: '' }, name: { type: String, default: '' } },
    sessionId: { type: String, default: '' },
    tool: { type: String, default: '' },
    kind: { type: String, default: 'unknown' },
    outcome: { type: String, required: true },
    code: { type: String, default: '' },
    reason: { type: String, default: '' },
    problem: { type: Boolean, default: false },
    charged: { type: Number, default: 0 },
    changeId: { type: String, default: null },
    late: { type: String, default: null },
    expiresAt: { type: Date, required: true },
}, { collection: 'mcp_call_logs', versionKey: false });

schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
schema.index({ at: -1, _id: -1 });
schema.index({ channelId: 1, at: -1, _id: -1 });
schema.index({ 'user.id': 1, at: -1, _id: -1 });
schema.index({ at: -1, _id: -1 }, { name: 'problems_at', partialFilterExpression: { problem: true } });

export const McpCallLog = model<IMcpCallLog>('mcp_call_log', schema);

/** Codes that mean the call ran into trouble on our side; every other refusal is `blocked`. */
const FAILED_CODES = new Set(['failed', 'outcome_unknown', 'credits_unavailable']);

export function classifyMcpOutcome(code: string | null): { outcome: McpCallOutcome; problem: boolean } {
    if (!code) return { outcome: 'ok', problem: false };
    if (FAILED_CODES.has(code)) return { outcome: 'failed', problem: true };
    return { outcome: 'blocked', problem: code !== 'permission_denied' };
}

export interface McpCallRecord {
    operationId: string;
    startedAt: number;
    channelId: string;
    channelLogin?: string;
    user: { id: string; login?: string; role?: 'owner' | 'admin' };
    client: { id: string; name: string };
    sessionId: string;
    tool: string;
    kind?: ToolKind;
    code: string | null;
    reason?: string;
    charged: number;
    changeId?: string;
    late?: boolean;
}

const clip = (text: string, max: number) => scrubSensitive(String(text ?? '').replace(/\s+/g, ' ').trim()).slice(0, max);

function row(record: McpCallRecord, now = Date.now()): IMcpCallLog {
    const { outcome, problem } = classifyMcpOutcome(record.code);
    return {
        _id: record.operationId,
        at: new Date(record.startedAt),
        ms: Math.max(0, now - record.startedAt),
        channelId: record.channelId,
        channelLogin: String(record.channelLogin ?? '').slice(0, 64),
        user: { id: record.user.id, login: String(record.user.login ?? '').slice(0, 64), role: record.user.role ?? '' },
        client: { id: String(record.client.id ?? '').slice(0, 512), name: clip(record.client.name, 100) },
        sessionId: record.sessionId,
        tool: String(record.tool ?? '').slice(0, 64),
        kind: record.kind ?? 'unknown',
        outcome,
        code: record.code ?? '',
        reason: record.code ? clip(record.reason ?? '', MCP_CALL_REASON_MAX) : '',
        problem,
        charged: record.charged,
        changeId: record.changeId ?? null,
        late: record.late ? 'pending' : null,
        expiresAt: new Date(now + MCP_CALL_LOG_RETENTION_DAYS * 86_400_000),
    };
}

/**
 * Saves the call's row. Fire-and-forget for the caller: the returned promise never rejects and only orders later
 * updates of the same row after its insert (settleLateMcpCall).
 */
export function recordMcpCall(record: McpCallRecord): Promise<void> {
    let doc: IMcpCallLog;
    try { doc = row(record); } catch { return Promise.resolve(); }
    return McpCallLog.collection.insertOne(doc as never).then(() => undefined, (err: unknown) => {
        void warn({ function: 'mcp.callLog', operationId: record.operationId, error: err instanceof Error ? err.message : String(err) }, { channelId: record.channelId, destination: 'cache' }).catch(() => undefined);
    });
}

/** A late write ended: whether it landed and what it was charged. Call after the row's insert. Never throws. */
export async function settleLateMcpCall(operationId: string, landed: boolean, charged: number): Promise<void> {
    await McpCallLog.collection.updateOne({ _id: operationId as never, late: 'pending' },
        { $set: { late: landed ? 'applied' : 'failed', ...(landed ? { charged } : {}) } }).catch(() => undefined);
}

/**
 * Calls answer up to a few minutes after they started (a 30 s wait for a slot, 90 s to run, 120 s to apply), so a
 * call that was already running when the account was deleted can still insert its row: two later sweeps remove them.
 */
export const MCP_CALL_LOG_DELETE_SWEEPS_MS: readonly number[] = [15_000, 5 * 60_000];

/** Account deletion: the channel's rows and the person's rows on other channels, now and in the later sweeps. */
export async function deleteMcpCallLogs(channelId: string): Promise<number> {
    const filter = { $or: [{ channelId }, { 'user.id': channelId }] };
    const result = await McpCallLog.collection.deleteMany(filter);
    for (const delay of MCP_CALL_LOG_DELETE_SWEEPS_MS) {
        setTimeout(() => { void McpCallLog.collection.deleteMany(filter).catch(() => undefined); }, delay).unref?.();
    }
    return result.deletedCount ?? 0;
}

export const __mcpCallRowForTests = row;
