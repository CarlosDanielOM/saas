import assert from 'node:assert/strict';
import test from 'node:test';
import { canAdminReplayDomainEvent, evaluateDomainEventDeliveryPolicy } from './domain_event_delivery_policy.js';

const now = Date.UTC(2026, 8, 5);
const policy = { consumer: 'ephemeral', schemaVersions: [1], adminReplay: false, maxEventAgeMs: 300_000 };
const event = { schemaVersion: 1, occurredAt: new Date(now), expiresAt: new Date(now + 90 * 86_400_000) };

test('age eligibility ends exactly at the occurrence-time boundary, not journal/retry time', () => {
    assert.equal(evaluateDomainEventDeliveryPolicy(policy, event, now + 299_999).status, 'eligible');
    assert.deepEqual(evaluateDomainEventDeliveryPolicy(policy, event, now + 300_000), {
        status: 'skipped', reason: 'Event exceeds maxEventAgeMs 300000 for ephemeral'
    });
    assert.equal(evaluateDomainEventDeliveryPolicy(policy, { ...event, occurredAt: new Date(NaN) }, now).status, 'dead');
});

test('incompatible versions are permanent failures even when also stale', () => {
    assert.deepEqual(evaluateDomainEventDeliveryPolicy(policy, { ...event, schemaVersion: 2 }, now + 300_000), {
        status: 'dead', reason: 'Unsupported schema version 2 for ephemeral'
    });
});

test('future provider timestamps cannot extend the ephemeral journal-age horizon', () => {
    const future = { ...event, occurredAt: new Date(now + 90 * 86_400_000), journaledAt: new Date(now) };
    assert.equal(evaluateDomainEventDeliveryPolicy(policy, future, now + 299_999).status, 'eligible');
    assert.equal(evaluateDomainEventDeliveryPolicy(policy, future, now + 300_000).status, 'skipped');
});

test('uncapped consumers preserve retained history and generic engines need no version policy', () => {
    const historical = { ...event, occurredAt: new Date(now - 89 * 86_400_000) };
    assert.equal(evaluateDomainEventDeliveryPolicy({ consumer: 'generic' }, historical, now).status, 'eligible');
    assert.equal(canAdminReplayDomainEvent({ consumer: 'analytics', adminReplay: true }, historical, now), true);
});

test('manual replay is fail-closed for policy, age, compatibility, and journal retention', () => {
    const allowed = { ...policy, adminReplay: true };
    assert.equal(canAdminReplayDomainEvent(undefined, event, now), false);
    assert.equal(canAdminReplayDomainEvent({ consumer: 'unspecified' }, event, now), false);
    assert.equal(canAdminReplayDomainEvent(policy, event, now), false);
    assert.equal(canAdminReplayDomainEvent(allowed, null, now), false);
    assert.equal(canAdminReplayDomainEvent(allowed, { ...event, expiresAt: new Date(now) }, now), false);
    assert.equal(canAdminReplayDomainEvent(allowed, { ...event, expiresAt: new Date(NaN) }, now), false);
    assert.equal(canAdminReplayDomainEvent(allowed, { ...event, schemaVersion: 2 }, now), false);
    assert.equal(canAdminReplayDomainEvent(allowed, event, now + 300_000), false);
    assert.equal(canAdminReplayDomainEvent(allowed, event, now), true);
});
