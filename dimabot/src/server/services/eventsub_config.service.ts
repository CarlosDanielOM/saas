import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import EventsubSchema from "../../schemas/eventsub.schema.js";
import UsersSchema from "../../schemas/users.schema.js";
import { EventSchema } from "../../schemas/event.schema.js";
import {
    CANONICAL_BITS_EVENT_TYPE,
    canonicalizeEventsubType,
    getEquivalentEventsubTypes,
    subscribeTwitchEvent,
    unsubscribeTwitchEvent
} from "../../utils/eventsub.js";
import type { ICheerTiers, ICondition } from "../../schemas/eventsub.schema.js";
import { OUTGOING_RAID_EVENT, isRaidEvent, raidConfigType, raidDirection, raidCondition } from '../../utils/raid_direction.js';
import { RaidSubscriptionPreferenceSchema as RaidPreferences } from '../../schemas/raid_subscription_preference.schema.js';
import { raidPreferenceID } from '../../utils/raid_subscriptions.js';

/**
 * Chat events (channel EventSub configs): the create/update/delete logic shared by
 * `POST|PATCH|DELETE /eventsubs/:channelID` and the site assistant
 * (`site_agent/tools/write/settings/chat_events.ts`). Callers check `eventsubs:manage` first.
 * Each operation returns the exact HTTP status and JSON body the route sends.
 */

export const NON_DISABLEABLE_EVENT_TYPES = new Set(['stream.online', 'stream.offline']);
/** Settings a raid chat event can change (both directions). */
export const RAID_EVENT_FIELDS = new Set(['enabled', 'message', 'clipEnabled', 'minViewers', 'delay']);

export interface EventsubResult {
    status: number;
    body: Record<string, unknown>;
}

export type PlanTier = 'free' | 'premium' | 'pro';

const PLAN_RANK: Record<PlanTier, number> = {
    free: 0,
    premium: 1,
    pro: 2
};

export function hasPlanAccess(userPlan: PlanTier, requiredPlan: PlanTier): boolean {
    return PLAN_RANK[userPlan] >= PLAN_RANK[requiredPlan];
}

export async function getUserPlanTier(twitchUserId: string): Promise<PlanTier> {
    const user = await UsersSchema.findOne(
        { 'accounts.id': twitchUserId, 'accounts.type': 'twitch' },
        { plan_tier: 1 }
    ).lean() as { plan_tier?: PlanTier } | null;

    if (user?.plan_tier === 'premium' || user?.plan_tier === 'pro') {
        return user.plan_tier;
    }

    return 'free';
}

function getTierLimitForPlan(
    tierLimits: { free?: number; premium?: number; pro?: number } | undefined,
    plan: PlanTier
): number {
    if (!tierLimits) {
        return plan === 'free' ? 0 : plan === 'premium' ? 2 : 5;
    }

    if (plan === 'pro') {
        return typeof tierLimits.pro === 'number' ? tierLimits.pro : 5;
    }

    if (plan === 'premium') {
        return typeof tierLimits.premium === 'number' ? tierLimits.premium : 2;
    }

    return typeof tierLimits.free === 'number' ? tierLimits.free : 0;
}

function extractCheerTiers(config: unknown, body: unknown): unknown[] | null {
    if (config && typeof config === 'object' && Array.isArray((config as { cheerTiers?: unknown[] }).cheerTiers)) {
        return (config as { cheerTiers: unknown[] }).cheerTiers;
    }

    if (body && typeof body === 'object' && Array.isArray((body as { cheerTiers?: unknown[] }).cheerTiers)) {
        return (body as { cheerTiers: unknown[] }).cheerTiers;
    }

    return null;
}

function normalizeCheerTiers(value: unknown): ICheerTiers[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const normalized = value
        .map((tier) => {
            if (!tier || typeof tier !== 'object') {
                return null;
            }

            const candidate = tier as {
                id?: unknown;
                name?: unknown;
                message?: unknown;
                minAmount?: unknown;
                maxAmount?: unknown;
                min_amount?: unknown;
                max_amount?: unknown;
            };

            const minAmount = typeof candidate.min_amount === 'number'
                ? candidate.min_amount
                : candidate.minAmount;
            const maxAmount = typeof candidate.max_amount === 'number'
                ? candidate.max_amount
                : candidate.maxAmount;

            if (
                typeof candidate.id !== 'string'
                || typeof candidate.name !== 'string'
                || typeof candidate.message !== 'string'
                || typeof minAmount !== 'number'
                || !Number.isFinite(minAmount)
                || typeof maxAmount !== 'number'
                || !Number.isFinite(maxAmount)
            ) {
                return null;
            }

            return {
                id: candidate.id,
                name: candidate.name,
                message: candidate.message,
                min_amount: minAmount,
                max_amount: maxAmount
            } satisfies ICheerTiers;
        })
        .filter((tier): tier is ICheerTiers => tier !== null);

    return normalized;
}

