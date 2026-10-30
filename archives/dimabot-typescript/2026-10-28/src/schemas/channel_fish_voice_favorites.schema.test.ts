import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import {
    ChannelFishVoiceFavoritesSchema,
    FavoriteAliasError,
    normalizeFavoriteAlias,
    renameFishVoiceFavorite,
    type FishVoiceFavorite
} from './channel_fish_voice_favorites.schema.js';
import { ChannelTtsSettingsSchema } from './channel_tts_settings.schema.js';

const voiceID = 'a'.repeat(32);
const otherID = 'b'.repeat(32);

test('nicknames are normalized and reject invalid or reserved names', () => {
    assert.equal(normalizeFavoriteAlias(' Bill '), 'bill');
    for (const value of ['', 'bill cypher', '_bill', 'a'.repeat(41), 'gojo', 'RIAS_GREMORY', 3]) {
        assert.throws(() => normalizeFavoriteAlias(value), FavoriteAliasError);
    }
});

test('renaming keeps the voice name and pins a legacy default to its stable ID', async t => {
    const favorites: FishVoiceFavorite[] = [
        { id: voiceID, name: 'Bill Cypher', alias: 'bill_cypher' },
        { id: otherID, name: 'Other Voice', alias: 'other_voice' }
    ];
    const settingsUpdates: unknown[][] = [];
    const find = mock.method(ChannelFishVoiceFavoritesSchema, 'findOne', () => ({ lean: async () => ({ favorites }) }) as never);
    const update = mock.method(ChannelFishVoiceFavoritesSchema, 'findOneAndUpdate', (filter: any, change: any, options: any) => ({
        lean: async () => {
            assert.equal(filter.channelID, 'channel');
            assert.equal(filter['favorites.id'], voiceID);
            assert.deepEqual(options.arrayFilters, [{ 'target.id': voiceID }]);
            const alias = change.$set['favorites.$[target].alias'];
            if (favorites.some(item => item.alias === alias)) return null;
            favorites[0].alias = alias;
            return { favorites };
        }
    }) as never);
    const settings = mock.method(ChannelTtsSettingsSchema, 'updateOne', async (...args: unknown[]) => { settingsUpdates.push(args); return {} as never; });
    t.after(() => { find.mock.restore(); update.mock.restore(); settings.mock.restore(); });

    const renamed = await renameFishVoiceFavorite('channel', voiceID, 'Bill');
    assert.deepEqual(renamed, { id: voiceID, name: 'Bill Cypher', alias: 'bill' });
    assert.deepEqual(settingsUpdates[0], [
        { channelID: 'channel', 'voices.cloneDefault': 'bill_cypher' },
        { $set: { 'voices.cloneDefault': voiceID } }
    ]);

    await assert.rejects(renameFishVoiceFavorite('channel', voiceID, 'other_voice'),
        (error: unknown) => error instanceof FavoriteAliasError && error.code === 'alias_taken');
    assert.equal(favorites[0].alias, 'bill');
});
