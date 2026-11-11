import TwitchStreamers from '../classes/twitch_streamers.class.js';
import { CustomTimerSchema, type ICustomTimer } from '../schemas/custom_timer.schema.js';
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';
import { isLive as checkChannelLive } from '../functions/channels/is_live.channel.js';
import {
    TIMER_FREQUENCY_UNIT,
    getTimerIntervalMinutes,
    validateTimerEditInterval,
    validateTimerInterval
} from '../utils/timer_policy.js';

const MAX_NAME_LENGTH = 30;
const MAX_MESSAGE_LENGTH = 350;
const NAME_PATTERN = /^[\w]+$/;

interface ITimerCommandResult {
    error: boolean;
    message: string;
    status: number;
    /** `changed` when a compare-and-set write found the timer different from its guard. */
    code?: string;
    timer?: unknown;
    timers?: unknown[];
}

function getTierTimerLimit(tier: string): number {
    switch (tier) {
        case 'pro':
            return 50;
        case 'premium':
            return 15;
        case 'free':
        default:
            return 5;
    }
}

function validateName(name: string): { valid: boolean; error?: string } {
    if (!name || name.length === 0) {
        return { valid: false, error: 'Timer name is required' };
    }
    if (name.length > MAX_NAME_LENGTH) {
        return { valid: false, error: `Timer name cannot exceed ${MAX_NAME_LENGTH} characters` };
    }
    if (!NAME_PATTERN.test(name)) {
        return { valid: false, error: 'Timer name can only contain letters, numbers, and underscores' };
    }
    return { valid: true };
}

function validateMessage(message: string): { valid: boolean; error?: string } {
    if (!message || message.length === 0) {
        return { valid: false, error: 'Timer message is required' };
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
        return { valid: false, error: `Timer message cannot exceed ${MAX_MESSAGE_LENGTH} characters` };
    }
    return { valid: true };
}

async function checkTimerLimit(channelID: string, tier: string): Promise<{ allowed: boolean; count: number; limit: number }> {
    const limit = getTierTimerLimit(tier);
    const count = await CustomTimerSchema.countDocuments({ channelID, active: true });
    return { allowed: count < limit, count, limit };
}

/** Unique (channel, name) index hit: someone created that name between our check and the write. */
const isDuplicateKey = (error: unknown) => (error as { code?: number } | null)?.code === 11000;

export interface CreateTimerOptions {
    /** `false` creates it switched off: it does not count against the plan's limit of enabled timers and is not scheduled. Default on. */
    active?: boolean;
    /** Putting back a timer that existed (site assistant undo): its interval is accepted even if the plan no longer offers it. */
    restore?: boolean;
}

