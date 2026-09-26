import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, map, timeout } from 'rxjs';
import { LinksService } from '../../services/links.service';
import type { AlertDesign, OverlayScene, AlertEvent } from './overlay.model';
export interface StudioState { schemaVersion: 1; revision: number; scenes: OverlayScene[]; designs: AlertDesign[] }
export type Snapshot = NonNullable<OverlayScene['published']>;
@Injectable({ providedIn: 'root' })
export class OverlayApi {
  private readonly http = inject(HttpClient);
  readonly base = inject(LinksService).getApiUrl();
  request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return firstValueFrom(this.http.request<{ data: T }>(method, `${this.base}/overlay-studio/${path}`, { body }).pipe(timeout(20000), map(r => r.data)));
  }
  load(channel: string) { return this.request<StudioState>('GET', channel); }
  save(channel: string, state: StudioState) { return this.request<StudioState>('PUT', channel, state); }
  action(channel: string, scene: string, revision: number, action: 'publish' | 'rotate') { return this.request<StudioState>('POST', `${channel}/scenes/${scene}/${action}`, { revision }); }
  render(channel: string, texts: string[], kind: AlertEvent, user: string, amount: string) { return this.request<string[]>('POST', `${channel}/preview`, { texts, kind, user, amount }); }
}
