import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { LinksService } from '../../../services/links.service';
import { DuelCharacter, DuelSide, DuelTurn } from './duel-battle';
export interface DuelSettings { enabled:boolean; timeoutEnabled:boolean; timeoutSeconds:number; language:'en'|'es' }
export interface DuelState {
  revision:number; serverTime:number; connected:boolean; settings:DuelSettings;
  challenge:{id:string;challenger:string;opponent:string;expiresAt:number}|null;
  run:{id:string;challenger:string;opponent:string;winner:DuelSide;fighters?:Record<DuelSide,DuelCharacter>;turns?:DuelTurn[];mode:'overlay'|'chat';startedAt:number;endsAt:number;completedAt:number|null;announcementError?:string;timeoutError?:string}|null;
}
@Injectable({providedIn:'root'})
export class DuelApi {
  private readonly http=inject(HttpClient);
  readonly base=inject(LinksService).getApiUrl();
  async read(channel:string):Promise<DuelState> { return (await firstValueFrom(this.http.get<{data:DuelState}>(`${this.base}/widgets/${channel}/duel`))).data; }
  async save(channel:string, settings:DuelSettings, revision:number, key:string):Promise<DuelState> { return (await firstValueFrom(this.http.post<{data:DuelState}>(`${this.base}/widgets/${channel}/duel/configure`,settings,{headers:{'If-Match':String(revision),'Idempotency-Key':key}}))).data; }
  async token(channel:string):Promise<string> { return (await firstValueFrom(this.http.post<{data:{token:string}}>(`${this.base}/widgets/${channel}/duel/overlay-token`,{}))).data.token; }
}
