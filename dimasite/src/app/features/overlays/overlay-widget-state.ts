import type { InteractionSnapshot } from './overlay-interaction.model';
import type { OverlayWidget } from './overlay.model';
import { type WidgetStates, type WidgetStateSnapshot } from './overlay-widget-contract.generated';
import { OVERLAY_WIDGET_MODULES, widgetModuleFor } from './overlay-widget-registry';

export type WidgetStateMessage = Partial<WidgetStateSnapshot> & { interactions?: InteractionSnapshot };
/** Negotiate once per socket handshake, so an open OBS tab can survive a server rollback. */
export class WidgetStateTransport {
  private generic = false;
  private serverTime = 0;
  begin(message: WidgetStateMessage): void {
    this.generic = Object.hasOwn(message, 'widgetStates');
    this.serverTime = 0;
  }
  reset(): void { this.generic = false; this.serverTime = 0; }
  accept(message: WidgetStateMessage): Partial<WidgetStateSnapshot> & { widgetStates: WidgetStates } | null {
    let states: WidgetStates, serverTime = message.serverTime;
    if (message.widgetStates) { this.generic = true; states = message.widgetStates; }
    else {
      if (this.generic || !message.interactions) return null;
      states = legacyWidgetStates(message.interactions); serverTime = message.interactions.serverTime;
    }
    if (serverTime !== undefined && Number.isFinite(serverTime)) {
      if (serverTime < this.serverTime) return null;
      this.serverTime = serverTime;
    }
    return { widgetStates: states, serverTime, failedSources: message.failedSources };
  }
}

/** Full scoped snapshots remove unavailable keys, while older per-module revisions cannot rewind live state. */
export function acceptWidgetStates(previous: WidgetStates, incoming: WidgetStates, widgets: readonly OverlayWidget[] = [], failedSources: readonly string[] = []): WidgetStates {
  const next: WidgetStates = {};
  for (const [key, entry] of Object.entries(incoming)) {
    if (!entry || !Number.isSafeInteger(entry.revision) || entry.revision < 0 || !Object.hasOwn(entry, 'state')) continue;
    const old = previous[key];
    next[key] = entry.state !== null && old && old.revision > entry.revision ? old : entry;
  }
  // A failed adapter is different from a successful empty snapshot. Preserve only
  // sources still requested by this scene; hidden/removed placements clear as usual.
  for (const widget of widgets) {
    if (!widget.visible) continue;
    const binding = widgetModuleFor(widget, 'scene')?.definition.state;
    if (binding && failedSources.includes(binding.source) && !Object.hasOwn(incoming, binding.stateKey) && previous[binding.stateKey]) next[binding.stateKey] = previous[binding.stateKey];
  }
  return next;
}
/** Compatibility adapter for sources released before the generic scene-state envelope. */
export function legacyWidgetStates(snapshot: InteractionSnapshot): WidgetStates {
  const states = snapshot as unknown as Record<string, unknown>;
  return Object.fromEntries(Object.values(OVERLAY_WIDGET_MODULES).flatMap(module => {
    const key = module.definition.state?.stateKey;
    if (!key || !Object.hasOwn(states, key)) return [];
    const state = states[key];
    return [[key, { state, revision: state && typeof state === 'object' && 'revision' in state && typeof state.revision === 'number' ? state.revision : 0 }]];
  }));
}
export function stateForWidget(widget: OverlayWidget, states: WidgetStates): unknown {
  const key = widgetModuleFor(widget, 'scene')?.definition.state?.stateKey;
  return key ? states[key]?.state ?? null : null;
}
