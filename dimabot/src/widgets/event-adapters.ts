import { applyWidgetEvent, activeWidgetEventTargets } from './service.js';
import type { WidgetEventAdapter } from './events.js';

// Add future widget adapters here. All use the same durable consumer, regardless of count.
export const dbdWidgetEventAdapter: WidgetEventAdapter = {
  id: 'dbd-challenge',
  eventTypes: ['channel.bits.received'],
  targets: activeWidgetEventTargets,
  apply: (target, event) => applyWidgetEvent(target.id, event)
};

export const WIDGET_EVENT_ADAPTERS: readonly WidgetEventAdapter[] = [dbdWidgetEventAdapter];
