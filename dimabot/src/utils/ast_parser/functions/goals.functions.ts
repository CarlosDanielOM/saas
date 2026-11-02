import { registerFunction, type FunctionHandler } from '../evaluator.js';
import { nextGoalContribution } from '../effects.js';
import { RequiredGoalContributionError } from '../required_goal_contribution_error.js';
import { GoalError } from '../../../goals/model.js';
import { DomainEventContractError } from '../../../domain_events/domain_event_contracts.js';

export const goalAddHandler: FunctionHandler = async (args, ctx) => {
    if (ctx.authorization?.origin === 'llm' || ctx.platform !== 'twitch') return 'Error: goal_permission_required';
    const itemKey = String(args[0] ?? '');
    const rawQuantity = String(args[1] ?? '');
    if (!/^[a-z0-9_]{1,48}$/.test(itemKey) || !/^[1-9]\d*$/.test(rawQuantity)) return 'Error: invalid_goal_contribution';
    const quantity = Number(rawQuantity);
    if (!Number.isSafeInteger(quantity) || quantity > 1_000_000_000 || args.length > 3) return 'Error: invalid_goal_contribution';
    const receipt = args.length === 3 ? String(args[2] ?? '').trim() : '';
    if (args.length === 3 && (!receipt || receipt.length > 200)) return 'Error: invalid_goal_receipt';

    const identity = nextGoalContribution(ctx.effectContext, ctx.broadcasterId);
    let receiptIdentity: string;
    let occurredAt: Date;
    if (identity) {
        // The actor and signed chat badges come from verified EventSub ingress,
        // never from eventData or the streamer's authored privilege elevation.
        const authorizedChat = identity.origin.kind === 'chat-command' && Boolean(identity.actor.chat)
            && (identity.actor.userId === ctx.broadcasterId
                || identity.actor.chat!.badges.some(b => b.set_id === 'moderator' || b.set_id === 'lead_moderator'));
        const authorizedEvent = identity.origin.kind === 'twitch-event' && identity.eventsubConfig
            && ctx.authorization?.origin === 'authored';
        const authorized = authorizedChat || authorizedEvent;
        if (!authorized) return 'Error: goal_permission_required';
        receiptIdentity = receipt
            ? JSON.stringify(['explicit', identity.actionKey, receipt])
            : JSON.stringify(['origin', identity.origin.kind, identity.origin.id, identity.actionKey]);
        occurredAt = new Date(identity.origin.occurredAt);
    } else {
        // No opaque provenance: do not trust the elevated identity given to a
        // streamer-authored body. An independently authorized chat identity and
        // an explicit stable receipt are both required.
        if (ctx.authorization?.origin !== 'chat' || (ctx.authorization.identity?.level ?? 0) < 7) return 'Error: goal_permission_required';
        if (!receipt) return 'Error: goal_receipt_required';
        if (!ctx.scopeType || !ctx.scopeName) return 'Error: goal_scope_required';
        receiptIdentity = JSON.stringify(['explicit', ctx.scopeType, ctx.scopeName, ctx.commandId, receipt]);
        occurredAt = new Date();
    }
    try {
        const { ingestCustomGoalContribution } = await import('../../../domain_events/goal_custom_events.js');
        await ingestCustomGoalContribution({ channelID: ctx.broadcasterId, receiptIdentity, itemKey, quantity, occurredAt });
        return '';
    } catch (error) {
        // A configured durable event must retry transient journal failures. Known
        // invalid input and receipt conflicts are permanent business outcomes.
        if (error instanceof GoalError || error instanceof DomainEventContractError) return 'Error: goal_contribution_failed';
        if (identity?.origin.kind === 'twitch-event' && identity.eventsubConfig) throw new RequiredGoalContributionError();
        return 'Error: goal_contribution_failed';
    }
};

export function registerGoalFunctions(): void {
    registerFunction('goal.add', goalAddHandler, {
        description: 'Record an item on a configured currency goal. This does not charge a customer or verify a sale.',
        syntax: 'goal.add item_name quantity [receipt_id]', category: 'goals', minUserLevel: 7,
        surfaces: ['authoring'], examples: ['goal.add sticker 3'],
        keywords: ['goal', 'currency', 'contribution', 'meta']
    });
}
