import { Types } from 'mongoose';
import { TWITCH_DOMAIN_EVENT_TYPES } from '../../../../domain_events/domain_event_contracts.js';
import { DOMAIN_EVENT_VIEWER_FIELDS, DomainEventSchema } from '../../../../schemas/domain_event.schema.js';
import { DomainEventDeliverySchema } from '../../../../schemas/domain_event_delivery.schema.js';
import { actorOf, clipText, flatData, loginOnly, mongoPage, num, str, type FeedSource } from '../source.js';
import type { FeedActor, FeedFilters, FeedItem } from '../types.js';

/**
 * Journaled Twitch events (`domain_events`, topic `channel`, the EventSub and dashboard-test sources).
 * Billing events (topic `domain`) are not part of the feed, and neither are the progress updates of polls,
 * predictions, hype trains and goals: they would flood it. Begin and end are kept.
 *
 * Indexes: one channel uses `{channelID, source, type, occurredAt, _id}` (one range per source × type,
 * merged in order); every channel uses `{topic, occurredAt, _id}`; one viewer uses the partial index of
 * each field that can name them (`DOMAIN_EVENT_VIEWER_FIELDS`), merged in order.
 */
export const TWITCH_EVENT_SOURCES = ['twitch-eventsub', 'twitch-eventsub-test'] as const;
export const TEST_EVENT_SOURCE = 'twitch-eventsub-test';

export const FEED_EVENT_TYPES: string[] = [...new Set([...Object.values(TWITCH_DOMAIN_EVENT_TYPES), 'channel.raid.sent'])]
    .filter(type => !type.endsWith('.updated'))
    .sort();

/** Journal type → the Twitch type it came from, for rows without `metadata.originalEventType`. */
const ORIGINAL_TYPE = new Map<string, string>([['channel.raid.sent', 'channel.raid']]);
for (const [twitchType, journalType] of Object.entries(TWITCH_DOMAIN_EVENT_TYPES)) {
    if (!ORIGINAL_TYPE.has(journalType)) ORIGINAL_TYPE.set(journalType, twitchType);
}
export const twitchTypeOf = (journalType: string, metadata: unknown): string | null =>
    str((metadata as { originalEventType?: unknown } | undefined)?.originalEventType) ?? ORIGINAL_TYPE.get(journalType) ?? null;

type TwitchEvent = Record<string, unknown>;
const record = (value: unknown): TwitchEvent => value && typeof value === 'object' && !Array.isArray(value) ? value as TwitchEvent : {};

/** Who caused it: the user, the raiding broadcaster, the chatter, the person who started the ad. */
export function eventActor(journalType: string, event: TwitchEvent): FeedActor | null {
    if (journalType === 'channel.raid.received' || journalType === 'channel.raid.sent') {
        return actorOf(event.from_broadcaster_user_id, event.from_broadcaster_user_login, event.from_broadcaster_user_name);
    }
    if (journalType === 'channel.chat.notification') {
        return event.chatter_is_anonymous === true ? null : actorOf(event.chatter_user_id, event.chatter_user_login, event.chatter_user_name);
    }
    if (journalType === 'channel.ad_break.began') return actorOf(event.requester_user_id, event.requester_user_login, event.requester_user_name);
    if (event.is_anonymous === true) return null;
    return actorOf(event.user_id, event.user_login, event.user_name);
}

const messageText = (event: TwitchEvent): string | null =>
    typeof event.message === 'string' ? clipText(event.message) : clipText(record(event.message).text);

