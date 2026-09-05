import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Types } from 'mongoose';
import UsersSchema from '../schemas/users.schema.js';
import type { DomainEventSubject } from './domain_event.types.js';
import { resolveDomainEventOwner } from './domain_event_identity.js';

const ownerId = new Types.ObjectId('0123456789abcdef01234567');
const customer: DomainEventSubject = { provider: 'polar', kind: 'customer', id: 'customer-1' };

function mockQuery(t: TestContext, method: 'findOne' | 'findById', result: unknown) {
    const lean = t.mock.fn(async () => result);
    const select = t.mock.fn((_projection: string) => ({ lean }));
    const query = t.mock.method(UsersSchema, method, (() => ({ select })) as unknown as typeof UsersSchema[typeof method]);
    return { query, select, lean };
}

test('streaming accounts match provider and ID in one element and return the canonical user ID', async (t) => {
    const { query, select, lean } = mockQuery(t, 'findOne', { _id: ownerId });
    const byId = mockQuery(t, 'findById', null);
    const subject: DomainEventSubject = { provider: 'twitch', kind: 'streaming-account', id: 'channel-1' };

    assert.equal(await resolveDomainEventOwner(subject, ownerId.toString()), ownerId.toString());
    assert.deepEqual(query.mock.calls[0].arguments, [{
        accounts: { $elemMatch: { type: 'twitch', id: 'channel-1' } }
    }]);
    assert.deepEqual(select.mock.calls[0].arguments, ['_id']);
    assert.equal(lean.mock.callCount(), 1);
    assert.equal(byId.query.mock.callCount(), 0);
});

test('unlinked streaming accounts do not fall back to an external user ID', async (t) => {
    mockQuery(t, 'findOne', null);
    const byId = mockQuery(t, 'findById', { _id: ownerId });

    assert.equal(await resolveDomainEventOwner({
        provider: 'youtube', kind: 'streaming-account', id: 'channel-1'
    }, ownerId.toString()), undefined);
    assert.equal(byId.query.mock.callCount(), 0);
});

test('Polar customer links take precedence over external owner IDs', async (t) => {
    const { query, select } = mockQuery(t, 'findOne', { _id: ownerId });
    const byId = mockQuery(t, 'findById', null);

    assert.equal(await resolveDomainEventOwner(customer, 'abcdef0123456789abcdef01'), ownerId.toString());
    assert.deepEqual(query.mock.calls[0].arguments, [{ polar_sh_customer_id: customer.id }]);
    assert.deepEqual(select.mock.calls[0].arguments, ['_id']);
    assert.equal(byId.query.mock.callCount(), 0);
});

for (const link of [undefined, null, '', customer.id]) {
    test(`Polar external owner fallback accepts an existing user with link ${String(link)}`, async (t) => {
        mockQuery(t, 'findOne', null);
        const user = link === undefined ? { _id: ownerId } : { _id: ownerId, polar_sh_customer_id: link };
        const { query, select, lean } = mockQuery(t, 'findById', user);
        const externalOwnerId = ownerId.toString().toUpperCase();

        assert.equal(await resolveDomainEventOwner(customer, externalOwnerId), ownerId.toString());
        assert.deepEqual(query.mock.calls[0].arguments, [externalOwnerId]);
        assert.deepEqual(select.mock.calls[0].arguments, ['_id polar_sh_customer_id']);
        assert.equal(lean.mock.callCount(), 1);
    });
}

test('Polar external owner fallback cannot cross another customer', async (t) => {
    mockQuery(t, 'findOne', null);
    mockQuery(t, 'findById', { _id: ownerId, polar_sh_customer_id: 'another-customer' });

    assert.equal(await resolveDomainEventOwner(customer, ownerId.toString()), undefined);
});

test('Polar external owner fallback requires an existing user', async (t) => {
    mockQuery(t, 'findOne', null);
    mockQuery(t, 'findById', null);

    assert.equal(await resolveDomainEventOwner(customer, ownerId.toString()), undefined);
});

test('missing and invalid external owner IDs never query by ID', async (t) => {
    mockQuery(t, 'findOne', null);
    const { query } = mockQuery(t, 'findById', { _id: ownerId });

    for (const id of [undefined, '', 'channel-1', '123456789012', 'g'.repeat(24), `${ownerId} `]) {
        assert.equal(await resolveDomainEventOwner(customer, id), undefined);
    }
    assert.equal(query.mock.callCount(), 0);
});

test('unsupported integrations and customer providers remain unresolved without querying users', async (t) => {
    const findOne = mockQuery(t, 'findOne', { _id: ownerId });
    const findById = mockQuery(t, 'findById', { _id: ownerId });
    const subjects: DomainEventSubject[] = [
        { provider: 'streamlabs', kind: 'integration-account', id: 'channel-1' },
        { provider: 'twitch', kind: 'integration-account', id: 'channel-1' },
        { provider: 'polar', kind: 'integration-account', id: customer.id },
        { provider: 'future-provider', kind: 'customer', id: customer.id }
    ];

    for (const subject of subjects) {
        assert.equal(await resolveDomainEventOwner(subject, ownerId.toString()), undefined);
    }
    assert.equal(findOne.query.mock.callCount(), 0);
    assert.equal(findById.query.mock.callCount(), 0);
});
