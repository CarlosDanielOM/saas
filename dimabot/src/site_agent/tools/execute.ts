/**
 * MCP v1 tool core, transport-neutral: lists and runs the MCP allowlist (`mcp.ts`) for one OAuth principal. The MCP
 * endpoint (SDK, auth, JSON-RPC) only calls `listMcpTools` and `executeMcpToolCall`.
 *
 * A call: allowlisted tool → fresh website access to the channel (the requester's own rights; a token never adds
 * any) → the token's scope for the tool's kind → the tool's permissions and plan → input → credits held
 * (`credits.ts`; free tools hold nothing) → run. A write's proposal is shown to nobody: access, permissions and plan
 * are checked again, every command text it makes run must pass the safe-body guard, then it applies through the
 * runner's own apply step (`changes.applyProposal`, 120 s → outcome unknown) and is logged with source mcp, so it can
 * be undone here (undo_change) or on the website. Credits are charged only for a billable success (a read that
 * returned data, a write that applied); everything else releases the hold. A write that has started is never
 * abandoned (a client abort waits for it); one still running after 120 s is reported as unknown and keeps its hold,
 * which is settled once if it lands and released if it fails.
 */
import { Types } from 'mongoose';
import UsersSchema from '../../schemas/users.schema.js';
import { error as logError, warn } from '../../utils/logger.js';
import { permissionChecker, resolveAccess, roleFor, type ChannelAccess } from '../access.js';
import { applyProposal, changeFromApply, recordChange, type LateApply, type RecordChangeInput } from '../changes.js';
import { CreditError, releaseToolCredits, reserveToolCredits, settleToolCredits, toolPrice, type CreditReservation } from '../credits.js';
import { ToolConflictError, ToolInputError, type AgentTool, type ChangeProposal, type ChangeRecordInput, type ExecutableCheck, type JsonSchema, type Requester, type ToolContext, type ToolOutcome } from '../types.js';
import { MCP_ALLOWLIST, requiredScope, ToolDeniedError } from './mcp.js';
import { mcpOnlyTools } from './mcp_changes.js';
import { getTool, planAllows, toolsFor } from './registry.js';
import { checkSafeBody } from './safe_body.js';
import { untrusted } from './util.js';

export interface McpPrincipal { requesterId: string; channelId: string; sessionId: string; clientId: string; clientName: string; scopes: readonly string[] }

export interface McpToolListing {
    name: string;
    description: string;
    inputSchema: JsonSchema;
    annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
    credits: number;
}

export type ExecuteOutcome =
    | { ok: true; result: unknown; changeId?: string; undoable?: boolean; charged: number }
    | { ok: false; code: 'unknown_tool' | 'invalid_input' | 'no_access' | 'permission_denied' | 'insufficient_scope' | 'plan_required'
        | 'unsafe_content' | 'credits_exhausted' | 'credits_unavailable' | 'conflict' | 'outcome_unknown' | 'failed';
        message: string; requiredScopes?: string[] };

type Failure = Extract<ExecuteOutcome, { ok: false }>;
/** `late`: a write still running after the timeout; it decides the hold (settle if it lands, release if not). */
type Done = { outcome: Omit<Extract<ExecuteOutcome, { ok: true }>, 'charged'> | Failure; billable: boolean; late?: Promise<boolean> };

/** Same as the runner's tool timeout. */
const RUN_TIMEOUT_MS = 90_000;
/** One save and two retries; the change already happened, so it is still reported as applied. */
const RECORD_ATTEMPTS = 3;
const RECORD_RETRY_MS = 150;

const MCP_ONLY = new Map(mcpOnlyTools.map((tool) => [tool.name, tool]));

/** An allowlisted tool by name (MCP-only ones first); undefined for every other name. */
export function mcpTool(name: string): AgentTool | undefined {
    if (typeof name !== 'string' || !Object.hasOwn(MCP_ALLOWLIST, name)) return undefined;
    return MCP_ONLY.get(name) ?? getTool(name);
}

