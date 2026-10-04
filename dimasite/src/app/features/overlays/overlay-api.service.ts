import type { QueueStatus, OverlayAction, OverlayScope } from './overlay-queue.model';
import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, map, timeout } from 'rxjs';
import { LinksService } from '../../services/links.service';
import type { AlertDesign, OverlayScene, AlertEvent } from './overlay.model';
export interface StudioState { schemaVersion: 1; revision: number; scenes: OverlayScene[]; designs: AlertDesign[] }
export interface OverlaySourceConnection {
  connected: boolean; connectedAt: number; disconnectedAt: number | null; lastReportAt: number | null; revision: number | null;
  status: 'reconnecting' | 'loading' | 'unresponsive' | 'updating' | 'ready';
  issue: 'snapshot' | 'event' | 'media' | 'autoplay' | null; issueAt: number | null; activationFailed: boolean; stateFailed: boolean; dropped?: number;
}
export interface OverlayConnections {
  checkedAt: number; pollingFailed: boolean;
  scenes: { id: string; published: boolean; revision: number; width: number; height: number; receives: string[]; sources: OverlaySourceConnection[] }[];
}
export type Snapshot = NonNullable<OverlayScene['published']>;
@Injectable({ providedIn: 'root' })
export class OverlayApi {
  private readonly http = inject(HttpClient);
  readonly base = inject(LinksService).getApiUrl();
  request<T>(method: string, path: string, body?: unknown, timeoutMs = 20000): Promise<T> {
    return firstValueFrom(this.http.request<{ data: T }>(method, `${this.base}/overlay-studio/${path}`, { body }).pipe(timeout(timeoutMs), map(r => r.data)));
  }
  load(channel: string) { return this.request<StudioState>('GET', channel); }
  connections(channel: string) { return this.request<OverlayConnections>('GET', `${channel}/connections`); }
  queue(channel: string) { return this.request<QueueStatus>('GET', `${channel}/queue`); }
  control(channel: string, action: OverlayAction, platform: OverlayScope) { return this.request<QueueStatus>('POST', `${channel}/queue`, { action, platform }); }
  save(channel: string, state: StudioState) { return this.request<StudioState>('PUT', channel, state); }
  action(channel: string, scene: string, revision: number, action: 'publish' | 'rotate') { return this.request<StudioState>('POST', `${channel}/scenes/${scene}/${action}`, { revision }); }
  render(channel: string, texts: string[], kind: AlertEvent, user: string, amount: string, tier = '1000') { return this.request<string[]>('POST', `${channel}/preview`, { texts, kind, user, amount, tier }); }
}
