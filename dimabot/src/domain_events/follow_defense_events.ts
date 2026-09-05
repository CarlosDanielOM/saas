import type { DomainEventEnvelope } from './domain_event.types.js';
import type { FollowDefenseFollowPayload, FollowDefenseRaidMarker } from '../utils/follow_defense_queue.js';

export interface FollowDefenseEventDependencies {
    getStreamer(channelID: string): Promise<unknown>;
    getEventsubConfig(channelID: string, type: string): Promise<{ enabled: boolean; minViewers?: number } | null>;
    processFollow(follow: FollowDefenseFollowPayload): Promise<void>;
    setRaidMarker(marker: FollowDefenseRaidMarker): Promise<void>;
}

async function getDependencies(): Promise<FollowDefenseEventDependencies> {
    const [{ default: UsersSchema }, { default: EventsubSchema }, defense, queue] = await Promise.all([
        import('../schemas/users.schema.js'),
        import('../schemas/eventsub.schema.js'),
        import('../utils/follow_defense.js'),
        import('../utils/follow_defense_queue.js')
    ]);
    return {
        // The legacy streamer cache helper turns dependency errors into null.
        getStreamer: async (channelID) => UsersSchema.exists({ accounts: { $elemMatch: { type: 'twitch', id: channelID } } }),
        getEventsubConfig: (channelID, type) => EventsubSchema.findOne({ channelID, type }).lean(),
        processFollow: defense.processDurableFollowDefenseFollow,
        setRaidMarker: queue.applyDurableFollowDefenseRaidMarker
    };
}

export async function applyFollowDefenseDomainEvent(
    event: DomainEventEnvelope,
    injectedDependencies?: FollowDefenseEventDependencies
): Promise<void> {
    if (event.source !== 'twitch-eventsub' || event.metadata.durableDefenseHandled !== true
        || event.topic !== 'channel' || event.schemaVersion !== 1
        || !['channel.follow.received', 'channel.raid.received'].includes(event.type)) return;
    const occurredAt = event.occurredAt.getTime();
    if (!event.channelID || !event.eventKey || !Number.isFinite(occurredAt)) {
        throw new Error('Follow defense requires channel, event identity and occurrence time');
    }
    const raw = event.payload.event as Record<string, unknown> | undefined;
    const isFollow = event.type === 'channel.follow.received';
    const subjectID = String((isFollow ? raw?.user_id : raw?.from_broadcaster_user_id) || '');
    if (!subjectID) throw new Error('Follow defense requires a follower or raider identity');
    const dependencies = injectedDependencies || await getDependencies();
    if (!await dependencies.getStreamer(event.channelID)) return;
    const config = await dependencies.getEventsubConfig(event.channelID, isFollow ? 'channel.follow' : 'channel.raid');
    if (config?.enabled === false) return;

    if (isFollow) {
        await dependencies.processFollow({
            eventID: event.eventKey,
            channelID: event.channelID,
            channelLogin: String(raw?.broadcaster_user_login || ''),
            channelName: String(raw?.broadcaster_user_name || ''),
            followerID: subjectID,
            followerLogin: String(raw?.user_login || ''),
            followerName: String(raw?.user_name || ''),
            followedAt: event.occurredAt.toISOString(),
            receivedAt: event.journaledAt.getTime()
        });
    } else {
        const viewers = Number(raw?.viewers || 0);
        if ((config?.minViewers || 0) > viewers) return;
        await dependencies.setRaidMarker({
            eventID: event.eventKey,
            channelID: event.channelID,
            channelLogin: String(raw?.to_broadcaster_user_login || ''),
            channelName: String(raw?.to_broadcaster_user_name || ''),
            raiderChannelID: subjectID,
            raiderChannelLogin: String(raw?.from_broadcaster_user_login || ''),
            raiderChannelName: String(raw?.from_broadcaster_user_name || ''),
            raidViewers: viewers,
            createdAt: occurredAt,
            expiresAt: occurredAt + 300_000
        });
    }
}
