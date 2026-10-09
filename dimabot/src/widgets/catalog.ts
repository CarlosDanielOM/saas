import dbd from './dbd.json' with { type: 'json' };
export type Role = 'killer' | 'survivor';
export type Mode = 'challenge' | 'characters' | 'perks';
export interface Entry { id: string; english: string; spanish: string; image_url: string; role: Role; kind: 'character' | 'perk'; available: boolean }
export interface Pack { id: string; game: string; role: Role; mode: Mode }
export const entries = dbd.entries as Entry[];
// Legacy IDs remain available for already-open OBS sources. The control center presents one game pack.
export const packs: Pack[] = (['killer', 'survivor'] as const).flatMap(role =>
  (['challenge', 'characters', 'perks'] as const).map(mode => ({ id: `dbd-${role}-${mode}`, game: 'Dead by Daylight', role, mode })));
export const catalog = { widgets: [{id: 'dbd-challenge', game: 'Dead by Daylight', roles: ['killer', 'survivor']}, {id: 'duel', game: 'Chat duel'}], packs, entries, researchedAt: dbd.researched_at };
