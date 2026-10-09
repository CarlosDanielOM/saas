import type { DomainEventEnvelope, DomainEventHandler } from '../domain_events/domain_event.types.js';

export const WIDGET_EVENT_MAX_AGE_MS = 5 * 60_000;

export interface WidgetEventTarget {
  id: string;
  enabled: boolean;
  active: boolean;
  activeSince: number | null;
  allowTestEvents: boolean;
}

/** Adapters own persistence/rules; the shared consumer owns no widget runtime state. */
export interface WidgetEventAdapter {
  id: string;
  eventTypes: readonly string[];
  targets(channelID: string): Promise<readonly WidgetEventTarget[]>;
  // Recheck activation at the atomic state write and persist an event receipt with effects.
  apply(target: WidgetEventTarget, event: DomainEventEnvelope): Promise<void>;
}

export function widgetEventEligible(target: WidgetEventTarget, event: DomainEventEnvelope, now = Date.now()): boolean {
  const occurred = event.occurredAt.getTime(), journaled = event.journaledAt.getTime();
  return target.enabled && target.active && target.activeSince !== null
    && Number.isFinite(target.activeSince) && Number.isFinite(occurred) && Number.isFinite(journaled)
    && Math.min(occurred, journaled) >= target.activeSince
    && now - Math.min(occurred, journaled) <= WIDGET_EVENT_MAX_AGE_MS
    && (event.source === 'twitch-eventsub' || event.source === 'twitch-eventsub-test' && target.allowTestEvents);
}

export function createWidgetEventHandler(adapters: readonly WidgetEventAdapter[]): DomainEventHandler {
  // Copy registration once; no connections, channel caches, or per-widget processes.
  const registered = [...adapters];
  if (new Set(registered.map(adapter => adapter.id)).size !== registered.length) throw new Error('Duplicate widget adapter ID');
  return async event => {
    if (event.topic !== 'channel' || event.schemaVersion !== 1 || !event.channelID
      || !['twitch-eventsub', 'twitch-eventsub-test'].includes(event.source)) return;
    const errors: unknown[] = [];
    for (const adapter of registered) {
      if (!adapter.eventTypes.includes(event.type)) continue;
      try {
        const targets = await adapter.targets(event.channelID);
        for (const target of targets) {
          if (!widgetEventEligible(target, event)) continue;
          try { await adapter.apply(target, event); }
          catch (error) { errors.push(error); }
        }
      } catch (error) { errors.push(error); }
    }
    // One unavailable widget must not starve other widgets. Successful effects dedupe on retry.
    if (errors.length) throw new AggregateError(errors, 'Widget event effects failed');
  };
}

export async function applyWidgetDomainEvent(event: DomainEventEnvelope): Promise<void> {
  const { WIDGET_EVENT_ADAPTERS } = await import('./event-adapters.js');
  await createWidgetEventHandler(WIDGET_EVENT_ADAPTERS)(event);
}
