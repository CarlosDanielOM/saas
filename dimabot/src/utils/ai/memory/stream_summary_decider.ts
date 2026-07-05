import TwitchStreamers from '../../../classes/twitch_streamers.class.js';
import { ChannelAIPersonalitySchema } from '../../../schemas/channel_ai_personality.schema.js';
import { BACKGROUND_MODELS, BACKGROUND_MODEL_FALLBACK, getProviderRestriction } from '../constants.js';
import { createFetchWithRetry, type RetryOptions } from '../fetch.utils.js';
import { ingestPolarSHEvent } from '../../polarsh.js';
import { warn as logWarn, error as logError, debug as logDebug } from '../../logger.js';
import {
    STREAM_SUMMARY_JSON_SCHEMA,
    parseStreamSummaryResponse,
    sanitizeStreamSummaryResponse,
    type StreamSummaryParseResult,
    type StreamSummaryMemoryAction
} from './stream_summary_schema.js';

/**
 * HTTP-level retry config for stream summary OpenRouter calls.
 *
 * Stream summaries run as a background job after a stream goes offline, so added
 * latency from longer backoff is acceptable. We use a custom 15s/30s/60s schedule
 * (much longer than the default 1s/3s/5s) to absorb upstream 429 rate limits from
 * the deepseek provider, which is heavily used by v4 Pro. The 60s per-request
 * timeout is generous because v4 Pro can be slow on large payloads, but a single
 * request taking >60s usually indicates a real problem rather than mere slowness.
 */
const STREAM_SUMMARY_FETCH_OPTIONS: RetryOptions = {
    retries: 3,
    delays: [15_000, 30_000, 60_000],
    timeout: 60_000,
    retryOn: [429, 500, 502, 503, 504],
};
const fetchStreamSummary = createFetchWithRetry(STREAM_SUMMARY_FETCH_OPTIONS);

interface StreamSummaryContext {
    channelID: string;
    session: {
        id: string;
        streamID: string;
        channel: string;
        status: string;
        startedAt: string;
        endedAt: string;
        durationMinutes: number;
        averageViewers: number;
        peakViewers: number;
        follows: number;
        subs: number;
        bits: number;
        donations: number;
    };
    snapshots: Array<{
        capturedAt: string;
        viewers: number;
        title: string;
        gameName: string;
    }>;
    sampledChatMessages: Array<{
        username: string;
        message: string;
        timestamp: number;
    }>;
    existingMemories: Array<{
        memoryID: string;
        status: string;
        type: string;
        confidence: number;
        summary: string;
        content: string;
        useCount: number;
        lastUsedAt?: string;
        updatedAt?: string;
    }>;
    archivedMemories: Array<{
        memoryID: string;
        status: string;
        type: string;
        confidence: number;
        summary: string;
        content: string;
        useCount: number;
        lastUsedAt?: string;
        updatedAt?: string;
    }>;
    language: string;
}

interface SummaryOutput {
    summary: {
        headline: string;
        recap: string;
        highlights: string[];
    };
    actions: StreamSummaryMemoryAction[];
}

interface GenerateStreamSummaryDecisionResult {
    error: boolean;
    message?: string;
    output?: SummaryOutput;
    model?: string;
    usedFallback?: boolean;
}

interface LeanPersonalityDocument {
    profiles?: Array<{
        profileID?: string;
        personaMode?: string;
        tonePreset?: string;
        personality?: string;
    }>;
    activeProfileId?: string;
    personaMode?: string;
    tonePreset?: string;
    personality?: string;
}

interface OpenRouterChoice {
    message?: {
        content?: string;
    };
}

