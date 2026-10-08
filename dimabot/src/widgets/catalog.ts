import dbd from './dbd.json' with { type: 'json' };
export type Role = 'killer' | 'survivor';
export type Mode = 'challenge' | 'characters' | 'perks';
export interface Entry { id: string; english: string; spanish: string; image_url: string; role: Role; kind: 'character' | 'perk'; available: boolean }
export interface Pack { id: string; game: string; role: Role; mode: Mode }
export const entries = dbd.entries as Entry[];
export const packs: Pack[] = (['killer', 'survivor'] as const).flatMap(role =>
  (['challenge', 'characters', 'perks'] as const).map(mode => ({ id: `dbd-${role}-${mode}`, game: 'Dead by Daylight', role, mode })));
export const catalog = { packs, entries, researchedAt: dbd.researched_at };
