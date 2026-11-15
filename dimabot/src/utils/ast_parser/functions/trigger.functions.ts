import { registerFunction, type FunctionHandler } from '../evaluator.js';
import type { ExecutionContext } from '../types.js';
import { TriggerSchema } from '../../../schemas/trigger.schema.js';
import { sendTrigger, type FiredBy } from '../../../functions/triggers/send_trigger.trigger.js';
import { resolveTriggerPlaybackAsset } from '../../../functions/triggers/resolve_trigger_file.trigger.js';

function parseQueueFlag(raw: unknown): boolean | null {
    const normalized = String(raw).trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    return null;
}

/** Who fired the trigger, for `$(user)` in its look. Timers have no real chatter (their context is the streamer). */
function firedByFrom(ctx: ExecutionContext): FiredBy | undefined {
    if (ctx.scopeType === 'timer') return undefined;
    const firedBy: FiredBy = {};
    if (typeof ctx.userId === 'string' && ctx.userId.trim()) firedBy.id = ctx.userId;
    if (typeof ctx.userLogin === 'string' && ctx.userLogin.trim()) firedBy.login = ctx.userLogin;
    if (typeof ctx.userDisplayName === 'string' && ctx.userDisplayName.trim()) firedBy.name = ctx.userDisplayName;
    return Object.keys(firedBy).length ? firedBy : undefined;
}

const triggerSendHandler: FunctionHandler = async (args, ctx) => {
    if (args.length === 0) {
        return 'Usage: $(trigger.send trigger_name true|false)';
    }

    let queue = false;
    let triggerNameParts = [...args].map((arg) => String(arg).trim()).filter(Boolean);

    const maybeQueueArg = triggerNameParts[triggerNameParts.length - 1];
    const parsedQueue = maybeQueueArg ? parseQueueFlag(maybeQueueArg) : null;
    if (parsedQueue !== null) {
        queue = parsedQueue;
        triggerNameParts = triggerNameParts.slice(0, -1);
    }

    const triggerName = triggerNameParts.join(' ').trim();

    if (!triggerName) {
        return 'Usage: $(trigger.send trigger_name true|false)';
    }

    const trigger = await TriggerSchema.findOne({
        channelID: ctx.broadcasterId,
        name: triggerName
    });

    if (!trigger) {
        return `Trigger not found: ${triggerName}`;
    }

    if (!trigger.isEnabled) {
        return `Trigger is disabled: ${triggerName}`;
    }

    const file = await resolveTriggerPlaybackAsset(trigger);

    if (!file) {
        return `Trigger file not found: ${trigger.file}`;
    }

    const firedBy = firedByFrom(ctx);
    const result = await sendTrigger(ctx.broadcasterId, {
        triggerId: String(trigger._id),
        name: trigger.name,
        url: file.fileUrl,
        mediaType: file.fileType,
        volume: trigger.volume,
        ...(firedBy ? { firedBy } : {})
    }, queue);

    return result.error ? result.message : '';
};

export function registerTriggerFunctions(): void {
    registerFunction('trigger.send', triggerSendHandler, {
        description: 'Fires a configured sound/video trigger by name. Optional true/false last argument controls queueing.',
        syntax: 'trigger.send trigger_name [true|false]',
        category: 'trigger',
        examples: ['trigger.send airhorn', 'trigger.send airhorn true'],
        minUserLevel: 7,
        keywords: ['trigger', 'alert', 'sound', 'video', 'alerta', 'sonido', 'reproducir alerta']
    });
}