export function normalizeEventsubPayload<T extends Record<string, unknown>>(payload: T): T {
    const normalizedPayload: Record<string, unknown> = { ...payload };

    if (typeof normalizedPayload.type === 'string') {
        normalizedPayload.type = canonicalizeEventsubType(normalizedPayload.type);
    }

    const cheerTiers = normalizeCheerTiers(normalizedPayload.cheerTiers);
    if (cheerTiers) {
        normalizedPayload.cheerTiers = cheerTiers;
    }

    const config = normalizedPayload.config;
    if (config && typeof config === 'object' && !Array.isArray(config)) {
        const normalizedConfig: Record<string, unknown> = { ...(config as Record<string, unknown>) };
        const configCheerTiers = normalizeCheerTiers(normalizedConfig.cheerTiers);

        if (configCheerTiers) {
            normalizedConfig.cheerTiers = configCheerTiers;
        }

        normalizedPayload.config = normalizedConfig;
    }

    return normalizedPayload as T;
}

/** Catalog entry (plan, tier limits) for an event type; bits aliases resolve to the canonical type. */
export async function findEventTemplateByType(type: string) {
    const normalizedType = canonicalizeEventsubType(type);

    const templates = await EventSchema.find(
        { type: { $in: getEquivalentEventsubTypes(normalizedType) } },
        { plan_tier: 1, tierLimits: 1, type: 1 }
    ).lean() as Array<{
        type?: string;
        plan_tier?: PlanTier;
        tierLimits?: { free?: number; premium?: number; pro?: number };
    }>;

    return templates.find((template) => template.type === normalizedType)
        || templates[0]
        || null;
}

export function normalizeEventsubResponseType<T extends { type?: string; condition?: ICondition }>(eventsub: T): T {
    if (typeof eventsub.type !== 'string') {
        return eventsub;
    }

    return {
        ...eventsub,
        type: raidConfigType(canonicalizeEventsubType(eventsub.type), eventsub.condition)
    };
}

function getEventsubConfigRichness(eventsub: Record<string, unknown>): number {
    let score = 0;

    if (eventsub.enabled === false) score += 3;
    if (typeof eventsub.message === 'string' && eventsub.message.trim().length > 0) score += 3;
    if (typeof eventsub.endMessage === 'string' && eventsub.endMessage.trim().length > 0) score += 2;
    if (eventsub.endEnabled === true) score += 1;
    if (eventsub.clipEnabled === true) score += 1;
    if (typeof eventsub.minViewers === 'number' && Number.isFinite(eventsub.minViewers) && eventsub.minViewers !== 2) score += 2;
    if (typeof eventsub.delay === 'number' && Number.isFinite(eventsub.delay) && eventsub.delay !== 0) score += 2;
    if (Array.isArray(eventsub.cheerTiers) && eventsub.cheerTiers.length > 0) score += 4;

    return score;
}

function choosePreferredEventsub<T extends { type?: string } & Record<string, unknown>>(current: T | undefined, candidate: T): T {
    if (!current) {
        return candidate;
    }

    const currentType = typeof current.type === 'string' ? current.type : '';
    const candidateType = typeof candidate.type === 'string' ? candidate.type : '';
    const currentCanonicalType = canonicalizeEventsubType(currentType);
    const candidateCanonicalType = canonicalizeEventsubType(candidateType);

    if (currentCanonicalType === CANONICAL_BITS_EVENT_TYPE && candidateCanonicalType === CANONICAL_BITS_EVENT_TYPE) {
        if (candidateType === CANONICAL_BITS_EVENT_TYPE && currentType !== CANONICAL_BITS_EVENT_TYPE) {
            return candidate;
        }

        if (currentType === CANONICAL_BITS_EVENT_TYPE && candidateType !== CANONICAL_BITS_EVENT_TYPE) {
            return current;
        }
    }

    const currentScore = getEventsubConfigRichness(current);
    const candidateScore = getEventsubConfigRichness(candidate);

    if (candidateScore !== currentScore) {
        return candidateScore > currentScore ? candidate : current;
    }

    return candidateType === candidateCanonicalType && currentType !== currentCanonicalType
        ? candidate
        : current;
}

