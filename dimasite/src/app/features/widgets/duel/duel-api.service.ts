import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { LinksService } from '../../../services/links.service';
import { DuelCharacter, DuelSide, DuelTurn } from './duel-battle';
import { DuelRules } from './duel-rules';
/** leaderboard and rivalries only track overlay fights under the default rules. */
export interface DuelSettings { enabled:boolean; timeoutEnabled:boolean; timeoutSeconds:number; language:'en'|'es'; leaderboard:boolean; rivalries:boolean; rules:DuelRules }
/** Head-to-head wins of each side before the fight. */
export interface DuelRecord { left:number; right:number }
export interface DuelRanking { login:string; kills:number; deaths:number; kd:number }
/** live: counting fights; paused: custom rules are on, so new fights don't count; off: turned off. */
export type DuelLeaderboardStatus = 'live'|'paused'|'off';
/** Top fighters by K/D; ranked counts every fighter, duels every recorded overlay fight. */
export interface DuelLeaderboard { players:DuelRanking[]; ranked:number; duels:number; status?:DuelLeaderboardStatus }
export interface DuelState {
  revision:number; serverTime:number; connected:boolean; settings:DuelSettings;
  challenge:{id:string;challenger:string;opponent:string;expiresAt:number;enraged?:DuelSide|null}|null;
  run:{id:string;challenger:string;opponent:string;winner:DuelSide;fighters?:Record<DuelSide,DuelCharacter>;turns?:DuelTurn[];enraged?:DuelSide|null;mode:'overlay'|'chat';startedAt:number;endsAt:number;completedAt:number|null;announcementError?:string;timeoutError?:string;record?:DuelRecord|null;maxHp?:number|null;healCharges?:number|null;tracked?:boolean}|null;
}
@Injectable({providedIn:'root'})
export class DuelApi {
  private readonly http=inject(HttpClient);
  readonly base=inject(LinksService).getApiUrl();
  async read(channel:string):Promise<DuelState> { return (await firstValueFrom(this.http.get<{data:DuelState}>(`${this.base}/widgets/${channel}/duel`))).data; }
  async leaderboard(channel:string):Promise<DuelLeaderboard> { return (await firstValueFrom(this.http.get<{data:DuelLeaderboard}>(`${this.base}/widgets/${channel}/duel/leaderboard`))).data; }
  async save(channel:string, settings:DuelSettings, revision:number, key:string):Promise<DuelState> { return (await firstValueFrom(this.http.post<{data:DuelState}>(`${this.base}/widgets/${channel}/duel/configure`,settings,{headers:{'If-Match':String(revision),'Idempotency-Key':key}}))).data; }
  async token(channel:string):Promise<string> { return (await firstValueFrom(this.http.post<{data:{token:string}}>(`${this.base}/widgets/${channel}/duel/overlay-token`,{}))).data.token; }
}
