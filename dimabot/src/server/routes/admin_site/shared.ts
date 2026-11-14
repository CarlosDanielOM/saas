import type { RequestHandler, Response, Router } from 'express';
import { authMiddleware } from '../../../middleware/auth.middleware.js';
import type { AuthRequest } from '../../../middleware/types.js';
import UsersSchema from '../../../schemas/users.schema.js';

/**
 * Shared pieces for the owner-only admin site API (`/admin-site/*`).
 *
 * Every route here shows data from every channel, so every route is owner only. Register routes with
 * `ownerGet` / `ownerPut` / `ownerPost` / `ownerPatch` / `ownerDelete`: they add the sign-in check, the owner check, `no-store`, and a
 * catch-all that answers with a plain message (driver errors can carry connection details, so they are
 * never sent to the browser).
 */
export const SUPER_ADMIN_LOGIN = 'cdom201';
export type { AuthRequest };

export function ensureSuperAdmin(req: AuthRequest, res: Response): boolean {
    if (String(req.user?.login || '').toLowerCase() === SUPER_ADMIN_LOGIN) return true;
    res.status(403).json({ error: true, message: 'You do not have permission to access this endpoint', status: 403 });
    return false;
}

/** Thrown by a handler (or a parser below) to answer 400/404/409 with a message that is safe to show. */
export class AdminRequestError extends Error {
    constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 422 = 400) { super(message); }
}

export type OwnerHandler = (req: AuthRequest, res: Response) => Promise<unknown> | unknown;

/** What the handler returns becomes `data`; return `{ data, message }` through `reply` to set the message. */
const REPLY = Symbol('admin-reply');
export const reply = <T>(data: T, message: string, status = 200) => ({ [REPLY]: true as const, data, message, status });

function wrap(label: string, handler: OwnerHandler): RequestHandler[] {
    return [authMiddleware as unknown as RequestHandler, async (req, res) => {
        const request = req as AuthRequest;
        if (!ensureSuperAdmin(request, res)) return;
        res.setHeader('Cache-Control', 'no-store');
        try {
            const result = await handler(request, res);
            if (res.headersSent) return;
            const shaped = result && typeof result === 'object' && (result as Record<symbol, unknown>)[REPLY]
                ? result as ReturnType<typeof reply>
                : reply(result, 'OK');
            res.status(shaped.status).json({ error: false, message: shaped.message, status: shaped.status, data: shaped.data });
        } catch (error) {
            if (res.headersSent) return;
            if (error instanceof AdminRequestError) {
                res.status(error.status).json({ error: true, message: error.message, status: error.status });
                return;
            }
            console.error(`Error in ${label}:`, error instanceof Error ? error.message : 'unknown error');
            res.status(500).json({ error: true, message: 'This could not be loaded right now', status: 500 });
        }
    }];
}

export const ownerGet = (router: Router, path: string, handler: OwnerHandler) => router.get(path, ...wrap(`GET /admin-site${path}`, handler));
export const ownerPut = (router: Router, path: string, handler: OwnerHandler) => router.put(path, ...wrap(`PUT /admin-site${path}`, handler));
export const ownerPost = (router: Router, path: string, handler: OwnerHandler) => router.post(path, ...wrap(`POST /admin-site${path}`, handler));
export const ownerPatch = (router: Router, path: string, handler: OwnerHandler) => router.patch(path, ...wrap(`PATCH /admin-site${path}`, handler));
export const ownerDelete = (router: Router, path: string, handler: OwnerHandler) => router.delete(path, ...wrap(`DELETE /admin-site${path}`, handler));

// ---- Query parsing. Each returns the fallback for a missing value and throws 400 for a bad one. ----

/** Query values must be plain strings: `?a[$ne]=x` and `?a=1&a=2` are refused, not coerced. */
export function queryString(value: unknown, name: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new AdminRequestError(`Invalid ${name}`);
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}

export function queryInt(value: unknown, name: string, fallback: number, min: number, max: number): number {
    const text = queryString(value, name);
    if (text === undefined) return fallback;
    if (!/^\d{1,9}$/.test(text)) throw new AdminRequestError(`Invalid ${name}`);
    const parsed = Number(text);
    if (parsed < min || parsed > max) throw new AdminRequestError(`Invalid ${name}`);
    return parsed;
}

export function queryEnum<T extends string>(value: unknown, name: string, allowed: readonly T[], fallback: T): T;
export function queryEnum<T extends string>(value: unknown, name: string, allowed: readonly T[]): T | undefined;
export function queryEnum<T extends string>(value: unknown, name: string, allowed: readonly T[], fallback?: T): T | undefined {
    const text = queryString(value, name);
    if (text === undefined) return fallback;
    if (!allowed.includes(text as T)) throw new AdminRequestError(`Invalid ${name}`);
    return text as T;
}

/** Comma-separated list of allowed values, e.g. `kinds=command,alert`. Missing = undefined (no filter). */
export function queryEnumList<T extends string>(value: unknown, name: string, allowed: readonly T[]): T[] | undefined {
    const text = queryString(value, name);
    if (text === undefined) return undefined;
    const items = [...new Set(text.split(',').map(item => item.trim()).filter(Boolean))];
    if (!items.length || items.length > allowed.length || !items.every(item => allowed.includes(item as T))) throw new AdminRequestError(`Invalid ${name}`);
    return items as T[];
}

