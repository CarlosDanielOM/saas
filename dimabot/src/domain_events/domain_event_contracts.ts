import type { JournalDomainEventInput } from './domain_event.types.js';
import type { PolarBillingPayload } from './polar_events.js';

export class DomainEventContractError extends Error {
    readonly permanent = true;

    constructor(message: string) {
        super(`Domain event contract: ${message}`);
        this.name = 'DomainEventContractError';
    }
}

export const TWITCH_DOMAIN_EVENT_TYPES = {
    'channel.bits.use': 'channel.bits.received',
    'channel.cheer': 'channel.bits.received',
    'channel.bit.use': 'channel.bits.received',
    'channel.follow': 'channel.follow.received',
    'channel.raid': 'channel.raid.received',
    'channel.subscribe': 'channel.subscription.received',
    'channel.subscription.message': 'channel.subscription.received',
    'channel.subscription.gift': 'channel.subscription.gifted',
    'channel.subscription.end': 'channel.subscription.ended',
    'stream.online': 'stream.started',
    'stream.offline': 'stream.ended'
} as const;

export type TwitchEventsubPayload = {
    [Type in keyof typeof TWITCH_DOMAIN_EVENT_TYPES]: {
        subscription: Record<string, unknown> & { type: Type; id?: string; version?: string };
        event: Record<string, unknown> & (
            Type extends 'channel.raid' ? { to_broadcaster_user_id: string; from_broadcaster_user_id: string; viewers: number }
                : { broadcaster_user_id: string } & (
                    Type extends 'stream.online' ? { id: string; started_at?: string }
                        : Type extends 'channel.follow' | 'channel.subscribe' | 'channel.subscription.message' | 'channel.subscription.end'
                            ? { user_id: string; followed_at?: string }
                            : Type extends 'channel.bits.use' | 'channel.bit.use' | 'channel.cheer' ? { bits: number }
                                : { total?: number }
                )
        );
    }
}[keyof typeof TWITCH_DOMAIN_EVENT_TYPES];

const POLAR_DOMAIN_EVENT_TYPES: Record<string, string> = {
    'order.paid': 'billing.order.paid',
    'subscription.updated': 'billing.subscription.updated',
    'customer.state_changed': 'billing.customer.state.changed'
};
export const DOMAIN_EVENT_MAX_JSON_BYTES = 256 * 1024;

function requireContract(condition: unknown, message: string): asserts condition {
    if (!condition) throw new DomainEventContractError(message);
}

function record(value: unknown, field: string): asserts value is Record<string, unknown> {
    requireContract(value !== null && typeof value === 'object' && !Array.isArray(value)
        && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null), `${field} must be a plain record`);
}

function text(value: unknown, field: string): asserts value is string {
    requireContract(typeof value === 'string' && value.trim() !== '' && value === value.trim(), `${field} is required and must be a nonblank string`);
}

function count(value: unknown, field: string, minimum = 0): void {
    requireContract(typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum, `${field} must be a safe integer >= ${minimum}`);
}

function date(value: unknown, field: string, allowDate = false): void {
    if (allowDate && value instanceof Date) {
        requireContract(Number.isFinite(value.getTime()), `${field} must be a valid date`);
        return;
    }
    requireContract(typeof value === 'string'
        && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
        && Number.isFinite(Date.parse(value)), `${field} must be a valid date`);
    const [year, month, day] = value.slice(0, 10).split('-').map(Number);
    requireContract(month >= 1 && month <= 12 && day >= 1
        && day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
        && Number(value.slice(11, 13)) < 24, `${field} must be a valid date`);
}

