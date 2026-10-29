import assert from 'node:assert/strict';
import test from 'node:test';
import { existingChannelModerationView, isUntouchedLazyStub, planModerationSeed } from './seed_plan.js';

test('untouched GET stub is the empty disabled version-1 document', () => {
    assert.equal(isUntouchedLazyStub({ enabled: false, rules: [], settingsVersion: 1 }), true);
    assert.equal(isUntouchedLazyStub({ enabled: false, rules: undefined, settingsVersion: 1 }), true);
    assert.equal(isUntouchedLazyStub({ enabled: false, rules: [], settingsVersion: null }), true);
});

test('configured or user-saved documents are not stubs', () => {
    assert.equal(isUntouchedLazyStub(null), false);
    assert.equal(isUntouchedLazyStub({ enabled: true, rules: [], settingsVersion: 1 }), false);
    assert.equal(isUntouchedLazyStub({ enabled: false, rules: [{ type: 'caps' }], settingsVersion: 1 }), false);
    assert.equal(isUntouchedLazyStub({ enabled: false, rules: [], settingsVersion: 2 }), false);
});

test('seed plan: missing document is created, GET stub is replaced, user saves are kept', () => {
    assert.equal(planModerationSeed(null), 'create');
    assert.equal(planModerationSeed({ enabled: false, rules: [], settingsVersion: 1 }), 'replace-stub');
    assert.equal(planModerationSeed({ enabled: true, rules: [{ type: 'caps' }], settingsVersion: 1 }), 'keep');
    assert.equal(planModerationSeed({ enabled: false, rules: [], settingsVersion: 2 }), 'keep');
});

test('existing-channel GET view is disabled with no rules and does not invent a document id', () => {
    const view = existingChannelModerationView('ch1', 'streamer');
    assert.equal(view.enabled, false);
    assert.deepEqual(view.rules, []);
    assert.equal(view.channelID, 'ch1');
    assert.equal(view.settingsVersion, 1);
});
