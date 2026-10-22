import { createClient, type RedisClientOptions } from 'redis';
import { DomainEventWakeups, type DomainEventWakeupClient } from '../utils/domain_event_wakeups.js';

export const PET_WAKE = 'pet:runtime:wake:v1';
const MAX_HINT_OWNERS = 64;
interface HintClient extends Omit<DomainEventWakeupClient, 'subscribe'> {
    subscribe(channel: string, listener: (message: string) => void): Promise<unknown>;
}
type ClientFactory = (options: RedisClientOptions) => HintClient;
function adapter(client: HintClient, publish: () => Promise<unknown>, receive: (message: string) => void): DomainEventWakeupClient {
    return { connect: () => client.connect(), publish,
        subscribe: (_channel, listener) => client.subscribe(PET_WAKE, message => { receive(message); listener(); }),
        on: (event, listener) => client.on(event, listener), destroy: () => client.destroy(), unref: () => client.unref?.() };
}
/** Reuse the domain-event hint lifecycle; only the topic and bounded owner batch differ. */
export class PetWakeupPublisher {
    private readonly owners = new Set<string>();
    private readonly wakeups: DomainEventWakeups;
    constructor(create: ClientFactory = createClient) {
        this.wakeups = new DomainEventWakeups({ createClient: options => {
            const client = create(options);
            return adapter(client, () => {
                const owners = [...this.owners]; this.owners.clear();
                return client.publish(PET_WAKE, JSON.stringify(owners));
            }, () => {});
        } });
    }
    notify(ownerId: string): void {
        if (!/^[a-f0-9]{24}$/i.test(ownerId)) return;
        if (this.owners.size < MAX_HINT_OWNERS) this.owners.add(ownerId);
        // No connection creation, network await or provider work on this call stack.
        this.wakeups.publish();
    }
    stop(): void { this.owners.clear(); this.wakeups.stop(); }
}
export function subscribePetWakeups(onOwners: (owners: string[]) => void, create: ClientFactory = createClient) {
    const owners = new Set<string>();
    const wakeups = new DomainEventWakeups({ onWake: () => { const batch = [...owners]; owners.clear(); onOwners(batch); },
        createClient: options => {
            const client = create(options);
            return adapter(client, async () => undefined, message => {
                if (message.length > 4096) return;
                try {
                    const batch: unknown = JSON.parse(message);
                    if (!Array.isArray(batch) || batch.length > MAX_HINT_OWNERS) return;
                    for (const id of batch) if (typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id)) owners.add(id);
                } catch { /* Hints are untrusted and disposable; Mongo remains authoritative. */ }
            });
        } });
    wakeups.start();
    return () => { owners.clear(); wakeups.stop(); };
}
export const petWakeups = new PetWakeupPublisher();
