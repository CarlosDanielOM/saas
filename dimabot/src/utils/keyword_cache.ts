import { CommandsSchema, type ICommands } from '../schemas/commands.schema.js';
import { getDragonflyClient } from './databases/dragonfly.database.js';
import { pubSubManager } from '../classes/pubsub_manager.class.js';
import { KeywordIndexCache, normalizeKeyword, type KeywordEntry } from './keywords.js';

const TOPIC = 'keywords:changed';
const key = (channelID: string) => `keywords:index:${channelID}`;
const revisionKey = (channelID: string) => `keywords:revision:${channelID}`;
export const keywordBodyKey = (channelID: string, id: string) => `keywords:body:${channelID}:${id}`;

async function loadSharedIndex(channelID: string): Promise<KeywordEntry[]> {
    const redis = await getDragonflyClient('Keywords');
    for (let attempt = 0; attempt < 5; attempt++) {
        const cached = await redis.get(key(channelID));
        if (cached !== null) return JSON.parse(cached) as KeywordEntry[];
        const revision = await redis.get(revisionKey(channelID)) ?? '0';
        const rows = await CommandsSchema.find({ channelID, activation: 'keyword', enabled: true })
            .select('_id cmd keywordSettings').lean();
        const entries: KeywordEntry[] = rows.map(row => ({ id: String(row._id),
            text: normalizeKeyword(row.cmd), matchMode: row.keywordSettings?.matchMode ?? 'start' }));
        // An edit racing this query must not republish an obsolete list.
        const saved = await redis.eval("if (redis.call('get', KEYS[2]) or '0') == ARGV[1] then redis.call('set', KEYS[1], ARGV[2], 'EX', 86400); return 1 end; return 0",
            { keys: [key(channelID), revisionKey(channelID)], arguments: [revision, JSON.stringify(entries)] });
        if (saved === 1) return entries;
    }
    throw new Error('Keyword settings changed repeatedly while loading');
}

export const keywordIndexCache = new KeywordIndexCache(loadSharedIndex);

export async function startKeywordCacheSubscription(): Promise<void> {
    await pubSubManager.subscribe(TOPIC, (event: { channelID?: string }) => {
        if (event.channelID) {
            keywordIndexCache.invalidate(event.channelID);
            // Warm only on demand; edits to inactive channels need no local allocation.
        }
    });
}

/** Called after every keyword settings/add/delete write; counters only invalidate the body. */
export async function refreshKeywordIndex(channelID: string, id?: string): Promise<void> {
    const redis = await getDragonflyClient('Keywords');
    const transaction = redis.multi().incr(revisionKey(channelID)).del(key(channelID));
    if (id) transaction.del(keywordBodyKey(channelID, id));
    await transaction.exec();
    keywordIndexCache.invalidate(channelID);
    await redis.publish(TOPIC, JSON.stringify({ channelID }));
    await keywordIndexCache.get(channelID);
}

export async function getKeywordBody(channelID: string, id: string): Promise<ICommands | null> {
    const redis = await getDragonflyClient('Keywords');
    for (let attempt = 0; attempt < 5; attempt++) {
        const cached = await redis.get(keywordBodyKey(channelID, id));
        if (cached !== null) return JSON.parse(cached) as ICommands;
        const revision = await redis.get(revisionKey(channelID)) ?? '0';
        const row = await CommandsSchema.findOne({ channelID, _id: id, activation: 'keyword' });
        if (!row) return null;
        const saved = await redis.eval("if (redis.call('get', KEYS[2]) or '0') == ARGV[1] then redis.call('set', KEYS[1], ARGV[2], 'EX', 30); return 1 end; return 0",
            { keys: [keywordBodyKey(channelID, id), revisionKey(channelID)], arguments: [revision, JSON.stringify(row)] });
        if (saved === 1) return row;
    }
    throw new Error('Keyword changed repeatedly while loading');
}

export async function saveKeywordCount(channelID: string, id: string, count: number): Promise<void> {
    await CommandsSchema.updateOne({ channelID, _id: id, activation: 'keyword' }, { $set: { count } });
    const redis = await getDragonflyClient('Keywords');
    await redis.del(keywordBodyKey(channelID, id));
}
