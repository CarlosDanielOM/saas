import { WidgetEntry, WidgetEventAction, WidgetEventRule } from './widgets-api.service';

export type BitsMatch = 'exact' | 'between' | 'atLeast' | 'atMost';
export type BitsActionType = WidgetEventAction['type'];
export const BITS_ACTIONS: { group: 'wins' | 'perks'; type: BitsActionType }[] = [
  {group: 'wins', type: 'remove-wins'}, {group: 'wins', type: 'reset-wins'}, {group: 'wins', type: 'add-win-target'}, {group: 'wins', type: 'set-win-target'},
  {group: 'perks', type: 'add-perks'}, {group: 'perks', type: 'remove-perks'},
];
type Translate = (key: string, params?: Record<string, string | number>) => string;

/** The server stores min/max; streamers think in "exactly / between / at least / at most". */
export function bitsMatch(rule: Pick<WidgetEventRule, 'minBits' | 'maxBits'>): BitsMatch {
  if (rule.maxBits === null) return 'atLeast';
  if (rule.minBits === rule.maxBits) return 'exact';
  return rule.minBits === 1 ? 'atMost' : 'between';
}
export function bitsRange(match: BitsMatch, from: number, to: number): {minBits: number; maxBits: number | null} {
  if (match === 'exact') return {minBits: from, maxBits: from};
  if (match === 'atLeast') return {minBits: from, maxBits: null};
  if (match === 'atMost') return {minBits: 1, maxBits: from};
  return {minBits: from, maxBits: to};
}
export function bitsMatches(rule: WidgetEventRule, bits: number): boolean {
  return rule.enabled && bits >= rule.minBits && (rule.maxBits === null || bits <= rule.maxBits);
}
export function bitsCondition(rule: Pick<WidgetEventRule, 'minBits' | 'maxBits'>, t: Translate): string {
  const match = bitsMatch(rule), n = (v: number) => v.toLocaleString();
  if (match === 'exact') return t('bits.cond.exact', {n: n(rule.minBits)});
  if (match === 'atLeast') return t('bits.cond.atLeast', {n: n(rule.minBits)});
  if (match === 'atMost') return t('bits.cond.atMost', {n: n(rule.maxBits!)});
  return t('bits.cond.between', {min: n(rule.minBits), max: n(rule.maxBits!)});
}
/** Chosen perks name themselves, so only role-wide actions show a role chip. */
export function bitsShowsRole(action: WidgetEventAction): boolean {
  return !('perkIds' in action) || !action.perkIds.length;
}
export function bitsAction(action: WidgetEventAction, t: Translate, names: (ids: string[]) => string): string {
  const one = 'amount' in action && action.amount === 1 ? 'One' : '';
  switch (action.type) {
    case 'remove-wins': return t('bits.do.removeWins' + one, {n: action.amount});
    case 'reset-wins': return t('bits.do.resetWins');
    case 'add-win-target': return t('bits.do.addWinTarget' + one, {n: action.amount});
    case 'set-win-target': return t('bits.do.setWinTarget', {n: action.amount});
    case 'add-perks':
      if (!action.perkIds.length) return t('bits.do.addRandom' + one, {n: action.amount});
      return t(action.amount > 1 ? 'bits.do.addChosenSlots' : 'bits.do.addChosen', {names: names(action.perkIds), n: action.amount});
    case 'remove-perks':
      if (!action.perkIds.length) return t('bits.do.removeRandom' + one, {n: action.amount});
      return t('bits.do.removeChosen', {names: names(action.perkIds)});
  }
}
export function perkNames(ids: string[], byId: Map<string, WidgetEntry>, label: (e: WidgetEntry) => string, t: Translate): string {
  const shown = ids.slice(0, 2).flatMap(id => { const entry = byId.get(id); return entry ? [label(entry)] : []; }).join(', ');
  return ids.length > 2 ? `${shown} ${t('bits.more', {n: ids.length - 2})}` : shown;
}
