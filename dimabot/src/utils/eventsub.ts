import { getTwitchStreamerHeaderById, type TwitchHeaderResult } from './header.js';
import { getTwitchHelixUrl } from './links.js';
import { getAppToken } from './tokens.js';
import TwitchStreamers from '../classes/twitch_streamers.class.js';
import EventsubSchema, { type IEventsub, type ICondition } from '../schemas/eventsub.schema.js';
import { buildBitsEventsubConfig, type EventsubConfig } from './eventsub_bits_config.js';

export const CANONICAL_BITS_EVENT_TYPE = 'channel.bits.use';
export const LEGACY_BITS_EVENT_TYPES = ['channel.cheer', 'channel.bit.use'] as const;

export function isLegacyBitsEventType(type: string): type is (typeof LEGACY_BITS_EVENT_TYPES)[number] {
    return LEGACY_BITS_EVENT_TYPES.includes(type as (typeof LEGACY_BITS_EVENT_TYPES)[number]);
}

export function isBitsEventType(type: string): boolean {
    return type === CANONICAL_BITS_EVENT_TYPE || isLegacyBitsEventType(type);
}

export function canonicalizeEventsubType(type: string): string {
    return isLegacyBitsEventType(type) ? CANONICAL_BITS_EVENT_TYPE : type;
}

export function getEquivalentEventsubTypes(type: string): string[] {
    const canonicalType = canonicalizeEventsubType(type);

    if (canonicalType === CANONICAL_BITS_EVENT_TYPE) {
        return [CANONICAL_BITS_EVENT_TYPE, ...LEGACY_BITS_EVENT_TYPES];
    }

    return [canonicalType];
}

export interface SubscriptionType {
    type: string;
    version: string;
    condition: ICondition;
    config?: EventsubConfig;
}

export interface SubscribeTwitchEventResponse {
    _id?: string;
    id: string;
    status: string;
    type: string;
    version: string;
    condition: ICondition;
    created_at: string;
    transport: {
        method: string;
        callback: string;
    };
    cost: number;
    [key: string]: any;
}

export interface SubscribeTwitchEventError {
    error: string;
    message: string;
    status: number;
}

export interface BitsEventsubMigrationResult {
    canonicalEventsub: IEventsub | null;
    hadCanonicalBeforeMigration: boolean;
    hadLegacyBeforeMigration: boolean;
    createdCanonical: boolean;
    removedLegacyCount: number;
    errors: string[];
}

const MOD_ID = '698614112';

function sortValueDeep(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortValueDeep);
    }

    if (value && typeof value === 'object') {
        return Object.keys(value as Record<string, unknown>)
            .sort()
            .reduce<Record<string, unknown>>((acc, key) => {
                acc[key] = sortValueDeep((value as Record<string, unknown>)[key]);
                return acc;
            }, {});
    }

    return value;
}

function serializeCondition(condition: ICondition): string {
    return JSON.stringify(sortValueDeep((condition || {}) as Record<string, unknown>));
}

function toEventsubResponse(eventsub: Partial<IEventsub> & { _id?: unknown }): SubscribeTwitchEventResponse {
    return {
        _id: eventsub._id ? String(eventsub._id) : undefined,
        id: String(eventsub.id || ''),
        status: String(eventsub.status || ''),
        type: String(eventsub.type || ''),
        version: String(eventsub.version || ''),
        condition: (eventsub.condition || {}) as ICondition,
        created_at: String(eventsub.created_at || ''),
        transport: eventsub.transport || {
            method: '',
            callback: ''
        },
        cost: Number(eventsub.cost || 0),
        channel: String(eventsub.channel || ''),
        channelID: String(eventsub.channelID || ''),
        enabled: Boolean(eventsub.enabled),
        message: String(eventsub.message || ''),
        endMessage: String(eventsub.endMessage || ''),
        endEnabled: Boolean(eventsub.endEnabled),
        minViewers: Number(eventsub.minViewers || 0),
        temporalBanMessage: String(eventsub.temporalBanMessage || ''),
        clipEnabled: Boolean(eventsub.clipEnabled),
        delay: Number(eventsub.delay || 0),
        cheerTiers: Array.isArray(eventsub.cheerTiers) ? eventsub.cheerTiers : [],
        todayFollows: eventsub.todayFollows,
    };
}

