import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildMediaAssetSearchPattern,
    getDefaultMediaScope,
    getMediaQuotaChargeBytes,
    getPlanStorageQuotaBytes,
    getPlanUploadLimitBytes
} from './media_library.service.js';

test('public asset search accepts displayed spaces and accents while escaping regex syntax', () => {
    const name = new RegExp(buildMediaAssetSearchPattern('mejor país de chile'), 'i');
    assert.match('Mejor_Pais_de_Chile', name);
    assert.match('Mejor País de Chile', name);
    assert.doesNotMatch('Mejor_Pais_del_Chile', name);
    assert.match('cdom.*', new RegExp(buildMediaAssetSearchPattern('cdom.*'), 'i'));
    assert.doesNotMatch('cdom123', new RegExp(buildMediaAssetSearchPattern('cdom.*'), 'i'));
});

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
