import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeEditors } from './editor_list.js';

test('normalizes each Helix editor exactly once', () => {
    const editors = normalizeEditors([
        { user_id: '1', user_login: 'first', user_name: 'FirstEditor' },
        { user_id: '2', user_login: 'second', user_name: 'SecondEditor' }
    ]);

    assert.deepEqual(editors, [
        { user_id: '1', user_login: 'firsteditor', user_name: 'FirstEditor' },
        { user_id: '2', user_login: 'secondeditor', user_name: 'SecondEditor' }
    ]);
});
