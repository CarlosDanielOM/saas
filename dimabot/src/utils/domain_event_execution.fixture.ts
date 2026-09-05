// Service-free child used to prove watchdog termination of a blocked event loop.
const consumer = process.argv.find((arg) => arg.startsWith('--consumer='))?.slice('--consumer='.length);
if (consumer === 'blocked') {
    process.send!({
        type: 'claimed', lease: { eventKey: 'fixture', leaseToken: 'fixture', lockedUntil: Date.now() + 10_000 }
    }, () => {
        while (true) { /* Deliberately cannot process timers, IPC, or SIGTERM. */ }
    });
} else if (consumer?.startsWith('lease-')) {
    const { mock } = await import('node:test');
    const { DomainEventSchema } = await import('../schemas/domain_event.schema.js');
    const { DomainEventDeliverySchema } = await import('../schemas/domain_event_delivery.schema.js');
    const { drainDomainEvents } = await import('./domain_event_consumer.js');
    const event = new DomainEventSchema({ eventKey: 'fixture', topic: 'domain' });
    const query = (value: unknown) => ({
        sort() { return this; }, limit() { return this; }, lean: async () => value
    });
    mock.method(DomainEventDeliverySchema, 'find', (() => query([{ eventID: event._id }])) as never);
    mock.method(DomainEventSchema, 'findById', (async () => event) as never);
    mock.method(DomainEventDeliverySchema, 'findOneAndUpdate', ((_: unknown, update: any) => Promise.resolve({
        _id: event._id, attempts: 1, status: update.$setOnInsert ? 'pending' : 'processing', leaseToken: 'fixture'
    })) as never);
    mock.method(DomainEventDeliverySchema, 'updateOne', (async () => {
        if (consumer === 'lease-error') throw new Error('renewal failed');
        return { modifiedCount: 0 };
    }) as never);
    await drainDomainEvents({
        consumer, topics: ['domain'], leaseMs: 6000,
        handler: async () => {
            await new Promise((resolve) => setTimeout(resolve, 2500));
            process.send!({ type: 'obsolete-effect' });
        },
        runtime: { leaseLost: () => process.exit(23) }
    });
    process.exit(2);
} else {
    process.send!({ type: 'drained' }, () => process.exit(0));
}
