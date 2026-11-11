import TwitchStreamers from '../../../../classes/twitch_streamers.class.js';
import UsersSchema from '../../../../schemas/users.schema.js';
import { ToolConflictError, ToolInputError, type Lang, type PlanTier, type ToolContext } from '../../../types.js';
import { describeCommandEffects } from '../../effects.js';
import { stableJson } from '../../util.js';

/** Shared helpers for the settings write tools (one file per area next to this one). */

export const PLAN_RANK: Record<PlanTier, number> = { free: 0, premium: 1, pro: 2 };

export const tr = (lang: Lang, en: string, es: string): string => lang === 'es' ? es : en;

export const sameValue = (a: unknown, b: unknown): boolean => stableJson(a) === stableJson(b);

export function getPath(source: unknown, path: string): unknown {
    let value: unknown = source;
    for (const key of path.split('.')) {
        if (!value || typeof value !== 'object') return undefined;
        value = (value as Record<string, unknown>)[key];
    }
    return value;
}

export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
    const keys = path.split('.');
    let node = target;
    for (const key of keys.slice(0, -1)) {
        if (!node[key] || typeof node[key] !== 'object') node[key] = {};
        node = node[key] as Record<string, unknown>;
    }
    node[keys[keys.length - 1]] = value;
}

/** path → value for the given paths. */
export function pickPaths(source: unknown, paths: readonly string[]): Record<string, unknown> {
    return Object.fromEntries(paths.map((path) => [path, getPath(source, path) ?? null]));
}

/** Keeps only the entries of `next` whose value differs from `current` at the same path. */
export function changedPaths(current: unknown, next: Record<string, unknown>): string[] {
    return Object.keys(next).filter((path) => !sameValue(getPath(current, path) ?? null, next[path] ?? null));
}

export interface FieldLabel { en: string; es: string }

/** Display copy of path-keyed values for the approval card and the change log. */
export function display(values: Record<string, unknown>, labels: Record<string, FieldLabel>, lang: Lang): Record<string, unknown> {
    return Object.fromEntries(Object.entries(values).map(([path, value]) => [labels[path]?.[lang] ?? path, value]));
}

