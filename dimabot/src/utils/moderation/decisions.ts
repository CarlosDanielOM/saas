import { compileRuleVariations } from './variations.js';
import { createHash } from 'node:crypto';
import { ModerationDecision, type IModerationDecision } from '../../schemas/moderation_decision.schema.js';
import { DECISION_POLICY_VERSION, MODERATION_RETENTION_DAYS, SEMANTIC_MODEL } from './advanced.js';

export function moderationDecisionID(channelID: string, messageID: string, ruleID: string): string {
    return createHash('sha256').update(JSON.stringify([channelID, messageID, ruleID])).digest('hex');
}
export async function createModerationDecision(input: Pick<IModerationDecision,
    'channelID' | 'userID' | 'username' | 'messageID' | 'messageText' | 'ruleID' | 'rule' | 'settingsVersion' | 'matches' | 'context' | 'mode' | 'deadline' | 'reviewSource'>): Promise<IModerationDecision> {
    const id = moderationDecisionID(input.channelID, input.messageID, input.ruleID);
    const semantic = input.mode === 'semantic';
    const rule = compileRuleVariations(input.rule);
    return await ModerationDecision.findOneAndUpdate({ _id: id }, { $setOnInsert: {
        ...input, _id: id,
        rule: semantic ? { ...rule, semantic: { ...rule.semantic!, thresholdPercent: rule.semantic?.thresholdPercent ?? 85 } } : rule,
        state: semantic ? 'pending' : 'completed', verdict: semantic ? 'uncertain' : 'violation',
        status: semantic ? 'pending' : 'matched', model: semantic ? SEMANTIC_MODEL : '',
        decisionPolicyVersion: DECISION_POLICY_VERSION,
        createdAt: new Date(), expiresAt: new Date(Date.now() + MODERATION_RETENTION_DAYS * 86_400_000)
    } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean() as IModerationDecision;
}

export async function awaitSemanticDecision(decision: IModerationDecision): Promise<IModerationDecision> {
    while (Date.now() < decision.deadline.getTime()) {
        const current = await ModerationDecision.findById(decision._id).lean();
        if (current?.state === 'completed') return current;
        await new Promise(resolve => setTimeout(resolve, 80));
    }
    // Compare-and-set fences worker results that arrive after the deadline.
    await ModerationDecision.updateOne({ _id: decision._id, state: { $in: ['pending', 'processing'] } }, {
        $set: { state: 'completed', verdict: 'uncertain', status: 'timeout', 'consequence.status': 'allowed_fallback' }
    });
    return await ModerationDecision.findById(decision._id).lean() as IModerationDecision;
}
