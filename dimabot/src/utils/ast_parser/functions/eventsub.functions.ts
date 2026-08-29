import { registerFunction, type FunctionHandler } from '../evaluator.js';
import type { FunctionMetadata } from '../types.js';

function getEventData(ctx: Parameters<FunctionHandler>[1]): Record<string, unknown> {
    return (ctx.eventData as Record<string, unknown> | undefined) || {};
}

function getStringField(eventData: Record<string, unknown>, keys: string[]): string {
    for (const key of keys) {
        const value = eventData[key];
        if (typeof value === 'string' && value.trim() !== '') {
            return value;
        }
    }
    return '';
}

function getNumberField(eventData: Record<string, unknown>, keys: string[]): number | null {
    for (const key of keys) {
        const value = eventData[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }
        if (typeof value === 'string') {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) {
                return parsed;
            }
        }
    }
    return null;
}

function getBooleanField(eventData: Record<string, unknown>, keys: string[]): boolean {
    for (const key of keys) {
        const value = eventData[key];
        if (typeof value === 'boolean') {
            return value;
        }
        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase();
            if (normalized === 'true') {
                return true;
            }
            if (normalized === 'false') {
                return false;
            }
        }
    }
    return false;
}

function formatSubscriptionTier(eventData: Record<string, unknown>): string {
    const rawTier = getStringField(eventData, ['tier', 'sub_tier', 'subscription_tier']);
    const normalizedTier = rawTier.trim().toLowerCase().replace(/[\s_-]+/g, '');
    const planName = getStringField(eventData, ['sub_plan_name', 'plan_name', 'subscription_plan_name']).trim().toLowerCase();
    const isPrime = getBooleanField(eventData, ['is_prime', 'prime', 'is_prime_sub'])
        || normalizedTier === 'prime'
        || planName.includes('prime');

    if (isPrime) {
        return 'Prime';
    }

    switch (normalizedTier) {
        case '1000':
        case 'tier1':
            return 'Tier 1';
        case '2000':
        case 'tier2':
            return 'Tier 2';
        case '3000':
        case 'tier3':
            return 'Tier 3';
        default:
            return rawTier || 'unknown';
    }
}

const raidViewersHandler: FunctionHandler = async (_args, ctx) => {
    const eventData = getEventData(ctx);
    const viewers = getNumberField(eventData, ['viewers']);
    return String(viewers ?? 0);
};

const raidChannelHandler: FunctionHandler = async (_args, ctx) => {
    const eventData = getEventData(ctx);
    const channelName = getStringField(eventData, [
        'from_broadcaster_user_name',
        'from_broadcaster_user_login'
    ]);
    return channelName || 'unknown';
};

const raidLoginHandler: FunctionHandler = async (_args, ctx) => {
    const eventData = getEventData(ctx);
    const channelLogin = getStringField(eventData, ['from_broadcaster_user_login']);
    return channelLogin || 'unknown';
};

const cheerAmountHandler: FunctionHandler = async (_args, ctx) => {
    const eventData = getEventData(ctx);
    const cheerData = eventData.cheer as Record<string, unknown> | undefined;
    const bitsFromCheer = cheerData && typeof cheerData.bits === 'number' ? cheerData.bits : null;
    const bits = bitsFromCheer ?? getNumberField(eventData, ['bits']);
    return String(bits ?? 0);
};

const cheerMessageHandler: FunctionHandler = async (_args, ctx) => {
    const eventData = getEventData(ctx);
    const messageData = eventData.message as Record<string, unknown> | undefined;
    const messageText = messageData && typeof messageData.text === 'string'
        ? messageData.text
        : getStringField(eventData, ['message']);

    return messageText;
};

const subTierHandler: FunctionHandler = async (_args, ctx) => {
    const eventData = getEventData(ctx);
    return formatSubscriptionTier(eventData);
};

const subMonthsHandler: FunctionHandler = async (_args, ctx) => {
    const eventData = getEventData(ctx);
    const months = getNumberField(eventData, ['cumulative_months', 'streak_months', 'months']);
    return String(months ?? 0);
};

const giftedUserHandler: FunctionHandler = async (_args, ctx) => {
    const eventData = getEventData(ctx);
    const giftedUser = getStringField(eventData, [
        'recipient_user_name',
        'recipient_user_login',
        'user_name',
        'user_login'
    ]);
    return giftedUser || 'unknown';
};

const hypeTrainProgressHandler: FunctionHandler = async (_args, ctx) => {
    const eventData = getEventData(ctx);
    const progress = getNumberField(eventData, ['progress', 'total', 'goal']);
    return String(progress ?? 0);
};

const hypeTrainLevelHandler: FunctionHandler = async (_args, ctx) => {
    const eventData = getEventData(ctx);
    const level = getNumberField(eventData, ['level']);
    return String(level ?? 0);
};

const hypeTrainEndHandler: FunctionHandler = async (_args, ctx) => {
    const eventData = getEventData(ctx);
    const endAt = getStringField(eventData, ['ends_at', 'ended_at', 'cooldown_ends_at']);
    return endAt || 'unknown';
};

