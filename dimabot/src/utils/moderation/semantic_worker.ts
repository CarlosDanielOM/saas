import Users from '../../schemas/users.schema.js';
import { ModerationDecision } from '../../schemas/moderation_decision.schema.js';
import { ChannelModerationSettingsSchema } from '../../schemas/channel_moderation_settings.schema.js';
import { getAiCredits, isAiCreditsExhausted } from '../billing.js';
import { ingestPolarSHEvent } from '../polarsh.js';
import { paidModeration, SEMANTIC_MODEL } from './advanced.js';
import { SPAM_CLASSIFIER_MODEL } from './spam_categories.js';
import { evaluateSemanticDecision, fallbackResult, semanticPrice, moderationModelForReview } from './semantic.js';
import { isSpamDecision, semanticPolicyActive } from './spam.js';

/** One atomic claim per request. Expired work is never reclaimed for punishment. */
export async function processNextSemanticDecision(): Promise<boolean> {
    const decision = await ModerationDecision.findOneAndUpdate({ state: 'pending', deadline: { $gt: new Date() } },
        { $set: { state: 'processing' } }, { sort: { createdAt: 1 }, new: true }).lean();
    if (!decision) return false;
    const started = Date.now();
    try {
        const spamProtection = isSpamDecision(decision);
        // A chatter's first messages are included with the plan: never charged, whatever the credit balance.
        const included = spamProtection && decision.reviewSource === 'first_message';
        const owner = await Users.findOne({ accounts: { $elemMatch: { type: 'twitch', id: decision.channelID } } }).select('plan_tier polar_sh_customer_id accounts.type accounts.id accounts.name').lean();
        const settings = await ChannelModerationSettingsSchema.findOne({ channelID: decision.channelID }).lean();
        let result = fallbackResult('policy_changed');
        let customerID = '';
        let model: string = SEMANTIC_MODEL;
        let hasCredits = false;
        let creditStatus = 'credits_unavailable';
        if (semanticPolicyActive(settings, decision)) {
            if (!spamProtection && !paidModeration(owner?.plan_tier)) {
                result = fallbackResult('plan_required');
            } else {
                // An included review needs no credits, so the balance (up to 750 ms of the 4-second budget) is not read.
                if (!included && owner && paidModeration(owner.plan_tier) && owner.polar_sh_customer_id) {
                    try {
                        if (await isAiCreditsExhausted(decision.channelID)) creditStatus = 'quota_exhausted';
                        else {
                            const credits = await getAiCredits(owner, decision.channelID, { requireVerified: true, signal: AbortSignal.timeout(750) });
                            hasCredits = credits.available && credits.status === 'available' && credits.balance > 0;
                            if (credits.status === 'exhausted') creditStatus = 'quota_exhausted';
                        }
                    } catch {
                        // Chat protection uses Lite when balances cannot be verified.
                    }
                }
                model = spamProtection ? moderationModelForReview(decision.reviewSource, owner?.plan_tier, hasCredits) : SEMANTIC_MODEL;
                // Fallback for decisions without the chat event's login; a stored name can be stale after a rename.
                const broadcaster = owner?.accounts?.find(account => account.type === 'twitch' && account.id === decision.channelID)?.name || '';
                result = !spamProtection && !hasCredits ? fallbackResult(creditStatus) : await evaluateSemanticDecision(decision, model, broadcaster);
            }
        }
        // Successful paid inference consumes credits even when the safe verdict
        // is uncertain. Included reviews, the Lite fallback and failed/late reviews never charge.
        const reviewed = ['completed', 'uncertain'].includes(result.status);
        const billable = hasCredits && !included && (model === SPAM_CLASSIFIER_MODEL || !spamProtection) && reviewed;
        const price = semanticPrice(billable ? result.inputTokens : 0);
        const credits = price.credits;
        // What an included review cost us is still reported to Polar, with zero credits, so spend stays visible per customer.
        const tracked = included && reviewed && result.cost > 0 && !!owner?.polar_sh_customer_id;
        customerID = billable || tracked ? owner?.polar_sh_customer_id || '' : '';
        const update = await ModerationDecision.updateOne({ _id: decision._id, state: 'processing', deadline: { $gt: new Date() } }, { $set: {
            ...result, state: 'completed', latencyMs: Date.now() - started,
            charge: { ...price, status: credits > 0 || tracked ? 'pending' : 'none', credits, externalID: `moderation:${decision._id}`, customerID }
        } });
        if (!update.modifiedCount) {
            // Retain late teacher scores for audit, but never change the effective
            // fallback verdict, increment an offense, or charge the user.
            await ModerationDecision.updateOne({ _id: decision._id }, { $set: {
                scores: result.scores, model: result.model, provider: result.provider,
                providerRequestID: result.providerRequestID, inputTokens: result.inputTokens,
                cost: result.cost, latencyMs: Date.now() - started
            } });
        }
    } catch {
        await ModerationDecision.updateOne({ _id: decision._id, state: 'processing' }, {
            $set: { state: 'completed', verdict: 'uncertain', status: 'unavailable', latencyMs: Date.now() - started }
        });
    }
    return true;
}

export async function maintainSemanticDecisions(): Promise<void> {
    await ModerationDecision.updateMany({ state: { $in: ['pending', 'processing'] }, deadline: { $lte: new Date() } }, {
        $set: { state: 'completed', verdict: 'uncertain', status: 'timeout', 'consequence.status': 'allowed_fallback' }
    });
    // A charge waits for the handler's outcome, because a cancelled ban is not charged. The zero-credit
    // cost report of an included review has nothing to cancel, so it never depends on the handler.
    const billable = await ModerationDecision.find({ 'charge.status': 'pending', $or: [{ 'charge.credits': { $lte: 0 } },
        { 'consequence.status': { $in: ['allowed', 'allowed_fallback', 'scheduled', 'executed'] } }] }).sort({ createdAt: 1 }).limit(10).lean();
    for (const decision of billable) {
        // No credits on the charge means an included review: Polar gets its real provider cost and zero credits.
        const charged = decision.charge.credits > 0;
        const result = await ingestPolarSHEvent({
            customerId: decision.charge.customerID, channelID: decision.channelID,
            externalId: decision.charge.externalID, cost: charged ? decision.charge.billableCostUSD ?? 0 : decision.cost, chargeCredits: charged, reason: 'contextual_moderation', mode: 'cache',
            llm: { model: decision.model, usage: { prompt_tokens: decision.inputTokens, completion_tokens: 0, total_tokens: decision.inputTokens } },
            usage: { requestId: decision._id, operation: 'contextual_moderation', category: 'other', source: 'moderation', provider: 'openrouter', resourceType: 'llm_generation', resourceId: decision.messageID }
        });
        if (!result.error) await ModerationDecision.updateOne({ _id: decision._id }, { $set: { 'charge.status': 'recorded' } });
    }
}
