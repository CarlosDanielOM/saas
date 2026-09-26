import { randomUUID } from 'node:crypto';
import type { Model } from 'mongoose';
import { CommandsSchema } from '../../schemas/commands.schema.js';
import { RedemptionRewardSchema } from '../../schemas/redemption_reward.schema.js';
import { getDragonflyClient } from '../databases/dragonfly.database.js';
import { getTwitchStreamerHeaderById } from '../header.js';
import { getTwitchHelixUrl } from '../links.js';
import { availabilityState, internalWrite, type AvailabilityState } from './schema.js';

export const MAX_AVAILABILITY_SECONDS = 604800;
const LEASE_MS = 60000;
const RETRY_MS = 30000;
const selection = '+availability +availabilityLease';
export interface AvailabilityAdapter {
    name: string;
    model: Model<any>;
    enabledField: string;
    resolve(channelID: string, name: string): Promise<any>;
    sync(document: any): Promise<void>;
}
const exact = (value: string) => new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

// Add another adapter here and attach addAvailabilityFields to its schema.
// AST registration and durable recovery use the same registry.
export const availabilityAdapters: AvailabilityAdapter[] = [
    {
        name: 'command', model: CommandsSchema, enabledField: 'enabled',
        async resolve(channelID, name) {
            const matches = await CommandsSchema.find({ channelID, cmd: exact(name.replace(/^!/, '')) }).select(selection).limit(2).lean();
            if (matches.length !== 1) throw new Error(matches.length ? 'Command name is ambiguous' : 'Command not found');
            return matches[0];
        },
        async sync(document) {
            const cache = await getDragonflyClient('Availability');
            await cache.del(`${document.channelID}:commands:${document.cmd}`);
        }
    },
    {
        name: 'redemption', model: RedemptionRewardSchema, enabledField: 'isEnabled',
        async resolve(channelID, name) {
            const byId = await RedemptionRewardSchema.findOne({ channelID, rewardID: name }).select(selection).lean();
            if (byId) return byId;
            const matches = await RedemptionRewardSchema.find({ channelID, title: exact(name) }).select(selection).limit(2).lean();
            if (matches.length !== 1) throw new Error(matches.length ? 'Redemption name is ambiguous; use its reward ID' : 'Redemption not found');
            return matches[0];
        },
        async sync(document) {
            if (document.createdFor !== 'twitch') throw new Error('Only Twitch redemptions are supported');
            const auth = await getTwitchStreamerHeaderById(document.channelID);
            if (auth.error || !auth.header) throw new Error(auth.message);
            const params = new URLSearchParams({ broadcaster_id: document.channelID, id: document.rewardID });
            const response = await fetch(getTwitchHelixUrl('channel_points/custom_rewards', params.toString()), {
                method: 'PATCH', headers: auth.header as unknown as Record<string, string>,
                body: JSON.stringify({ is_enabled: document.isEnabled }), signal: AbortSignal.timeout(15000)
            });
            const result = await response.json();
            if (!response.ok || result.error) throw new Error(result.message || 'Twitch rejected the reward update');
            if (result.data?.[0]?.is_enabled !== document.isEnabled) throw new Error('Twitch did not confirm the reward state');
        }
    }
];

export function getAvailabilityAdapter(kind: string): AvailabilityAdapter {
    const adapter = availabilityAdapters.find(item => item.name === kind);
    if (!adapter) throw new Error(`Unsupported availability target: ${kind}`);
    return adapter;
}

/** Writes desired state and its restoration together, then synchronizes it.
 * The document identity, not its mutable name, owns the deadline.
 */