const fail = (code: Failure['code'], message: string, requiredScopes?: string[]): Failure => ({ ok: false, code, message, ...(requiredScopes ? { requiredScopes } : {}) });
const isRead = (tool: AgentTool) => tool.kind === 'knowledge' || tool.kind === 'read';
const cleanName = (name: string) => String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 100) || 'an app';
const message = (err: unknown) => err instanceof Error ? err.stack ?? err.message : String(err);

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

type Check = ReturnType<typeof permissionChecker>;
interface Call { ctx: ToolContext; check: Check }

/** The requester's Twitch login and name, from their own account record. */
async function requesterOf(requesterId: string, access: ChannelAccess): Promise<Requester> {
    const user = await UsersSchema.findOne({ accounts: { $elemMatch: { type: 'twitch', id: requesterId } } })
        .select('accounts.type accounts.id accounts.name').lean() as unknown as { accounts?: Array<{ type?: string; id?: string; name?: string | null }> } | null;
    const name = user?.accounts?.find((account) => account.type === 'twitch' && account.id === requesterId)?.name?.trim();
    const fallback = requesterId === access.channelId ? access.channelLogin : requesterId;
    return { id: requesterId, login: (name || fallback).toLowerCase(), displayName: name || fallback };
}

async function openCall(p: McpPrincipal, opts: { operationId: string; signal: AbortSignal }): Promise<Call | null> {
    const access = await resolveAccess(p.requesterId, p.channelId, 'mcp');
    if (!access) return null;
    const check = permissionChecker(p.requesterId, access.channelId, undefined, 'mcp');
    const clientName = cleanName(p.clientName);
    return {
        check,
        ctx: {
            channelId: access.channelId, channelLogin: access.channelLogin, requester: await requesterOf(p.requesterId, access),
            role: roleFor(p.requesterId, access), plan: access.plan, lang: access.savedLang ?? 'en',
            sessionId: p.sessionId, turnId: opts.operationId, callId: opts.operationId,
            userMessage: `Via ${clientName} (MCP)`, page: null, signal: opts.signal,
            can: (permissions) => check(permissions),
            mcp: { clientId: p.clientId, clientName, scopes: [...p.scopes] },
        },
    };
}

/** A tool context for one MCP call, from a fresh access check; null when the requester has no website access to the channel. */
export async function createMcpToolContext(p: McpPrincipal, opts: { operationId: string; signal: AbortSignal }): Promise<ToolContext | null> {
    return (await openCall(p, opts))?.ctx ?? null;
}

/** ALL permissions, with `owner` meaning the channel owner (as the runner reads it). */
async function holds(call: Call, permissions: readonly string[], fresh = false): Promise<boolean> {
    if (permissions.includes('owner') && call.ctx.role !== 'owner') return false;
    return call.check(permissions.filter((permission) => permission !== 'owner'), fresh);
}

function missingScope(tool: AgentTool, scopes: readonly string[]): string | null {
    const scope = requiredScope(tool.kind);
    return scope && !scopes.includes(scope) ? scope : null;
}

const planName = (tool: AgentTool) => tool.minPlan === 'pro' ? 'Pro' : 'Premium';

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

// Fallback only: every allowlisted write has its own mcpDescription and mcpAnnotations (mcp_descriptions.test.ts).
const WRITE_NOTE = ' Through MCP the change applies right away and is logged; undo_change reverts it.';
const BODY_NOTE = ' Command text it writes or makes reachable (stored text included) may only use reply functions (names, arguments, random numbers, counters, math, text helpers, event values, Twitch reads); anything else is set up on the website.';
/** Hints for a tool that declares none: reads are safe; a write is assumed to overwrite, repeat and reach Twitch (the spec's defaults). */
const READ_HINTS = { destructive: false, idempotent: true, openWorld: false };
const WRITE_HINTS = { destructive: true, idempotent: false, openWorld: true };

