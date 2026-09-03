import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldRemoveModerator } from './moderation.helpers.js';

test('ban.mod removes moderator status only for a confirmed moderator', () => {
    assert.equal(shouldRemoveModerator({ error: false, isModerator: true }), true);
    assert.equal(shouldRemoveModerator({ error: false, isModerator: false }), false);
});

test('ban.mod does not remove moderator status when the role check fails', () => {
    assert.equal(shouldRemoveModerator({ error: true, isModerator: false }), false);
});
