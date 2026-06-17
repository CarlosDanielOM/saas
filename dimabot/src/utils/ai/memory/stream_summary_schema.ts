/**
 * Stream Summary Response Schema
 *
 * Single source of truth for the JSON shape we expect from the LLM when it
 * decides what should go into a stream summary (headline, recap, highlights)
 * and what memory actions to apply (create / edit / archive / delete / noop).
 *
 * This file drives BOTH:
 *   1. The OpenRouter `response_format.json_schema` payload (STREAM_SUMMARY_JSON_SCHEMA)
 *      — what the model is told its output must conform to.
 *   2. The Zod runtime validator (StreamSummaryResponseSchema) — what we
 *      actually accept in our code, with defensive defaults.
 *
 * Keeping them in one file prevents the prompt contract and the runtime
 * contract from drifting apart.
 */
import { z } from 'zod';

export const MEMORY_ACTIONS = ['create', 'edit', 'archive', 'delete', 'noop'] as const;
export const MEMORY_RISKS = ['low', 'medium', 'high'] as const;
export const MEMORY_TYPES = [
    'channel_lore',
    'running_joke',
    'known_user_fact',
    'preference',
    'boundary'
] as const;

export type MemoryActionKind = (typeof MEMORY_ACTIONS)[number];
export type MemoryRiskKind = (typeof MEMORY_RISKS)[number];
export type MemoryTypeKind = (typeof MEMORY_TYPES)[number];

// ----------------------------------------------------------------------------
// Zod schema — used for runtime validation after the model responds.
// Designed to be lenient: missing optional fields get sensible defaults
// (empty string, 0, 'low', []) so the rest of the pipeline can rely on
// every action having a fully-populated shape.
// ----------------------------------------------------------------------------

const MemoryActionZodSchema = z.object({
    action: z.enum(MEMORY_ACTIONS),
    type: z.string().default(''),
    targetMemoryId: z.string().default(''),
    summary: z.string().default(''),
    content: z.string().default(''),
    confidence: z.number().min(0).max(1).default(0),
    risk: z.enum(MEMORY_RISKS).default('low'),
    reason: z.string().default(''),
    evidence: z.array(z.string()).default([])
});

export const StreamSummaryResponseSchema = z.object({
    summary: z.object({
        headline: z.string().min(1).max(120),
        recap: z.string().min(1).max(2000),
        highlights: z.array(z.string().max(500)).max(8)
    }),
    actions: z.array(MemoryActionZodSchema).max(50)
});

export type StreamSummaryResponse = z.infer<typeof StreamSummaryResponseSchema>;
export type StreamSummaryMemoryAction = z.infer<typeof MemoryActionZodSchema>;

// ----------------------------------------------------------------------------
// JSON Schema for OpenRouter — used in `response_format.json_schema`.
// The model is told its output must conform to this. We deliberately
// keep `additionalProperties: false` to prevent surprise extra keys, and
// make every field required-but-nullable so the LLM can use `null` for
// context-dependent fields instead of fabricating empty strings.
//
// We pass `strict: true` so OpenRouter enforces the schema server-side.
// If a particular model rejects `strict: true` (some non-OpenAI models
// proxied through OpenRouter do), set STRICT_MODE = false below.
// ----------------------------------------------------------------------------

export const STRICT_MODE = true;

export const STREAM_SUMMARY_JSON_SCHEMA = {
    name: 'stream_summary_decision',
    strict: STRICT_MODE,
    schema: {
        type: 'object',
        additionalProperties: false,
        required: ['summary', 'actions'],
        properties: {
            summary: {
                type: 'object',
                additionalProperties: false,
                required: ['headline', 'recap', 'highlights'],
                properties: {
                    headline: { type: 'string', maxLength: 120 },
                    recap: { type: 'string', maxLength: 2000 },
                    highlights: {
                        type: 'array',
                        items: { type: 'string', maxLength: 500 },
                        maxItems: 8
                    }
                }
            },
            actions: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: [
                        'action',
                        'type',
                        'targetMemoryId',
                        'summary',
                        'content',
                        'confidence',
                        'risk',
                        'reason',
                        'evidence'
                    ],
                    properties: {
                        action: {
                            type: 'string',
                            enum: [...MEMORY_ACTIONS]
                        },
                        type: {
                            type: 'string',
                            enum: [...MEMORY_TYPES, '']
                        },
                        targetMemoryId: { type: 'string' },
                        summary: { type: 'string' },
                        content: { type: 'string' },
                        confidence: { type: 'number', minimum: 0, maximum: 1 },
                        risk: {
                            type: 'string',
                            enum: [...MEMORY_RISKS]
                        },
                        reason: { type: 'string' },
                        evidence: {
                            type: 'array',
                            items: { type: 'string' }
                        }
                    }
                }
            }
        }
    }
} as const;

