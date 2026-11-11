/**
 * Change log of everything the assistant changed after an approval, and undo.
 *
 * - The owner (and global admins, who act as owner) see every assistant change on the channel and
 *   can undo any of them; a channel admin sees and undoes only their own.
 * - Undo calls the tool's `undo()`, which refuses (ToolConflictError) when the target changed after
 *   the assistant's change. A successful undo marks the original and is recorded as a change itself
 *   (`undoOf`), which can't be undone again.
 * - Records expire after 90 days (`expiresAt` TTL index).
 */
import { Types } from 'mongoose';
import { SITE_AGENT_CHANGE_TTL_DAYS, SiteAgentChangeSchema, type ISiteAgentChange } from './changes.schema.js';
import type { AgentTool, ChangeProposal, ChangeRecordInput, PlanTier, ToolContext } from './types.js';
import { ToolConflictError } from './types.js';

/** Wire shape (dimasite `assistant.types.ts` `ChangeView`). Never includes the undo data. */
export interface ChangeView {
    id: string;
    actor: { id: string; login: string; displayName: string; role: 'owner' | 'admin' };
    request: string;
    title: string;
    area: string;
    target: { type: string; id: string | null; label: string };
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    effects: string[];
    at: number;
    undone: { at: number; by: { id: string; login: string } } | null;
    canUndo: boolean;
}

export interface ChangeViewer {
    id: string;
    role: 'owner' | 'admin';
}

export interface RecordChangeInput {
    channelId: string;
    actor: { id: string; login: string; displayName: string; role: 'owner' | 'admin' };
    sessionId?: string | null;
    turnId?: string | null;
    callId?: string | null;
    /** The user's message (cut to 2000 characters). */
    request: string;
    tool: string;
    title: string;
    effects: string[];
    change: ChangeRecordInput;
    /** Set on the record of an undo. */
    undoOf?: string | null;
    at?: Date;
}

/** Errors with the HTTP status and code the route should answer with. */
export class ChangeError extends Error {
    constructor(public readonly status: number, public readonly code: string, message: string) {
        super(message);
    }
}
/** Unknown id, another channel, or another admin's change (404 `change_not_found`). */
export class ChangeNotFoundError extends ChangeError {
    constructor(message = 'Change not found') { super(404, 'change_not_found', message); }
}
/** Undo records, changes without restore data, or tools without undo (409 `not_undoable`). */
export class ChangeNotUndoableError extends ChangeError {
    constructor(message = 'This change can\'t be undone') { super(409, 'not_undoable', message); }
}
/** The viewer no longer holds the tool's permissions, or the plan lost the feature (403 `forbidden`). */
export class ChangeForbiddenError extends ChangeError {
    constructor(message = 'You no longer have permission to change this') { super(403, 'forbidden', message); }
}

const MAX_REQUEST = 2000;
const MAX_LIST = 50;
const UNDO_LOCK_MS = 60_000;
const PLAN_RANK: Record<PlanTier, number> = { free: 0, premium: 1, pro: 2 };

type ChangeRow = Omit<ISiteAgentChange, 'undo' | 'undoLockUntil'> & { undo?: Record<string, unknown> | null };

function isId(value: unknown): value is string {
    return typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
}

function mayUndo(row: Pick<ChangeRow, 'actor'>, viewer: ChangeViewer): boolean {
    return viewer.role === 'owner' || row.actor?.id === viewer.id;
}

export function toChangeView(row: ChangeRow, viewer: ChangeViewer): ChangeView {
    const undone = row.undoneAt
        ? { at: new Date(row.undoneAt).getTime(), by: { id: row.undoneBy?.id ?? '', login: row.undoneBy?.login ?? '' } }
        : null;
    return {
        id: String(row._id),
        actor: { id: row.actor.id, login: row.actor.login ?? '', displayName: row.actor.displayName ?? '', role: row.actor.role },
        request: row.request ?? '',
        title: row.title,
        area: row.area,
        target: { type: row.target.type, id: row.target.id ?? null, label: row.target.label ?? '' },
        before: row.before ?? null,
        after: row.after ?? null,
        effects: row.effects ?? [],
        at: new Date(row.at).getTime(),
        undone,
        canUndo: !undone && !row.undoOf && Boolean(row.undoable) && mayUndo(row, viewer),
    };
}

/** Saves one applied change; returns its id. */
export async function recordChange(input: RecordChangeInput): Promise<string> {
    const at = input.at ?? new Date();
    const undo = input.undoOf ? null : input.change.undo ?? null;
    const doc = await SiteAgentChangeSchema.create({
        channelId: input.channelId,
        actor: input.actor,
        sessionId: input.sessionId ?? null,
        turnId: input.turnId ?? null,
        callId: input.callId ?? null,
        request: String(input.request ?? '').slice(0, MAX_REQUEST),
        tool: input.tool,
        title: String(input.title).slice(0, 200),
        area: input.change.area,
        target: input.change.target,
        before: input.change.before ?? null,
        after: input.change.after ?? null,
        undo,
        undoable: undo !== null,
        effects: (input.effects ?? []).slice(0, 20),
        summary: String(input.change.summary ?? '').slice(0, 300),
        at,
        undoneAt: null,
        undoneBy: null,
        undoOf: input.undoOf ? new Types.ObjectId(input.undoOf) : null,
        undoLockUntil: null,
        expiresAt: new Date(at.getTime() + SITE_AGENT_CHANGE_TTL_DAYS * 86_400_000),
    });
    return String(doc._id);
}

