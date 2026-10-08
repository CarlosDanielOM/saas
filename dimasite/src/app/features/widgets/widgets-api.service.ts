import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { LinksService } from '../../services/links.service';
export type WidgetRole = 'killer' | 'survivor';
export type WidgetMode = 'challenge' | 'characters' | 'perks' | 'poll';
export interface WidgetEntry { id: string; english: string; spanish: string; image_url: string; role: WidgetRole; kind: 'character' | 'perk'; available: boolean }
export interface WidgetPack { id: string; game: string; role: WidgetRole; mode: WidgetMode }
export interface WidgetCatalog { packs: WidgetPack[]; entries: WidgetEntry[]; researchedAt: string }
export type WidgetCharacterDesign = 'cards' | 'reel' | 'wheel' | 'elimination';
export interface WidgetSequence { character: boolean; fixedCharacterId: string | null; poll: boolean; perks: boolean; perkCount: number }
export interface WidgetLayout { cameraCorner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'; cameraWidth: number; cameraHeight: number; loadoutMode: 'detailed' | 'compact'; autoCompact: boolean; progressStyle: 'badges' | 'bar'; showActive: boolean; showInfo: boolean; showProgress: boolean; hideActiveDuringGameplay: boolean }
export const widgetDefaultLayout = (): WidgetLayout => ({cameraCorner: 'bottom-right', cameraWidth: 512, cameraHeight: 288, loadoutMode: 'detailed', autoCompact: true, progressStyle: 'badges', showActive: true, showInfo: true, showProgress: true, hideActiveDuringGameplay: true});
export interface WidgetConfig { sequences: Record<WidgetRole, WidgetSequence>; layout: WidgetLayout; targets: Record<WidgetRole, number>; language: 'en' | 'es'; characterDesign: WidgetCharacterDesign; spinSeconds: number; pollSeconds: number; channelPointsVoting: boolean; channelPointsPerVote: number; includeUnavailable: boolean; excludedIds: string[] }
export interface WidgetDraw { id: string; kind: 'character' | 'perk'; design?: WidgetCharacterDesign; itemId: string; poolIds: string[]; startedAt: number; endsAt: number }
export type WidgetPhase = 'idle' | 'character-spin' | 'character-result' | 'poll-starting' | 'polling' | 'poll-error' | 'reveal' | 'perk-spin' | 'perk-result' | 'complete';
export interface WidgetState {
  wins: Record<WidgetRole, number>; loadouts: Record<WidgetRole, {characterId: string | null; perkIds: string[]}>; revision: number; serverTime: number; packId: string; config: WidgetConfig; visible: boolean; phase: WidgetPhase; nextAt: number | null;
  resultPhase?: 'character-result' | 'perk-result';
  run: { operation?: WidgetMode; sequence?: WidgetSequence; id: string; characterId: string | null; perkIds: string[]; draw: WidgetDraw | null; cards: (number | null)[]; votes: number[]; channelPointsVotes: number[]; winningCard: number | null; perkCount: number | null; pollId: string | null; pollTitle: string; pollEndsAt: number | null; error: string | null } | null;
}
export type WidgetAction = 'select' | 'configure' | 'start' | 'show' | 'hide' | 'reset' | 'retry-poll' | 'role' | 'layout' | 'progress';
export function normalizeWidgetState(state: WidgetState): WidgetState {
  const sequence = {character: true, fixedCharacterId: null, poll: true, perks: true, perkCount: 4};
  return {...state, phase: state.resultPhase ?? state.phase, wins: state.wins ?? {killer: 0, survivor: 0}, loadouts: state.loadouts ?? {killer: {characterId: null, perkIds: []}, survivor: {characterId: null, perkIds: []}}, config: {...state.config, sequences: state.config.sequences ?? {killer: {...sequence}, survivor: {...sequence}}, layout: state.config.layout ?? widgetDefaultLayout(), targets: state.config.targets ?? {killer: 3, survivor: 4}}};
}
@Injectable({ providedIn: 'root' })
export class WidgetsApi {
  private readonly http = inject(HttpClient);
  readonly base = inject(LinksService).getApiUrl();
  async read(channel: string): Promise<WidgetState> { return normalizeWidgetState((await firstValueFrom(this.http.get<{ data: WidgetState }>(`${this.base}/widgets/${channel}`))).data); }
  async catalog(channel: string): Promise<WidgetCatalog> { return (await firstValueFrom(this.http.get<{ data: WidgetCatalog }>(`${this.base}/widgets/${channel}/catalog`))).data; }
  async token(channel: string): Promise<string> { return (await firstValueFrom(this.http.post<{ data: { token: string } }>(`${this.base}/widgets/${channel}/overlay-token`, {}))).data.token; }
  async action(channel: string, action: WidgetAction, body: unknown, revision: number, key: string): Promise<WidgetState> {
    return normalizeWidgetState((await firstValueFrom(this.http.post<{ data: WidgetState }>(`${this.base}/widgets/${channel}/actions/${action}`, body, { headers: { 'Idempotency-Key': key, 'If-Match': String(revision) } }))).data);
  }
}
