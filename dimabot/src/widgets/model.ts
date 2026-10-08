import { randomInt, randomUUID } from 'node:crypto';
import { catalog, type Entry, type Pack, type Role } from './catalog.js';
export { RouletteError as WidgetError, fail, integer, object, text } from '../roulette/model.js';
import { fail, integer, object } from '../roulette/model.js';

export type CharacterDesign = 'cards' | 'reel' | 'wheel' | 'elimination';
export type Operation = 'challenge' | 'characters' | 'perks' | 'poll';
export interface Sequence { character: boolean; fixedCharacterId: string | null; poll: boolean; perks: boolean; perkCount: number }
export interface Layout { cameraCorner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'; cameraWidth: number; cameraHeight: number; loadoutMode: 'detailed' | 'compact'; autoCompact: boolean; progressStyle: 'badges' | 'bar'; showActive: boolean; showInfo: boolean; showProgress: boolean; hideActiveDuringGameplay: boolean }
export const defaultSequence = (): Sequence => ({ character: true, fixedCharacterId: null, poll: true, perks: true, perkCount: 4 });
export const defaultLayout = (): Layout => ({ cameraCorner: 'bottom-right', cameraWidth: 512, cameraHeight: 288, loadoutMode: 'detailed', autoCompact: true, progressStyle: 'badges', showActive: true, showInfo: true, showProgress: true, hideActiveDuringGameplay: true });
export interface Config { sequences?: Record<Role, Sequence>; layout?: Layout; targets?: Record<Role, number>; language: 'en' | 'es'; characterDesign: CharacterDesign; spinSeconds: number; pollSeconds: number; channelPointsVoting: boolean; channelPointsPerVote: number; includeUnavailable: boolean; excludedIds: string[] }
export type Phase = 'idle' | 'character-spin' | 'character-result' | 'poll-starting' | 'polling' | 'poll-error' | 'reveal' | 'perk-spin' | 'perk-result' | 'complete';
export interface Draw { id: string; kind: 'character' | 'perk'; design?: CharacterDesign; itemId: string; poolIds: string[]; startedAt: number; endsAt: number }
export interface Run {
  operation?: Operation; sequence?: Sequence; id: string; characterId: string | null; perkIds: string[]; draw: Draw | null;
  cards: number[]; votes: number[]; channelPointsVotes: number[]; winningCard: number | null; perkCount: number | null;
  pollId: string | null; choiceIds: string[]; pollTitle: string; pollEndsAt: number | null;
  error: string | null;
}
export interface State { wins?: Record<Role, number>; loadouts?: Record<Role, {characterId: string | null; perkIds: string[]}>; packId: string; config: Config; visible: boolean; phase: Phase; run: Run | null; nextAt: number | null }
export const initial = (): State => ({ packId: 'dbd-killer-challenge', config: { language: 'en', characterDesign: 'cards', spinSeconds: 4, pollSeconds: 30, channelPointsVoting: false, channelPointsPerVote: 100, includeUnavailable: false, excludedIds: [], sequences: { killer: defaultSequence(), survivor: defaultSequence() }, layout: defaultLayout(), targets: { killer: 3, survivor: 4 } }, visible: false, phase: 'idle', run: null, nextAt: null, wins: { killer: 0, survivor: 0 }, loadouts: { killer: {characterId: null, perkIds: []}, survivor: {characterId: null, perkIds: []} } });
export const pick = <T>(items: T[]): T => items[randomInt(items.length)];
export function shuffle<T>(items: T[]): T[] { const out = [...items]; for (let n = out.length - 1; n > 0; n--) { const i = randomInt(n + 1); [out[n], out[i]] = [out[i], out[n]]; } return out; }
export function pack(id: string): Pack { const result = catalog.packs.find(p => p.id === id); if (!result) return fail('invalid', 'Unknown widget pack'); return result; }
export function pool(state: State, kind: Entry['kind']): Entry[] {
  return catalog.entries.filter(e => e.role === pack(state.packId).role && e.kind === kind && (state.config.includeUnavailable || e.available) && !state.config.excludedIds.includes(e.id));
}
/** Normalize old channel documents in memory; their OBS token and active run remain intact. */
export function normalize(state: State): State {
  state.config = { ...initial().config, ...state.config, sequences: state.config.sequences ?? {killer: defaultSequence(), survivor: defaultSequence()}, layout: state.config.layout ?? defaultLayout(), targets: state.config.targets ?? {killer: 3, survivor: 4} };
  state.wins ??= {killer: 0, survivor: 0};
  if (!state.loadouts) {
    state.loadouts = {killer: {characterId: null, perkIds: []}, survivor: {characterId: null, perkIds: []}};
    if (state.run) state.loadouts[pack(state.packId).role] = {characterId: state.run.characterId, perkIds: [...state.run.perkIds]};
  }
  return state;
}
export function layout(input: unknown): Layout {
  const data = object(input), defaults = defaultLayout();
  if (Object.keys(data).some(k => !Object.hasOwn(defaults, k))) fail('invalid', 'Unknown layout setting');
  if (!['top-left','top-right','bottom-left','bottom-right'].includes(data.cameraCorner as string)) fail('invalid', 'Choose a camera corner');
  if (!['detailed','compact'].includes(data.loadoutMode as string) || !['badges','bar'].includes(data.progressStyle as string)) fail('invalid', 'Invalid loadout or progress style');
  for (const k of ['autoCompact','showActive','showInfo','showProgress','hideActiveDuringGameplay']) if (typeof data[k] !== 'boolean') fail('invalid', `${k} must be a boolean`);
  return {...data, cameraWidth: integer(data.cameraWidth, 'cameraWidth', 320, 800), cameraHeight: integer(data.cameraHeight, 'cameraHeight', 180, 640)} as unknown as Layout;
}
function sequence(input: unknown, role: Role): Sequence {
  const data = object(input);
  if (Object.keys(data).some(k => !['character','fixedCharacterId','poll','perks','perkCount'].includes(k))) fail('invalid', 'Unknown sequence setting');
  for (const k of ['character','poll','perks']) if (typeof data[k] !== 'boolean') fail('invalid', `${k} must be a boolean`);
  if (data.fixedCharacterId !== null && !catalog.entries.some(e => e.id === data.fixedCharacterId && e.role === role && e.kind === 'character')) fail('invalid', 'Choose a character for this role');
  if (!data.character && !data.fixedCharacterId) fail('invalid', 'A skipped character draw needs a fixed character');
  return {...data, perkCount: integer(data.perkCount, 'perkCount', 0, 4)} as unknown as Sequence;
}
export function config(input: unknown): Config {
  const data = object(input);
  if (Object.keys(data).some(k => !['language', 'characterDesign', 'spinSeconds', 'pollSeconds', 'channelPointsVoting', 'channelPointsPerVote', 'includeUnavailable', 'excludedIds', 'sequences', 'layout', 'targets'].includes(k))) fail('invalid', 'Unknown widget setting');
  if (data.language !== 'en' && data.language !== 'es') fail('invalid', 'Choose English or Spanish');
  if (data.characterDesign !== undefined && !['cards', 'reel', 'wheel', 'elimination'].includes(data.characterDesign as string)) fail('invalid', 'Choose cards, reel, wheel, or last one standing for the character roulette');
  if (typeof data.includeUnavailable !== 'boolean') fail('invalid', 'includeUnavailable must be a boolean');
  if (data.channelPointsVoting !== undefined && typeof data.channelPointsVoting !== 'boolean') fail('invalid', 'channelPointsVoting must be a boolean');
  if (!Array.isArray(data.excludedIds) || data.excludedIds.length > catalog.entries.length || data.excludedIds.some(id => typeof id !== 'string' || !catalog.entries.some(e => e.id === id))) fail('invalid', 'Unknown excluded entry');
  const sequences = data.sequences === undefined ? {killer: defaultSequence(), survivor: defaultSequence()} : object(data.sequences);
  if (Object.keys(sequences).some(k => !['killer','survivor'].includes(k))) fail('invalid', 'Unknown sequence role');
  const targets = data.targets === undefined ? {killer: 3, survivor: 4} : object(data.targets);
  if (Object.keys(targets).some(k => !['killer','survivor'].includes(k))) fail('invalid', 'Unknown progress role');
  return { sequences: {killer: sequence(sequences.killer, 'killer'), survivor: sequence(sequences.survivor, 'survivor')}, layout: data.layout === undefined ? defaultLayout() : layout(data.layout), targets: {killer: integer(targets.killer, 'killer target', 1, 20), survivor: integer(targets.survivor, 'survivor target', 1, 20)}, language: data.language as Config['language'], characterDesign: (data.characterDesign ?? 'cards') as CharacterDesign, spinSeconds: integer(data.spinSeconds, 'spinSeconds', 1, 15), pollSeconds: integer(data.pollSeconds, 'pollSeconds', 15, 180), channelPointsVoting: data.channelPointsVoting === true, channelPointsPerVote: integer(data.channelPointsPerVote === undefined ? 100 : data.channelPointsPerVote, 'channelPointsPerVote', 1, 1000000), includeUnavailable: data.includeUnavailable as boolean, excludedIds: [...new Set(data.excludedIds as string[])] };
}
export function active(state: State): boolean { return !['idle', 'complete', 'poll-error'].includes(state.phase); }
export function idle(state: State): void { if (active(state) || state.phase === 'poll-error') fail('busy', 'Finish or reset the challenge first', 409); }
function draw(state: State, kind: Draw['kind'], now: number): void {
  const options = pool(state, kind).filter(e => !state.run!.perkIds.includes(e.id));
  if (!options.length) fail('empty_pool', 'Select more entries before starting');
  state.run!.draw = { id: randomUUID(), kind, design: kind === 'perk' ? 'wheel' : state.config.characterDesign ?? 'cards', itemId: pick(options).id, poolIds: options.map(e => e.id), startedAt: now, endsAt: now + state.config.spinSeconds * 1000 };
  state.phase = kind === 'character' ? 'character-spin' : 'perk-spin'; state.nextAt = state.run!.draw.endsAt;
}
function finish(state: State): void { state.phase = 'complete'; state.nextAt = null; }
function afterCharacter(state: State, now: number): void {
  const run = state.run!, mode = run.operation ?? pack(state.packId).mode;
  if (mode === 'characters') { finish(state); return; }
  if (mode === 'poll' || run.sequence?.poll !== false) { state.phase = 'poll-starting'; state.nextAt = now + 30000; }
  else if (run.sequence.perks && run.perkCount! > 0) draw(state, 'perk', now);
  else finish(state);
}
export function start(state: State, now: number, operation?: Operation): void {
  idle(state); normalize(state);
  const role = pack(state.packId).role, mode = operation ?? pack(state.packId).mode;
  if (!['challenge','characters','perks','poll'].includes(mode)) fail('invalid', 'Unknown widget operation');
  const sequence = {...state.config.sequences![role]};
  const needsCharacter = mode === 'characters' || (mode === 'challenge' && sequence.character);
  const requiredPerks = mode === 'perks' ? 1 : mode === 'challenge' && sequence.perks ? (sequence.poll ? 4 : sequence.perkCount) : 0;
  if (needsCharacter && !pool(state, 'character').length) fail('empty_pool', 'Select at least one character');
  if (pool(state, 'perk').length < requiredPerks) fail('empty_pool', 'Select more perks for this sequence');
  if (mode === 'challenge' && !sequence.character && !pool(state, 'character').some(e => e.id === sequence.fixedCharacterId)) fail('empty_pool', 'The fixed character must be enabled');
  // Legacy pack IDs stay on the wire for already-open OBS clients. The control center is one pack.
  state.packId = `dbd-${role}-${mode === 'poll' ? 'challenge' : mode}`;
  const id = randomUUID(), previous = state.loadouts![role];
  state.run = { operation: mode, sequence, id, characterId: mode === 'challenge' && !sequence.character ? sequence.fixedCharacterId : needsCharacter ? null : previous.characterId, perkIds: mode === 'challenge' ? [] : [...previous.perkIds], draw: null, cards: shuffle([0, 1, 2, 3, 4]), votes: [0, 0, 0, 0, 0], channelPointsVotes: [0, 0, 0, 0, 0], winningCard: null, perkCount: mode === 'challenge' && !sequence.poll ? sequence.perkCount : null, pollId: null, choiceIds: [], pollTitle: `${state.config.language === 'es' ? 'DBD: Elige una carta' : 'DBD: Choose a card'} (${id.slice(0, 8)})`, pollEndsAt: null, error: null };
  if (mode === 'challenge') state.loadouts![role] = {characterId: state.run.characterId, perkIds: []};
  if (mode === 'perks' && state.run.perkIds.length >= 4) { state.run.perkIds = []; state.loadouts![role].perkIds = []; }
  state.visible = true;
  if (needsCharacter) draw(state, 'character', now);
  else if (mode === 'perks') draw(state, 'perk', now);
  else afterCharacter(state, now);
}
/** Pure timed transitions. Poll creation/results are claimed separately by the service. */
export function settle(state: State, now: number): boolean {
  if (state.nextAt === null || state.nextAt > now || !state.run) return false;
  normalize(state);
  const run = state.run, mode = run.operation ?? pack(state.packId).mode, loadout = state.loadouts![pack(state.packId).role];
  if (state.phase === 'character-spin') {
    run.characterId = run.draw!.itemId; loadout.characterId = run.characterId;
    state.phase = mode === 'challenge' ? 'character-result' : 'complete';
    state.nextAt = mode === 'challenge' ? now + 3000 : null;
  } else if (state.phase === 'character-result') {
    afterCharacter(state, now);
  } else if (state.phase === 'perk-spin') {
    run.perkIds.push(run.draw!.itemId); loadout.perkIds = [...run.perkIds];
    state.phase = mode === 'challenge' ? 'perk-result' : 'complete';
    state.nextAt = mode === 'challenge' ? now + 3000 : null;
  } else if (state.phase === 'perk-result') {
    if (run.perkIds.length < run.perkCount!) draw(state, 'perk', now);
    else { state.phase = 'complete'; state.nextAt = null; }
  } else if (state.phase === 'reveal') {
    if (mode === 'poll' || run.sequence?.perks === false || run.perkCount === 0) { state.phase = 'complete'; state.nextAt = null; }
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
  normalize(state);
  const run = state.run ? { ...state.run, cards: state.run.winningCard === null ? state.run.cards.map(() => null) : state.run.cards, choiceIds: undefined } : null;
  // Already-open OBS sources understand spin phases and stop animating at draw.endsAt.
  // Keep that contract while newer clients can label the persisted result stage.
  const resultPhase = state.phase === 'character-result' || state.phase === 'perk-result' ? state.phase : undefined;
  return { ...state, phase: resultPhase === 'character-result' ? 'character-spin' : resultPhase === 'perk-result' ? 'perk-spin' : state.phase, resultPhase, config: { ...initial().config, ...state.config }, run: run ? { ...run, channelPointsVotes: run.channelPointsVotes ?? [0, 0, 0, 0, 0] } : null };
}
