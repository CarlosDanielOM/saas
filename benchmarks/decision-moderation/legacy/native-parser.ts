import fs from 'node:fs';
const ALLOW_THRESHOLD=0.1; const DEFAULT_SPAM_THRESHOLD=85; const SEMANTIC_MODEL='respan/span-01-lite';
type SpamCategory = 'spam' | 'ads' | 'self_promotion' | 'profanity' | 'insults';
type SemanticResult = any;
function fallbackResult(status: string) {return {verdict:'uncertain',status};}
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

export function parseSpamResponse(raw: unknown, categories: SpamCategory[], thresholdPercent = DEFAULT_SPAM_THRESHOLD): SemanticResult {
    if (!raw || typeof raw !== 'object' || !categories.length) return fallbackResult('invalid_response');
    const data = raw as Record<string, any>;
    const scores: Record<string, number> = {};
    for (const name of [...categories, 'unsafe']) {
        const answer = data.answers?.[name];
        if (answer?.type !== 'noul' || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) return fallbackResult('invalid_response');
        scores[name] = answer.noul;
    }
    // P(none selected) is the complement of the model's P(any selected).
    // Asking the positive behavior avoids an unreliable negated classifier prompt.
    scores.safe = 1 - scores.unsafe;
    delete scores.unsafe;
    const highest = Math.max(...categories.map(category => scores[category]));
    const result = parseSemanticResponse({ ...data, answers: { violation: { type: 'noul', noul: highest } } }, thresholdPercent);
    if (result.status === 'invalid_response' || result.status === 'invalid_configuration') return result;
    // These are independent behavior probabilities, not an exclusive distribution.
    // Safe winning vetoes enforcement; ties and low confidence never cause bans.
    const verdict = scores.safe > highest ? 'allow'
        : scores.safe < highest && highest >= thresholdPercent / 100 ? 'violation' : 'uncertain';
    return { ...result, verdict, status: verdict === 'uncertain' ? 'uncertain' : 'completed', scores: { ...scores, violation: highest } };
}