export async function createTimer(channelID: string, name: string, frequency: number, message: string, options: CreateTimerOptions = {}): Promise<ITimerCommandResult> {
    try {
        const streamer = await TwitchStreamers.getTwitchAccountById(channelID);
        if (!streamer) {
            return { error: true, message: 'Streamer not found', status: 404 };
        }

        const tier = streamer.plan_tier || 'free';

        const nameValidation = validateName(name);
        if (!nameValidation.valid) {
            return { error: true, message: String(nameValidation.error), status: 400 };
        }

        const frequencyValidation = options.restore
            ? (Number.isInteger(frequency) && frequency > 0 ? { valid: true } : { valid: false, error: 'Frequency must be a positive whole number of minutes' })
            : validateTimerInterval(frequency, tier);
        if (!frequencyValidation.valid) {
            return { error: true, message: String(frequencyValidation.error), status: 400 };
        }

        const messageValidation = validateMessage(message);
        if (!messageValidation.valid) {
            return { error: true, message: String(messageValidation.error), status: 400 };
        }

        const existingTimer = await CustomTimerSchema.findOne({ channelID, name: name.toLowerCase() });
        if (existingTimer) {
            return { error: true, message: `Timer "${name}" already exists`, status: 409 };
        }

        const active = options.active !== false;
        if (active) {
            const limitCheck = await checkTimerLimit(channelID, tier);
            if (!limitCheck.allowed) {
                return {
                    error: true,
                    message: `Timer limit reached (${limitCheck.limit} for ${tier} plan). Upgrade for more timers.`,
                    status: 403
                };
            }
        }

        const timer = await CustomTimerSchema.create({
            name: name.toLowerCase(),
            message,
            frequency,
            frequencyUnit: TIMER_FREQUENCY_UNIT,
            channel: streamer.name,
            channelID,
            active
        });

        if (!active) {
            return { error: false, message: `Timer "${name}" created. It is off.`, timer: timer.toObject(), status: 201 };
        }

        const cache = await getDragonflyClient('timerManager');

        // First check: is the channel in our live-tracking cache?
        let isLive = Boolean(await cache.sIsMember('timer:active', channelID));

        // Fallback: if not in cache, verify via Twitch API (covers missed EventSub events)
        if (!isLive) {
            const liveResult = await checkChannelLive(channelID);
            isLive = !liveResult.error && Array.isArray(liveResult.data) && liveResult.data.length > 0;

            // If Twitch says live, register the channel so we track it going forward
            if (isLive) {
                await cache.sAdd('timer:active', channelID);
            }
        }

        if (isLive) {
            await cache.hSet(`timer:channel:${channelID}:timers`, String(timer._id), JSON.stringify(timer.toObject()));
            await cache.set(`timer:channel:${channelID}:heartbeat:${timer._id}`, '0');
            await cache.set(`timer:channel:${channelID}:heartbeat-unit:${timer._id}`, TIMER_FREQUENCY_UNIT);
        }

        const minutes = frequency;
        return {
            error: false,
            message: isLive
                ? `Timer "${name}" created and starting now. Will send every ${minutes} minute${minutes !== 1 ? 's' : ''}.`
                : `Timer "${name}" created. Will send every ${minutes} minute${minutes !== 1 ? 's' : ''} when you go live.`,
            timer: timer.toObject(),
            status: 201
        };
    } catch (error) {
        if (isDuplicateKey(error)) return { error: true, message: `Timer "${name}" already exists`, status: 409 };
        console.error('Error in createTimer:', {
            channelID,
            name,
            frequency,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });
        return { error: true, message: 'Failed to create timer', status: 500 };
    }
}

export async function editTimer(channelID: string, name: string, frequency?: number, message?: string): Promise<ITimerCommandResult> {
    try {
        const streamer = await TwitchStreamers.getTwitchAccountById(channelID);
        if (!streamer) {
            return { error: true, message: 'Streamer not found', status: 404 };
        }

        const tier = streamer.plan_tier || 'free';
        const timer = await CustomTimerSchema.findOne({ channelID, name: name.toLowerCase() });
        if (!timer) {
            return { error: true, message: `Timer "${name}" not found`, status: 404 };
        }

        const currentMinutes = getTimerIntervalMinutes(timer);
        const frequencyValidation = validateTimerEditInterval(timer, frequency, tier);
        if (!frequencyValidation.valid) {
            const grandfatheredMessage = frequency === undefined
                ? `This timer can keep running at ${currentMinutes} minutes, but it cannot be edited on your current plan. Choose a valid interval first.`
                : String(frequencyValidation.error);
            return { error: true, message: grandfatheredMessage, status: 400 };
        }

        if (frequency !== undefined) {
            timer.frequency = frequency;
        }
        timer.frequencyUnit = TIMER_FREQUENCY_UNIT;
        if (frequency === undefined) {
            timer.frequency = currentMinutes;
        }

        if (message !== undefined) {
            const messageValidation = validateMessage(message);
            if (!messageValidation.valid) {
                return { error: true, message: String(messageValidation.error), status: 400 };
            }
            timer.message = message;
        }

        await timer.save();

        const cache = await getDragonflyClient('timerManager');

        // First check: is the channel in our live-tracking cache?
        let isLive = Boolean(await cache.sIsMember('timer:active', channelID));

        // Fallback: if not in cache, verify via Twitch API (covers missed EventSub events)
        if (!isLive) {
            const liveResult = await checkChannelLive(channelID);
            isLive = !liveResult.error && Array.isArray(liveResult.data) && liveResult.data.length > 0;

            // If Twitch says live, register the channel so we track it going forward
            if (isLive) {
                await cache.sAdd('timer:active', channelID);
            }
        }

        if (isLive && timer.active) {
            await cache.hSet(`timer:channel:${channelID}:timers`, String(timer._id), JSON.stringify(timer.toObject()));
            await cache.set(`timer:channel:${channelID}:heartbeat:${timer._id}`, '0');
            await cache.set(`timer:channel:${channelID}:heartbeat-unit:${timer._id}`, TIMER_FREQUENCY_UNIT);
        }

        const minutes = getTimerIntervalMinutes(timer);
        return {
            error: false,
            message: `Timer "${name}" updated. Sends every ${minutes} minute${minutes !== 1 ? 's' : ''} when live.`,
            timer: timer.toObject(),
            status: 200
        };
    } catch (error) {
        console.error('Error in editTimer:', {
            channelID,
            name,
            frequency,
            message,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });
        return { error: true, message: 'Failed to edit timer', status: 500 };
    }
}