async function findExistingEventsub(
    channelID: string,
    type: string,
    version: string,
    condition: ICondition
): Promise<(Partial<IEventsub> & { _id?: unknown }) | null> {
    const conditionKey = serializeCondition(condition);
    const existingEventsubs = await EventsubSchema.find({ channelID, type, version }).lean();

    for (const eventsub of existingEventsubs) {
        if (serializeCondition((eventsub.condition || {}) as ICondition) === conditionKey) {
            return eventsub as Partial<IEventsub> & { _id?: unknown };
        }
    }

    return null;
}

export const SUBSCRIPTION_TYPES: SubscriptionType[] = [
    {
        type: 'channel.chat.message',
        version: '1',
        condition: {
            broadcaster_user_id: '698614112',
            user_id: MOD_ID
        }
    },
    {
        type: 'channel.follow',
        version: '2',
        condition: {
            broadcaster_user_id: '698614112',
            moderator_user_id: MOD_ID
        },
        config: {
            message: '$(user) has followed, Welcome to the stream!'
        }
    },
    {
        type: 'stream.online',
        version: '1',
        condition: {
            broadcaster_user_id: '698614112'
        },
        config: {
            message: '$(twitch.channel) is now live! Playing $(twitch.game)'
        }
    },
    {
        type: 'stream.offline',
        version: '1',
        condition: {
            broadcaster_user_id: '698614112'
        },
        config: {
            message: '$(twitch.channel) is now offline!'
        }
    },
    {
        type: 'channel.raid',
        version: '1',
        condition: {
            to_broadcaster_user_id: '698614112'
        },
        config: {
            message: '$(raid.channel) is raiding with $(raid.viewers) viewers!',
            clipEnabled: true
        }
    },
    {
        type: 'channel.poll.progress',
        version: '1',
        condition: {
            broadcaster_user_id: '698614112'
        }
    },
    {
        type: 'channel.prediction.progress',
        version: '1',
        condition: {
            broadcaster_user_id: '698614112'
        }
    },
    {
        type: 'channel.hype_train.begin',
        version: '2',
        condition: {
            broadcaster_user_id: '698614112'
        },
        config: {
            message: 'Hype train has started! It started at $(hypetrain.progress) and will end at $(hypetrain.end)'
        }
    },
    {
        type: 'channel.hype_train.progress',
        version: '2',
        condition: {
            broadcaster_user_id: '698614112'
        },
        config: {
            message: 'Hype train has progressed to level $(hypetrain.level)!'
        }
    },
    {
        type: 'channel.hype_train.end',
        version: '2',
        condition: {
            broadcaster_user_id: '698614112'
        },
        config: {
            message: 'Hype train has ended! It ended at level $(hypetrain.level) with $(hypetrain.progress)% progress!'
        }
    },
    {
        type: 'channel.shoutout.receive',
        version: '1',
        condition: {
            broadcaster_user_id: '698614112',
            moderator_user_id: MOD_ID
        },
        config: {
            message: '$(shoutout.channel) has sent a shoutout to $(twitch.channel)!'
        }
    },
    {
        type: 'channel.ad_break.begin',
        version: '1',
        condition: {
            broadcaster_user_id: '698614112'
        },
        config: {
            message: '$(ad.time) seconds of ad break has begun!',
            endMessage: 'Ad break has ended!',
            endEnabled: true
        }
    },
    {
        type: 'user.update',
        version: '1',
        condition: {
            user_id: '698614112'
        }
    },
    {
        type: 'channel.subscribe',
        version: '1',
        condition: {
            broadcaster_user_id: '698614112'
        },
        config: {
            message: '$(user) subscribed with $(sub.tier) for the first time!'
        }
    },
    {
        type: 'channel.subscription.gift',
        version: '1',
        condition: {
            broadcaster_user_id: '698614112'
        },
        config: {
            message: '$(user) gifted a $(sub.tier) subscription to $(gifted.user)!'
        }
    },
    {
        type: 'channel.subscription.message',
        version: '1',
        condition: {
            broadcaster_user_id: '698614112'
        },
        config: {
            message: '$(user) resubscribed with $(sub.tier) for $(sub.months) months on a row!'
        }
    },
    {
        type: 'channel.subscription.end',
        version: '1',
        condition: {
            broadcaster_user_id: '698614112'
        }
    },
    {
        type: 'channel.update',
        version: '1',
        condition: {
            broadcaster_user_id: '698614112'
        }
    },
    {
        type: CANONICAL_BITS_EVENT_TYPE,
        version: '1',
        condition: {
            broadcaster_user_id: '698614112'
        },
        config: {
            message: '$(user) cheered $(cheer.amount) bits!'
        }
    },
    {
        type: 'automod.message.hold',
        version: '1',
        condition: {
            broadcaster_user_id: '698614112'
        }
    }
];