/** A Twitch id (channel or user): digits only. */
export function queryTwitchId(value: unknown, name: string): string | undefined {
    const text = queryString(value, name);
    if (text === undefined) return undefined;
    if (!/^\d{1,20}$/.test(text)) throw new AdminRequestError(`Invalid ${name}`);
    return text;
}

/** A Twitch login: lower-cased, 1–25 of [a-z0-9_]. */
export function queryLogin(value: unknown, name: string): string | undefined {
    const text = queryString(value, name)?.toLowerCase().replace(/^@/, '');
    if (text === undefined) return undefined;
    if (!/^[a-z0-9_]{1,25}$/.test(text)) throw new AdminRequestError(`Invalid ${name}`);
    return text;
}

/** Free text that ends up in an exact-match filter (model, provider, source). Never used as a regex. */
export function queryToken(value: unknown, name: string, max = 100): string | undefined {
    const text = queryString(value, name);
    if (text === undefined) return undefined;
    if (text.length > max || !/^[\w .:/@+-]+$/.test(text)) throw new AdminRequestError(`Invalid ${name}`);
    return text;
}

export function queryDate(value: unknown, name: string): Date | undefined {
    const text = queryString(value, name);
    if (text === undefined) return undefined;
    // ISO date or date-time only; `new Date('1')` and friends are not dates.
    if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(text)) throw new AdminRequestError(`Invalid ${name}`);
    const date = new Date(text);
    if (!Number.isFinite(date.getTime())) throw new AdminRequestError(`Invalid ${name}`);
    return date;
}

export interface TimeRange { from: Date; to: Date }

/**
 * `from`/`to` from the query, defaulting to the last `defaultDays` days. The window is capped at
 * `maxDays` so one request can never scan a collection's whole history.
 */
export function queryRange(query: Record<string, unknown>, defaultDays: number, maxDays: number, now = new Date()): TimeRange {
    const to = queryDate(query.to, 'to') || now;
    const from = queryDate(query.from, 'from') || new Date(to.getTime() - defaultDays * 86_400_000);
    if (from.getTime() >= to.getTime()) throw new AdminRequestError('Invalid range');
    if (to.getTime() - from.getTime() > maxDays * 86_400_000 + 60_000) throw new AdminRequestError(`The range can be at most ${maxDays} days`);
    return { from, to };
}

export interface Page { page: number; limit: number; skip: number }
export function queryPage(query: Record<string, unknown>, defaultLimit = 25, maxLimit = 50): Page {
    const page = queryInt(query.page, 'page', 1, 1, 10_000);
    const limit = queryInt(query.limit, 'limit', defaultLimit, 1, maxLimit);
    return { page, limit, skip: (page - 1) * limit };
}
export const pagination = (page: Page, total: number) => ({ page: page.page, limit: page.limit, total, totalPages: Math.max(1, Math.ceil(total / page.limit)) });

// ---- Cursors for "load more" lists sorted by time, newest first. ----

export interface TimeCursor { at: Date; id: string }
export function encodeCursor(cursor: TimeCursor): string {
    return Buffer.from(JSON.stringify([cursor.at.getTime(), cursor.id])).toString('base64url');
}
export function decodeCursor(value: unknown, name = 'cursor'): TimeCursor | undefined {
    const text = queryString(value, name);
    if (text === undefined) return undefined;
    try {
        if (text.length > 600) throw new Error('long');
        const parsed = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
        if (!Array.isArray(parsed) || parsed.length !== 2 || !Number.isSafeInteger(parsed[0]) || typeof parsed[1] !== 'string' || parsed[1].length > 300) throw new Error('shape');
        const at = new Date(parsed[0]);
        if (!Number.isFinite(at.getTime())) throw new Error('date');
        return { at, id: parsed[1] };
    } catch {
        throw new AdminRequestError(`Invalid ${name}`);
    }
}

// ---- Names. Stores keep Twitch ids; the admin shows logins. ----

/** Channel id → login for the streamers that have an account here. Ids without one are left out. */
export async function channelLogins(channelIDs: Iterable<string | null | undefined>): Promise<Map<string, string>> {
    const ids = [...new Set([...channelIDs].filter((id): id is string => typeof id === 'string' && /^\d{1,20}$/.test(id)))];
    const names = new Map<string, string>();
    if (!ids.length) return names;
    const owners = await UsersSchema.find({ accounts: { $elemMatch: { type: 'twitch', id: { $in: ids } } } })
        .select('accounts.type accounts.id accounts.name').maxTimeMS(5000).lean();
    for (const owner of owners) {
        for (const account of owner.accounts || []) {
            if (account.type === 'twitch' && ids.includes(String(account.id))) names.set(String(account.id), String(account.name || ''));
        }
    }
    return names;
}

/** Channel login → id, for a search box that accepts either. Undefined when no streamer has that login. */
export async function channelIdForLogin(login: string): Promise<string | undefined> {
    const owner = await UsersSchema.findOne({ accounts: { $elemMatch: { type: 'twitch', name: login } } })
        .select('accounts.type accounts.id accounts.name').maxTimeMS(5000).lean();
    const account = owner?.accounts?.find(item => item.type === 'twitch' && String(item.name).toLowerCase() === login);
    return account ? String(account.id) : undefined;
}

/** AI credits are priced so that 1,000 credits = 1 US cent. */
export const CREDITS_PER_USD = 100_000;
export const creditsToUSD = (credits: number): number => Math.round((credits / CREDITS_PER_USD) * 1e6) / 1e6;