export async function deleteTimer(channelID: string, name: string): Promise<ITimerCommandResult> {
    try {
        const timer = await CustomTimerSchema.findOneAndDelete({ channelID, name: name.toLowerCase() });
        if (!timer) {
            return { error: true, message: `Timer "${name}" not found`, status: 404 };
        }

        const cache = await getDragonflyClient('timerManager');
        await cache.hDel(`timer:channel:${channelID}:timers`, String(timer._id));
        await cache.del(`timer:channel:${channelID}:heartbeat:${timer._id}`);
        await cache.del(`timer:channel:${channelID}:heartbeat-unit:${timer._id}`);

        return {
            error: false,
            message: `Timer "${name}" deleted`,
            timer: timer.toObject(),
            status: 200
        };
    } catch (error) {
        console.error('Error in deleteTimer:', {
            channelID,
            name,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });
        return { error: true, message: 'Failed to delete timer', status: 500 };
    }
}

export async function toggleTimer(channelID: string, name: string, active?: boolean): Promise<ITimerCommandResult> {
    try {
        const timer = await CustomTimerSchema.findOne({ channelID, name: name.toLowerCase() });
        if (!timer) {
            return { error: true, message: `Timer "${name}" not found`, status: 404 };
        }

        timer.active = active !== undefined ? active : !timer.active;
        await timer.save();

        const cache = await getDragonflyClient('timerManager');

        // First check: is the channel in our live-tracking cache?
        let isLive = Boolean(await cache.sIsMember('timer:active', channelID));

        // Fallback: if not in cache, verify via Twitch API (covers missed EventSub events)
        if (!isLive) {
            const liveResult = await checkChannelLive(channelID);
            isLive = !liveResult.error && Array.isArray(liveResult.data) && liveResult.data.length > 0;

            // If Twitch says live, register the channel so we track it going forward
            if (isLive) {
                await cache.sAdd('timer:active', channelID);
            }
        }

        if (isLive) {
            if (timer.active) {
                await cache.hSet(`timer:channel:${channelID}:timers`, String(timer._id), JSON.stringify(timer.toObject()));
                await cache.set(`timer:channel:${channelID}:heartbeat:${timer._id}`, '0');
                await cache.set(`timer:channel:${channelID}:heartbeat-unit:${timer._id}`, TIMER_FREQUENCY_UNIT);
            } else {
                await cache.hDel(`timer:channel:${channelID}:timers`, String(timer._id));
                await cache.del(`timer:channel:${channelID}:heartbeat:${timer._id}`);
                await cache.del(`timer:channel:${channelID}:heartbeat-unit:${timer._id}`);
            }
        }

        return {
            error: false,
            message: `Timer "${name}" ${timer.active ? 'enabled' : 'disabled'}`,
            timer: timer.toObject(),
            status: 200
        };
    } catch (error) {
        console.error('Error in toggleTimer:', {
            channelID,
            name,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });
        return { error: true, message: 'Failed to toggle timer', status: 500 };
    }
}

export async function listTimers(channelID: string): Promise<ITimerCommandResult> {
    try {
        const timers = await CustomTimerSchema.find({ channelID }).sort({ name: 1 }).lean();

        if (timers.length === 0) {
            return {
                error: false,
                message: 'No timers configured',
                timers: [],
                status: 200
            };
        }

        const timerList = timers.map((t) => ({
            name: t.name,
            frequency: t.frequency,
            minutes: getTimerIntervalMinutes(t),
            message: t.message.length > 50 ? t.message.substring(0, 47) + '...' : t.message,
            active: t.active
        }));

        const summary = timerList
            .map((t) => `${t.active ? '✓' : '✗'} ${t.name}: ${t.minutes}min - "${t.message}"`)
            .join(' | ');

        return {
            error: false,
            message: `Timers (${timers.length}): ${summary}`,
            timers,
            status: 200
        };
    } catch (error) {
        console.error('Error in listTimers:', {
            channelID,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });
        return { error: true, message: 'Failed to list timers', status: 500 };
    }
}

