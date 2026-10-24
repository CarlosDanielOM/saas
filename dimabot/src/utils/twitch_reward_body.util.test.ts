import assert from 'node:assert/strict';
import test from 'node:test';
import {
    MAX_GLOBAL_COOLDOWN_SECONDS,
    isTwitchOnlyRewardUpdate,
    toTwitchRewardBody,
    validateRewardSettings
} from './twitch_reward_body.util.js';

test('maps limits to Twitch fields and turns them off with 0', () => {
    assert.deepEqual(toTwitchRewardBody({ maxPerStream: 10, maxPerUserPerStream: 2 }), {
        is_max_per_stream_enabled: true,
        max_per_stream: 10,
        is_max_per_user_per_stream_enabled: true,
        max_per_user_per_stream: 2
    });
    assert.deepEqual(toTwitchRewardBody({ maxPerStream: 0, maxPerUserPerStream: null }), {
        is_max_per_stream_enabled: false,
        is_max_per_user_per_stream_enabled: false
    });
});

test('skip queue can be turned off again', () => {
    assert.deepEqual(toTwitchRewardBody({ skipQueue: false }), { should_redemptions_skip_request_queue: false });
    assert.deepEqual(toTwitchRewardBody({ skipQueue: true }), { should_redemptions_skip_request_queue: true });
});

test('pause is only sent on update', () => {
    assert.deepEqual(toTwitchRewardBody({ isPaused: true }, 'update'), { is_paused: true });
    assert.deepEqual(toTwitchRewardBody({ isPaused: true, title: 'x' }, 'create'), { title: 'x' });
});

test('cooldown, enabled and user input keep their existing mapping', () => {
    assert.deepEqual(toTwitchRewardBody({ cooldown: 300, isEnabled: false, userInput: true, message: 'hi' }), {
        is_global_cooldown_enabled: true,
        global_cooldown_seconds: 300,
        is_enabled: false,
        is_user_input_required: true,
        message: 'hi'
    });
    assert.deepEqual(toTwitchRewardBody({ cooldown: 0 }), { is_global_cooldown_enabled: false, global_cooldown_seconds: 0 });
});

test('validation rejects bad limits and cooldowns', () => {
    assert.equal(validateRewardSettings({ maxPerStream: 5, maxPerUserPerStream: 1, cooldown: 60, isPaused: false }), null);
    assert.equal(validateRewardSettings({ maxPerStream: 0 }), null);
    assert.match(validateRewardSettings({ maxPerStream: -1 }) ?? '', /per stream/);
    assert.match(validateRewardSettings({ maxPerUserPerStream: 1.5 }) ?? '', /per viewer/);
    assert.match(validateRewardSettings({ maxPerStream: '3' }) ?? '', /per stream/);
    assert.match(validateRewardSettings({ cooldown: MAX_GLOBAL_COOLDOWN_SECONDS + 1 }) ?? '', /7 days/);
    assert.match(validateRewardSettings({ isPaused: 'yes' }) ?? '', /isPaused/);
});

test('detects updates that only touch Twitch-side settings', () => {
    assert.equal(isTwitchOnlyRewardUpdate({ isPaused: true }), true);
    assert.equal(isTwitchOnlyRewardUpdate({ maxPerStream: 3, background_color: '#fff' }), true);
    assert.equal(isTwitchOnlyRewardUpdate({ maxPerStream: 3, title: 'x' }), false);
    assert.equal(isTwitchOnlyRewardUpdate({}), false);
});