/** A few plain facts per type for the detail view. */
export function eventFacts(journalType: string, event: TwitchEvent): FeedItem['data'] {
    const facts: Record<string, unknown> = {};
    switch (journalType) {
        case 'channel.bits.received':
            facts.amount = num(event.bits);
            break;
        case 'channel.subscription.received':
        case 'channel.subscription.ended':
            facts.tier = str(event.tier);
            facts.months = num(event.cumulative_months);
            break;
        case 'channel.subscription.gifted':
            facts.amount = num(event.total);
            facts.tier = str(event.tier);
            break;
        case 'channel.raid.received':
        case 'channel.raid.sent':
            facts.viewers = num(event.viewers);
            break;
        case 'channel.chat.notification': {
            const notice = str(event.notice_type);
            facts.notice = notice;
            const detail = notice ? record(event[notice]) : {};
            facts.tier = str(detail.sub_tier);
            facts.months = num(detail.cumulative_months) ?? num(detail.duration_months);
            facts.amount = num(detail.total);
            facts.viewers = num(detail.viewer_count);
            break;
        }
        case 'channel.hype_train.began':
        case 'channel.hype_train.ended':
            facts.amount = num(event.total);
            break;
        case 'channel.goal.began':
        case 'channel.goal.ended':
            facts.amount = num(event.current_amount);
            break;
    }
    facts.message = messageText(event);
    return flatData(facts);
}

export interface EventRow {
    _id: Types.ObjectId;
    eventKey: string;
    source: string;
    type: string;
    channelID?: string;
    occurredAt: Date;
    payload?: { event?: unknown };
    metadata?: { originalEventType?: unknown };
}

export function eventItem(row: EventRow, failedDeliveries = 0): FeedItem {
    const event = record(row.payload?.event);
    const data = eventFacts(row.type, event);
    if (row.source === TEST_EVENT_SOURCE) data.test = true;
    if (failedDeliveries > 0) data.failedDeliveries = failedDeliveries;
    const title = clipText(event.title) ?? clipText(event.description);
    return {
        id: `event:${row._id.toHexString()}`,
        at: new Date(row.occurredAt).toISOString(),
        kind: 'twitch_event',
        name: twitchTypeOf(row.type, row.metadata) ?? row.type,
        outcome: 'ok',
        reason: null,
        channelID: row.channelID || null,
        channel: null,
        actor: eventActor(row.type, event),
        text: messageText(event) ?? title,
        credits: null,
        providerUSD: null,
        durationMs: null,
        data,
        ref: { type: 'event', id: row.eventKey }
    };
}

export function eventFilter(filters: FeedFilters): Record<string, unknown> {
    const filter: Record<string, unknown> = { topic: 'channel', source: { $in: [...TWITCH_EVENT_SOURCES] }, type: { $in: FEED_EVENT_TYPES } };
    if (filters.channelID) filter.channelID = filters.channelID;
    // Each branch repeats its partial index's own filter (topic, `$type`) so the planner sees that it applies.
    if (filters.actorID) {
        filter.$or = DOMAIN_EVENT_VIEWER_FIELDS.map(field => ({ topic: 'channel', [`payload.event.${field}`]: { $eq: filters.actorID, $type: 'string' } }));
    } else if (filters.actorLogin) {
        // Logins are not indexed: only reached with a channel (see `plan`), which bounds the scan.
        filter.$or = DOMAIN_EVENT_VIEWER_FIELDS.map(field => field.replace(/_id$/, '_login')).map(field => ({ [`payload.event.${field}`]: filters.actorLogin }));
    }
    return filter;
}

/**
 * One viewer: one query per field that can name them, each read in order from that field's partial index.
 * (With the four fields in one `$or` the planner prefers walking the time index of every event.)
 */
export function viewerFilters(filters: FeedFilters & { actorID: string }): Record<string, unknown>[] {
    const base = eventFilter({ ...filters, actorID: undefined, actorLogin: undefined });
    return DOMAIN_EVENT_VIEWER_FIELDS.map(field => ({ ...base, [`payload.event.${field}`]: { $eq: filters.actorID, $type: 'string' } }));
}

const newestFirst = (a: EventRow, b: EventRow) =>
    new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime() || b._id.toHexString().localeCompare(a._id.toHexString());