// One bounded walk rejects values JSON.stringify would silently change or execute.
// SDK-only conversion permits Date and omitted object properties before persistence.
function checkJson(value: unknown, sdk = false): void {
    const ancestors = new Set<object>();
    let bytes = 0;
    function visit(value: unknown, depth: number): void {
        requireContract(depth <= 32, 'JSON nesting exceeds 32 levels');
        if (value === null || typeof value === 'boolean') bytes += 5;
        else if (typeof value === 'string') {
            requireContract(value.length <= DOMAIN_EVENT_MAX_JSON_BYTES, 'JSON exceeds 256 KiB');
            bytes += Buffer.byteLength(JSON.stringify(value));
        } else if (typeof value === 'number') {
            requireContract(Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)), 'JSON numbers must be finite and integers must be safe');
            bytes += String(value).length;
        } else if (sdk && value instanceof Date) {
            date(value, 'SDK date', true);
            requireContract(Object.getPrototypeOf(value) === Date.prototype && Reflect.ownKeys(value).length === 0, 'SDK date must not override serialization');
            bytes += 26;
        } else {
            requireContract(value !== null && typeof value === 'object', 'payload and metadata must be JSON-safe');
            const array = Array.isArray(value);
            if (array) requireContract(Object.getPrototypeOf(value) === Array.prototype, 'JSON array has an invalid prototype');
            else record(value, 'JSON value');
            requireContract(!ancestors.has(value), 'JSON must not contain cycles');
            ancestors.add(value);
            bytes += 2;
            let entries = 0;
            for (const key of Reflect.ownKeys(value)) {
                if (array && key === 'length') continue;
                requireContract(typeof key === 'string' && !['__proto__', 'prototype', 'constructor'].includes(key), 'JSON contains an unsafe property');
                requireContract(key.length <= DOMAIN_EVENT_MAX_JSON_BYTES, 'JSON exceeds 256 KiB');
                if (array) requireContract(/^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length, 'JSON arrays must not contain extra properties');
                const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
                requireContract('value' in descriptor && descriptor.enumerable, 'JSON must not contain accessors or hidden properties');
                if (sdk && !array && descriptor.value === undefined) continue;
                entries++;
                bytes += array ? 1 : Buffer.byteLength(JSON.stringify(key)) + 2;
                visit(descriptor.value, depth + 1);
            }
            if (array) requireContract(entries === value.length, 'JSON arrays must not contain holes');
            ancestors.delete(value);
        }
        requireContract(bytes <= DOMAIN_EVENT_MAX_JSON_BYTES, 'JSON exceeds 256 KiB');
    }
    visit(value, 0);
}

export function serializeDomainEventProviderData(value: Record<string, unknown>): Record<string, unknown> {
    record(value, 'providerData');
    checkJson(value, true);
    return JSON.parse(JSON.stringify(value));
}

