import type { ExecutionContext } from '../types.js';
import { getTwitchUserByLogin } from '../../../functions/users/index.js';
import { getChannelInformation } from '../../../functions/channels/index.js';

type User = NonNullable<Awaited<ReturnType<typeof getTwitchUserByLogin>>['data']>;
type Channel = NonNullable<Awaited<ReturnType<typeof getChannelInformation>>['data']>;
const targets = new WeakMap<ExecutionContext, Map<string, Promise<User | null>>>();
const channels = new WeakMap<ExecutionContext, Map<string, Promise<Channel | null>>>();
export function normalizeTarget(value: unknown): string {
    const login = String(value ?? '').trim().replace(/^@/, '').toLowerCase();
    return /^[a-z0-9_]{1,25}$/.test(login) ? login : '';
}
export async function targetUser(ctx: ExecutionContext, value: unknown): Promise<User | null> {
    const login = normalizeTarget(value);
    if (!login) return null;
    let cache = targets.get(ctx);
    if (!cache) targets.set(ctx, cache = new Map());
    if (!cache.has(login)) cache.set(login, getTwitchUserByLogin(login, true)
        .then(result => !result.error && result.data?.id ? result.data : null).catch(() => null));
    return cache.get(login)!;
}
export async function targetChannel(ctx: ExecutionContext, value: unknown): Promise<Channel | null> {
    const user = await targetUser(ctx, value);
    if (!user) return null;
    let cache = channels.get(ctx);
    if (!cache) channels.set(ctx, cache = new Map());
    if (!cache.has(user.id)) cache.set(user.id, getChannelInformation(user.id, true)
        .then(result => !result.error && result.data ? result.data : null).catch(() => null));
    return cache.get(user.id)!;
}
