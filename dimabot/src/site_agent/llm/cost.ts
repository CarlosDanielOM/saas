/**
 * Step cost helpers. OpenRouter normally reports the real price (BYOK: `upstreamCostUsd`); when it
 * gives tokens but no price we estimate from `MODEL_PRICES` so the daily totals stay close.
 */
import { MODEL_PRICES } from '../config.js';
import type { LlmUsage } from '../types.js';

function priceFor(model: string): (typeof MODEL_PRICES)[string] | undefined {
    // "openai/gpt-6-luna:nitro" and similar variants cost the same as the base model.
    return MODEL_PRICES[model] ?? MODEL_PRICES[model.split(':')[0]];
}

/** True when the usage already says what the step cost. */
function hasCost(usage: LlmUsage): boolean {
    if (usage.upstreamCostUsd !== null) return true;
    if (usage.routerCostUsd === null) return false;
    // Without BYOK the router cost is the whole price. With BYOK it is only OpenRouter's fee.
    if (usage.isByok === false) return true;
    return usage.isByok === null && usage.routerCostUsd > 0;
}

/**
 * Returns a copy of `usage`. If the provider gave tokens but no price, `upstreamCostUsd` is set from
 * `MODEL_PRICES` (cached input at the cached price) and `source` becomes 'estimated'.
 */
export function estimateUsageCost(model: string, usage: LlmUsage): LlmUsage {
    const copy = { ...usage };
    if (hasCost(usage) || usage.promptTokens + usage.completionTokens <= 0) return copy;
    const price = priceFor(model);
    if (!price) return copy;
    const cached = Math.min(usage.cachedTokens, usage.promptTokens);
    // Reasoning tokens are already part of completionTokens.
    const estimate = (usage.promptTokens - cached) * price.input + cached * price.cachedInput + usage.completionTokens * price.output;
    copy.upstreamCostUsd = Math.round(estimate * 1e12) / 1e12;
    copy.source = 'estimated';
    return copy;
}

/** What the step cost us in USD (provider + OpenRouter fee), or null when unknown. */
export function effectiveCostUsd(usage: LlmUsage | null): number | null {
    if (!usage) return null;
    const { upstreamCostUsd: upstream, routerCostUsd: router } = usage;
    if (usage.isByok === false) return router ?? upstream;
    if (upstream === null && router === null) return null;
    if (usage.isByok === null && upstream !== null && router !== null && router >= upstream) {
        // Unknown billing mode with both numbers: the router figure already includes the upstream price.
        return router;
    }
    return (upstream ?? 0) + (router ?? 0);
}