interface OpenRouterUsage {
    completion_tokens?: number;
    completion_tokens_details?: {
        audio_tokens?: number;
        image_tokens?: number;
        reasoning_tokens?: number;
    };
    cost?: number;
    cost_details?: {
        upstream_inference_completions_cost?: number;
        upstream_inference_cost?: number;
        upstream_inference_prompt_cost?: number;
    };
    is_byok?: boolean;
    prompt_tokens?: number;
    prompt_tokens_details?: {
        audio_tokens?: number;
        cache_write_tokens?: number;
        cached_tokens?: number;
        video_tokens?: number;
    };
    total_tokens?: number;
}

interface OpenRouterResponse {
    error?: {
        message?: string;
    };
    message?: string;
    choices?: OpenRouterChoice[];
    usage?: OpenRouterUsage;
}

function normalizeText(value: unknown): string {
    return String(value || '').trim();
}

function selectBackgroundModel(planTier: string | undefined): string {
    if (planTier === 'pro') {
        return BACKGROUND_MODELS.pro;
    }
    if (planTier === 'premium') {
        return BACKGROUND_MODELS.premium;
    }
    return BACKGROUND_MODELS.free;
}

function fallbackOutput(context: StreamSummaryContext): SummaryOutput {
    const highlights: string[] = [];
    highlights.push(`Stream lasted ${context.session.durationMinutes} minutes with peak ${context.session.peakViewers} viewers.`);

    if (context.session.subs > 0 || context.session.follows > 0 || context.session.bits > 0) {
        highlights.push(`Session gains: ${context.session.subs} subs, ${context.session.follows} follows, ${context.session.bits} bits.`);
    }

    if (context.sampledChatMessages.length > 0) {
        const firstMessage = context.sampledChatMessages[0];
        highlights.push(`Chat sample started with ${firstMessage.username}: ${firstMessage.message.slice(0, 90)}`);
    }

    return {
        summary: {
            headline: `Stream summary for ${context.session.channel || context.channelID}`,
            recap: 'No high-confidence automatic memory actions were generated, but the stream summary was captured successfully.',
            highlights: highlights.slice(0, 4)
        },
        actions: []
    };
}

function extractPersonaInfo(personalityDoc: unknown): {
    mode: string;
    tonePreset: string;
    personality: string;
} {
    const doc = personalityDoc as LeanPersonalityDocument | null | undefined;

    const activeProfile = doc?.profiles?.find(
        (profile) => profile.profileID === doc.activeProfileId
    ) || doc?.profiles?.[0] || null;

    return {
        mode: activeProfile?.personaMode || doc?.personaMode || 'original',
        tonePreset: activeProfile?.tonePreset || doc?.tonePreset || 'balanced',
        personality: activeProfile?.personality || doc?.personality || ''
    };
}