export async function subscribeTwitchEvent(
    channelID: string,
    type: string,
    version: string,
    condition: ICondition,
    config?: EventsubConfig,
    options?: { ignoreExisting?: boolean }
): Promise<SubscribeTwitchEventResponse | SubscribeTwitchEventError> {
    if (!process.env.TWITCH_EVENTSUB_SECRET) {
        return {
            error: 'EventSub secret is not configured',
            message: 'TWITCH_EVENTSUB_SECRET is not set',
            status: 500
        };
    }
    const streamer = await TwitchStreamers.getTwitchAccountById(channelID);
    if (!streamer) {
        return {
            error: 'Streamer not found',
            message: 'Streamer not found',
            status: 404
        };
    }

    if (!options?.ignoreExisting) {
        const existingEventsub = await findExistingEventsub(channelID, type, version, condition);
        if (existingEventsub?.id) {
            return toEventsubResponse(existingEventsub);
        }
    }

    const streamerHeaderResult = await getTwitchStreamerHeaderById(channelID);
    if (streamerHeaderResult.error || !streamerHeaderResult.header) {
        return {
            error: 'Failed to get streamer header',
            message: streamerHeaderResult.message,
            status: 500
        };
    }

    const appAccessToken = await getAppToken('twitch');

    if (!appAccessToken || !process.env.CLIENT_ID) {
        console.error('Error getting Twitch app credentials');
        return {
            error: 'Error getting Twitch app credentials',
            message: 'An app access token and client ID are required',
            status: 500
        };
    }

    // Twitch requires app authorization for EventSub webhook transport.
    const headers = {
        ...streamerHeaderResult.header,
        Authorization: `Bearer ${appAccessToken}`
    };

    const response = await fetch(getTwitchHelixUrl('eventsub/subscriptions'), {
        method: 'POST',
        headers: headers as unknown as Record<string, string>,
        body: JSON.stringify({
            type,
            version,
            condition,
            transport: {
                method: 'webhook',
                callback: `https://subscriptions.domdimabot.com/eventsub`,
                secret: process.env.TWITCH_EVENTSUB_SECRET
            }
        })
    });

    const data = await response.json();

    if (!response.ok || data?.error || !Array.isArray(data?.data) || !data.data[0]) {
        const error = String(data?.error || `Twitch returned HTTP ${response.status}`);
        console.error(`Error subscribing to ${type} for ${channelID}: ${error}`);
        return {
            error,
            message: String(data?.message || error),
            status: response.status || 502
        };
    }

    const subscriptionData = data.data[0];

    const eventsubPayload = {
        id: subscriptionData.id,
        status: subscriptionData.status,
        type: subscriptionData.type,
        version: subscriptionData.version,
        condition: subscriptionData.condition,
        created_at: subscriptionData.created_at,
        transport: subscriptionData.transport,
        cost: subscriptionData.cost,
        channel: streamer.name,
        channelID: channelID
    };

    const newEventSub = await EventsubSchema.findOneAndUpdate(
        { id: subscriptionData.id },
        {
            $set: {
                ...eventsubPayload,
                ...(config || {})
            }
        },
        {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true
        }
    ).lean();

    return toEventsubResponse((newEventSub || eventsubPayload) as Partial<IEventsub> & { _id?: unknown });
}

export async function getEventsubs(): Promise<any> {
    const appToken = await getAppToken('twitch');
    if (!appToken || !process.env.CLIENT_ID) {
        return {
            error: 'Twitch app credentials are not configured',
            message: 'Unable to list EventSub subscriptions without an app token and client ID',
            status: 500
        };
    }

    const headers = {
        'Authorization': `Bearer ${appToken}`,
        'Client-Id': process.env.CLIENT_ID!,
        'Content-Type': 'application/json'
    };

    const data: unknown[] = [];
    const seenCursors = new Set<string>();
    let cursor = '';
    let summary: Record<string, unknown> = {};
    let pageCount = 0;

    do {
        pageCount += 1;
        if (pageCount > 1_000) {
            return { error: 'EventSub pagination exceeded safety limit', status: 502 };
        }
        const params = new URLSearchParams({ first: '100' });
        if (cursor) params.set('after', cursor);
        const response = await fetch(getTwitchHelixUrl('eventsub/subscriptions', params.toString()), {
            headers: headers as unknown as Record<string, string>
        });
        const page = await response.json();
        if (!response.ok || page?.error) {
            return page;
        }
        if (Array.isArray(page?.data)) {
            data.push(...page.data);
        }
        summary = page;
        const nextCursor = String(page?.pagination?.cursor || '');
        if (seenCursors.has(nextCursor)) {
            return { error: 'EventSub pagination returned a repeated cursor', status: 502 };
        }
        if (!nextCursor) {
            cursor = '';
        } else {
            seenCursors.add(nextCursor);
            cursor = nextCursor;
        }
    } while (cursor);

    return {
        ...summary,
        data,
        total: data.length,
        pagination: {},
        complete: true
    };
}

