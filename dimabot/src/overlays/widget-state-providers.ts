import { interactionSnapshot } from './interactions.js';
import type { InteractionSnapshot, InteractionState } from './interaction-model.js';
import type { WidgetStates, WidgetStateEntry } from './widget-contract.js';
import { WidgetStateRegistry } from './widget-state.js';

const entry = (state: InteractionState | null): WidgetStateEntry => ({ revision: state?.revision ?? 0, state });
/** Poll and prediction consume one existing sanitized aggregate read per channel/source. */
export const widgetStateRegistry = new WidgetStateRegistry([{
  source: 'twitch-interactions',
  async snapshot(channel) {
    const snapshot = await interactionSnapshot(channel);
    return { poll: entry(snapshot.poll), prediction: entry(snapshot.prediction) };
  }
}]);
/** Transitional compatibility envelope is projected from the same read as generic modules. */
export function legacyInteractions(widgetStates: WidgetStates, serverTime: number): InteractionSnapshot {
  return { poll: widgetStates['poll']?.state as InteractionState | null ?? null,
    prediction: widgetStates['prediction']?.state as InteractionState | null ?? null, serverTime };
}