function buildSystemPrompt(
    context: StreamSummaryContext,
    correction?: { previousError: string; previousModel: string }
): string {
    const language = context.language === 'es' ? 'Spanish' : 'English';

    const basePrompt = `You are a stream memory curator.
Your job is to identify and capture valuable knowledge from this stream that should be remembered for future interactions.

OUTPUT FORMAT: Your response must validate against the JSON schema provided via response_format.json_schema. The schema requires:
- "summary": { "headline": string, "recap": string, "highlights": string[] }
- "actions": array of memory action objects with "action" (one of: create, edit, archive, delete, noop), and contextual fields (type, summary, content, confidence, risk, reason, evidence)

CRITICAL: Generate ALL content (summary, headline, recap, highlights, memory content, summaries) in ${language}.
All text output must be in ${language}.

CRITICAL CONCEPT - What Makes a Valuable Memory:
Memories are facts, jokes, preferences, or lore that help you understand the channel and reference past events naturally in future conversations. A good memory is something YOU would want to know if you joined the channel for the first time, or something the streamer would want their AI to remember about their community.

MEMORY TYPES (use the "type" field with one of these exact strings):
- "channel_lore": Important events, traditions, recurring themes
- "running_joke": Jokes that get referenced repeatedly
- "known_user_fact": Notable facts about specific users
- "preference": Streamer preferences, habits, likes/dislikes
- "boundary": Topics or behaviors to avoid

RISK VALUES (use the "risk" field with one of: "low", "medium", "high").

APPROVED MEMORIES (golden examples):
These are memories the streamer has already confirmed as valuable. Use them as benchmarks for quality and relevance:
${context.existingMemories.length > 0
    ? context.existingMemories.map(m => `- [${m.type}] ${m.summary}: ${m.content}`).join('\n')
    : '(No approved memories yet - be proactive in creating new ones)'}

ARCHIVED MEMORIES (lower priority context):
These are old memories for additional reference. Not all passed review or may be outdated:
${context.archivedMemories.length > 0
    ? context.archivedMemories.map(m => `- [${m.type}] ${m.summary}`).join('\n')
    : '(No archived memories)'}

YOUR TASK:
1. Create memories for genuinely noteworthy moments from this stream
2. Update existing memories if facts changed or evolved
3. Archive memories that are no longer relevant or accurate
4. Delete memories that are clearly wrong (requires very high confidence)

RULES:
- If no approved memories exist: CREATE PROACTIVELY, don't wait for obvious changes - capture anything noteworthy
- If approved memories exist: use them as benchmarks for quality and relevance
- Keep actions HIGH SIGNAL — only propose memories that would genuinely help future conversations
- For create actions: include type, summary, content, confidence (0.5-1.0), risk (low/medium/high), reason, evidence
- For archive/delete: include targetMemoryId, confidence, reason, evidence
- summary.headline: short title under 120 characters
- summary.recap: short paragraph summarizing the stream
- summary.highlights: 2-6 bullet-style strings of key moments
`;

    if (correction) {
        return `${basePrompt}

CORRECTION FROM PREVIOUS ATTEMPT:
Your previous response on model "${correction.previousModel}" failed validation: ${correction.previousError}

You MUST return a JSON object that strictly conforms to the schema. Do NOT include any prose, markdown fences, or commentary before or after the JSON. Output only the JSON object.`;
    }

    return basePrompt;
}

interface AttemptResult {
    ok: boolean;
    response?: OpenRouterResponse;
    error?: string;
}

/**
 * Per-model max output tokens for stream-summary OpenRouter calls.
 *
 * Bumped to 256k on 2026-07-05 for v4 Pro / v4 Flash (premium + pro tiers):
 * v4-pro is a reasoning model that was burning the full output budget on
 * internal reasoning and emitting empty `content` before the JSON body,
 * which surfaced as DECIDER_EMPTY_CONTENT → DECIDER_HTTP_ERROR cascades.
 * 256k gives reasoning + structured output room to complete.
 *
 * v4-flash also benefits at higher values; empirical OpenRouter probe (2026-07-05)
 * shows both 50k and 256k are accepted for v4-flash — OpenRouter auto-routes
 * higher-budget requests to the DeepSeek provider instead of the cheaper
 * third-party hosts.
 *
 * Free tier (qwen/qwen3-235b-a22b-2507) keeps 50,000; bumping to 256k is
 * left for a later change since the affected callers are low-priority and
 * the cost spike on qwen is not currently budgeted.
 *
 * NOTE: deepseek/deepseek-v4-pro is hard-pinned to provider `deepseek` in
 * MODEL_PROVIDER_RESTRICTIONS (constants.ts) — that pin is what gives us
 * the 75% price cut vs deepinfra/fireworks/digitalocean. Do not remove it.
 */
const STREAM_SUMMARY_MAX_TOKENS_BY_MODEL: Readonly<Record<string, number>> = {
    "deepseek/deepseek-v4-pro": 256000,
    "deepseek/deepseek-v4-flash": 256000
};

function resolveMaxTokens(model: string): number {
    return STREAM_SUMMARY_MAX_TOKENS_BY_MODEL[model] ?? 50000;
}