/** Retained mode is for trusted journal reads; all producer/write boundaries must use ingest mode. */
export function validateDomainEventContract(input: JournalDomainEventInput, mode: 'ingest' | 'retained' = 'retained'): void {
    requireContract(input !== null && typeof input === 'object', 'input must be an envelope');
    for (const field of ['source', 'sourceEventId', 'type'] as const) text(input[field], field);
    requireContract(['channel', 'activity', 'telemetry', 'domain'].includes(input.topic), 'topic is invalid');
    count(input.schemaVersion === undefined ? 1 : input.schemaVersion, 'schemaVersion', 1);
    if (input.retentionSeconds !== undefined) {
        requireContract(typeof input.retentionSeconds === 'number' && Number.isFinite(input.retentionSeconds), 'retentionSeconds must be finite numbers');
        requireContract(input.retentionSeconds > 0 && input.retentionSeconds <= 8e12, 'retentionSeconds is out of range');
    }
    if (input.channelID !== undefined || input.topic === 'channel') text(input.channelID, 'channelID');
    if (input.streamID !== undefined) text(input.streamID, 'streamID');
    if (input.ownerUserId !== undefined) requireContract(typeof input.ownerUserId === 'string' && /^[a-f\d]{24}$/i.test(input.ownerUserId), 'ownerUserId must be an internal user ObjectId');
    if (input.subject !== undefined) {
        // Retained envelopes can contain a hydrated Mongoose subject subdocument.
        requireContract(input.subject !== null && typeof input.subject === 'object' && !Array.isArray(input.subject), 'subject must be an identity');
        text(input.subject.provider, 'subject.provider');
        text(input.subject.id, 'subject.id');
        requireContract(['streaming-account', 'integration-account', 'customer', 'resource'].includes(input.subject.kind), 'subject.kind is invalid');
    }
    requireContract(input.topic === 'channel' || input.subject || input.ownerUserId, 'requires a subject or owner identity');
    if (input.occurredAt !== undefined) date(input.occurredAt, 'occurredAt', true);
    if ('eventKey' in input) {
        text(input.eventKey, 'eventKey');
        date(input.occurredAt, 'occurredAt', true);
    }
    if ('journaledAt' in input) date(input.journaledAt, 'journaledAt', true);
    if ('expiresAt' in input) date(input.expiresAt, 'expiresAt', true);
    record(input.payload, 'payload');
    if (input.metadata !== undefined) record(input.metadata, 'metadata');
    checkJson({ payload: input.payload, metadata: input.metadata ?? {} });
    const metadata = input.metadata ?? {};
    const twitch = input.source === 'twitch-eventsub' || input.source === 'twitch-eventsub-test';
    const polar = input.source === 'polar-webhook';
    if (!twitch && !polar) return;
    requireContract((input.schemaVersion ?? 1) === 1, `unsupported schemaVersion for ${input.source}`);
    text(metadata.originalEventType, 'metadata.originalEventType');
    const original = metadata.originalEventType;

    if (twitch) {
        requireContract(Object.hasOwn(TWITCH_DOMAIN_EVENT_TYPES, original)
            && TWITCH_DOMAIN_EVENT_TYPES[original as keyof typeof TWITCH_DOMAIN_EVENT_TYPES] === input.type
            && input.topic === 'channel', 'Twitch source/type/topic/originalEventType mismatch');
        // Before 75e22ef, Twitch schema 1 used channelID without subject/owner or durable-effect markers.
        // Only that complete retained shape may omit the subject; payload checks below remain identical.
        const legacySubject = mode === 'retained' && input.subject === undefined && input.ownerUserId === undefined
            && original !== 'channel.raid' && metadata.durableChatHandled === undefined && metadata.durableDefenseHandled === undefined
            && input.schemaVersion === 1 && '_id' in input && input._id !== null && typeof input._id === 'object'
            && '_bsontype' in input._id && input._id._bsontype === 'ObjectId'
            && 'eventKey' in input && input.eventKey === [input.source, input.sourceEventId, input.type].map(encodeURIComponent).join(':')
            && input.occurredAt instanceof Date && 'journaledAt' in input && input.journaledAt instanceof Date
            && 'expiresAt' in input && input.expiresAt instanceof Date
            && typeof metadata.subscriptionID === 'string' && typeof metadata.subscriptionVersion === 'string'
            && typeof metadata.messageTimestamp === 'string';
        requireContract(legacySubject || (input.subject?.provider === 'twitch' && input.subject.kind === 'streaming-account'
            && input.subject.id === input.channelID), 'Twitch subject/channelID mismatch');
        const { subscription, event } = input.payload;
        record(subscription, 'payload.subscription');
        record(event, 'payload.event');
        requireContract(subscription.type === original, 'Twitch subscription.type/originalEventType mismatch');
        if (subscription.id !== undefined) text(subscription.id, 'subscription.id');
        if (subscription.version !== undefined) requireContract(subscription.version === (original === 'channel.follow' ? '2' : '1'), 'unsupported Twitch subscription.version');
        if (subscription.cost !== undefined) count(subscription.cost, 'subscription.cost');
        if (subscription.created_at !== undefined) date(subscription.created_at, 'subscription.created_at');
        if (subscription.condition !== undefined) {
            record(subscription.condition, 'subscription.condition');
            for (const field of ['broadcaster_user_id', 'to_broadcaster_user_id', 'from_broadcaster_user_id']) {
                if (subscription.condition[field] !== undefined) requireContract(subscription.condition[field]
                    === (field === 'from_broadcaster_user_id' ? event.from_broadcaster_user_id : input.channelID), `subscription.condition.${field} mismatch`);
            }
        }
        for (const [field, value] of [['subscriptionID', subscription.id], ['subscriptionVersion', subscription.version]] as const) {
            if (metadata[field] !== undefined) requireContract(metadata[field] === (value ?? ''), `metadata.${field} mismatch`);
        }
        const channelField = original === 'channel.raid' ? 'to_broadcaster_user_id' : 'broadcaster_user_id';
        text(event[channelField], `event.${channelField}`);
        requireContract(event[channelField] === input.channelID, 'Twitch payload/channelID mismatch');
        if (event.broadcaster_user_id !== undefined) requireContract(event.broadcaster_user_id === input.channelID, 'Twitch broadcaster/channelID mismatch');
        if (original === 'channel.raid') {
            text(event.from_broadcaster_user_id, 'event.from_broadcaster_user_id');
            count(event.viewers, 'event.viewers');
        }
        if (['channel.follow', 'channel.subscribe', 'channel.subscription.message', 'channel.subscription.end'].includes(original)) text(event.user_id, 'event.user_id');
        if (input.type === 'channel.bits.received') count(event.bits, 'event.bits', 1);
        if (original === 'stream.online') {
            text(event.id, 'event.id');
            requireContract(input.streamID === event.id, 'Twitch streamID/event.id mismatch');
        }
        for (const field of ['total', 'cumulative_months', 'duration_months', 'months'] as const) {
            if (event[field] !== undefined) count(event[field], `event.${field}`, field === 'total' ? 1 : 0);
        }
        for (const field of ['cumulative_total', 'streak_months'] as const) {
            if (event[field] != null) count(event[field], `event.${field}`);
        }
        for (const field of ['is_anonymous', 'is_gift'] as const) {
            if (event[field] !== undefined) requireContract(typeof event[field] === 'boolean', `event.${field} must be boolean`);
        }
        for (const field of ['tier', 'sub_tier', 'subscription_tier'] as const) {
            if (event[field] !== undefined) requireContract(['1000', '2000', '3000', 'Prime'].includes(event[field] as string), `event.${field} is invalid`);
        }
        for (const field of ['user_id', 'user_login', 'user_name', 'broadcaster_user_login', 'broadcaster_user_name',
            'to_broadcaster_user_login', 'to_broadcaster_user_name', 'from_broadcaster_user_login', 'from_broadcaster_user_name']) {
            if (event[field] !== undefined && event[field] !== null) requireContract(typeof event[field] === 'string', `event.${field} must be a string`);
        }
        for (const field of ['followed_at', 'started_at', 'subscribed_at', 'ended_at']) if (event[field] !== undefined) date(event[field], `event.${field}`);
        if (metadata.messageTimestamp !== undefined && metadata.messageTimestamp !== '') date(metadata.messageTimestamp, 'metadata.messageTimestamp');
        const occurredAt = original === 'channel.follow' ? event.followed_at ?? metadata.messageTimestamp
            : original === 'stream.online' ? event.started_at ?? metadata.messageTimestamp : metadata.messageTimestamp;
        if (occurredAt) requireContract(input.occurredAt !== undefined
            && new Date(input.occurredAt).getTime() === Date.parse(occurredAt as string), 'Twitch occurredAt/payload timestamp mismatch');
        if (metadata.messageRetry !== undefined) count(metadata.messageRetry, 'metadata.messageRetry');
        for (const field of ['staleRetry', 'durableChatHandled', 'durableDefenseHandled']) {
            if (metadata[field] !== undefined) requireContract(typeof metadata[field] === 'boolean', `metadata.${field} must be boolean`);
        }
        if (metadata.durableDefenseHandled === true) requireContract(input.source === 'twitch-eventsub'
            && ['channel.follow', 'channel.raid'].includes(original), 'invalid durableDefenseHandled scope');
        return;
    }

    const mapped = Object.hasOwn(POLAR_DOMAIN_EVENT_TYPES, original) ? POLAR_DOMAIN_EVENT_TYPES[original] : undefined;
    requireContract(input.type === (mapped ?? `provider.polar.${original}`) && input.topic === 'domain', 'Polar source/type/topic/originalEventType mismatch');
    requireContract(input.channelID === undefined && input.streamID === undefined, 'Polar events must not fabricate Twitch channel/stream identity');
    requireContract(input.subject?.provider === 'polar', 'Polar subject provider mismatch');
    requireContract(input.occurredAt !== undefined, 'Polar occurredAt is required');
    for (const field of ['externalCustomerId', 'legacyTwitchChannelId']) if (metadata[field] !== undefined) text(metadata[field], `metadata.${field}`);
    if (!mapped) {
        requireContract(metadata.unmapped === true, 'Polar provider events require unmapped=true');
        const data = input.payload.providerData;
        record(data, 'payload.providerData');
        text(data.id, 'providerData.id');
        if (data.customer !== undefined && data.customer !== null) record(data.customer, 'providerData.customer');
        const customer = data.customer as Record<string, unknown> | undefined;
        if (data.customerId != null && customer?.id != null) requireContract(data.customerId === customer.id, 'Polar providerData customer identities mismatch');
        const customerId = original.startsWith('customer.') ? data.id : data.customerId ?? customer?.id;
        if (customerId !== undefined && customerId !== null) text(customerId, 'providerData.customerId');
        requireContract(input.subject.kind === (customerId ? 'customer' : 'resource')
            && input.subject.id === (customerId ?? data.id), 'Polar providerData/subject mismatch');
        return;
    }
    requireContract(metadata.unmapped === undefined || metadata.unmapped === false, 'mapped Polar event cannot be unmapped');
    const payload = input.payload;
    text(payload.customerId, 'payload.customerId');
    requireContract(input.subject.kind === 'customer' && input.subject.id === payload.customerId, 'Polar customerId/subject mismatch');
    for (const field of ['orderId', 'subscriptionId', 'productId', 'status']) if (payload[field] !== undefined) text(payload[field], `payload.${field}`);
    if (payload.cadence !== undefined) requireContract(payload.cadence === 'monthly' || payload.cadence === 'yearly', 'payload.cadence is invalid');
    if (payload.periodEnd !== undefined && payload.periodEnd !== null) date(payload.periodEnd, 'payload.periodEnd');
    if (payload.paid !== undefined) requireContract(typeof payload.paid === 'boolean', 'payload.paid must be boolean');
    if (original === 'order.paid') {
        text(payload.orderId, 'payload.orderId');
        text(payload.status, 'payload.status');
        requireContract(payload.paid === true, 'Polar order.paid requires paid=true');
        if (payload.subscriptionId !== undefined) requireContract(payload.cadence !== undefined, 'Polar subscription order requires cadence');
    } else if (original === 'subscription.updated') {
        for (const field of ['subscriptionId', 'productId', 'status', 'cadence']) text(payload[field], `payload.${field}`);
    }
    if (original === 'customer.state_changed' || payload.meters !== undefined) {
        requireContract(Array.isArray(payload.meters), 'payload.meters must be an array');
        for (const meter of payload.meters) {
            record(meter, 'meter');
            text(meter.meter_id, 'meter.meter_id');
            for (const field of ['consumed_units', 'credited_units', 'balance']) if (meter[field] !== undefined) {
                requireContract(typeof meter[field] === 'number' && Number.isFinite(meter[field]), `meter.${field} must be finite`);
            }
        }
    }
}

export function getTwitchEventsubPayload(input: JournalDomainEventInput): TwitchEventsubPayload {
    validateDomainEventContract(input);
    requireContract(input.source === 'twitch-eventsub' || input.source === 'twitch-eventsub-test', 'expected a Twitch event');
    return input.payload as TwitchEventsubPayload;
}

export function getPolarBillingPayload(input: JournalDomainEventInput): PolarBillingPayload {
    validateDomainEventContract(input);
    requireContract(input.source === 'polar-webhook' && Object.values(POLAR_DOMAIN_EVENT_TYPES).includes(input.type), 'expected a mapped Polar billing event');
    return input.payload as PolarBillingPayload;
}