/** One config per (channel, event type), the same choice the Chat events page shows. */
export function dedupeNormalizedEventsubs<T extends { type?: string; channelID?: string; condition?: ICondition }>(eventsubs: T[]): T[] {
    const byKey = new Map<string, T>();

    for (const eventsub of eventsubs) {
        const key = `${eventsub.channelID || ''}:${raidConfigType(canonicalizeEventsubType(typeof eventsub.type === 'string' ? eventsub.type : ''), eventsub.condition)}`;
        byKey.set(key, choosePreferredEventsub(byKey.get(key), eventsub));
    }

    return Array.from(byKey.values()).map(normalizeEventsubResponseType);
}

/** POST /eventsubs/:channelID after the access check. */
export async function createChannelEventsub(channelID: string, rawBody: Record<string, unknown>): Promise<EventsubResult> {
    const body = normalizeEventsubPayload(rawBody);
    const type = body.type as string;
    const version = body.version as string;
    const condition = body.condition;
    const config = body.config as Record<string, unknown> | undefined;

    if (!type || !version || !condition) {
        return { status: 400, body: {
            error: 'Bad Request',
            message: 'Missing type, version or condition',
            status: 400
        } };
    }

    const normalizedType = canonicalizeEventsubType(type);
    const requestedRaid = isRaidEvent(normalizedType);
    const direction = normalizedType === OUTGOING_RAID_EVENT ? 'outgoing' : raidDirection(condition as ICondition);
    if (requestedRaid) {
        const expected = raidCondition(channelID, direction);
        const provided = condition as ICondition;
        if (version !== '1' || provided.from_broadcaster_user_id && provided.to_broadcaster_user_id
            || Object.entries(expected).some(([key, value]) => provided[key as keyof ICondition] !== value)) {
            return { status: 400, body: { error: true, message: 'Raid condition must match this channel and one direction' } };
        }
        if (config && (Object.keys(config).some(key => !RAID_EVENT_FIELDS.has(key))
            || config.enabled !== undefined && typeof config.enabled !== 'boolean'
            || config.message !== undefined && typeof config.message !== 'string')) {
            return { status: 400, body: { error: true, message: 'Invalid raid event settings' } };
        }
    }

    const userPlan = await getUserPlanTier(channelID);

    const eventTemplate = await findEventTemplateByType(normalizedType);

    const requiredPlan: PlanTier =
        eventTemplate?.plan_tier === 'premium' || eventTemplate?.plan_tier === 'pro'
            ? eventTemplate.plan_tier
            : 'free';

    if (!hasPlanAccess(userPlan, requiredPlan)) {
        return { status: 403, body: {
            error: true,
            message: `This event requires ${requiredPlan} plan`,
            status: 403
        } };
    }

    const cheerTiers = extractCheerTiers(config, body);
    if (cheerTiers) {
        const tierLimit = getTierLimitForPlan(eventTemplate?.tierLimits, userPlan);
        if (cheerTiers.length > tierLimit) {
            return { status: 403, body: {
                error: true,
                message: `Your ${userPlan} plan allows up to ${tierLimit} cheer tiers`,
                status: 403
            } };
        }
    }

    const eventsub = await subscribeTwitchEvent(channelID, requestedRaid ? 'channel.raid' : normalizedType, version,
        requestedRaid ? raidCondition(channelID, direction) : condition as ICondition, config);

    if (!eventsub || (eventsub as any).error) {
        return { status: 400, body: {
            error: 'Bad Request',
            message: 'Failed to create eventsub',
            status: 400
        } };
    }

    if (requestedRaid) await RaidPreferences.updateOne({ _id: raidPreferenceID(channelID, direction) },
        { $set: { channelID, direction, deleted: false, operation: randomUUID(), updatedAt: new Date() } }, { upsert: true });

    return { status: 201, body: {
        error: false,
        data: eventsub
    } };
}