async function callOpenRouter(
    model: string,
    systemPrompt: string,
    userPayload: object,
    context: StreamSummaryContext
): Promise<AttemptResult> {
    try {
        const body: Record<string, unknown> = {
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: JSON.stringify(userPayload) }
            ],
            response_format: {
                type: 'json_schema',
                json_schema: STREAM_SUMMARY_JSON_SCHEMA
            },
            max_tokens: resolveMaxTokens(model),
            user: context.channelID
        };

        // If this model has a pinned upstream provider (e.g. v4 Pro -> deepseek
        // for the 75% price cut), attach `provider.only` to the request body so
        // OpenRouter refuses to route through deepinfra/fireworks/digitalocean.
        // Models without a configured pin (e.g. v4-flash) get free OpenRouter
        // routing, which is what we want for chat and for the fallback path.
        const providerPin = getProviderRestriction(model);
        if (providerPin) {
            body.provider = { only: [...providerPin.only] };
        }

        const response = await fetchStreamSummary('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                'HTTP-Referer': 'https://domdimabot.com',
                'X-Title': 'DomDimaBot'
            },
            body: JSON.stringify(body)
        });

        const payload = await response.json() as OpenRouterResponse;

        if (!response.ok || payload?.error) {
            const errMsg = payload?.error?.message || payload?.message || `OpenRouter HTTP ${response.status}`;
            return { ok: false, error: errMsg };
        }

        return { ok: true, response: payload };
    } catch (err) {
        return {
            ok: false,
            error: err instanceof Error ? err.message : String(err)
        };
    }
}

interface AttemptLog {
    model: string;
    tryIndex: number;
    isFallback: boolean;
    phase: 'http_error' | 'parse' | 'schema' | 'ok';
    error?: string;
    rawSnippet?: string;
    actionsRaw?: number;
    actionsValid?: number;
}

