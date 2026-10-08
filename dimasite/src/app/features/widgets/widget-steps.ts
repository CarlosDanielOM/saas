import { WidgetRole, WidgetState } from './widgets-api.service';

export type WidgetStepKey = 'character' | 'vote' | 'perks' | 'play';
export interface WidgetStep { key: WidgetStepKey; status: 'todo' | 'current' | 'done' }

/** The challenge's visible steps and where the round is. Standalone draws and polls have no steps. */
export function challengeSteps(state: WidgetState, role: WidgetRole): WidgetStep[] {
  const run = state.run;
  if ((run?.operation ?? 'challenge') !== 'challenge') return [];
  const sequence = run?.sequence ?? state.config.sequences[role];
  const keys: WidgetStepKey[] = [...(sequence.character ? ['character' as const] : []), ...(sequence.poll ? ['vote' as const] : []), ...(sequence.perks && (sequence.poll || sequence.perkCount > 0) ? ['perks' as const] : []), 'play'];
  const phase = state.phase;
  const at: WidgetStepKey | null = phase.startsWith('character') ? 'character' : phase.startsWith('poll') || phase === 'reveal' ? 'vote' : phase.startsWith('perk') ? 'perks' : phase === 'complete' ? 'play' : null;
  const current = at === null ? -1 : keys.indexOf(at);
  return keys.map((key, i) => ({ key, status: i === current ? 'current' : current >= 0 && i < current ? 'done' : 'todo' }));
}
