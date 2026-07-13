export const TIMER_FREQUENCY_UNIT = 'minutes' as const;
export const MAX_GRANDFATHERED_TIMER_MINUTES = 24 * 60;

export type TimerPlanTier = 'free' | 'premium' | 'pro';
export type TimerFrequencyUnit = typeof TIMER_FREQUENCY_UNIT;

export interface TimerFrequencyValue {
    frequency: number;
    frequencyUnit?: string;
}

export interface TimerIntervalValidation {
    valid: boolean;
    error?: string;
}

export interface TimerEditIntervalValidation extends TimerIntervalValidation {
    minutes: number;
}

const FREE_INTERVALS = new Set([15, 30, 45, 60]);
const MAX_CURRENT_TIMER_MINUTES = 180;
const MAX_LEGACY_FREQUENCY_TICKS = MAX_GRANDFATHERED_TIMER_MINUTES / 5;

export function convertLegacyTimerFrequency(frequency: unknown): number | null {
    if (!Number.isInteger(frequency) || (frequency as number) < 1 || (frequency as number) > MAX_LEGACY_FREQUENCY_TICKS) {
        return null;
    }

    return (frequency as number) * 5;
}

export function getTimerIntervalMinutes(timer: TimerFrequencyValue): number {
    return timer.frequencyUnit === TIMER_FREQUENCY_UNIT
        ? timer.frequency
        : timer.frequency * 5;
}

export function getTimerHeartbeatMinutes(
    timer: TimerFrequencyValue,
    storedHeartbeat: number,
    heartbeatUnit?: string | null
): number {
    const safeHeartbeat = Number.isFinite(storedHeartbeat) && storedHeartbeat >= 0
        ? storedHeartbeat
        : 0;

    if (heartbeatUnit === TIMER_FREQUENCY_UNIT || timer.frequencyUnit === TIMER_FREQUENCY_UNIT) {
        return safeHeartbeat;
    }

    return safeHeartbeat * 5;
}

export function parseTimerFrequencyInput(rawValue: string | undefined): number | null {
    if (!rawValue) {
        return null;
    }

    const normalized = String(rawValue).trim().toLowerCase();
    const match = normalized.match(/^(\d+)([mh])?$/);
    if (!match) {
        return null;
    }

    const amount = Number.parseInt(match[1], 10);
    if (!Number.isInteger(amount) || amount <= 0) {
        return null;
    }

    return match[2] === 'h' ? amount * 60 : amount;
}

export function validateTimerInterval(
    minutes: number,
    tier: string
): TimerIntervalValidation {
    if (!Number.isInteger(minutes) || minutes <= 0) {
        return { valid: false, error: 'Frequency must be a positive whole number of minutes' };
    }

    switch (tier as TimerPlanTier) {
        case 'pro':
            if (minutes > MAX_CURRENT_TIMER_MINUTES) {
                return { valid: false, error: 'Pro timers must be between 1 and 180 minutes' };
            }
            return { valid: true };

        case 'premium':
            if (minutes < 5 || minutes > MAX_CURRENT_TIMER_MINUTES || minutes % 5 !== 0) {
                return { valid: false, error: 'Premium timers must use 5-minute intervals from 5 to 180 minutes' };
            }
            return { valid: true };

        case 'free':
        default:
            if (!FREE_INTERVALS.has(minutes)) {
                return { valid: false, error: 'Free timers must use 15, 30, 45, or 60 minutes' };
            }
            return { valid: true };
    }
}

export function validateTimerEditInterval(
    timer: TimerFrequencyValue,
    requestedMinutes: number | undefined,
    tier: string
): TimerEditIntervalValidation {
    const minutes = requestedMinutes ?? getTimerIntervalMinutes(timer);
    return {
        minutes,
        ...validateTimerInterval(minutes, tier)
    };
}
