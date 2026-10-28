/**
 * Converts DomDimaBot's reward fields into the body Twitch's
 * channel_points/custom_rewards endpoints expect, and validates the
 * settings that only live on Twitch (limits, pause). Twitch is the
 * source of truth for those, so they are never stored in our DB.
 *
 * Unknown keys pass through untouched (Twitch ignores them), so older
 * callers that send DB-only fields like `message` keep working.
 */

/** Twitch's longest global cooldown: 7 days. */
export const MAX_GLOBAL_COOLDOWN_SECONDS = 604_800;

export type TwitchRewardBodyMode = 'create' | 'update';

/** Fields that exist only on Twitch and never in the redemption_reward collection. */
export const TWITCH_ONLY_REWARD_FIELDS = [
    'background_color',
    'backgroundColor',
    'isPaused',
    'maxPerStream',
    'maxPerUserPerStream',
    'skipQueue',
    'userInput'
] as const;

function toLimit(value: unknown): number {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n > 0 ? n : 0;
}

export function toTwitchRewardBody(
    body: Record<string, any>,
    mode: TwitchRewardBodyMode = 'update'
): Record<string, any> {
    const parsed: Record<string, any> = { ...body };

    if ('isEnabled' in parsed) {
        parsed.is_enabled = parsed.isEnabled;
        delete parsed.isEnabled;
    }

    if ('skipQueue' in parsed) {
        if (typeof parsed.skipQueue === 'boolean') {
            parsed.should_redemptions_skip_request_queue = parsed.skipQueue;
        }
        delete parsed.skipQueue;
    }

    if ('cooldown' in parsed) {
        const seconds = toLimit(parsed.cooldown);
        if (seconds > 0) {
            parsed.is_global_cooldown_enabled = true;
            parsed.global_cooldown_seconds = seconds;
        } else if (parsed.cooldown !== undefined && parsed.cooldown !== null) {
            parsed.is_global_cooldown_enabled = false;
            parsed.global_cooldown_seconds = 0;
        }
        delete parsed.cooldown;
    }

    if (parsed.userInput !== undefined) {
        parsed.is_user_input_required = parsed.userInput;
        delete parsed.userInput;
    }

    // 0 or null turns a limit off. Twitch needs a value >= 1 only while it's on.
    if ('maxPerStream' in parsed) {
        const limit = toLimit(parsed.maxPerStream);
        parsed.is_max_per_stream_enabled = limit > 0;
        if (limit > 0) parsed.max_per_stream = limit;
        delete parsed.maxPerStream;
    }

    if ('maxPerUserPerStream' in parsed) {
        const limit = toLimit(parsed.maxPerUserPerStream);
        parsed.is_max_per_user_per_stream_enabled = limit > 0;
        if (limit > 0) parsed.max_per_user_per_stream = limit;
        delete parsed.maxPerUserPerStream;
    }

    if ('isPaused' in parsed) {
        // Twitch can only pause an existing reward.
        if (mode === 'update' && typeof parsed.isPaused === 'boolean') {
            parsed.is_paused = parsed.isPaused;
        }
        delete parsed.isPaused;
    }

    return parsed;
}

function isWholeNumber(value: unknown): boolean {
    return typeof value === 'number' && Number.isSafeInteger(value);
}

/** Returns a plain-language error for invalid Twitch-side settings, or null. */
export function validateRewardSettings(body: Record<string, any>): string | null {
    if (body.cooldown !== undefined && body.cooldown !== null) {
        if (!isWholeNumber(body.cooldown) || body.cooldown < 0 || body.cooldown > MAX_GLOBAL_COOLDOWN_SECONDS) {
            return `Cooldown must be a whole number of seconds from 0 to ${MAX_GLOBAL_COOLDOWN_SECONDS} (7 days)`;
        }
    }

    for (const [key, label] of [['maxPerStream', 'Redeems per stream'], ['maxPerUserPerStream', 'Redeems per viewer per stream']] as const) {
        const value = body[key];
        if (value === undefined || value === null) continue;
        if (!isWholeNumber(value) || value < 0) {
            return `${label} must be a whole number (0 turns the limit off)`;
        }
    }

    if (body.isPaused !== undefined && typeof body.isPaused !== 'boolean') {
        return 'isPaused must be true or false';
    }

    return null;
}

/** True when a PATCH body only touches settings that live on Twitch. */
export function isTwitchOnlyRewardUpdate(body: Record<string, any>): boolean {
    const keys = Object.keys(body);
    return keys.length > 0 && keys.every((key) => (TWITCH_ONLY_REWARD_FIELDS as readonly string[]).includes(key));
}
