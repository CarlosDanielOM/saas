import type { ExecutionContext } from '../types.js';
import { registerFunction, type FunctionHandler } from '../evaluator.js';
import { getFollowDefenseStatus, triggerFollowDefenseAttackMode } from '../../../utils/follow_defense_queue.js';

const REQUIRED_MOD_LEVEL = 7;

function canUseDefenseMode(ctx: ExecutionContext): boolean {
    return ctx.userLevel >= REQUIRED_MOD_LEVEL;
}

function getAction(args: unknown[], ctx: ExecutionContext): string {
    return String(args[0] || ctx.argument || '').trim().toLowerCase();
}

const botModeHandler: FunctionHandler = async (args, ctx) => {
    if (!canUseDefenseMode(ctx)) return '';

    const action = getAction(args, ctx);
    if (action === 'attack') {
        await triggerFollowDefenseAttackMode(
            ctx.broadcasterId,
            String(ctx.streamer?.name || ''),
            String(ctx.streamer?.name || '')
        );
        return 'Attack mode queued.';
    }

    if (action === 'status') {
        const state = await getFollowDefenseStatus(ctx.broadcasterId);
        if (!state || state.mode === 'normal') {
            return 'Follow defense is normal.';
        }
        const remainingSeconds = Math.max(0, Math.ceil((state.expiresAt - Date.now()) / 1000));
        return `Follow defense mode: ${state.mode}. ${remainingSeconds}s remaining.`;
    }

    return 'Usage: $(bot.mode attack) or $(bot.mode status)';
};

export function registerDefenseFunctions(): void {
    registerFunction('bot.mode', botModeHandler, {
        description: 'Follow-defense control: "attack" queues attack mode, "status" reports the current defense mode and time remaining.',
        syntax: 'bot.mode attack|status',
        category: 'defense',
        examples: ['bot.mode attack', 'bot.mode status'],
        minUserLevel: 7,
        keywords: ['follow defense', 'attack mode', 'defensa de follows', 'modo ataque', 'bot mode']
    });
}
