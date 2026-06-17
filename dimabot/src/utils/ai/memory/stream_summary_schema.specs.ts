/**
 * Unit tests for stream_summary_schema.ts
 *
 * Run with: npx tsx src/utils/ai/memory/stream_summary_schema.specs.ts
 * (excluded from tsc by tsconfig.json via the star-star-slash specs.ts pattern)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    STREAM_SUMMARY_JSON_SCHEMA,
    parseStreamSummaryResponse,
    sanitizeStreamSummaryResponse,
    type StreamSummaryResponse
} from './stream_summary_schema.js';

const validResponse: StreamSummaryResponse = {
    summary: {
        headline: 'Stream summary for test_channel',
        recap: 'A great stream with lots of chat engagement.',
        highlights: [
            'First highlight of the stream',
            'Second highlight with details',
            'Third highlight with a longer description that should still be allowed'
        ]
    },
    actions: [
        {
            action: 'create',
            type: 'channel_lore',
            targetMemoryId: '',
            summary: 'New running joke',
            content: 'Chat always responds with KEKW when streamer dies',
            confidence: 0.85,
            risk: 'low',
            reason: 'Repeated 3+ times in sampled chat',
            evidence: ['msg1', 'msg2', 'msg3']
        },
        {
            action: 'archive',
            type: 'preference',
            targetMemoryId: 'mem_abc123',
            summary: '',
            content: '',
            confidence: 0.9,
            risk: 'low',
            reason: 'Outdated preference',
            evidence: []
        }
    ]
};

describe('parseStreamSummaryResponse', () => {
    it('accepts a well-formed response', () => {
        const raw = JSON.stringify(validResponse);
        const result = parseStreamSummaryResponse(raw);
        assert.equal(result.ok, true);
        if (result.ok) {
            assert.equal(result.data.summary.headline, validResponse.summary.headline);
            assert.equal(result.data.actions.length, 2);
            assert.equal(result.data.actions[0].action, 'create');
            assert.equal(result.data.actions[1].action, 'archive');
        }
    });

    it('strips markdown fences', () => {
        const raw = '```json\n' + JSON.stringify(validResponse) + '\n```';
        const result = parseStreamSummaryResponse(raw);
        assert.equal(result.ok, true);
    });

    it('strips bare ``` fences (no language tag)', () => {
        const raw = '```\n' + JSON.stringify(validResponse) + '\n```';
        const result = parseStreamSummaryResponse(raw);
        assert.equal(result.ok, true);
    });

    it('rejects empty input', () => {
        const result = parseStreamSummaryResponse('');
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.phase, 'empty');
        }
    });

    it('rejects non-string input', () => {
        const result = parseStreamSummaryResponse(null as unknown as string);
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.phase, 'empty');
        }
    });

    it('rejects malformed JSON', () => {
        const result = parseStreamSummaryResponse('{ "summary": { "headline":');
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.phase, 'json');
            assert.ok(result.rawSnippet.length > 0);
        }
    });

    it('rejects a JSON array (not an object)', () => {
        const result = parseStreamSummaryResponse('[]');
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.phase, 'json');
        }
    });

    it('rejects wrong action enum', () => {
        const bad = {
            ...validResponse,
            actions: [{ action: 'Create', type: 'channel_lore', confidence: 0.8, risk: 'low' }]
        };
        const result = parseStreamSummaryResponse(JSON.stringify(bad));
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.phase, 'schema');
            assert.match(result.error, /action/);
        }
    });

    it('rejects unknown action value', () => {
        const bad = {
            ...validResponse,
            actions: [{ action: 'merge', type: 'channel_lore', confidence: 0.8, risk: 'low' }]
        };
        const result = parseStreamSummaryResponse(JSON.stringify(bad));
        assert.equal(result.ok, false);
    });

    it('rejects missing summary key', () => {
        const bad = { actions: [] };
        const result = parseStreamSummaryResponse(JSON.stringify(bad));
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.phase, 'schema');
        }
    });

    it('rejects confidence > 1', () => {
        const bad = {
            ...validResponse,
            actions: [{ action: 'create', type: 'channel_lore', confidence: 1.5, risk: 'low' }]
        };
        const result = parseStreamSummaryResponse(JSON.stringify(bad));
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.phase, 'schema');
        }
    });

    it('rejects confidence < 0', () => {
        const bad = {
            ...validResponse,
            actions: [{ action: 'create', type: 'channel_lore', confidence: -0.5, risk: 'low' }]
        };
        const result = parseStreamSummaryResponse(JSON.stringify(bad));
        assert.equal(result.ok, false);
    });

    it('rejects bad risk enum', () => {
        const bad = {
            ...validResponse,
            actions: [{ action: 'create', type: 'channel_lore', confidence: 0.8, risk: 'extreme' }]
        };
        const result = parseStreamSummaryResponse(JSON.stringify(bad));
        assert.equal(result.ok, false);
    });

    it('rejects non-string headline', () => {
        const bad = {
            ...validResponse,
            summary: { ...validResponse.summary, headline: 12345 }
        };
        const result = parseStreamSummaryResponse(JSON.stringify(bad));
        assert.equal(result.ok, false);
    });

    it('rejects empty headline', () => {
        const bad = {
            ...validResponse,
            summary: { ...validResponse.summary, headline: '' }
        };
        const result = parseStreamSummaryResponse(JSON.stringify(bad));
        assert.equal(result.ok, false);
    });

    it('accepts minimal valid response (no actions)', () => {
        const minimal = {
            summary: {
                headline: 'OK',
                recap: 'A recap.',
                highlights: []
            },
            actions: []
        };
        const result = parseStreamSummaryResponse(JSON.stringify(minimal));
        assert.equal(result.ok, true);
    });
});

describe('sanitizeStreamSummaryResponse', () => {
    it('fills in defaults for missing optional fields', () => {
        const minimal: StreamSummaryResponse = {
            summary: {
                headline: 'Headline here',
                recap: 'Recap here',
                highlights: ['h1']
            },
            actions: [
                // @ts-expect-error - intentionally missing optional fields to test defaults
                { action: 'create' }
            ]
        };
        const sanitized = sanitizeStreamSummaryResponse(minimal, {
            defaultHeadline: 'FALLBACK',
            defaultRecap: 'FALLBACK RECAP'
        });
        assert.equal(sanitized.actions.length, 1);
        const action = sanitized.actions[0];
        assert.equal(action.action, 'create');
        assert.equal(action.type, '');
        assert.equal(action.targetMemoryId, '');
        assert.equal(action.summary, '');
        assert.equal(action.content, '');
        assert.equal(action.confidence, 0);
        assert.equal(action.risk, 'low');
        assert.equal(action.reason, '');
        assert.deepEqual(action.evidence, []);
    });

    it('clamps out-of-range confidence', () => {
        const r: StreamSummaryResponse = {
            summary: { headline: 'H', recap: 'R', highlights: [] },
            actions: [
                { action: 'create', type: '', confidence: 5, risk: 'low' } as any,
                { action: 'create', type: '', confidence: -2, risk: 'low' } as any
            ]
        };
        const sanitized = sanitizeStreamSummaryResponse(r, { defaultHeadline: 'X', defaultRecap: 'Y' });
        assert.equal(sanitized.actions[0].confidence, 1);
        assert.equal(sanitized.actions[1].confidence, 0);
    });

    it('caps highlights at 8 and drops empty', () => {
        const r: StreamSummaryResponse = {
            summary: {
                headline: 'H',
                recap: 'R',
                highlights: ['a', '', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k']
            },
            actions: []
        };
        const sanitized = sanitizeStreamSummaryResponse(r, { defaultHeadline: 'X', defaultRecap: 'Y' });
        assert.equal(sanitized.summary.highlights.length, 8);
        assert.ok(!sanitized.summary.highlights.includes(''));
    });

    it('falls back to defaults when summary fields are empty', () => {
        const r: StreamSummaryResponse = {
            summary: { headline: '', recap: '', highlights: [] },
            actions: []
        };
        const sanitized = sanitizeStreamSummaryResponse(r, {
            defaultHeadline: 'FB HEADLINE',
            defaultRecap: 'FB RECAP'
        });
        assert.equal(sanitized.summary.headline, 'FB HEADLINE');
        assert.equal(sanitized.summary.recap, 'FB RECAP');
    });
});

describe('STREAM_SUMMARY_JSON_SCHEMA', () => {
    it('declares the expected top-level shape', () => {
        const schema = STREAM_SUMMARY_JSON_SCHEMA.schema as { type: string; required: string[] };
        assert.equal(schema.type, 'object');
        assert.deepEqual(schema.required.sort(), ['actions', 'summary']);
    });

    it('uses strict mode', () => {
        assert.equal(STREAM_SUMMARY_JSON_SCHEMA.strict, true);
    });

    it('constrains the action enum', () => {
        const actionSchema = (STREAM_SUMMARY_JSON_SCHEMA.schema as any).properties.actions.items.properties.action;
        assert.deepEqual(actionSchema.enum.sort(), ['archive', 'create', 'delete', 'edit', 'noop']);
    });
});
