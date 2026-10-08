import { randomInt, randomUUID } from 'node:crypto';
import { catalog, type Entry, type Pack } from './catalog.js';
export { RouletteError as WidgetError, fail, integer, object, text } from '../roulette/model.js';
import { fail, integer, object } from '../roulette/model.js';

export interface Config { language: 'en' | 'es'; spinSeconds: number; pollSeconds: number; channelPointsVoting: boolean; channelPointsPerVote: number; includeUnavailable: boolean; excludedIds: string[] }
export type Phase = 'idle' | 'character-spin' | 'poll-starting' | 'polling' | 'poll-error' | 'reveal' | 'perk-spin' | 'complete';
export interface Draw { id: string; kind: 'character' | 'perk'; itemId: string; poolIds: string[]; startedAt: number; endsAt: number }
export interface Run {
  id: string; characterId: string | null; perkIds: string[]; draw: Draw | null;
  cards: number[]; votes: number[]; channelPointsVotes: number[]; winningCard: number | null; perkCount: number | null;
  pollId: string | null; choiceIds: string[]; pollTitle: string; pollEndsAt: number | null;
  error: string | null;
}
export interface State { packId: string; config: Config; visible: boolean; phase: Phase; run: Run | null; nextAt: number | null }
export const initial = (): State => ({ packId: 'dbd-killer-challenge', config: { language: 'en', spinSeconds: 4, pollSeconds: 30, channelPointsVoting: false, channelPointsPerVote: 100, includeUnavailable: false, excludedIds: [] }, visible: false, phase: 'idle', run: null, nextAt: null });
export const pick = <T>(items: T[]): T => items[randomInt(items.length)];
export function shuffle<T>(items: T[]): T[] { const out = [...items]; for (let n = out.length - 1; n > 0; n--) { const i = randomInt(n + 1); [out[n], out[i]] = [out[i], out[n]]; } return out; }
export function pack(id: string): Pack { const result = catalog.packs.find(p => p.id === id); if (!result) return fail('invalid', 'Unknown widget pack'); return result; }
export function pool(state: State, kind: Entry['kind']): Entry[] {
  return catalog.entries.filter(e => e.role === pack(state.packId).role && e.kind === kind && (state.config.includeUnavailable || e.available) && !state.config.excludedIds.includes(e.id));
}
export function config(input: unknown): Config {
  const data = object(input);
  if (Object.keys(data).some(k => !['language', 'spinSeconds', 'pollSeconds', 'channelPointsVoting', 'channelPointsPerVote', 'includeUnavailable', 'excludedIds'].includes(k))) fail('invalid', 'Unknown widget setting');
  if (data.language !== 'en' && data.language !== 'es') fail('invalid', 'Choose English or Spanish');
  if (typeof data.includeUnavailable !== 'boolean') fail('invalid', 'includeUnavailable must be a boolean');
  if (data.channelPointsVoting !== undefined && typeof data.channelPointsVoting !== 'boolean') fail('invalid', 'channelPointsVoting must be a boolean');
  if (!Array.isArray(data.excludedIds) || data.excludedIds.length > catalog.entries.length || data.excludedIds.some(id => typeof id !== 'string' || !catalog.entries.some(e => e.id === id))) fail('invalid', 'Unknown excluded entry');
  return { language: data.language as Config['language'], spinSeconds: integer(data.spinSeconds, 'spinSeconds', 1, 15), pollSeconds: integer(data.pollSeconds, 'pollSeconds', 15, 180), channelPointsVoting: data.channelPointsVoting === true, channelPointsPerVote: integer(data.channelPointsPerVote === undefined ? 100 : data.channelPointsPerVote, 'channelPointsPerVote', 1, 1000000), includeUnavailable: data.includeUnavailable as boolean, excludedIds: [...new Set(data.excludedIds as string[])] };
}
export function active(state: State): boolean { return !['idle', 'complete', 'poll-error'].includes(state.phase); }
export function idle(state: State): void { if (active(state) || state.phase === 'poll-error') fail('busy', 'Finish or reset the challenge first', 409); }
function draw(state: State, kind: Draw['kind'], now: number): void {
  const options = pool(state, kind).filter(e => !state.run!.perkIds.includes(e.id));
  if (!options.length) fail('empty_pool', 'Select more entries before starting');
  state.run!.draw = { id: randomUUID(), kind, itemId: pick(options).id, poolIds: options.map(e => e.id), startedAt: now, endsAt: now + state.config.spinSeconds * 1000 };
  state.phase = kind === 'character' ? 'character-spin' : 'perk-spin'; state.nextAt = state.run!.draw.endsAt;
}
export function start(state: State, now: number): void {
  idle(state);
  const mode = pack(state.packId).mode;
  if (mode !== 'perks' && !pool(state, 'character').length) fail('empty_pool', 'Select at least one character');
  if (mode === 'challenge' && pool(state, 'perk').length < 4) fail('empty_pool', 'A challenge needs at least four enabled perks');
  if (mode === 'perks' && !pool(state, 'perk').length) fail('empty_pool', 'Select at least one perk');
  const id = randomUUID();
  state.run = { id, characterId: null, perkIds: [], draw: null, cards: shuffle([0, 1, 2, 3, 4]), votes: [0, 0, 0, 0, 0], channelPointsVotes: [0, 0, 0, 0, 0], winningCard: null, perkCount: null, pollId: null, choiceIds: [], pollTitle: `${state.config.language === 'es' ? 'DBD: Elige una carta' : 'DBD: Choose a card'} (${id.slice(0, 8)})`, pollEndsAt: null, error: null };
  state.visible = true; draw(state, mode === 'perks' ? 'perk' : 'character', now);
}
/** Pure timed transitions. Poll creation/results are claimed separately by the service. */
export function settle(state: State, now: number): boolean {
  if (state.nextAt === null || state.nextAt > now || !state.run) return false;
  const run = state.run, mode = pack(state.packId).mode;
  if (state.phase === 'character-spin') {
    run.characterId = run.draw!.itemId;
    state.phase = mode === 'challenge' ? 'poll-starting' : 'complete';
    state.nextAt = mode === 'challenge' ? now + 30000 : null;
  } else if (state.phase === 'perk-spin') {
    run.perkIds.push(run.draw!.itemId);
    if (mode === 'challenge' && run.perkIds.length < run.perkCount!) draw(state, 'perk', now);
    else { state.phase = 'complete'; state.nextAt = null; }
  } else if (state.phase === 'reveal') {
    if (run.perkCount === 0) { state.phase = 'complete'; state.nextAt = null; }
    else draw(state, 'perk', now);
  } else return false;
  return true;
}
export function reveal(state: State, votes: number[], now: number): void {
  const best = Math.max(...votes), tied = votes.flatMap((v, i) => v === best ? [i] : []);
  const run = state.run!;
  run.votes = votes; run.winningCard = pick(tied); run.perkCount = run.cards[run.winningCard]; run.error = null;
  state.phase = 'reveal'; state.nextAt = now + 3500;
}
/** The card values stay server-only until the poll has completed, including owner responses. */
export function publicState(state: State) {
  const run = state.run ? { ...state.run, cards: state.run.winningCard === null ? state.run.cards.map(() => null) : state.run.cards, choiceIds: undefined } : null;
  return { ...state, config: { ...initial().config, ...state.config }, run: run ? { ...run, channelPointsVotes: run.channelPointsVotes ?? [0, 0, 0, 0, 0] } : null };
}
