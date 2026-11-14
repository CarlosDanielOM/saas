/**
 * MCP-only tools (surface mcp, never in the site registry): the change log and undo, for apps whose writes apply
 * without an approval card. Visibility is the Changes list's (owner: every change on the channel; admin: their
 * own), narrowed to areas the requester may view now. Undo goes through `changes.undoChange`, after the original
 * tool's scope, permissions and plan are checked again.
 */
import { SiteAgentChangeSchema } from '../changes.schema.js';
import { ChangeError, ChangeForbiddenError, listChanges, undoChange, type ChangeView } from '../changes.js';
import { ToolConflictError, ToolInputError, type AgentTool, type Lang, type ToolContext } from '../types.js';
import { mcpUndoable, requiredScope, ToolDeniedError } from './mcp.js';
import { getUndoTool, planAllows } from './registry.js';
import { SETTINGS_READ_PERMISSIONS } from './settings_read.js';
import { asObject, int, str, untrusted } from './util.js';

const l = (lang: Lang, en: string, es: string) => (lang === 'es' ? es : en);
const CHANGE_ID = /^[a-f0-9]{24}$/i;

/**
 * Change-log area → the permission that views it (the view side of the tools that write it: commands and timers
 * pages, each settings area's GET route, rewards, stream actions owner/full access). Unknown areas: owner only.
 */
export const AREA_VIEW_PERMISSIONS: Readonly<Record<string, string>> = {
    commands: 'commands:view',
    timers: 'commands:view',
    ...SETTINGS_READ_PERMISSIONS,
    rewards: 'rewards:view',
    stream: '*',
};

async function mayView(ctx: ToolContext, area: string): Promise<boolean> {
    const permission = Object.hasOwn(AREA_VIEW_PERMISSIONS, area) ? AREA_VIEW_PERMISSIONS[area] : null;
    return permission ? ctx.can([permission]) : ctx.role === 'owner';
}

function view(change: ChangeView, tool: string | undefined) {
    return {
        id: change.id,
        at: new Date(change.at).toISOString(),
        area: change.area,
        by: { login: change.actor.login, role: change.actor.role },
        via: change.source.surface === 'mcp' ? `${change.source.clientName ?? 'an app'} (MCP)` : 'website assistant',
        undone: change.undone ? { at: new Date(change.undone.at).toISOString(), by: change.undone.by.login } : null,
        canUndo: change.canUndo && Boolean(tool && mcpUndoable(tool)),
        details: untrusted({ title: change.title, target: change.target.label, request: change.request, before: change.before, after: change.after, effects: change.effects }),
    };
}

interface ListInput { limit: number; before?: string }

export const listRecentChangesTool: AgentTool<ListInput> = {
    name: 'list_recent_changes',
    kind: 'read',
    permissions: [],
    surfaces: ['mcp'],
    description:
        'Recent changes the assistant made on this channel, from the website assistant or an MCP app like this one, newest '
        + 'first (kept 90 days): id, when, area, who asked (by), where (via), whether it was undone, canUndo (undo it with '
        + 'undo_change), and details (title, target, request, before, after). The owner sees every change on the channel; an '
        + 'admin sees their own, only in areas they may still view. Pages of up to 30: pass `next` back as before.',
    parameters: {
        type: 'object',
        properties: {
            limit: { type: 'integer', minimum: 1, maximum: 30, description: 'Default 15.' },
            before: { type: 'string', description: '`next` from the previous page.' },
        },
        additionalProperties: false,
    },
    label: (_input, lang) => l(lang, 'Reading recent changes…', 'Leyendo los cambios recientes…'),
    validate(raw) {
        const input = asObject(raw);
        const before = str(input, 'before', { max: 24 });
        if (before !== undefined && !CHANGE_ID.test(before)) throw new ToolInputError('before must be the `next` value from a previous page');
        return { limit: int(input, 'limit', { min: 1, max: 30 }) ?? 15, ...(before ? { before } : {}) };
    },
    async run(input, ctx) {
        const page = await listChanges(ctx.channelId, { id: ctx.requester.id, role: ctx.role }, input.before, input.limit);
        const rows = page.changes.length
            ? await SiteAgentChangeSchema.find({ channelId: ctx.channelId, _id: { $in: page.changes.map((change) => change.id) } }).select('tool').lean() as unknown as Array<{ _id: unknown; tool: string }>
            : [];
        const tools = new Map(rows.map((row) => [String(row._id), row.tool]));
        const areas = new Map<string, boolean>();
        const changes = [];
        for (const change of page.changes) {
            if (!areas.has(change.area)) areas.set(change.area, await mayView(ctx, change.area));
            if (areas.get(change.area)) changes.push(view(change, tools.get(change.id)));
        }
        return {
            type: 'result',
            summary: l(ctx.lang, `${changes.length} changes`, `${changes.length} cambios`),
            result: { count: changes.length, changes, next: page.next },
        };
    },
};

