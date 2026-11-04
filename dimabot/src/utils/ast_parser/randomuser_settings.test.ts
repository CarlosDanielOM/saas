import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRandomUserBlacklist } from './randomuser_settings.js';

test('randomuser blacklist normalizes and deduplicates Twitch logins', () => {
    assert.deepEqual(normalizeRandomUserBlacklist([' @NightBot ', 'nightbot', 'Some_User']), ['nightbot', 'some_user']);
    assert.deepEqual(normalizeRandomUserBlacklist([]), []);
});

test('randomuser blacklist rejects malformed values and excessive lists', () => {
    for (const value of [null, 'name', [null], [''], ['two words'], ['@'], ['a'.repeat(26)], Array(201).fill('alice')]) {
        assert.equal(normalizeRandomUserBlacklist(value), null);
    }
});