export async function unsubscribeTwitchEvent(id: string): Promise<Response | any> {
    const appAccessToken = await getAppToken('twitch');

    if (!appAccessToken || !process.env.CLIENT_ID) {
        console.error('Error getting Twitch app credentials');
        return {
            error: 'Error getting Twitch app credentials',
            message: 'An app access token and client ID are required',
            status: 500
        };
    }

    const headers = {
        'Authorization': `Bearer ${appAccessToken}`,
        'Client-Id': process.env.CLIENT_ID!,
        'Content-Type': 'application/json'
    };

    const response = await fetch(getTwitchHelixUrl('eventsub/subscriptions') + `?id=${id}`, {
        method: 'DELETE',
        headers: headers as unknown as Record<string, string>
    });

    if (response.status === 204 || response.status === 404) {
        await EventsubSchema.deleteOne({ id });
        return response;
    }

    const data = await response.json();

    const errorMessage = String(data?.message || data?.error || `Twitch returned HTTP ${response.status}`);
    console.error(`Error unsubscribing to ${id}: ${errorMessage}`);
    return {
        error: String(data?.error || 'Failed to unsubscribe EventSub'),
        message: errorMessage,
        status: response.status
    };
}

export async function migrateLegacyBitsEventsubs(channelID: string): Promise<BitsEventsubMigrationResult> {
    const [canonicalEventsub, legacyEventsubs] = await Promise.all([
        EventsubSchema.findOne({ channelID, type: CANONICAL_BITS_EVENT_TYPE }).lean(),
        EventsubSchema.find({ channelID, type: { $in: LEGACY_BITS_EVENT_TYPES } }).lean()
    ]);
    const typedCanonicalEventsub = canonicalEventsub as (Partial<IEventsub> & { _id?: unknown }) | null;

    const result: BitsEventsubMigrationResult = {
        canonicalEventsub: typedCanonicalEventsub as IEventsub | null,
        hadCanonicalBeforeMigration: Boolean(typedCanonicalEventsub),
        hadLegacyBeforeMigration: legacyEventsubs.length > 0,
        createdCanonical: false,
        removedLegacyCount: 0,
        errors: []
    };

    if (legacyEventsubs.length === 0) {
        return result;
    }

    const mergedConfig = buildBitsEventsubConfig(
        typedCanonicalEventsub as Partial<IEventsub> | null,
        legacyEventsubs as Array<Partial<IEventsub>>
    );

    let currentCanonicalEventsub = typedCanonicalEventsub;

    if (!currentCanonicalEventsub) {
        const createResult = await subscribeTwitchEvent(
            channelID,
            CANONICAL_BITS_EVENT_TYPE,
            '1',
            { broadcaster_user_id: channelID },
            mergedConfig
        );

        if ('error' in createResult) {
            result.errors.push(createResult.message || 'Failed to create canonical bits eventsub');
            return result;
        }

        currentCanonicalEventsub = await EventsubSchema.findOne({ channelID, type: CANONICAL_BITS_EVENT_TYPE }).lean() as IEventsub | null;
        result.createdCanonical = true;
    } else {
        currentCanonicalEventsub = await EventsubSchema.findOneAndUpdate(
            { _id: currentCanonicalEventsub._id },
            { $set: mergedConfig },
            { new: true }
        ).lean() as IEventsub | null;
    }

    for (const legacyEventsub of legacyEventsubs) {
        const unsubscribeResult = await unsubscribeTwitchEvent(legacyEventsub.id);
        if ((unsubscribeResult as { error?: unknown })?.error) {
            result.errors.push(`Failed to remove ${legacyEventsub.type}`);
            continue;
        }

        result.removedLegacyCount += 1;
    }

    result.canonicalEventsub = currentCanonicalEventsub as IEventsub | null;
    return result;
}