const shoutoutChannelHandler: FunctionHandler = async (_args, ctx) => {
    const eventData = getEventData(ctx);
    const channelName = getStringField(eventData, [
        'from_broadcaster_user_name',
        'from_broadcaster_user_login',
        'broadcaster_user_name',
        'broadcaster_user_login'
    ]);
    return channelName || 'unknown';
};

const rewardInputHandler: FunctionHandler = async (_args, ctx) => {
    const eventData = getEventData(ctx);
    const userInput = getStringField(eventData, ['user_input', 'reward_input']);
    return userInput;
};

export function registerEventsubFunctions(): void {
    registerFunction('raid.channel', raidChannelHandler, {
        description: 'Display name of the channel raiding us (raid event data).',
        syntax: 'raid.channel',
        category: 'event-data',
        examples: ['raid.channel'],
        keywords: ['raid', 'who raids', 'quien raidea', 'canal del raid'],
        surfaces: ['authoring']
    });
    registerFunction('raid.login', raidLoginHandler, {
        description: 'Login name of the channel raiding us (raid event data).',
        syntax: 'raid.login',
        category: 'event-data',
        examples: ['raid.login'],
        keywords: ['raid login', 'login del raid'],
        surfaces: ['authoring']
    });
    registerFunction('raid.viewers', raidViewersHandler, {
        description: 'Number of viewers brought by the incoming raid (raid event data).',
        syntax: 'raid.viewers',
        category: 'event-data',
        examples: ['raid.viewers'],
        keywords: ['raid viewers', 'viewers del raid', 'cuantos en el raid'],
        surfaces: ['authoring']
    });
    registerFunction('cheer.amount', cheerAmountHandler, {
        description: 'Bits amount of the current cheer event.',
        syntax: 'cheer.amount',
        category: 'event-data',
        examples: ['cheer.amount'],
        keywords: ['bits', 'cheer', 'cuantos bits'],
        surfaces: ['authoring']
    });
    registerFunction('cheer.message', cheerMessageHandler, {
        description: 'Text message attached to the current cheer event.',
        syntax: 'cheer.message',
        category: 'event-data',
        examples: ['cheer.message'],
        keywords: ['cheer message', 'mensaje del cheer'],
        surfaces: ['authoring']
    });
    registerFunction('sub.tier', subTierHandler, {
        description: 'Subscription tier of the current sub event (Prime, Tier 1, Tier 2, Tier 3).',
        syntax: 'sub.tier',
        category: 'event-data',
        examples: ['sub.tier'],
        keywords: ['sub tier', 'tier de sub', 'nivel de suscripcion'],
        surfaces: ['authoring']
    });
    registerFunction('sub.months', subMonthsHandler, {
        description: 'Cumulative subscription months of the current sub event.',
        syntax: 'sub.months',
        category: 'event-data',
        examples: ['sub.months'],
        keywords: ['sub months', 'meses de sub', 'antiguedad sub'],
        surfaces: ['authoring']
    });
    registerFunction('gifted.user', giftedUserHandler, {
        description: 'Recipient username of a gifted subscription event.',
        syntax: 'gifted.user',
        category: 'event-data',
        examples: ['gifted.user'],
        keywords: ['gifted sub', 'sub regalada', 'quien recibio el gift'],
        surfaces: ['authoring']
    });
    registerFunction('hypetrain.progress', hypeTrainProgressHandler, {
        description: 'Current hype train progress points.',
        syntax: 'hypetrain.progress',
        category: 'event-data',
        examples: ['hypetrain.progress'],
        keywords: ['hype train', 'tren del hype', 'progreso'],
        surfaces: ['authoring']
    });
    registerFunction('hypetrain.level', hypeTrainLevelHandler, {
        description: 'Current hype train level.',
        syntax: 'hypetrain.level',
        category: 'event-data',
        examples: ['hypetrain.level'],
        keywords: ['hype train level', 'nivel del hype train'],
        surfaces: ['authoring']
    });
    registerFunction('hypetrain.end', hypeTrainEndHandler, {
        description: 'End time of the current hype train.',
        syntax: 'hypetrain.end',
        category: 'event-data',
        examples: ['hypetrain.end'],
        keywords: ['hype train end', 'fin del hype train'],
        surfaces: ['authoring']
    });
    registerFunction('shoutout.channel', shoutoutChannelHandler, {
        description: 'Target channel of a shoutout event.',
        syntax: 'shoutout.channel',
        category: 'event-data',
        examples: ['shoutout.channel'],
        keywords: ['shoutout', 'canal del shoutout'],
        surfaces: ['authoring']
    });
    const rewardInputMetadata: FunctionMetadata = {
        description: 'User input text from a channel point reward redemption.',
        syntax: 'reward.input',
        category: 'event-data',
        examples: ['reward.input'],
        keywords: ['reward input', 'user input', 'texto del canje', 'input de la recompensa'],
        surfaces: ['authoring']
    };
    registerFunction('reward.input', rewardInputHandler, rewardInputMetadata);
    registerFunction('redemption.input', rewardInputHandler, { ...rewardInputMetadata, aliasOf: 'reward.input' });
}
