import Users from '../../schemas/users.schema.js';
import { ModerationDecision } from '../../schemas/moderation_decision.schema.js';
import { ChannelModerationSettingsSchema } from '../../schemas/channel_moderation_settings.schema.js';
import { getAiCredits, isAiCreditsExhausted } from '../billing.js';
import { ingestPolarSHEvent } from '../polarsh.js';
import { paidModeration, SEMANTIC_MODEL } from './advanced.js';
import { SPAM_CLASSIFIER_MODEL } from './spam_categories.js';
import { evaluateSemanticDecision, fallbackResult, semanticPrice, moderationModelForAccount } from './semantic.js';
import { isSpamDecision, semanticPolicyActive } from './spam.js';

/** One atomic claim per request. Expired work is never reclaimed for punishment. */
export async function processNextSemanticDecision(): Promise<boolean> {
    const decision = await ModerationDecision.findOneAndUpdate({ state: 'pending', deadline: { $gt: new Date() } },
        { $set: { state: 'processing' } }, { sort: { createdAt: 1 }, new: true }).lean();
    if (!decision) return false;
    const started = Date.now();
    try {
        const spamProtection = isSpamDecision(decision);
        const owner = await Users.findOne({ accounts: { $elemMatch: { type: 'twitch', id: decision.channelID } } }).select('plan_tier polar_sh_customer_id').lean();
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
                if (owner && paidModeration(owner.plan_tier) && owner.polar_sh_customer_id) {
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
                model = spamProtection ? moderationModelForAccount(owner?.plan_tier, hasCredits) : SEMANTIC_MODEL;
                customerID = hasCredits ? owner?.polar_sh_customer_id || '' : '';
                result = !spamProtection && !hasCredits ? fallbackResult(creditStatus) : await evaluateSemanticDecision(decision, model);
            }
        }
        // Successful paid inference consumes credits even when the safe verdict
        // is uncertain. Free fallback and failed/late reviews never charge.
        const billable = hasCredits && (model === SPAM_CLASSIFIER_MODEL || !spamProtection) && ['completed', 'uncertain'].includes(result.status);
        const price = semanticPrice(billable ? result.inputTokens : 0);
        const credits = price.credits;
        const update = await ModerationDecision.updateOne({ _id: decision._id, state: 'processing', deadline: { $gt: new Date() } }, { $set: {
            ...result, state: 'completed', latencyMs: Date.now() - started,
            charge: { ...price, status: credits > 0 ? 'pending' : 'none', credits, externalID: `moderation:${decision._id}`, customerID }
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
    const billable = await ModerationDecision.find({ 'charge.status': 'pending', 'consequence.status': { $in: ['allowed', 'allowed_fallback', 'scheduled', 'executed'] } }).sort({ createdAt: 1 }).limit(10).lean();
    for (const decision of billable) {
        const result = await ingestPolarSHEvent({
            customerId: decision.charge.customerID, channelID: decision.channelID,
            externalId: decision.charge.externalID, cost: decision.charge.billableCostUSD ?? 0, reason: 'contextual_moderation', mode: 'cache',
            llm: { model: decision.model, usage: { prompt_tokens: decision.inputTokens, completion_tokens: 0, total_tokens: decision.inputTokens } },
            usage: { requestId: decision._id, operation: 'contextual_moderation', category: 'other', source: 'moderation', provider: 'openrouter', resourceType: 'llm_generation', resourceId: decision.messageID }
        });
        if (!result.error) await ModerationDecision.updateOne({ _id: decision._id }, { $set: { 'charge.status': 'recorded' } });
    }
}
