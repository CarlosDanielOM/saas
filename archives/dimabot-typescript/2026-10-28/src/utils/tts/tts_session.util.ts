import type { RedisClientType } from 'redis';

// Every key touched by Lua is declared. Dragonfly's default atomic mode rejects
// dynamic payload keys, and allow-undeclared-keys would stop unrelated traffic.
const ENQUEUE = `-- DIMA032_ENQUEUE
local session = redis.call('GET', KEYS[3])
local item = cjson.decode(ARGV[1])
item.queueSession = session or cjson.null
redis.call('SET', KEYS[2], cjson.encode(item))
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
return session or ''`;
const POP = `-- DIMA032_POP
local next = redis.call('ZRANGE', KEYS[1], 0, 0)
if #next == 0 then return {} end
if next[1] ~= ARGV[1] then return {'retry'} end
local payload = redis.call('GET', KEYS[3]) or ''
local session = redis.call('GET', KEYS[2]) or ''
redis.call('ZREM', KEYS[1], next[1])
return {next[1], payload, session}`;
const RESET = `-- DIMA032_RESET
local previous = redis.call('GET', KEYS[1]) or ''
local waiting = redis.call('ZRANGE', KEYS[2], 0, -1)
local processing = redis.call('GET', KEYS[3])
redis.call('SET', KEYS[1], ARGV[1])
for i = 2, #KEYS do redis.call('DEL', KEYS[i]) end
if processing then table.insert(waiting, processing) end
table.insert(waiting, 1, previous)
return waiting`;
const CLEAN_OLD = `-- DIMA032_CLEAN_OLD
for _, key in ipairs(KEYS) do
    local raw = redis.call('GET', key)
    if raw then
        local ok, item = pcall(cjson.decode, raw)
        if not ok or type(item) ~= 'table' or item.queueSession == nil or item.queueSession == cjson.null or item.queueSession == ARGV[1] then
            redis.call('DEL', key)
        end
    end
end
return 1`;

export async function enqueueTtsSession(cache: RedisClientType, channel: string, id: string, score: number, payload: string) {
    await cache.eval(ENQUEUE, { keys: [`twitch:${channel}:tts:queue`, `twitch:${channel}:tts:queue:data:${id}`, `twitch:${channel}:tts:session`],
        arguments: [payload, String(score), id] });
}
export async function popTtsSession(cache: RedisClientType, channel: string) {
    const queue = `twitch:${channel}:tts:queue`;
    // Peek only selects the declared payload key. CAS still snapshots/removes the
    // current minimum atomically with its payload and stream marker. Yield after
    // bounded contention; the queue's existing nonempty retry schedules the rest.
    for (let attempt = 0; attempt < 8; attempt++) {
        const [id] = await cache.zRange(queue, 0, 0);
        if (!id) return null;
        const value = await cache.eval(POP, { keys: [queue, `twitch:${channel}:tts:session`, `twitch:${channel}:tts:queue:data:${id}`], arguments: [id] }) as string[];
        if (value[0] === 'retry' && value.length === 1) continue;
        return value.length ? { value: value[0], payload: value[1], session: value[2] || null } : null;
    }
    return null;
}
export async function resetTtsSession(cache: RedisClientType, channel: string, session: string, orphanKeys: string[]) {
    const [previous, ...oldIds] = await cache.eval(RESET, { keys: [`twitch:${channel}:tts:session`, `twitch:${channel}:tts:queue`, `twitch:${channel}:tts:processing`,
        `twitch:${channel}:tts:connected`, `twitch:${channel}:tts:last_cleanup`, ...orphanKeys], arguments: [session] }) as string[];
    // Requests added after the caller's orphan snapshot are removed from queue
    // membership at RESET. Clean their payloads outside that atomic boundary,
    // fenced by the old marker even if an ID is reused by a new-session enqueue.
    const keys = [...new Set(oldIds)].map(id => `twitch:${channel}:tts:queue:data:${id}`);
    for (let offset = 0; offset < keys.length; offset += 128)
        await cache.eval(CLEAN_OLD, { keys: keys.slice(offset, offset + 128), arguments: [previous] });
}
