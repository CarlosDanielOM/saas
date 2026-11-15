import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import {
    buildMediaAssetSearchPattern,
    buildMediaPlaybackUrl,
    isValidMediaLinkSignature,
    mediaLinkSignature,
    safeEqual,
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

// Signed media links (the secret is read per call).
process.env.SECRET_KEY ??= 'a'.repeat(32);
const A = '65a1b2c3d4e5f60718293a4b', B = '65a1b2c3d4e5f60718293a4c';

test('signature: HMAC-SHA256 over media:<id>, base64url, 22 characters, stable and different per id', () => {
    const expected = createHmac('sha256', process.env.SECRET_KEY!).update(`media:${A}`).digest('base64url').slice(0, 22);
    assert.equal(mediaLinkSignature(A), expected);
    assert.equal(mediaLinkSignature(A), mediaLinkSignature(A));
    assert.notEqual(mediaLinkSignature(A), mediaLinkSignature(B));
    assert.match(mediaLinkSignature(A)!, /^[A-Za-z0-9_-]{22}$/);
});

test('playback URL carries ?k= for string and ObjectId-like ids', () => {
    assert.equal(buildMediaPlaybackUrl(A), `https://api.domdimabot.com/media/${A}?k=${mediaLinkSignature(A)}`);
    assert.equal(buildMediaPlaybackUrl({ toString: () => A } as never), `https://api.domdimabot.com/media/${A}?k=${mediaLinkSignature(A)}`);
});

test('verification: only the exact signature of that id; wrong types, other ids and truncation fail', () => {
    const k = mediaLinkSignature(A)!;
    assert.equal(isValidMediaLinkSignature(A, k), true);
    assert.equal(isValidMediaLinkSignature(B, k), false);
    assert.equal(isValidMediaLinkSignature(A, k.slice(0, 21)), false);
    assert.equal(isValidMediaLinkSignature(A, k + 'x'), false);
    for (const wrong of [undefined, null, '', [k], { k }, 1]) assert.equal(isValidMediaLinkSignature(A, wrong), false, String(wrong));
});

test('constant-time compare helper', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('abc', 'abcd'), false);
    assert.equal(safeEqual('', ''), true);
    assert.equal(safeEqual('é', 'e'), false);
});

test('without SECRET_KEY: unsigned URL, nothing verifies, never throws', () => {
    const saved = process.env.SECRET_KEY;
    delete process.env.SECRET_KEY;
    try {
        assert.equal(mediaLinkSignature(A), null);
        assert.equal(buildMediaPlaybackUrl(A), `https://api.domdimabot.com/media/${A}`);
        assert.equal(isValidMediaLinkSignature(A, 'anything'), false);
    } finally {
        process.env.SECRET_KEY = saved;
    }
});
