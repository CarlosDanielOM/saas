/**
 * Account deletion: remove everything the assistant kept for a channel (its chats, the chats this
 * person had on channels they manage, the change log, Expert refusal records, the turn log, daily counters and limit
 * hits). Sessions expire after 72 h anyway; the change log and the turn log would otherwise stay 90 days.
 */
import mongoose from 'mongoose';
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';
import { SITE_AGENT_KEYS as K } from './config.js';
import { limitHitsKey } from './limits.js';
import { stopTurn } from './runner.js';
import * as store from './store.js';
import { deleteTurnLogs } from './turn_log.js';
import { deleteMcpCallLogs } from './mcp_call_log.js';

/**
 * Stops the channel's turns, and this person's turns on channels they manage, that are still queued, running or
 * waiting, the way the Stop button does (a queued one ends at once, a running or waiting one at its next check), so
 * they end sooner and their turn-log write finds the account gone. Bounded by the active set (a few dozen at most).
 */
async function stopActiveTurns(channelId: string): Promise<void> {
    for (const id of await store.activeTurnIds()) {
        const turn = await store.getTurn(id).catch(() => null);
        if (turn && (turn.channelId === channelId || turn.userId === channelId)) await stopTurn(id, turn.userId).catch(() => undefined);
    }
}

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
    await stopActiveTurns(channelId);
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
    const prefs = [...new Set([...await scanKeys(K.prefs(channelId, '*')), ...await scanKeys(K.prefs('*', channelId))])];
    if (prefs.length) await client.del(prefs);
    for (const key of await scanKeys(limitHitsKey('*'))) await client.hDel(key, channelId);
    const result = await mongoose.connection.collection('site_agent_changes').deleteMany({ channelId });
    // Expert refusals record what was asked: on this channel, and by this person on channels they manage.
    await mongoose.connection.collection('site_agent_refusals').deleteMany({ $or: [{ channelId }, { userId: channelId }] });
    await deleteTurnLogs(channelId);
    // AI app (MCP) calls: on this channel, and by this person on channels they manage.
    await deleteMcpCallLogs(channelId);
    return { sessionsDeleted, changesDeleted: result.deletedCount ?? 0 };
}