export async function setAvailability(kind: string, channelID: string, name: string, enabled: boolean, seconds?: number): Promise<void> {
    if (!channelID || !name.trim()) throw new Error('A channel and target name are required');
    if (seconds !== undefined && (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_AVAILABILITY_SECONDS)) {
        throw new Error(`Duration must be a whole number of seconds from 1 to ${MAX_AVAILABILITY_SECONDS}`);
    }
    const adapter = getAvailabilityAdapter(kind);
    for (let attempt = 0; attempt < 5; attempt++) {
        const document = await adapter.resolve(channelID, name);
        if (kind === 'redemption' && document.createdFor !== 'twitch') throw new Error('Only Twitch redemptions are supported');
        const current = Boolean(document[adapter.enabledField]);
        const prior = document.availability as AvailabilityState | undefined;
        const previousEnabled = seconds !== undefined && prior?.restoreAt && current === enabled
            ? prior.previousEnabled : current;
        const state = availabilityState(previousEnabled, seconds === undefined ? null : new Date(Date.now() + seconds * 1000));
        const result = await internalWrite(adapter.model.updateOne({ _id: document._id, channelID,
            [adapter.enabledField]: document[adapter.enabledField],
            'availability.token': prior?.token ?? { $exists: false }
        }, { $set: { [adapter.enabledField]: enabled, availability: state } }));
        if (!result.matchedCount) continue;
        const error = await synchronizeAvailability(adapter, String(document._id), channelID);
        if (error) throw new Error(`State saved; synchronization will retry automatically: ${error}`);
        return;
    }
    throw new Error('Target changed concurrently; please try again');
}

/** One lease per target serializes external calls. Newer desired states may be
 * written during I/O; the lease owner rereads them before finishing. All writes
 * are idempotent, so a crashed owner can be replaced after its lease expires.
 */
export async function synchronizeAvailability(adapter: AvailabilityAdapter, id: string, channelID: string): Promise<string | undefined> {
    const owner = randomUUID();
    const filter = { _id: id, channelID };
    const locked = await internalWrite(adapter.model.findOneAndUpdate({ ...filter, $or: [
        { 'availabilityLease.until': { $exists: false } }, { 'availabilityLease.until': { $lte: new Date() } }
    ] }, { $set: { availabilityLease: { token: owner, until: new Date(Date.now() + LEASE_MS) } } }, { new: true })).select(selection).lean();
    if (!locked) return; // Another owner will reconcile the saved state.
    try {
        for (let pass = 0; pass < 4; pass++) {
            const lease = await internalWrite(adapter.model.updateOne({ ...filter, 'availabilityLease.token': owner }, {
                $set: { 'availabilityLease.until': new Date(Date.now() + LEASE_MS) }
            }));
            if (!lease.matchedCount) return;
            const document = await adapter.model.findOne(filter).select(selection).lean<any>();
            if (!document?.availability) return;
            const state = document.availability as AvailabilityState;
            if (state.restoreAt && state.restoreAt.getTime() <= Date.now()) {
                await internalWrite(adapter.model.updateOne({ ...filter, 'availability.token': state.token }, {
                    $set: { [adapter.enabledField]: state.previousEnabled, availability: availabilityState(state.previousEnabled) }
                }));
                continue;
            }
            if (!state.pending) return;
            try {
                await adapter.sync(document);
            } catch (error) {
                const retryAt = Math.min(Date.now() + RETRY_MS, state.restoreAt?.getTime() ?? Infinity);
                await internalWrite(adapter.model.updateOne({ ...filter, 'availability.token': state.token }, {
                    $set: { 'availability.nextAt': new Date(retryAt) }
                }));
                return error instanceof Error ? error.message : String(error);
            }
            // A manual edit replaces the token, so this cannot clear its work
            // or apply an old restoration over it.
            await internalWrite(adapter.model.updateOne({ ...filter, 'availability.token': state.token }, state.restoreAt
                ? { $set: { 'availability.pending': false, 'availability.nextAt': state.restoreAt } }
                : { $unset: { availability: 1 } }));
        }
    } finally {
        await internalWrite(adapter.model.updateOne({ ...filter, 'availabilityLease.token': owner }, { $unset: { availabilityLease: 1 } }));
    }
}

export async function recoverAvailability(): Promise<void> {
    for (const adapter of availabilityAdapters) {
        const due = await adapter.model.find({ 'availability.nextAt': { $lte: new Date() } }).select('_id channelID').limit(100).lean();
        // Bound API concurrency and let other records progress after a failure.
        for (let start = 0; start < due.length; start += 5) {
            const results = await Promise.allSettled(due.slice(start, start + 5).map(async document => {
                const error = await synchronizeAvailability(adapter, String(document._id), document.channelID);
                if (error) console.error('Availability synchronization will retry', { kind: adapter.name, channelID: document.channelID, error });
            }));
            for (const result of results) if (result.status === 'rejected') console.error('Availability recovery failed', result.reason);
        }
    }
}
