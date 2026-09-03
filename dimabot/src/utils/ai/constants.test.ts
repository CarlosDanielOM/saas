import test from 'node:test';
import assert from 'node:assert/strict';

import { getBackgroundSummaryModel } from './constants.js';

test('uses Muse Spark for all free stream summaries', () => {
    assert.equal(getBackgroundSummaryModel('free'), 'meta/muse-spark-1.2-contributor');
});