// ----------------------------------------------------------------------------
// Parser — strips markdown fences, parses JSON, and validates with Zod.
// Used by the decider after every LLM call. Returns a discriminated union
// so callers can handle parse failures vs validation failures separately.
// ----------------------------------------------------------------------------

export type StreamSummaryParseResult =
    | { ok: true; data: StreamSummaryResponse }
    | { ok: false; error: string; rawSnippet: string; phase: 'empty' | 'json' | 'schema' };

const RAW_SNIPPET_LIMIT = 800;

function stripMarkdownFences(raw: string): string {
    let cleaned = raw.trim();
    if (!cleaned.startsWith('```')) {
        return cleaned;
    }
    // Match ```json or ``` followed by content and a closing ```
    const match = cleaned.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
    if (match && match[1]) {
        return match[1].trim();
    }
    // Fallback: strip leading ``` and trailing ``` if present
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?\s*```\s*$/, '');
    return cleaned.trim();
}

export function parseStreamSummaryResponse(raw: string): StreamSummaryParseResult {
    if (!raw || typeof raw !== 'string') {
        return {
            ok: false,
            error: 'Empty response from LLM',
            rawSnippet: '',
            phase: 'empty'
        };
    }

    const cleaned = stripMarkdownFences(raw);

    if (!cleaned) {
        return {
            ok: false,
            error: 'Response was empty after stripping markdown fences',
            rawSnippet: raw.slice(0, RAW_SNIPPET_LIMIT),
            phase: 'empty'
        };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(cleaned);
    } catch (err) {
        return {
            ok: false,
            error: `JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
            rawSnippet: cleaned.slice(0, RAW_SNIPPET_LIMIT),
            phase: 'json'
        };
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
            ok: false,
            error: 'Response is not a JSON object',
            rawSnippet: cleaned.slice(0, RAW_SNIPPET_LIMIT),
            phase: 'json'
        };
    }

    const result = StreamSummaryResponseSchema.safeParse(parsed);
    if (!result.success) {
        const issues = result.error.issues
            .map((issue) => {
                const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
                return `${path}: ${issue.message}`;
            })
            .join('; ');
        return {
            ok: false,
            error: `Schema validation failed: ${issues}`,
            rawSnippet: cleaned.slice(0, RAW_SNIPPET_LIMIT),
            phase: 'schema'
        };
    }

    return { ok: true, data: result.data };
}

// ----------------------------------------------------------------------------
// Sanitizer — converts a Zod-validated response into the existing
// SummaryOutput shape used downstream. This is a thin pass-through since
// the Zod schema already populates defaults, but it centralizes the
// MAX_ACTIONS cap and the confidence clamp that the runner relies on.
// ----------------------------------------------------------------------------

export const MAX_SUMMARY_ACTIONS = Math.max(5, Number(process.env.STREAM_MEMORY_SUMMARY_MAX_ACTIONS || 24));

export interface SanitizedSummary {
    summary: {
        headline: string;
        recap: string;
        highlights: string[];
    };
    actions: StreamSummaryMemoryAction[];
}

function clampConfidence(value: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.max(0, Math.min(1, value));
}

function normalizeAction(input: StreamSummaryMemoryAction): StreamSummaryMemoryAction {
    return {
        action: input.action,
        type: String(input.type || '').trim(),
        targetMemoryId: String(input.targetMemoryId || '').trim(),
        summary: String(input.summary || '').trim(),
        content: String(input.content || '').trim(),
        confidence: clampConfidence(Number(input.confidence)),
        risk: input.risk,
        reason: String(input.reason || '').trim(),
        evidence: Array.isArray(input.evidence)
            ? input.evidence.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 8)
            : []
    };
}

export function sanitizeStreamSummaryResponse(
    response: StreamSummaryResponse | unknown,
    fallback: { defaultHeadline: string; defaultRecap: string }
): SanitizedSummary {
    // Run the input through Zod so defaults are applied to any missing fields.
    // This makes the sanitizer safe to call on either Zod-parsed data or
    // raw LLM output that hasn't been parsed yet.
    const parsed = StreamSummaryResponseSchema.safeParse(response);
    const data: StreamSummaryResponse = parsed.success
        ? parsed.data
        : (response as StreamSummaryResponse);

    const highlights = (data.summary.highlights || [])
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .slice(0, 8);

    const actions = (data.actions || [])
        .map(normalizeAction)
        .slice(0, MAX_SUMMARY_ACTIONS);

    return {
        summary: {
            headline: String(data.summary.headline || '').trim() || fallback.defaultHeadline,
            recap: String(data.summary.recap || '').trim() || fallback.defaultRecap,
            highlights
        },
        actions
    };
}