/** One tool as MCP lists it: its MCP description (or the website one plus the MCP notes), the price, explicit hints. */
export function listing(tool: AgentTool): McpToolListing {
    const credits = toolPrice(tool, 'mcp');
    const read = isRead(tool);
    const notes = tool.kind === 'write' && !MCP_ONLY.has(tool.name) ? WRITE_NOTE + (tool.executableFields ? BODY_NOTE : '') : '';
    const description = (tool.mcpDescription ?? tool.description + notes)
        + (credits > 0 ? ` Costs ${credits} AI credit${credits === 1 ? '' : 's'} from the channel.` : '');
    const hints = tool.mcpAnnotations ?? (read ? READ_HINTS : WRITE_HINTS);
    return {
        name: tool.name,
        description,
        inputSchema: tool.parameters,
        annotations: {
            readOnlyHint: read,
            // Only meaningful for tools that change something.
            destructiveHint: !read && hints.destructive,
            idempotentHint: hints.idempotent,
            openWorldHint: hints.openWorld,
        },
        credits,
    };
}

/** The allowlist ∩ the tools the requester may use on the channel (permissions + plan) ∩ the token's scopes. */
export async function listMcpTools(p: McpPrincipal): Promise<McpToolListing[]> {
    const access = await resolveAccess(p.requesterId, p.channelId, 'mcp');
    if (!access) return [];
    const check = permissionChecker(p.requesterId, access.channelId, undefined, 'mcp');
    const role = roleFor(p.requesterId, access);
    const can = (permissions: readonly string[]) => check(permissions);
    const site = new Set(await toolsFor(can, access.plan, role));
    const out: McpToolListing[] = [];
    for (const name of Object.keys(MCP_ALLOWLIST)) {
        const tool = mcpTool(name);
        if (!tool || missingScope(tool, p.scopes)) continue;
        const usable = MCP_ONLY.has(name)
            ? planAllows(tool, access.plan) && !(tool.permissions.includes('owner') && role !== 'owner') && await can(tool.permissions.filter((permission) => permission !== 'owner'))
            : site.has(tool);
        if (usable) out.push(listing(tool));
    }
    return out;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('tool_timeout')), ms);
        const onAbort = () => { clearTimeout(timer); reject(new Error('tool_aborted')); };
        if (signal.aborted) onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then((value) => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve(value); },
            (err) => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(err); });
    });
}

/** Saves the change-log row with retries under one preset id (a retry after a save that landed is a no-op). */
async function recordWithRetry(input: RecordChangeInput, meta: Record<string, unknown>): Promise<string | undefined> {
    const id = new Types.ObjectId().toHexString();
    let last: unknown;
    for (let attempt = 1; attempt <= RECORD_ATTEMPTS; attempt++) {
        try {
            return await recordChange({ ...input, id });
        } catch (err) {
            if ((err as { code?: unknown })?.code === 11000) return id;
            last = err;
            if (attempt < RECORD_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, RECORD_RETRY_MS * attempt));
        }
    }
    // The change happened; only the log entry is missing. Never report it as "not applied".
    await logError({ function: 'mcp.recordChange', ...meta, error: message(last) }, { destination: 'both' }).catch(() => undefined);
    return undefined;
}

/** Errors from `run` or `apply` that mean nothing was changed (null = not one of them). */
function refused(err: unknown, applying: boolean): Failure | null {
    if (err instanceof ToolDeniedError) return fail(err.code, err.message, err.requiredScopes);
    if (err instanceof ToolConflictError) return fail('conflict', `Not applied: ${err.message}`);
    if (!applying && err instanceof ToolInputError) return fail('invalid_input', err.message);
    return null;
}