let consumerNames: Promise<string[]> | undefined;
/** Loaded on first use: the consumer module pulls in every handler's dependencies. */
export function registeredConsumers(): Promise<string[]> {
    consumerNames ??= import('../../../../domain_events/domain_event_consumers.js')
        .then(module => module.DOMAIN_EVENT_CONSUMERS.map(definition => definition.consumer))
        .catch(error => { consumerNames = undefined; throw error; });
    return consumerNames;
}

/** Consumers that gave up per event key, through the unique `{consumer, eventKey}` index. Best effort. */
async function deadDeliveries(eventKeys: string[], maxTimeMS: number): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (!eventKeys.length) return counts;
    try {
        const consumers = await registeredConsumers();
        const rows = await DomainEventDeliverySchema.collection.find(
            { consumer: { $in: consumers }, eventKey: { $in: eventKeys }, status: 'dead' },
            { projection: { _id: 0, eventKey: 1 }, maxTimeMS }
        ).toArray();
        for (const row of rows) counts.set(row.eventKey, (counts.get(row.eventKey) || 0) + 1);
    } catch {
        // The count is a hint on the row; the page is still right without it.
    }
    return counts;
}

const PROJECTION = { eventKey: 1, source: 1, type: 1, channelID: 1, occurredAt: 1, 'payload.event': 1, 'metadata.originalEventType': 1 };

export const eventsSource: FeedSource = {
    prefix: 'event',
    plan(filters) {
        if (filters.kinds?.length && !filters.kinds.includes('twitch_event')) return [];
        // Every row is a notification that arrived: nothing here is a problem.
        if (filters.outcome) return [];
        if (loginOnly(filters) && !filters.channelID) return [];
        return ['twitch_event'];
    },
    gaps(filters) {
        if (filters.kinds?.length && !filters.kinds.includes('twitch_event')) return [];
        return !filters.outcome && loginOnly(filters) && !filters.channelID ? ['twitch_event'] : [];
    },
    async list({ filters, bound, limit, maxTimeMS }) {
        const page = (filter: Record<string, unknown>) => mongoPage(DomainEventSchema.collection, filter, {
            timeField: 'occurredAt', idField: '_id', from: filters.from, to: filters.to, bound, limit, maxTimeMS,
            projection: PROJECTION, toDbId: id => /^[0-9a-f]{24}$/.test(id) ? new Types.ObjectId(id) : id
        }) as unknown as Promise<EventRow[]>;
        const { actorID } = filters;
        let rows: EventRow[];
        if (actorID) {
            const unique = new Map<string, EventRow>();
            for (const row of (await Promise.all(viewerFilters({ ...filters, actorID }).map(page))).flat()) unique.set(row._id.toHexString(), row);
            rows = [...unique.values()].sort(newestFirst).slice(0, limit);
        } else {
            rows = await page(eventFilter(filters));
        }
        const dead = await deadDeliveries(rows.map(row => row.eventKey), maxTimeMS);
        return rows.map(row => eventItem(row, dead.get(row.eventKey)));
    },
    async count({ filters, maxTimeMS }) {
        const window = { occurredAt: { $gte: filters.from, $lt: filters.to } };
        const { actorID } = filters;
        // A viewer: per field, as in `list`; a row is counted under the first field that names them.
        const queries = actorID
            ? viewerFilters({ ...filters, actorID }).map((filter, index) => ({
                ...filter, ...window,
                ...Object.fromEntries(DOMAIN_EVENT_VIEWER_FIELDS.slice(0, index).map(field => [`payload.event.${field}`, { $ne: actorID }]))
            }))
            : [{ ...eventFilter(filters), ...window }];
        const totals = await Promise.all(queries.map(query => DomainEventSchema.collection.countDocuments(query, { maxTimeMS })));
        const total = totals.reduce((sum, value) => sum + value, 0);
        return [{ kind: 'twitch_event', total, problems: 0, failed: 0 }];
    }
};