/** Everything `recordChange` needs after an approved `tool.apply()`. */
export function changeFromApply(ctx: ToolContext, proposal: ChangeProposal, change: ChangeRecordInput): RecordChangeInput {
    return {
        channelId: ctx.channelId,
        actor: { id: ctx.requester.id, login: ctx.requester.login, displayName: ctx.requester.displayName, role: ctx.role },
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        callId: ctx.callId,
        request: ctx.userMessage,
        tool: proposal.tool,
        title: proposal.title,
        effects: proposal.effects,
        change,
    };
}

/**
 * Newest first. Owner (or global admin): every assistant change on the channel; admin: their own.
 * `before` is the `next` cursor of the previous page.
 */
export async function listChanges(channelId: string, viewer: ChangeViewer, before?: string | null, limit = 30): Promise<{ changes: ChangeView[]; next: string | null }> {
    if (before !== undefined && before !== null && before !== '' && !isId(before)) return { changes: [], next: null };
    const size = Math.min(MAX_LIST, Math.max(1, Math.trunc(Number(limit) || 30)));
    const filter: Record<string, unknown> = { channelId };
    if (viewer.role !== 'owner') filter['actor.id'] = viewer.id;
    if (before) filter._id = { $lt: new Types.ObjectId(before) };
    const rows = await SiteAgentChangeSchema.find(filter).sort({ _id: -1 }).limit(size + 1).lean() as unknown as ChangeRow[];
    const page = rows.slice(0, size);
    return {
        changes: page.map((row) => toChangeView(row, viewer)),
        next: rows.length > size && page.length ? String(page[page.length - 1]._id) : null,
    };
}

/** The undone change as the Changes list shows it, plus what happened. */
export interface UndoChangeResult extends ChangeView {
    /** True when it had been undone before: nothing was done this time. */
    alreadyUndone: boolean;
    /** Id of the record of this undo (null when it was already undone). */
    undoChangeId: string | null;
}

/**
 * Undoes one change. Throws a ChangeError (ChangeNotFoundError: unknown, other channel, or another
 * admin's change; ChangeNotUndoableError; ChangeForbiddenError) or the tool's ToolConflictError
 * (the target changed since; nothing was touched). `makeContext().can` must check permissions
 * fresh. Already undone → returns the change with `alreadyUndone: true` and does nothing.
 */
export async function undoChange(
    channelId: string,
    changeId: string,
    viewer: ChangeViewer,
    resolveTool: (name: string) => AgentTool | undefined,
    makeContext: () => Omit<ToolContext, 'callId'>,
): Promise<UndoChangeResult> {
    if (!isId(changeId)) throw new ChangeNotFoundError();
    const row = await SiteAgentChangeSchema.findOne({ _id: changeId, channelId }).select('+undo').lean() as unknown as ChangeRow | null;
    // Another admin's change is reported as missing, like the list hides it.
    if (!row || !mayUndo(row, viewer)) throw new ChangeNotFoundError();
    if (row.undoneAt) return { ...toChangeView(row, viewer), alreadyUndone: true, undoChangeId: null };
    if (row.undoOf || !row.undoable || !row.undo) throw new ChangeNotUndoableError();

    const tool = resolveTool(row.tool);
    if (!tool?.undo) throw new ChangeNotUndoableError();
    const ctx = makeContext();
    if (ctx.channelId !== channelId || ctx.requester.id !== viewer.id) throw new ChangeForbiddenError('Wrong channel or requester');
    if (!(await ctx.can(tool.permissions))) throw new ChangeForbiddenError();
    if (tool.minPlan && PLAN_RANK[ctx.plan] < PLAN_RANK[tool.minPlan]) throw new ChangeForbiddenError('The channel\'s plan no longer includes this feature');

    // Claim it, so a double click (or two people) can't run the same undo twice.
    const now = Date.now();
    const claimed = await SiteAgentChangeSchema.findOneAndUpdate(
        { _id: changeId, channelId, undoneAt: null, $or: [{ undoLockUntil: null }, { undoLockUntil: { $lte: new Date(now) } }] },
        { $set: { undoLockUntil: new Date(now + UNDO_LOCK_MS) } },
        { new: true },
    ).lean();
    if (!claimed) {
        const latest = await SiteAgentChangeSchema.findOne({ _id: changeId, channelId }).lean() as unknown as ChangeRow | null;
        if (latest?.undoneAt) return { ...toChangeView(latest, viewer), alreadyUndone: true, undoChangeId: null };
        throw new ToolConflictError(ctx.lang === 'es' ? 'Este cambio se está deshaciendo en este momento.' : 'This change is being undone right now.');
    }

    try {
        await tool.undo({ undo: row.undo, after: row.after ?? null, target: row.target }, ctx);
    } catch (error) {
        await SiteAgentChangeSchema.updateOne({ _id: changeId }, { $set: { undoLockUntil: null } }).catch(() => undefined);
        throw error;
    }

    const undoneAt = new Date();
    const undoneBy = { id: ctx.requester.id, login: ctx.requester.login };
    await SiteAgentChangeSchema.updateOne({ _id: changeId }, { $set: { undoneAt, undoneBy, undoLockUntil: null } });
    const undoChangeId = await recordChange({
        channelId,
        actor: { id: ctx.requester.id, login: ctx.requester.login, displayName: ctx.requester.displayName, role: ctx.role },
        sessionId: ctx.sessionId || null,
        turnId: ctx.turnId || null,
        callId: null,
        request: '',
        tool: row.tool,
        title: `${ctx.lang === 'es' ? 'Deshacer' : 'Undo'}: ${row.title}`,
        effects: [],
        change: { area: row.area, target: row.target, before: row.after ?? null, after: row.before ?? null, undo: null, summary: `Undid: ${row.summary ?? row.title}` },
        undoOf: changeId,
        at: undoneAt,
    });
    return { ...toChangeView({ ...row, undoneAt, undoneBy }, viewer), alreadyUndone: false, undoChangeId };
}
