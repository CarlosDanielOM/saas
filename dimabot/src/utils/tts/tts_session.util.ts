import type { RedisClientType } from 'redis';

// Marker, payload and queue membership share one Redis command boundary. A new
// session marker can never be observed alongside the previous session's queue.
const ENQUEUE = `-- DIMA032_ENQUEUE
local session = redis.call('GET', KEYS[3])
local item = cjson.decode(ARGV[1])
item.queueSession = session or cjson.null
redis.call('SET', KEYS[2], cjson.encode(item))
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
return session or ''`;
const POP = `-- DIMA032_POP
local next = redis.call('ZPOPMIN', KEYS[1])
if #next == 0 then return {} end
return {next[1], redis.call('GET', ARGV[1] .. next[1]) or '', redis.call('GET', KEYS[2]) or ''}`;
const RESET = `-- DIMA032_RESET
local waiting = redis.call('ZRANGE', KEYS[2], 0, -1)
local processing = redis.call('GET', KEYS[3])
redis.call('SET', KEYS[1], ARGV[1])
for _, id in ipairs(waiting) do redis.call('DEL', ARGV[2] .. id) end
if processing then redis.call('DEL', ARGV[2] .. processing) end
for i = 3, #ARGV do redis.call('DEL', ARGV[i]) end
for i = 2, #KEYS do redis.call('DEL', KEYS[i]) end
return ARGV[1]`;

export async function enqueueTtsSession(cache: RedisClientType, channel: string, id: string, score: number, payload: string) {
    await cache.eval(ENQUEUE, { keys: [`twitch:${channel}:tts:queue`, `twitch:${channel}:tts:queue:data:${id}`, `twitch:${channel}:tts:session`],
        arguments: [payload, String(score), id] });
}
export async function popTtsSession(cache: RedisClientType, channel: string) {
    const value = await cache.eval(POP, { keys: [`twitch:${channel}:tts:queue`, `twitch:${channel}:tts:session`], arguments: [`twitch:${channel}:tts:queue:data:`] }) as string[];
    return value.length ? { value: value[0], payload: value[1], session: value[2] || null } : null;
}
export async function resetTtsSession(cache: RedisClientType, channel: string, session: string, orphanKeys: string[]) {
    await cache.eval(RESET, { keys: [`twitch:${channel}:tts:session`, `twitch:${channel}:tts:queue`, `twitch:${channel}:tts:processing`,
        `twitch:${channel}:tts:connected`, `twitch:${channel}:tts:last_cleanup`], arguments: [session, `twitch:${channel}:tts:queue:data:`, ...orphanKeys] });
}