export async function generateStreamSummaryDecision(
    context: StreamSummaryContext,
    mode: string
): Promise<GenerateStreamSummaryDecisionResult> {
    let streamer: Awaited<ReturnType<typeof TwitchStreamers.getTwitchAccountById>> = null;
    let personalityDoc: unknown = null;
    let primaryModel = '';
    let personaInfo: { mode: string; tonePreset: string; personality: string } = {
        mode: 'original',
        tonePreset: 'balanced',
        personality: ''
    };

    try {
        streamer = await TwitchStreamers.getTwitchAccountById(context.channelID);
        personalityDoc = await ChannelAIPersonalitySchema.findOne({ channelID: context.channelID }).lean();
        const isProUser = streamer?.plan_tier === 'pro';
        primaryModel = selectBackgroundModel(streamer?.plan_tier);
        personaInfo = extractPersonaInfo(personalityDoc);

        const userPayload = {
            mode,
            channelID: context.channelID,
            session: context.session,
            persona: {
                mode: personaInfo.mode,
                tonePreset: personaInfo.tonePreset,
                personality: personaInfo.personality
            },
            sampledChatMessages: context.sampledChatMessages,
            snapshots: context.snapshots,
            existingMemories: context.existingMemories,
            archivedMemories: context.archivedMemories
        };

        // Build attempt queue:
        //  1. primary model
        //  2. primary model + correction (only if step 1 returned a parseable but invalid response — i.e. a JSON schema deviation, not a network failure)
        //  3. fallback model (only for pro users)
        //  4. fallback model + correction (only for pro users, only if step 3 had a schema deviation)
        const fallbackModel = isProUser ? BACKGROUND_MODEL_FALLBACK : null;
        type AttemptSpec = {
            model: string;
            isFallback: boolean;
            withCorrection: boolean;
            previousError?: string;
        };
        const attemptQueue: AttemptSpec[] = [{ model: primaryModel, isFallback: false, withCorrection: false }];

        // Slot 2: correction retry on primary model — only filled in lazily after we know
        // what kind of failure happened. We handle this by extending the queue inside the loop.

        const attemptLogs: AttemptLog[] = [];
        let lastResponse: OpenRouterResponse | null = null;
        let successfulSanitized: ReturnType<typeof sanitizeStreamSummaryResponse> | null = null;
        let finalModelUsed = primaryModel;
        let usedFallback = false;

        for (let i = 0; i < attemptQueue.length; i++) {
            const spec = attemptQueue[i];
            const systemPrompt = buildSystemPrompt(
                context,
                spec.withCorrection && spec.previousError
                    ? { previousError: spec.previousError, previousModel: spec.model }
                    : undefined
            );

            const result = await callOpenRouter(spec.model, systemPrompt, userPayload, context);

            if (!result.ok || !result.response) {
                // Network / HTTP failure: don't retry with correction — same model would fail again.
                // Just queue the fallback model (if any).
                attemptLogs.push({
                    model: spec.model,
                    tryIndex: i,
                    isFallback: spec.isFallback,
                    phase: 'http_error',
                    error: result.error
                });

                await logWarn({
                    message: '[STREAM DECIDER] OpenRouter call failed',
                    step: 'DECIDER_HTTP_ERROR',
                    channelID: context.channelID,
                    model: spec.model,
                    isFallback: spec.isFallback,
                    error: result.error,
                    attemptIndex: i
                }, { channelId: context.channelID, destination: 'both' });

                if (fallbackModel && !spec.isFallback) {
                    // Try fallback model next (fresh, no correction)
                    attemptQueue.push({ model: fallbackModel, isFallback: true, withCorrection: false });
                }
                continue;
            }

            lastResponse = result.response;
            const rawContent = normalizeText(result.response?.choices?.[0]?.message?.content);

            if (!rawContent) {
                attemptLogs.push({
                    model: spec.model,
                    tryIndex: i,
                    isFallback: spec.isFallback,
                    phase: 'parse',
                    error: 'Empty content from model'
                });

                await logWarn({
                    message: '[STREAM DECIDER] Empty content from model',
                    step: 'DECIDER_EMPTY_CONTENT',
                    channelID: context.channelID,
                    model: spec.model,
                    isFallback: spec.isFallback,
                    attemptIndex: i
                }, { channelId: context.channelID, destination: 'both' });

                if (fallbackModel && !spec.isFallback) {
                    attemptQueue.push({ model: fallbackModel, isFallback: true, withCorrection: false });
                }
                continue;
            }

            const parseResult: StreamSummaryParseResult = parseStreamSummaryResponse(rawContent);

            if (!parseResult.ok) {
                attemptLogs.push({
                    model: spec.model,
                    tryIndex: i,
                    isFallback: spec.isFallback,
                    phase: parseResult.phase === 'json' ? 'parse' : 'schema',
                    error: parseResult.error,
                    rawSnippet: parseResult.rawSnippet
                });

                await logWarn({
                    message: `[STREAM DECIDER] ${parseResult.phase === 'json' ? 'JSON parse' : 'Schema validation'} failed`,
                    step: 'DECIDER_PARSE_FAILED',
                    channelID: context.channelID,
                    model: spec.model,
                    isFallback: spec.isFallback,
                    attemptIndex: i,
                    phase: parseResult.phase,
                    error: parseResult.error,
                    rawSnippet: parseResult.rawSnippet
                }, { channelId: context.channelID, destination: 'both' });

                // Queue the appropriate next step:
                //   - If primary model just failed with a JSON/schema issue AND we haven't retried it yet,
                //     queue a correction retry on the same model.
                //   - Otherwise, if there's a fallback and we haven't used it yet, try it (fresh, no correction).
                if (!spec.isFallback && !spec.withCorrection) {
                    attemptQueue.push({
                        model: spec.model,
                        isFallback: false,
                        withCorrection: true,
                        previousError: parseResult.error
                    });
                } else if (fallbackModel && !spec.isFallback) {
                    attemptQueue.push({ model: fallbackModel, isFallback: true, withCorrection: false });
                } else if (fallbackModel && spec.isFallback && !spec.withCorrection) {
                    attemptQueue.push({
                        model: fallbackModel,
                        isFallback: true,
                        withCorrection: true,
                        previousError: parseResult.error
                    });
                }
                continue;
            }

            // Success — sanitize and use it.
            const sanitized = sanitizeStreamSummaryResponse(parseResult.data, {
                defaultHeadline: `Stream summary for ${context.session.channel || context.channelID}`,
                defaultRecap: 'No stream recap was generated by the model.'
            });

            attemptLogs.push({
                model: spec.model,
                tryIndex: i,
                isFallback: spec.isFallback,
                phase: 'ok',
                actionsRaw: parseResult.data.actions.length,
                actionsValid: sanitized.actions.length
            });

            successfulSanitized = sanitized;
            finalModelUsed = spec.model;
            usedFallback = spec.isFallback;
            break;
        }

        // Track usage for PolarSH regardless of which model succeeded
        if (lastResponse?.usage && streamer?.polar_sh_customer_id) {
            const usageData = lastResponse.usage;
            const actualCost = usageData.cost ||
                ((usageData as any)?.upstream_inference_cost ||
                 ((usageData as any)?.upstream_inference_prompt_cost || 0) +
                 ((usageData as any)?.upstream_inference_completions_cost || 0));

            if (actualCost > 0) {
                const reason = mode === 'stream_offline' ? 'stream_summary'
                    : mode === 'weekly_maintenance' ? 'weekly_summary'
                    : 'monthly_summary';

                try {
                    await ingestPolarSHEvent({
                        customerId: streamer.polar_sh_customer_id,
                        channelID: context.channelID,
                        cost: actualCost,
                        reason,
                        llm: {
                            model: finalModelUsed,
                            usage: usageData as any
                        },
                        mode: 'batch'
                    });
                } catch (err) {
                    // PolarSH tracking is best-effort, don't fail the summary
                    await logWarn({
                        message: '[STREAM DECIDER] Failed to track PolarSH usage',
                        step: 'DECIDER_POLARSH_FAILED',
                        channelID: context.channelID,
                        error: err instanceof Error ? err.message : String(err)
                    }, { channelId: context.channelID, destination: 'both' });
                }
            }
        }

        if (successfulSanitized) {
            // Operator-only diagnostic summary line
            await logDebug({
                message: '[STREAM DECIDER] Decision successful',
                step: 'DECIDER_SUCCESS',
                channelID: context.channelID,
                model: finalModelUsed,
                usedFallback,
                attemptCount: attemptLogs.length,
                actionsValid: successfulSanitized.actions.length,
                highlightsCount: successfulSanitized.summary.highlights.length
            }, { channelId: context.channelID, destination: 'both' });

            return {
                error: false,
                output: {
                    summary: successfulSanitized.summary,
                    actions: successfulSanitized.actions
                },
                model: finalModelUsed,
                usedFallback
            };
        }

        // All attempts exhausted — operator warning
        await logWarn({
            message: '[STREAM DECIDER] All attempts exhausted, returning fallback',
            step: 'DECIDER_FALLBACK',
            channelID: context.channelID,
            attemptCount: attemptLogs.length,
            attempts: attemptLogs
        }, { channelId: context.channelID, destination: 'both' });

        return {
            error: true,
            message: `All decider attempts failed. See logs for details. (Attempts: ${attemptLogs.length})`,
            output: fallbackOutput(context),
            model: finalModelUsed,
            usedFallback
        };
    } catch (error) {
        await logError({
            message: 'Error in generateStreamSummaryDecision',
            step: 'DECIDER_EXCEPTION',
            channelID: context.channelID,
            mode,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        }, { channelId: context.channelID, destination: 'both' });

        return {
            error: true,
            message: 'Failed to generate stream summary decision',
            output: fallbackOutput(context)
        };
    }
}
