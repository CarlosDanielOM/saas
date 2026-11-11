/**
 * Account deletion: remove everything the assistant kept for a channel (its chats, the chats this
 * person had on channels they manage, the change log, daily counters). Sessions expire after 72 h
 * anyway; the change log would otherwise stay 90 days.
 */
import mongoose from 'mongoose';
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';
import { SITE_AGENT_KEYS as K } from './config.js';

async function scanKeys(pattern: string): Promise<string[]> {
    const client = await getDragonflyClient('site-agent-cleanup');
    const keys: string[] = [];
    for await (const batch of client.scanIterator({ MATCH: pattern, COUNT: 500 })) {
        keys.push(...(Array.isArray(batch) ? batch : [batch]));
    }
    return keys;
}

export async function deleteChannelSiteAgentData(channelId: string): Promise<{ sessionsDeleted: number; changesDeleted: number }> {
    const client = await getDragonflyClient('site-agent-cleanup');
    const lists = [...new Set([...await scanKeys(K.userSessions(channelId, '*')), ...await scanKeys(K.userSessions('*', channelId))])];
    let sessionsDeleted = 0;
    for (const list of lists) {
        const ids = await client.zRange(list, 0, -1);
        for (const id of ids) {
            await client.del([K.session(id), K.sessionItems(id), `${K.sessionItems(id)}:order`, K.sessionContext(id), K.sessionQueue(id)]);
            sessionsDeleted++;
        }
        await client.del(list);
    }
    const daily = await scanKeys(K.dailyCount(channelId, '*'));
    if (daily.length) await client.del(daily);
    const result = await mongoose.connection.collection('site_agent_changes').deleteMany({ channelId });
    return { sessionsDeleted, changesDeleted: result.deletedCount ?? 0 };
}