function shown(value: unknown): string {
    const text = typeof value === 'string' ? JSON.stringify(value) : stableJson(value);
    return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

/**
 * Compare-and-set on path-keyed values: throws ToolConflictError naming what changed since the
 * proposal (or since the change, for undo). `labels` make the message readable.
 */
export function assertUnchanged(current: unknown, expected: Record<string, unknown>, lang: Lang, what: string, labels: Record<string, FieldLabel> = {}): void {
    const changed = Object.keys(expected).filter((path) => !sameValue(getPath(current, path) ?? null, expected[path] ?? null));
    if (!changed.length) return;
    const parts = changed.slice(0, 4).map((path) => `${labels[path]?.[lang] ?? path}: ${shown(getPath(current, path) ?? null)}`);
    throw new ToolConflictError(tr(lang,
        `${what} changed since this was prepared (${parts.join('; ')}). Nothing was changed; ask again for a fresh proposal.`,
        `${what} cambió desde que se preparó este cambio (${parts.join('; ')}). No se cambió nada; vuelve a pedirlo para preparar uno nuevo.`));
}

export function conflict(lang: Lang, en: string, es: string): never {
    throw new ToolConflictError(tr(lang, en, es));
}

/** Channel display name (the same lookup the routes use). */
export async function channelName(channelId: string): Promise<string> {
    const streamer = await TwitchStreamers.getTwitchAccountById(channelId);
    if (!streamer) throw new ToolInputError('Channel not found');
    return streamer.name || '';
}

/**
 * Whether the streamer gave the bot full access (activated it on Twitch). Without it the bot only has
 * `channel:bot`, so EventSub subscriptions, polls, predictions, rewards and channel info fail.
 */
export async function hasFullAccess(channelId: string): Promise<boolean> {
    const owner = await UsersSchema.findOne({ accounts: { $elemMatch: { type: 'twitch', id: channelId } } }).select('accounts').lean() as { accounts?: Array<{ type?: string; id?: string; actived?: unknown }> } | null;
    const account = owner?.accounts?.find((item) => item.type === 'twitch' && item.id === channelId);
    return Boolean(account?.actived) && account?.actived !== 'false';
}

export function needsFullAccessResult(lang: Lang): { type: 'result'; result: unknown; summary: string } {
    return {
        type: 'result',
        summary: tr(lang, 'Needs full access', 'Necesita acceso completo'),
        result: {
            needsFullAccess: true,
            message: tr(lang,
                'This needs full access: the streamer must activate the bot on Twitch first (the "Activate Bot" button in the top bar). Nothing was changed.',
                'Esto necesita acceso completo: el streamer debe activar el bot en Twitch primero (el botón "Activar bot" de la barra superior). No se cambió nada.')
        }
    };
}

/** Dry-run effects of a command body for the approval card; never fails the tool. */
export async function bodyEffects(body: string | undefined, ctx: Pick<ToolContext, 'plan' | 'lang'>, label?: string): Promise<{ effects: string[]; warnings: string[] }> {
    if (!body || !body.trim()) return { effects: [], warnings: [] };
    const prefix = label ? `${label}: ` : '';
    try {
        const result = await describeCommandEffects(body, { plan: ctx.plan, lang: ctx.lang });
        return { effects: result.effects.map((effect) => `${prefix}${effect}`), warnings: result.problems.map((problem) => `${prefix}${problem}`) };
    } catch {
        return { effects: [], warnings: [`${prefix}${tr(ctx.lang, 'Could not check what this text does when it runs.', 'No se pudo revisar qué hace este texto al ejecutarse.')}`] };
    }
}

/** Merges several bodyEffects results. */
export function mergeEffects(...parts: Array<{ effects: string[]; warnings: string[] }>): { effects: string[]; warnings: string[] } {
    return { effects: [...new Set(parts.flatMap((part) => part.effects))], warnings: [...new Set(parts.flatMap((part) => part.warnings))] };
}

/** Rejects an empty change request with a model-readable message. */
export function requireSomething(values: object, what: string): void {
    if (!Object.values(values).some((value) => value !== undefined)) throw new ToolInputError(`Give at least one ${what} to change`);
}

/** String list argument (trimmed, empty items dropped). */
export function stringList(input: Record<string, unknown>, key: string, opts: { max?: number; maxLength?: number; required?: boolean } = {}): string[] | undefined {
    const value = input[key];
    if (value === undefined || value === null) {
        if (opts.required) throw new ToolInputError(`${key} is required`);
        return undefined;
    }
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new ToolInputError(`${key} must be a list of strings`);
    const items = (value as string[]).map((item) => item.trim()).filter(Boolean);
    if (opts.max !== undefined && items.length > opts.max) throw new ToolInputError(`${key} can have at most ${opts.max} items`);
    if (opts.maxLength !== undefined && items.some((item) => item.length > opts.maxLength!)) throw new ToolInputError(`Each ${key} item can be at most ${opts.maxLength} characters`);
    return items;
}

/** Owner-only tools mirror routes that check `requester.id === channelID` (global admins included only where the route allows it). */
export function requireChannelOwner(ctx: Pick<ToolContext, 'requester' | 'channelId' | 'lang'>): void {
    if (ctx.requester.id !== ctx.channelId) {
        throw new ToolInputError(tr(ctx.lang, 'Only the channel owner can do this.', 'Solo el dueño del canal puede hacer esto.'));
    }
}

/** The error message of a route-shaped `{ status, body }` failure. */
export function routeMessage(body: Record<string, unknown>, fallback: string): string {
    return typeof body.message === 'string' && body.message ? body.message : fallback;
}
