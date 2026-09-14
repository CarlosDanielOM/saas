import { createHash, randomUUID } from 'node:crypto';
import { getDragonflyClient } from './databases/dragonfly.database.js';
import { followDefenseKeys } from './follow_defense_queue.js';

const RETENTION_SECONDS = 48 * 60 * 60;

// Count the announcement decision, not the detector's tracked users. The receipt
// also prevents a retried suppressed event being announced after the mode expires.
export async function suppressFollowAnnouncement(channelID: string, eventID: string): Promise<boolean> {
    const cache = await getDragonflyClient('followDefense.suppressAnnouncement');
    const keys = followDefenseKeys(channelID);
    const receipt = keys.suppressionReceiptPrefix + createHash('sha256').update(eventID).digest('hex');
    const result = await cache.eval(`
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
if redis.call('GET', KEYS[3]) then return {1, ''} end
local settings = redis.call('GET', KEYS[2])
if settings and cjson.decode(settings).enabled == false then return {0, ''} end
local raw = redis.call('GET', KEYS[1])
if not raw then return {0, ''} end
local state = cjson.decode(raw)
if state.expiresAt <= now or (state.mode ~= 'silent' and state.mode ~= 'protection' and state.mode ~= 'attack') then return {0, ''} end
local indexType = redis.call('TYPE', KEYS[5]).ok
if indexType ~= 'none' and indexType ~= 'zset' then return redis.error_reply('WRONGTYPE summary index') end
local previous = redis.call('GET', KEYS[4])
local summary = previous and cjson.decode(previous) or {id = ARGV[2], count = 0, notBefore = 0}
summary.count = summary.count + 1
summary.notBefore = math.max(summary.notBefore, state.expiresAt)
redis.call('SET', KEYS[4], cjson.encode(summary), 'EX', ARGV[3])
redis.call('ZADD', KEYS[5], summary.notBefore, ARGV[1])
redis.call('SET', KEYS[3], '1', 'EX', ARGV[3])
return {1, ''}
`, {
        keys: [keys.state, keys.settings, receipt, keys.summary, keys.summaries],
        arguments: [channelID, randomUUID(), String(RETENTION_SECONDS)]
    }) as [number, string];
    return result[0] === 1;
}

export interface FollowSummaryDependencies {
    preferences(channelID: string): Promise<{ enabled: boolean; language: 'en' | 'es' }>;
    send(channelID: string, message: string): Promise<{ error: boolean }>;
}

const defaults: FollowSummaryDependencies = {
    async preferences(channelID) {
        const [{ default: Streamers }, { default: Eventsub }, { FollowDefenseSettingsSchema }] = await Promise.all([
            import('../classes/twitch_streamers.class.js'), import('../schemas/eventsub.schema.js'),
            import('../schemas/follow_defense_settings.schema.js')
        ]);
        const [streamer, config, settings] = await Promise.all([
            Streamers.getTwitchAccountById(channelID), Eventsub.findOne({ channelID, type: 'channel.follow' }).lean(),
            FollowDefenseSettingsSchema.findOne({ channelID }).lean()
        ]);
        return { enabled: Boolean(streamer) && streamer?.chat_enabled !== 'false' && settings?.enabled !== false
            && config?.enabled !== false && (!config || Boolean(config.message?.trim() || config.todayFollows)),
        language: settings?.language === 'es' ? 'es' : 'en' };
    },
    async send(channelID, message) {
        const { sendTwitchChatMessage } = await import('../functions/chats/send_message.chat.js');
        return sendTwitchChatMessage(channelID, message, null, { channelID });
    }
};

export function followSummaryMessage(count: number, language: 'en' | 'es'): string {
    const formatted = new Intl.NumberFormat(language).format(count);
    if (language === 'es') return count === 1
        ? 'Recibimos 1 follow adicional mientras los anuncios estaban en pausa. ¡Gracias por seguir el canal!'
        : `Recibimos ${formatted} follows adicionales mientras los anuncios estaban en pausa. ¡Gracias por seguir el canal!`;
    return `${formatted} additional ${count === 1 ? 'follow was' : 'follows were'} received while announcements were paused. Thanks for following!`;
}

// Independent of mode cleanup and the ban backlog. Escalation/expiry cannot erase
// an acknowledgement owed to followers. A single channel gets one aggregate.
export async function sendPendingFollowDefenseSummaries(dependencies = defaults): Promise<number> {
    const cache = await getDragonflyClient('followDefense.summaries');
    const channels = (await cache.zRangeByScore(followDefenseKeys('').summaries, 0, Date.now())).slice(0, 25);
    let sent = 0;
    for (const channelID of channels) {
        const keys = followDefenseKeys(channelID);
        const token = randomUUID();
        // Preferences are read before the atomic claim so a slow DB read cannot
        // claim an expired snapshot while a new flood has already renewed silence.
        const preferences = await dependencies.preferences(channelID);
        const claimed = await cache.eval(`
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local raw = redis.call('GET', KEYS[1])
if not raw then redis.call('ZREM', KEYS[3], ARGV[1]); return {0, ''} end
if redis.call('GET', KEYS[4]) then return {0, ''} end
local summary = cjson.decode(raw)
local current = redis.call('GET', KEYS[2])
local state = current and cjson.decode(current)
if state and state.mode ~= 'normal' then summary.notBefore = math.max(summary.notBefore, state.expiresAt) end
if summary.notBefore > now then
    redis.call('SET', KEYS[1], cjson.encode(summary), 'EX', ARGV[3])
    redis.call('ZADD', KEYS[3], summary.notBefore, ARGV[1])
    return {0, ''}
end
redis.call('SET', KEYS[4], ARGV[2], 'EX', 120)
redis.call('SET', KEYS[1], cjson.encode(summary), 'EX', ARGV[3])
return {1, cjson.encode(summary)}
`, { keys: [keys.summary, keys.state, keys.summaries, keys.summaryLock], arguments: [channelID, token, String(RETENTION_SECONDS)] }) as [number, string];
        if (!claimed[0]) continue;
        const summary = JSON.parse(claimed[1]) as { id: string; count: number; notBefore: number };
        let completed = !preferences.enabled;
        try {
            // An old acknowledgement should not unexpectedly appear hours later.
            if (Date.now() > summary.notBefore + 5 * 60_000) completed = true;
            if (!completed) {
                const result = await dependencies.send(channelID, followSummaryMessage(summary.count, preferences.language));
                completed = !result.error;
                if (completed) sent++;
            }
        } finally {
            await cache.eval(`
if redis.call('GET', KEYS[3]) ~= ARGV[2] then return {0, ''} end
local raw = redis.call('GET', KEYS[1])
if raw then
    local summary = cjson.decode(raw)
    if summary.id == ARGV[3] then
        if ARGV[5] == '1' then summary.count = math.max(0, summary.count - tonumber(ARGV[4]))
        else
            local clock = redis.call('TIME')
            local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
            -- The delivery deadline stays fixed while transient errors back off.
            redis.call('ZADD', KEYS[2], now + 30000, ARGV[1])
        end
        if summary.count == 0 then
            redis.call('DEL', KEYS[1]); redis.call('ZREM', KEYS[2], ARGV[1])
        else redis.call('SET', KEYS[1], cjson.encode(summary), 'EX', ARGV[6]) end
    end
end
redis.call('DEL', KEYS[3])
return {1, ''}
`, { keys: [keys.summary, keys.summaries, keys.summaryLock],
                arguments: [channelID, token, summary.id, String(summary.count), completed ? '1' : '0', String(RETENTION_SECONDS)] });
        }
    }
    return sent;
}
