import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

process.env.SECRET_KEY ??= 'a'.repeat(32);
const ITEM = '1'.repeat(24), ITEM_ASSET = '2'.repeat(24), OWN_ASSET = '3'.repeat(24);
const state: { items: Array<Record<string, unknown>>; assets: Array<Record<string, unknown>>; queries: Array<[string, Record<string, unknown>]> } = { items: [], assets: [], queries: [] };
const matches = (doc: Record<string, unknown>, filter: Record<string, unknown>) => Object.entries(filter).every(([key, value]) => String(doc[key] ?? null) === String(value));
const model = (name: string, rows: () => Array<Record<string, unknown>>) => ({
    findOne: (filter: Record<string, unknown>) => { state.queries.push([name, filter]); return { lean: async () => rows().find(row => matches(row, filter)) ?? null }; }
});
mock.module('../../schemas/user_media_library_item.schema.js', { namedExports: { UserMediaLibraryItemSchema: model('item', () => state.items) } });
mock.module('../../schemas/media_asset.schema.js', { namedExports: { MediaAssetSchema: model('asset', () => state.assets) } });

const { resolveTriggerPlaybackAsset } = await import('./resolve_trigger_file.trigger.js');
const { buildMediaPlaybackUrl } = await import('../../server/services/media_library.service.js');

test.beforeEach(() => {
    state.items = [{ _id: ITEM, channelID: 'chan', assetID: ITEM_ASSET, isActive: true, deletedAt: null }];
    state.assets = [{ _id: ITEM_ASSET, mimeType: 'video/mp4', deletedAt: null }, { _id: OWN_ASSET, mimeType: 'audio/mpeg', deletedAt: null }];
    state.queries = [];
});

test('library item first: its asset, a signed playback URL and its MIME type', async () => {
    const file = await resolveTriggerPlaybackAsset({ channelID: 'chan', libraryItemID: ITEM, assetID: OWN_ASSET });
    assert.deepEqual(file, { fileUrl: buildMediaPlaybackUrl(ITEM_ASSET), fileType: 'video/mp4' });
    assert.match(file!.fileUrl, /\/media\/2{24}\?k=[A-Za-z0-9_-]{22}$/);
    assert.deepEqual(state.queries[0], ['item', { _id: ITEM, channelID: 'chan', isActive: true, deletedAt: null }], 'the item must belong to the trigger channel');
});

test('falls back to the trigger asset when the item is foreign, inactive or its asset is deleted', async () => {
    assert.equal((await resolveTriggerPlaybackAsset({ channelID: 'other', libraryItemID: ITEM, assetID: OWN_ASSET }))?.fileType, 'audio/mpeg');
    state.items[0].isActive = false;
    assert.equal((await resolveTriggerPlaybackAsset({ channelID: 'chan', libraryItemID: ITEM, assetID: OWN_ASSET }))?.fileType, 'audio/mpeg');
    state.items[0].isActive = true; state.assets[0].deletedAt = new Date(0);
    assert.deepEqual(await resolveTriggerPlaybackAsset({ channelID: 'chan', libraryItemID: ITEM, assetID: OWN_ASSET }), { fileUrl: buildMediaPlaybackUrl(OWN_ASSET), fileType: 'audio/mpeg' });
});

test('legacy triggers without a resolvable asset resolve to null', async () => {
    assert.equal(await resolveTriggerPlaybackAsset({ channelID: 'chan' }), null);
    assert.equal(state.queries.length, 0, 'nothing to look up');
    state.assets = [];
    assert.equal(await resolveTriggerPlaybackAsset({ channelID: 'chan', libraryItemID: ITEM, assetID: OWN_ASSET }), null);
});
