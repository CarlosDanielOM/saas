import type { DomainEventOwnerResolver, DomainEventProducer, JournalDomainEventInput, JournalDomainEventResult } from './domain_event.types.js';
import { twitchEventsubProducer } from './twitch_eventsub_events.js';
import { polarWebhookProducer } from './polar_events.js';
import { journalDomainEvent } from '../utils/domain_events.js';

export const DOMAIN_EVENT_PRODUCERS = {
    twitch: twitchEventsubProducer,
    polar: polarWebhookProducer
} as const;

export async function ingestDomainEvent<Input>(
    producer: DomainEventProducer<Input>,
    input: Input,
    dependencies: {
        journal?: (event: JournalDomainEventInput) => Promise<JournalDomainEventResult>;
        resolveOwner?: DomainEventOwnerResolver;
    } = {}
): Promise<JournalDomainEventResult | null> {
    const event = producer.normalize(input);
    if (!event) return null;
    if (!event.subject || event.subject.provider !== producer.provider) {
        throw new Error(`Producer ${producer.provider} must supply its own provider subject`);
    }
    const resolvedOwner = await (dependencies.resolveOwner || producer.resolveOwner)?.(event);
    if (resolvedOwner !== undefined) event.ownerUserId = resolvedOwner;
    // Unresolved ownership is retained; consumers can resolve it on a later attempt.
    return (dependencies.journal || journalDomainEvent)(event);
}
