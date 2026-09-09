import assert from 'node:assert/strict';
import test from 'node:test';

import {
    getDefaultMediaScope,
    getMediaQuotaChargeBytes,
    getPlanStorageQuotaBytes,
    getPlanUploadLimitBytes
} from './media_library.service.js';

test('free plan has no private storage and forces uploads public', () => {
    assert.equal(getPlanStorageQuotaBytes('free'), 0);
    assert.equal(getPlanUploadLimitBytes('free'), 5 * 1024 * 1024);
    assert.equal(getDefaultMediaScope('free', 'private'), 'public');
});

test('public media never consumes private storage quota', () => {
    assert.equal(getMediaQuotaChargeBytes('public', 5 * 1024 * 1024), 0);
    assert.equal(getMediaQuotaChargeBytes('system', 256 * 1024), 0);
});

test('private media consumes its non-negative byte size', () => {
    assert.equal(getMediaQuotaChargeBytes('private', 25 * 1024 * 1024), 25 * 1024 * 1024);
    assert.equal(getMediaQuotaChargeBytes('private', -1), 0);
});

test('paid plans retain their private storage allowances', () => {
    assert.equal(getPlanStorageQuotaBytes('premium'), 250 * 1024 * 1024);
    assert.equal(getPlanStorageQuotaBytes('pro'), 1024 * 1024 * 1024);
});