/** DELETE /eventsubs/:channelID/:id after the access check (unsubscribes from Twitch). */
export async function deleteChannelEventsub(channelID: string, id: string): Promise<EventsubResult> {
    const eventsub = await EventsubSchema.findOne({ channelID, _id: id });

    if (!eventsub) {
        return { status: 404, body: {
            error: 'Not Found',
            message: 'Eventsub not found',
            status: 404
        } };
    }

    if (NON_DISABLEABLE_EVENT_TYPES.has(eventsub.type)) {
        return { status: 403, body: {
            error: true,
            message: 'This event cannot be deleted. Clear its message to silence chat output.',
            status: 403
        } };
    }

    const direction = raidDirection(eventsub.condition);
    const preferenceID = raidPreferenceID(channelID, direction), operation = randomUUID();
    const prior = eventsub.type === 'channel.raid' ? await RaidPreferences.findById(preferenceID).lean() : null;
    if (eventsub.type === 'channel.raid') await RaidPreferences.updateOne({ _id: preferenceID }, {
        $set: { channelID, direction, deleted: true, operation, updatedAt: new Date() }
    }, { upsert: true });
    let result;
    try { result = await unsubscribeTwitchEvent(eventsub.id); }
    catch (error) {
        if (eventsub.type === 'channel.raid') await RaidPreferences.updateOne({ _id: preferenceID, operation },
            { $set: { deleted: prior?.deleted || false, updatedAt: new Date() } });
        throw error;
    }

    if ((result as any).error) {
        if (eventsub.type === 'channel.raid') await RaidPreferences.updateOne({ _id: preferenceID, operation },
            { $set: { deleted: prior?.deleted || false, updatedAt: new Date() } });
        return { status: (result as any).status, body: {
            error: (result as any).error,
            message: (result as any).message,
            status: (result as any).status
        } };
    }

    return { status: 200, body: {
        error: false,
        message: 'Eventsub deleted',
        status: 200
    } };
}

export interface EventsubUpdateOptions {
    /**
     * Extra equality filter on the write (compare-and-set), stored field → value (`null` = missing).
     * When the stored config no longer matches, nothing is written and a 409 `changed` comes back.
     * The route never sets it.
     */
    guard?: Record<string, unknown>;
}

/** PATCH /eventsubs/:channelID/:id after the access check. The body is written as given. */
export async function updateChannelEventsub(channelID: string, id: string, rawBody: Record<string, unknown>, options: EventsubUpdateOptions = {}): Promise<EventsubResult> {
    const body = normalizeEventsubPayload(rawBody);

    if (!id) {
        return { status: 400, body: {
            error: 'Bad Request',
            message: 'ID is required',
            status: 400
        } };
    } else {
        if (!mongoose.isValidObjectId(id)) {
            return { status: 400, body: {
                error: 'Invalid ID',
                message: 'ID is not a valid ObjectID',
                status: 400
            } };
        }
    }

    const eventsub = await EventsubSchema.findOne({ _id: id, channelID });

    if (!eventsub) {
        return { status: 404, body: {
            error: 'Not Found',
            message: 'Eventsub not found',
            status: 404
        } };
    }

    if (eventsub.type === 'channel.raid') {
        if (Object.keys(body).some(key => !RAID_EVENT_FIELDS.has(key)) || body.enabled !== undefined && typeof body.enabled !== 'boolean'
            || body.message !== undefined && typeof body.message !== 'string') {
            return { status: 400, body: { error: true, message: 'Invalid raid event settings' } };
        }
    }

    if (
        NON_DISABLEABLE_EVENT_TYPES.has(eventsub.type) &&
        Object.prototype.hasOwnProperty.call(body, 'enabled') &&
        body.enabled === false
    ) {
        return { status: 403, body: {
            error: true,
            message: 'This event cannot be disabled. Clear its message to silence chat output.',
            status: 403
        } };
    }

    const userPlan = await getUserPlanTier(channelID);
    const eventTemplate = await findEventTemplateByType(eventsub.type);

    const requiredPlan: PlanTier =
        eventTemplate?.plan_tier === 'premium' || eventTemplate?.plan_tier === 'pro'
            ? eventTemplate.plan_tier
            : 'free';

    if (!hasPlanAccess(userPlan, requiredPlan)) {
        return { status: 403, body: {
            error: true,
            message: `This event requires ${requiredPlan} plan`,
            status: 403
        } };
    }

    const cheerTiers = extractCheerTiers(undefined, body);
    if (cheerTiers) {
        const tierLimit = getTierLimitForPlan(eventTemplate?.tierLimits, userPlan);
        if (cheerTiers.length > tierLimit) {
            return { status: 403, body: {
                error: true,
                message: `Your ${userPlan} plan allows up to ${tierLimit} cheer tiers`,
                status: 403
            } };
        }
    }

    const updatedEventsub = await EventsubSchema.findOneAndUpdate(
        { _id: id, channelID, ...(options.guard ?? {}) },
        body,
        { new: true }
    ).lean();

    if (!updatedEventsub && options.guard) {
        return { status: 409, body: { error: true, code: 'changed', message: 'The chat event changed since it was read', status: 409 } };
    }

    if (!updatedEventsub) {
        return { status: 400, body: {
            error: 'Bad Request',
            message: 'Failed to update eventsub',
            status: 400
        } };
    }

    return { status: 200, body: {
        error: false,
        data: updatedEventsub,
        status: 200
    } };
}
