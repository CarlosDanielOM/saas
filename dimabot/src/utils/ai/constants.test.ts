import test from 'node:test';
import assert from 'node:assert/strict';

import { getBackgroundSummaryModel, selectChatModel } from './constants.js';

test('exhausted chat uses Muse Spark 1.3 Contributor across all plan tiers', () => {
    for (const plan_tier of [undefined, 'free', 'premium', 'pro']) {
        assert.equal(selectChatModel({ plan_tier }, true), 'meta/muse-spark-1.3-contributor');
        assert.equal(selectChatModel({ plan_tier }), 'deepseek/deepseek-v4.1-flash');
    }
});

test('uses Muse Spark for all free stream summaries', () => {
    assert.equal(getBackgroundSummaryModel('free'), 'meta/muse-spark-1.2-contributor');
});

test('uses DeepSeek V4.1 Flash for Pro stream summaries', () => {
    assert.equal(getBackgroundSummaryModel('pro'), 'deepseek/deepseek-v4.1-flash');
});
