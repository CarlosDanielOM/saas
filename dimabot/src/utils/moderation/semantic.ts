import type { IModerationDecision } from '../../schemas/moderation_decision.schema.js';
export const SEMANTIC_USD_PER_MILLION_INPUT_TOKENS = 0.042;
export const SEMANTIC_PRICING_VERSION = 'span-lite-jev-equivalent-v1';

export function semanticPrice(inputTokens: number) {
    const billableCostUSD = inputTokens * SEMANTIC_USD_PER_MILLION_INPUT_TOKENS / 1_000_000;
    // Preserve the existing AI ledger's rounding and USD-to-credit conversion.
    const credits = Math.ceil((Math.round(billableCostUSD * 100 * 1e8) / 1e8) * 1000);
    return { billableCostUSD, credits, pricingVersion: SEMANTIC_PRICING_VERSION, usdPerMillionInputTokens: SEMANTIC_USD_PER_MILLION_INPUT_TOKENS };
}

import { ALLOW_THRESHOLD, SEMANTIC_MODEL } from './advanced.js';

export interface SemanticResult {
    verdict: 'allow' | 'violation' | 'uncertain';
    status: string;
    scores: Record<string, unknown> | null;
    model: string;
    provider: string;
    providerRequestID: string;
    inputTokens: number;
    cost: number;
}
export function fallbackResult(status: string): SemanticResult {
    return { verdict: 'uncertain', status, scores: null, model: SEMANTIC_MODEL, provider: 'openrouter', providerRequestID: '', inputTokens: 0, cost: 0 };
}
export function parseSemanticResponse(raw: unknown, thresholdPercent = 85): SemanticResult {
    if (!Number.isFinite(thresholdPercent) || thresholdPercent < 0 || thresholdPercent > 100) return fallbackResult('invalid_configuration');
    const violationThreshold = thresholdPercent / 100;
    if (!raw || typeof raw !== 'object') return fallbackResult('invalid_response');
    const data = raw as Record<string, any>;
    const score = data.answers?.violation?.noul;
    if (data.answers?.violation?.type !== 'noul' || typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) return fallbackResult('invalid_response');
    const cost = data.usage?.cost;
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0 || !Number.isSafeInteger(data.usage?.input_tokens) || data.usage.input_tokens < 0) return fallbackResult('invalid_response');
    return {
        verdict: score >= violationThreshold ? 'violation' : score <= ALLOW_THRESHOLD ? 'allow' : 'uncertain',
        status: score > ALLOW_THRESHOLD && score < violationThreshold ? 'uncertain' : 'completed',
        scores: { violation: score },
        model: typeof data.model === 'string' ? data.model.slice(0, 150) : SEMANTIC_MODEL,
        provider: typeof data.provider === 'string' ? data.provider.slice(0, 100) : 'openrouter',
        providerRequestID: typeof data.id === 'string' ? data.id.slice(0, 200) : '',
        inputTokens: data.usage.input_tokens,
        cost
    };
}

export function semanticRequest(decision: Pick<IModerationDecision, 'rule' | 'messageText' | 'username' | 'context' | 'matches'>) {
    const semantic = decision.rule.semantic!;
    return {
        model: SEMANTIC_MODEL,
        questions: {
            violation: {
                type: 'noul',
                instructions: 'Does the final message exhibit the described behavior?'
                    + (semantic.examples.length ? `\nPolicy examples: ${JSON.stringify(semantic.examples)}` : ''),
                // Span's behavior definition belongs in criteria, not only instructions.
                // Keep the channel's policy self-contained, including its exceptions.
                criteria: {
                    true: semantic.policy,
                    false: 'The described behavior is absent from the final message.'
                }
            }
        },
        // Respan accepts a string or its constrained span shape, not arbitrary state objects.
        state: JSON.stringify({ targetMessage: { author: decision.username, text: decision.messageText }, matchedSpans: decision.matches, precedingMessages: decision.context })
    };
}

export async function evaluateSemanticDecision(decision: IModerationDecision): Promise<SemanticResult> {
    const remaining = decision.deadline.getTime() - Date.now();
    if (remaining <= 0) return fallbackResult('timeout');
    if (!process.env.OPENROUTER_API_KEY) return fallbackResult('unavailable');
    try {
        const response = await fetch('https://openrouter.ai/api/alpha/decisions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(semanticRequest(decision)),
            signal: AbortSignal.timeout(remaining)
        });
        if (!response.ok) return fallbackResult(response.status === 429 ? 'rate_limited' : 'unavailable');
        return parseSemanticResponse(await response.json(), decision.rule.semantic?.thresholdPercent ?? 85);
    } catch (error) {
        return fallbackResult(Date.now() >= decision.deadline.getTime() || (error instanceof Error && error.name === 'TimeoutError') ? 'timeout' : 'unavailable');
    }
}
