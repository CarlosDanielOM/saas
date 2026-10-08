import { Roulette, RouletteDraw, slotsFor } from '../roulette/roulette-api.service';
import { WidgetEntry, WidgetState } from './widgets-api.service';

/** Populate the existing roulette renderer. Selection and timing remain the widget's frozen draw. */
export function widgetRoulette(state: WidgetState, entries: WidgetEntry[], name: string): { roulette: Roulette; draw: RouletteDraw | null } {
  const id = state.packId, source = state.run?.draw;
  const kind = entries[0]?.kind ?? (state.packId.endsWith('-perks') ? 'perk' : 'character');
  const design = kind === 'perk' ? 'wheel' : state.config.characterDesign ?? 'cards';
  const roulette: Roulette = {
    id, alias: id, name, design, cardSize: kind === 'character' ? 'small' : 'medium',
    colors: ['#cbbaff', '#f4c968', '#ec9baf'], durationSeconds: state.config.spinSeconds,
    items: entries.map(entry => ({ id: entry.id, label: state.config.language === 'es' ? entry.spanish : entry.english, multiplier: 1, weight: 1, copies: [entry.id], ...(entry.kind === 'character' ? {imageUrl: entry.image_url} : {}) })),
    order: entries.map(entry => entry.id),
    settings: { insertion: 'append', duplicate: 'separate', shuffleBeforeDraw: false, showOnStart: true, hideAfterSeconds: null, winnerAction: 'keep' },
  };
  if (!source) return { roulette, draw: null };
  const slots = slotsFor(roulette), winner = slots.find(slot => slot.itemId === source.itemId);
  return { roulette, draw: winner ? {
    id: source.id, rouletteId: id, startedAt: source.startedAt, endsAt: source.endsAt,
    completedAt: state.phase === 'complete' ? source.endsAt : null,
    winner, slots, design: source.design ?? (source.kind === 'perk' ? 'wheel' : design), cardSize: roulette.cardSize, colors: roulette.colors,
  } : null };
}