export async function getTimer(channelID: string, name: string): Promise<ITimerCommandResult> {
    try {
        const timer = await CustomTimerSchema.findOne({ channelID, name: name.toLowerCase() }).lean();
        if (!timer) {
            return { error: true, message: `Timer "${name}" not found`, status: 404 };
        }

        return {
            error: false,
            message: 'Timer found',
            timer,
            status: 200
        };
    } catch (error) {
        console.error('Error in getTimer:', {
            channelID,
            name,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });
        return { error: true, message: 'Failed to get timer', status: 500 };
    }
}

/** Live check used by the timer writes: the timer cache set first, then Twitch (registers the channel when live). */
async function isChannelLiveForTimers(channelID: string): Promise<boolean> {
    const cache = await getDragonflyClient('timerManager');
    if (await cache.sIsMember('timer:active', channelID)) return true;
    const liveResult = await checkChannelLive(channelID);
    const isLive = !liveResult.error && Array.isArray(liveResult.data) && liveResult.data.length > 0;
    if (isLive) await cache.sAdd('timer:active', channelID);
    return isLive;
}

async function dropTimerFromCache(channelID: string, timerID: string): Promise<void> {
    const cache = await getDragonflyClient('timerManager');
    await cache.hDel(`timer:channel:${channelID}:timers`, timerID);
    await cache.del(`timer:channel:${channelID}:heartbeat:${timerID}`);
    await cache.del(`timer:channel:${channelID}:heartbeat-unit:${timerID}`);
}

/**
 * Brings the live-timer cache in line with what is stored for one timer. For a caller whose write
 * landed but whose cache step failed (the site assistant reads the timer back after a 5xx): without
 * it the worker, which reads only the cache while live, keeps posting a deleted timer or never
 * starts a new one until the stream ends. Throws when the cache cannot be reached.
 */
export async function syncTimerCache(channelID: string, timerID: string): Promise<void> {
    const timer = await CustomTimerSchema.findOne({ channelID, _id: timerID });
    if (!timer || !timer.active) {
        await dropTimerFromCache(channelID, timerID);
        return;
    }
    if (!(await isChannelLiveForTimers(channelID))) return;
    const cache = await getDragonflyClient('timerManager');
    await cache.hSet(`timer:channel:${channelID}:timers`, String(timer._id), JSON.stringify(timer.toObject()));
    await cache.set(`timer:channel:${channelID}:heartbeat:${timer._id}`, '0');
    await cache.set(`timer:channel:${channelID}:heartbeat-unit:${timer._id}`, TIMER_FREQUENCY_UNIT);
}

/** Guard failed: 404 when the timer is gone, 409 `changed` when it is there but different. */
async function guardMiss(channelID: string, name: string): Promise<ITimerCommandResult> {
    if (await CustomTimerSchema.exists({ channelID, name: name.toLowerCase() })) {
        return { error: true, message: `Timer "${name}" changed since it was read`, status: 409, code: 'changed' };
    }
    return { error: true, message: `Timer "${name}" not found`, status: 404 };
}

export interface TimerChanges {
    /** New interval in minutes (validated like editTimer). */
    frequency?: number;
    message?: string;
    active?: boolean;
    /** New name (same rules as a new timer's name). 409 when another timer already has it. */
    name?: string;
}

/**
 * Compare-and-set edit for the site assistant: interval, message, on/off and name in ONE write, applied only
 * while the stored timer still equals `guard` (stored field → value, e.g. `{ _id, message, frequency,
 * frequencyUnit, active }`; `null` = missing). Same checks as editTimer (plan interval, grandfathered
 * intervals, message) when the interval or message changes; on/off alone needs none, like toggleTimer.
 * Same cache refresh as editTimer/toggleTimer. Guard miss → 409 `changed` (or 404 when gone).
 */