export const undoChangeTool: AgentTool<{ changeId: string }> = {
    name: 'undo_change',
    kind: 'write',
    permissions: [],
    surfaces: ['mcp'],
    description:
        'Undo one change from list_recent_changes by its id, like Undo in the website\'s Changes list: it puts back what was '
        + 'there before, only if nothing changed it since (otherwise it says what changed and leaves it as it is). It needs '
        + 'the same permission and plan as the original change. Changes to AI Personality, moderation, Follow Defense, '
        + 'rewards and stream actions are undone on the website. An undo can\'t be undone.',
    parameters: {
        type: 'object',
        properties: { changeId: { type: 'string', description: 'id from list_recent_changes.' } },
        required: ['changeId'],
        additionalProperties: false,
    },
    label: (_input, lang) => l(lang, 'Undoing the change…', 'Deshaciendo el cambio…'),
    validate(raw) {
        const changeId = str(asObject(raw), 'changeId', { required: true, max: 24 })!;
        if (!CHANGE_ID.test(changeId)) throw new ToolInputError('changeId must be an id from list_recent_changes');
        return { changeId };
    },
    async run(input, ctx) {
        const row = await SiteAgentChangeSchema.findOne({ _id: input.changeId, channelId: ctx.channelId })
            .select('tool title area target before after actor undoneAt undoOf undoable').lean() as unknown as
            { tool: string; title: string; area: string; target: { type: string; id: string | null; label: string }; before: Record<string, unknown> | null; after: Record<string, unknown> | null; actor?: { id?: string }; undoneAt: Date | null; undoOf: unknown; undoable: boolean } | null;
        // Another admin's change is reported as missing, like the Changes list hides it.
        if (!row || (ctx.role !== 'owner' && row.actor?.id !== ctx.requester.id)) throw new ToolInputError(`No change ${input.changeId} that you can see on this channel. Use list_recent_changes.`);
        if (row.undoneAt) return { type: 'result', billable: false, summary: l(ctx.lang, 'Already undone', 'Ya deshecho'), result: { alreadyUndone: true, message: 'This change was already undone. Nothing was changed.' } };
        const original = getUndoTool(row.tool);
        if (row.undoOf || !row.undoable || !original?.undo) throw new ToolInputError('This change can\'t be undone (it is an undo itself, or it left nothing to restore).');
        if (!mcpUndoable(row.tool)) throw new ToolDeniedError('permission_denied', 'This kind of change can only be undone on the website (Changes list in the assistant panel).');
        const scope = requiredScope(original.kind);
        if (scope && !(ctx.mcp?.scopes ?? []).includes(scope)) throw new ToolDeniedError('insufficient_scope', `Undoing this needs the ${scope} permission for this app.`, [scope]);
        if (!planAllows(original, ctx.plan)) throw new ToolDeniedError('plan_required', 'The channel\'s plan no longer includes this feature.');
        const owner = original.permissions.includes('owner');
        if ((owner && ctx.role !== 'owner') || !(await ctx.can(original.permissions.filter((permission) => permission !== 'owner')))) {
            throw new ToolDeniedError('permission_denied', 'This account no longer has permission to change this.');
        }
        return {
            type: 'approval',
            proposal: {
                tool: 'undo_change',
                title: `${l(ctx.lang, 'Undo', 'Deshacer')}: ${row.title}`,
                area: row.area,
                target: row.target,
                before: row.after ?? null,
                after: row.before ?? null,
                effects: [],
                permissions: [...original.permissions],
                payload: { changeId: input.changeId, tool: row.tool },
            },
        };
    },
    async apply(proposal, ctx) {
        const { changeId } = proposal.payload as { changeId: string };
        const { callId: _callId, ...context } = ctx;
        const source = ctx.mcp ? { surface: 'mcp' as const, clientId: ctx.mcp.clientId, clientName: ctx.mcp.clientName } : undefined;
        let done;
        try {
            done = await undoChange(ctx.channelId, changeId, { id: ctx.requester.id, role: ctx.role }, getUndoTool, () => context, source);
        } catch (error) {
            // Refused before anything was touched; the tool's own ToolConflictError (changed since) passes through.
            if (error instanceof ChangeForbiddenError) throw new ToolDeniedError(/plan/i.test(error.message) ? 'plan_required' : 'permission_denied', error.message);
            if (error instanceof ChangeError) throw new ToolConflictError(error.message);
            throw error;
        }
        if (done.alreadyUndone) throw new ToolConflictError('This change was undone in the meantime. Nothing was changed.');
        // undoChange logged the undo itself (an undo can't be undone), so there is no change to record here.
        return { result: { undone: true, changeId, undoChangeId: done.undoChangeId }, change: null };
    },
};

export const mcpOnlyTools: AgentTool[] = [listRecentChangesTool, undoChangeTool] as unknown as AgentTool[];
