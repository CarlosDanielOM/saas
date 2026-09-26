import type { ExecutionContext, FunctionNode, EvaluateResult, RootNode } from './types.js';
import { evaluate } from './evaluator.js';

export const TIMER_GRACE_MS = 10 * 60 * 1000;
export const MAX_TIMER_SECONDS = 7 * 24 * 60 * 60;
export const MAX_TIMER_DEPTH = 5;

/** Only data crosses the cache boundary; callbacks are rebuilt on recovery. */
export function snapshotTimerContext(ctx: ExecutionContext) {
    return {
        broadcasterId: ctx.broadcasterId, userId: ctx.userId,
        userLogin: ctx.userLogin, userDisplayName: ctx.userDisplayName,
        userPlan: ctx.userPlan, userLevel: ctx.userLevel,
        enforceFunctionPermissions: ctx.enforceFunctionPermissions,
        authorization: ctx.authorization, argument: ctx.argument, count: ctx.count,
        eventData: ctx.eventData, eventsubData: ctx.eventsubData, extraContext: ctx.extraContext,
        platform: ctx.platform, scopeType: ctx.scopeType, scopeName: ctx.scopeName,
        scopeAliases: ctx.scopeAliases, commandName: ctx.commandName, commandId: ctx.commandId,
        commandRefDepth: ctx.commandRefDepth, visitedCommands: [...(ctx.visitedCommands ?? [])],
        commandResponses: ctx.commandResponses,
        variables: [...ctx.variables], arrays: [...ctx.arrays], loopVars: [...(ctx.loopVars ?? [])],
        timerDepth: (ctx.timerDepth ?? 0) + 1
    };
}
export type TimerContext = ReturnType<typeof snapshotTimerContext>;
export type ScheduleTimer = (seconds: number, body: RootNode, context: ExecutionContext) => Promise<void>;

export async function evaluateTimer(
    node: FunctionNode,
    context: ExecutionContext,
    schedule: ScheduleTimer = async (seconds, body, ctx) => {
        const { scheduleAstTimer } = await import('../ast_timer_runtime.js');
        await scheduleAstTimer(seconds, body, ctx);
    }
): Promise<EvaluateResult> {
    const fail = (message: string, ctx = context) => ({ value: `timer: ${message}`, context: ctx });
    if (node.args.length < 2) return fail('usage: $(timer seconds message_and_actions)');
    if ((context.timerDepth ?? 0) >= MAX_TIMER_DEPTH) return fail('maximum nested timer depth reached');
    if (!context.broadcasterId || context.platform !== 'twitch') return fail('requires a Twitch channel');

    const duration = await evaluate(node.args[0], context);
    const seconds = Number(duration.value);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > MAX_TIMER_SECONDS) {
        return fail(`seconds must be between 1 and ${MAX_TIMER_SECONDS}`, duration.context);
    }
    try {
        await schedule(seconds, { type: 'root', children: node.args.slice(1) }, duration.context);
        return { value: '', context: duration.context };
    } catch (error) {
        console.error('AST timer scheduling failed', { channelID: context.broadcasterId, error });
        return fail('could not schedule timer', duration.context);
    }
}