async function applyWrite(call: Call, tool: AgentTool, input: unknown, proposal: ChangeProposal, p: McpPrincipal, opts: { operationId: string; signal: AbortSignal }, meta: Record<string, unknown>): Promise<Done> {
    const no = (outcome: Failure): Done => ({ outcome, billable: false });
    if (opts.signal.aborted) return no(fail('failed', 'Cancelled before anything was changed.'));
    // Fresh, right before the write: access, role, plan and permissions (no card was shown, so this is the approval).
    const access = await resolveAccess(p.requesterId, p.channelId, 'mcp');
    if (!access) return no(fail('no_access', 'This account no longer has access to this channel on the website. Nothing was changed.'));
    const fresh: Call = { check: call.check, ctx: { ...call.ctx, channelLogin: access.channelLogin, role: roleFor(p.requesterId, access), plan: access.plan } };
    if (!planAllows(tool, fresh.ctx.plan)) return no(fail('plan_required', `This needs the ${planName(tool)} plan. Nothing was changed.`));
    if (!tool.apply || !(await holds(fresh, tool.permissions, true)) || !(await holds(fresh, proposal.permissions))) {
        return no(fail('permission_denied', 'This account no longer has permission for this change. Nothing was changed.'));
    }
    // Every command text this change makes reachable must be safe: nobody reviews it before it applies.
    let toApply = proposal;
    if (tool.executableFields) {
        const found = await tool.executableFields(input as never, proposal, fresh.ctx);
        if (found === null) return no(fail('unsafe_content', `Not applied: this would turn on code that can't be checked here (a built-in command). It can be set up on the website instead.`));
        const { texts, stored = [], where, pinned, blocked } = Array.isArray(found) ? { texts: found } as ExecutableCheck : found;
        if (blocked) return no(fail('unsafe_content', `Not applied: ${blocked}. Do it on the website instead.`));
        for (const text of texts) {
            const check = checkSafeBody(text);
            if (!check.ok) return no(fail('unsafe_content', `Not applied: ${check.reason}. Through MCP, command text may only use reply functions (names, arguments, random numbers, counters, math, text helpers, event values, Twitch reads). This can be set up on the website instead.`));
        }
        for (const text of stored) {
            const check = checkSafeBody(text);
            if (!check.ok) return no(fail('unsafe_content', `Not applied: some stored text ${where ?? 'that this change would let run'} can act on your stream (${check.reason}); edit it on the website.`));
        }
        // Apply refuses unless the stored state it checked is still there.
        if (pinned) toApply = { ...proposal, payload: { ...proposal.payload, pinned } };
    }
    const record = (change: ChangeRecordInput) => recordWithRetry({
        ...changeFromApply(fresh.ctx, proposal, change), tool: tool.name,
        source: { surface: 'mcp', clientId: p.clientId, clientName: fresh.ctx.mcp?.clientName ?? cleanName(p.clientName) },
    }, meta);
    let applied: Awaited<ReturnType<typeof applyProposal>>;
    try {
        // No abort signal: a write that has started finishes (and is charged) even if the client goes away.
        applied = await applyProposal(tool, toApply, fresh.ctx, record);
    } catch (err) {
        const denied = refused(err, true);
        if (denied) return no(denied);
        const late = (err as Partial<LateApply>)?.late;
        await (late ? warn : logError)({ function: 'mcp.apply', ...meta, outcome: 'unknown', error: message(err) }, { destination: 'both' }).catch(() => undefined);
        return {
            billable: false,
            ...(late ? { late } : {}),
            outcome: fail('outcome_unknown', late
                ? 'This change took too long: it may or may not have been applied. Check the current state before trying again. It is charged only if it lands.'
                : 'Something went wrong while saving: this change may or may not have been applied. Check the current state before trying again.'),
        };
    }
    const logged = applied.changeId !== undefined;
    const undoable = logged && applied.change?.undo != null;
    return {
        billable: true,
        outcome: {
            ok: true,
            result: {
                applied: true,
                change: untrusted({ title: proposal.title, target: proposal.target.label, before: proposal.before, after: proposal.after }),
                ...(proposal.effects.length ? { effects: proposal.effects } : {}),
                ...(proposal.warnings?.length ? { warnings: proposal.warnings } : {}),
                result: applied.result,
                ...(logged ? { changeId: applied.changeId } : {}),
                undoable,
                ...(applied.change && !logged ? { note: 'The change was made, but it could not be saved to the change log, so undo_change can\'t undo it. Change it back by hand if needed.' } : {}),
            },
            ...(logged ? { changeId: applied.changeId } : {}),
            undoable,
        },
    };
}

