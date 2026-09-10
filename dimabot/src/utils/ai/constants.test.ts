import test from 'node:test';
import assert from 'node:assert/strict';

import { getBackgroundSummaryModel } from './constants.js';

test('uses Muse Spark for all free stream summaries', () => {
    assert.equal(getBackgroundSummaryModel('free'), 'meta/muse-spark-1.2-contributor');
});

test('uses DeepSeek V4.1 Flash for Pro stream summaries', () => {
    assert.equal(getBackgroundSummaryModel('pro'), 'deepseek/deepseek-v4.1-flash');
});
