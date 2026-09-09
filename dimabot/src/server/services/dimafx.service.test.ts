import assert from 'node:assert/strict';
import test from 'node:test';
import { Types } from 'mongoose';
import {
    normalizeDimafxViewerConfig,
    selectRedeemCandidate,
    type DimafxViewerConfig
} from './dimafx.service.js';

const DEFAULT_CONFIG: DimafxViewerConfig = {
    quickPurchasePriority: 'credits_first',
    quickPurchaseAction: 'use_now'
};

test('viewer config can switch from bits_first back to credits_first', () => {
    const current: DimafxViewerConfig = {
        quickPurchasePriority: 'bits_first',
        quickPurchaseAction: 'save'
    };

    assert.deepEqual(
        normalizeDimafxViewerConfig(
            { quickPurchasePriority: 'credits_first', quickPurchaseAction: 'use_now' },
            current
        ),
        { quickPurchasePriority: 'credits_first', quickPurchaseAction: 'use_now' }
    );
});

test('viewer config keeps current values when incoming fields are missing or invalid', () => {
    const current: DimafxViewerConfig = {
        quickPurchasePriority: 'bits_first',
        quickPurchaseAction: 'save'
    };

    assert.deepEqual(normalizeDimafxViewerConfig({}, current), current);
    assert.deepEqual(
        normalizeDimafxViewerConfig({ quickPurchasePriority: 'cash', quickPurchaseAction: 'gift' }, current),
        current
    );
    assert.deepEqual(
        normalizeDimafxViewerConfig({ quickPurchasePriority: 'bits_first' }, DEFAULT_CONFIG),
        { quickPurchasePriority: 'bits_first', quickPurchaseAction: 'use_now' }
    );
});

test('redeem candidate prefers the newest saved copy and ignores empty rows', () => {
    const itemID = new Types.ObjectId();
    const otherID = new Types.ObjectId();
    const newest = {
        channelExtensionItemID: itemID,
        quantity: 1,
        acquiredAt: new Date('2026-09-08T12:00:00.000Z')
    };
    const older = {
        channelExtensionItemID: itemID,
        quantity: 2,
        acquiredAt: new Date('2026-09-01T12:00:00.000Z')
    };
    const empty = {
        channelExtensionItemID: itemID,
        quantity: 0,
        acquiredAt: new Date('2026-09-09T12:00:00.000Z')
    };
    const otherItem = {
        channelExtensionItemID: otherID,
        quantity: 9,
        acquiredAt: new Date('2026-09-10T12:00:00.000Z')
    };

    assert.equal(
        selectRedeemCandidate([empty, older, otherItem, newest], String(itemID)),
        newest
    );
    assert.equal(selectRedeemCandidate([empty, otherItem], String(itemID)), null);
});