async function perform(call: Call, tool: AgentTool, input: unknown, p: McpPrincipal, opts: { operationId: string; signal: AbortSignal }, meta: Record<string, unknown>): Promise<Done> {
    let outcome: ToolOutcome;
    try {
        outcome = await withTimeout(tool.run(input as never, call.ctx), RUN_TIMEOUT_MS, opts.signal);
    } catch (err) {
        const denied = refused(err, false);
        if (denied) return { outcome: denied, billable: false };
        if (err instanceof Error && err.message === 'tool_timeout') return { outcome: fail('failed', 'The tool took too long.'), billable: false };
        if (err instanceof Error && err.message === 'tool_aborted') return { outcome: fail('failed', 'Cancelled.'), billable: false };
        await logError({ function: 'mcp.tool', ...meta, error: message(err) }, { destination: 'both' }).catch(() => undefined);
        return { outcome: fail('failed', 'The tool failed.'), billable: false };
    }
    switch (outcome.type) {
        case 'result':
            // Writes are billable only when they apply; a write's plain result (already set, needs full access…) changed nothing.
            return { outcome: { ok: true, result: outcome.result }, billable: isRead(tool) && outcome.billable !== false };
        case 'approval':
            return applyWrite(call, tool, input, outcome.proposal, p, opts, meta);
        default:
            return { outcome: fail('failed', 'This tool is not available here.'), billable: false };
    }
}

/**
 * Runs one MCP tool call for the principal. Never throws: every failure is an outcome. `opts.operationId` is the
 * server-generated id of this call (credits idempotency key, change-log turn/call id).
 */
export async function executeMcpToolCall(p: McpPrincipal, name: string, rawArgs: unknown, opts: { operationId: string; signal: AbortSignal }): Promise<ExecuteOutcome> {
    const tool = mcpTool(name);
    if (!tool) return fail('unknown_tool', `There is no tool named "${String(name).slice(0, 100)}".`);
    const meta = { tool: tool.name, operationId: opts.operationId, channelId: p.channelId, clientId: p.clientId };
    if (opts.signal.aborted) return fail('failed', 'Cancelled.');
    let hold: CreditReservation | null = null;
    let billable = false;
    let late: Promise<boolean> | null = null;
    try {
        const call = await openCall(p, opts);
        if (!call) return fail('no_access', 'This account has no access to this channel on the website.');
        const scope = missingScope(tool, p.scopes);
        if (scope) return fail('insufficient_scope', `This app was not given the ${scope} permission.`, [scope]);
        if (!(await holds(call, tool.permissions))) return fail('permission_denied', 'This account does not have permission for this on the channel.');
        if (!planAllows(tool, call.ctx.plan)) return fail('plan_required', `This needs the ${planName(tool)} plan.`);
        let input: unknown;
        try {
            input = tool.validate(rawArgs);
        } catch (err) {
            return fail('invalid_input', err instanceof ToolInputError ? err.message : 'The arguments are not valid.');
        }
        const price = toolPrice(tool, 'mcp');
        if (price > 0) {
            if (opts.signal.aborted) return fail('failed', 'Cancelled.');
            try {
                hold = await reserveToolCredits(call.ctx.channelId, price, opts.operationId);
            } catch (err) {
                if (err instanceof CreditError) {
                    return fail(err.code, err.code === 'credits_exhausted' ? 'The channel is out of AI credits.' : 'AI credits can\'t be checked right now. Try again in a moment.');
                }
                await logError({ function: 'mcp.reserveCredits', ...meta, error: message(err) }, { destination: 'both' }).catch(() => undefined);
                return fail('credits_unavailable', 'AI credits can\'t be checked right now. Try again in a moment.');
            }
        }
        const done = await perform(call, tool, input, p, opts, meta);
        billable = done.outcome.ok && done.billable;
        late = done.late ?? null;
        return done.outcome.ok ? { ...done.outcome, charged: billable && hold ? hold.credits : 0 } : done.outcome;
    } catch (err) {
        await logError({ function: 'mcp.call', ...meta, error: message(err) }, { destination: 'both' }).catch(() => undefined);
        return fail('failed', 'Something went wrong. Try again in a moment.');
    } finally {
        // settle never throws (it keeps or drops the hold itself); release is idempotent and never throws. Exactly one
        // of them per call: now, or when a write that outlived the timeout ends.
        const held = hold;
        const settle = (charge: boolean) => (charge ? settleToolCredits(held!, { tool: tool.name, surface: 'mcp' }) : releaseToolCredits(held!)).catch(() => undefined);
        if (held && late) void late.then(settle);
        else if (held) await settle(billable);
    }
}
