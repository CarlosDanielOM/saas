import { Roulette, RouletteDraw, slotsFor } from '../roulette/roulette-api.service';
import { WIDGET_SUB_WHEEL_PREFIX, WidgetConfig, WidgetEntry, WidgetPerkTuning, WidgetRole, WidgetState, WidgetSubWheel } from './widgets-api.service';

/** A mini roulette shown as one slice on the main perk wheel. */
export function subWheelEntry(wheel: Pick<WidgetSubWheel, 'id' | 'name' | 'role'>): WidgetEntry {
  const label = '🎲 ' + wheel.name;
  return {id: WIDGET_SUB_WHEEL_PREFIX + wheel.id, english: label, spanish: label, image_url: '', role: wheel.role, kind: 'perk', available: true};
}
/** Perk tuning plus each mini roulette slice's slots/weight, keyed by its wheel slot ID. */
export function wheelTuning(config: WidgetConfig): Record<string, WidgetPerkTuning> {
  return {...config.perkTuning, ...Object.fromEntries((config.subWheels ?? []).map(w => [WIDGET_SUB_WHEEL_PREFIX + w.id, {copies: w.copies, weight: w.weight}]))};
}
/** The saved main perk wheel: perks inside a mini roulette leave it, each mini roulette with a perk left becomes a slice. */
export function mainWheelEntries(config: WidgetConfig, role: WidgetRole, perks: WidgetEntry[], taken: string[] = []): WidgetEntry[] {
  const wheels = (config.subWheels ?? []).filter(w => w.role === role), inside = new Set(wheels.flatMap(w => w.perkIds));
  const left = perks.filter(e => !taken.includes(e.id));
  return [...left.filter(e => !inside.has(e.id)), ...wheels.filter(w => left.some(e => w.perkIds.includes(e.id))).map(subWheelEntry)];
}

/** Same order as the server: each perk's slots are spread evenly around the wheel, offset by its position. */
export function widgetSlotIds(entries: WidgetEntry[], tuning: Record<string, WidgetPerkTuning>): string[] {
  const n = entries.length;
  return entries.flatMap((e, i) => {
    const copies = e.kind === 'perk' ? tuning[e.id]?.copies ?? 1 : 1;
    return Array.from({length: copies}, (_, j) => ({id: e.id, at: (j + (i + .5) / n) / copies}));
  }).sort((a, b) => a.at - b.at).map(slot => slot.id);
}

/** Populate the existing roulette renderer. Selection and timing remain the widget's frozen draw. */
export function widgetRoulette(state: WidgetState, entries: WidgetEntry[], name: string): { roulette: Roulette; draw: RouletteDraw | null } {
  const id = state.packId, source = state.run?.draw, tuning = wheelTuning(state.config);
  const unique = [...new Map(entries.map(entry => [entry.id, entry])).values()];
  const kind = unique[0]?.kind ?? (state.packId.endsWith('-perks') ? 'perk' : 'character');
  const design = kind === 'perk' ? 'wheel' : state.config.characterDesign ?? 'cards';
  // A draw freezes its slot order; otherwise preview the saved slots.
  const order = source?.poolIds ?? widgetSlotIds(unique, tuning), keysById = new Map<string, string[]>();
  const keys = order.map(itemId => { const list = keysById.get(itemId) ?? []; const key = list.length ? `${itemId}~${list.length + 1}` : itemId; keysById.set(itemId, [...list, key]); return key; });
  const roulette: Roulette = {
    id, alias: id, name, design, cardSize: kind === 'character' ? 'small' : 'medium',
    colors: ['#cbbaff', '#f4c968', '#ec9baf'], durationSeconds: state.config.spinSeconds,
    items: unique.filter(entry => keysById.has(entry.id)).map(entry => { const copies = keysById.get(entry.id)!; return { id: entry.id, label: state.config.language === 'es' ? entry.spanish : entry.english, multiplier: copies.length, weight: entry.kind === 'perk' ? tuning[entry.id]?.weight ?? 1 : 1, copies, ...(entry.kind === 'character' ? {imageUrl: entry.image_url} : {}) }; }),
    order: keys,
    settings: { insertion: 'append', duplicate: 'separate', shuffleBeforeDraw: false, showOnStart: true, hideAfterSeconds: null, winnerAction: 'keep' },
  };
  if (!source) return { roulette, draw: null };
  // Land on the exact slot the server picked; older draws without a slot land on the first copy.
  const slots = slotsFor(roulette), slotKey = source.slot !== undefined && order[source.slot] === source.itemId ? keys[source.slot] : null;
  const winner = slots.find(slot => slot.key === slotKey) ?? slots.find(slot => slot.itemId === source.itemId);
  return { roulette, draw: winner ? {
    id: source.id, rouletteId: id, startedAt: source.startedAt, endsAt: source.endsAt,
    completedAt: state.phase === 'complete' ? source.endsAt : null,
    winner, slots, design: source.design ?? (source.kind === 'perk' ? 'wheel' : design), cardSize: roulette.cardSize, colors: roulette.colors,
  } : null };
}