export async function updateTimerIfUnchanged(channelID: string, name: string, guard: Record<string, unknown>, changes: TimerChanges): Promise<ITimerCommandResult> {
    try {
        const edits = changes.frequency !== undefined || changes.message !== undefined;
        const renames = changes.name !== undefined && changes.name.toLowerCase() !== name.toLowerCase();
        if (!edits && changes.active === undefined && !renames) return { error: true, message: 'Nothing to change', status: 400 };
        const timer = await CustomTimerSchema.findOne({ channelID, name: name.toLowerCase(), ...guard }).lean();
        if (!timer) return await guardMiss(channelID, name);

        const $set: Record<string, unknown> = {};
        if (renames) {
            const nameValidation = validateName(changes.name!);
            if (!nameValidation.valid) return { error: true, message: String(nameValidation.error), status: 400 };
            $set.name = changes.name!.toLowerCase();
        }
        if (edits) {
            const streamer = await TwitchStreamers.getTwitchAccountById(channelID);
            if (!streamer) return { error: true, message: 'Streamer not found', status: 404 };
            const tier = streamer.plan_tier || 'free';
            const currentMinutes = getTimerIntervalMinutes(timer);
            const frequencyValidation = validateTimerEditInterval(timer, changes.frequency, tier);
            if (!frequencyValidation.valid) {
                const grandfatheredMessage = changes.frequency === undefined
                    ? `This timer can keep running at ${currentMinutes} minutes, but it cannot be edited on your current plan. Choose a valid interval first.`
                    : String(frequencyValidation.error);
                return { error: true, message: grandfatheredMessage, status: 400 };
            }
            if (changes.message !== undefined) {
                const messageValidation = validateMessage(changes.message);
                if (!messageValidation.valid) return { error: true, message: String(messageValidation.error), status: 400 };
                $set.message = changes.message;
            }
            $set.frequency = changes.frequency ?? currentMinutes;
            $set.frequencyUnit = TIMER_FREQUENCY_UNIT;
        }
        if (changes.active !== undefined) $set.active = changes.active;

        const updated = await CustomTimerSchema.findOneAndUpdate({ channelID, name: name.toLowerCase(), ...guard }, { $set }, { new: true, runValidators: true });
        if (!updated) return await guardMiss(channelID, name);

        if (await isChannelLiveForTimers(channelID)) {
            if (updated.active) {
                const cache = await getDragonflyClient('timerManager');
                await cache.hSet(`timer:channel:${channelID}:timers`, String(updated._id), JSON.stringify(updated.toObject()));
                await cache.set(`timer:channel:${channelID}:heartbeat:${updated._id}`, '0');
                await cache.set(`timer:channel:${channelID}:heartbeat-unit:${updated._id}`, TIMER_FREQUENCY_UNIT);
            } else if (changes.active === false) {
                await dropTimerFromCache(channelID, String(updated._id));
            }
        }

        const minutes = getTimerIntervalMinutes(updated);
        return {
            error: false,
            message: `Timer "${updated.name}" updated. ${updated.active ? `Sends every ${minutes} minute${minutes !== 1 ? 's' : ''} when live.` : 'It is off.'}`,
            timer: updated.toObject(),
            status: 200
        };
    } catch (error) {
        if (isDuplicateKey(error)) return { error: true, message: `Timer "${changes.name ?? name}" already exists`, status: 409 };
        console.error('Error in updateTimerIfUnchanged:', {
            channelID,
            name,
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString()
        });
        return { error: true, message: 'Failed to edit timer', status: 500 };
    }
}

/** Compare-and-set delete for the site assistant: deletes only while the stored timer still equals `guard`. Same cache cleanup as deleteTimer. */
export async function deleteTimerIfUnchanged(channelID: string, name: string, guard: Record<string, unknown>): Promise<ITimerCommandResult> {
    try {
        const timer = await CustomTimerSchema.findOneAndDelete({ channelID, name: name.toLowerCase(), ...guard });
        if (!timer) return await guardMiss(channelID, name);
        await dropTimerFromCache(channelID, String(timer._id));
        return { error: false, message: `Timer "${name}" deleted`, timer: timer.toObject(), status: 200 };
    } catch (error) {
        console.error('Error in deleteTimerIfUnchanged:', {
            channelID,
            name,
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString()
        });
        return { error: true, message: 'Failed to delete timer', status: 500 };
    }
}

export type { ICustomTimer };
