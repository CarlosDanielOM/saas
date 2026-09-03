import test from 'node:test';
import assert from 'node:assert/strict';

import { getBackgroundSummaryModel } from './constants.js';

test('uses Muse Spark for free weekly and monthly summary maintenance', () => {
    assert.equal(getBackgroundSummaryModel('free', 'weekly_maintenance'), 'meta/muse-spark-1.2-contributor');
    assert.equal(getBackgroundSummaryModel('free', 'monthly_maintenance'), 'meta/muse-spark-1.2-contributor');
});

test('preserves the free model for ordinary stream summaries', () => {
    assert.equal(getBackgroundSummaryModel('free', 'stream_offline'), 'qwen/qwen3-235b-a22b-2507');
});
