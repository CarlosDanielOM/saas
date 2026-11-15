import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { LinksService } from '../../services/links.service';
import type { ApiEnvelope, TriggerLookErrorCode, TriggerLookSaveRequest, TriggerLookState } from './triggers.model';

/** A failed look request: `code` from the API (or `too_large` for the proxy's HTML 413), `status` the HTTP status. */
export class TriggerLookError extends Error {
  constructor(message: string, readonly status: number, readonly code: TriggerLookErrorCode | null) { super(message); }
}

/**
 * The look routes under `/triggers` (channel owners and channel admins with trigger permissions). These never touch
 * Overlay Studio routes: the look editor on the Triggers page must work for admins, and Studio APIs are owner-only.
 */
@Injectable({ providedIn: 'root' })
export class TriggerLooksService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(LinksService).getApiUrl();

  private url(channelID: string, triggerID: string): string {
    return `${this.base}/triggers/${encodeURIComponent(channelID)}/${encodeURIComponent(triggerID)}/look`;
  }

  get(channelID: string, triggerID: string): Promise<TriggerLookState> {
    return this.call(this.http.get<ApiEnvelope<TriggerLookState>>(this.url(channelID, triggerID)));
  }

  save(channelID: string, triggerID: string, body: TriggerLookSaveRequest): Promise<TriggerLookState> {
    return this.call(this.http.put<ApiEnvelope<TriggerLookState>>(this.url(channelID, triggerID), body));
  }

  remove(channelID: string, triggerID: string, revision: number): Promise<TriggerLookState> {
    return this.call(this.http.delete<ApiEnvelope<TriggerLookState>>(this.url(channelID, triggerID), { params: { revision } }));
  }

  /** Text objects of a look as they show on stream (empty event data). */
  async render(channelID: string, texts: string[]): Promise<string[]> {
    const response = await firstValueFrom(this.http.post<ApiEnvelope<string[]>>(`${this.base}/triggers/${encodeURIComponent(channelID)}/look/render`, { texts }));
    if (response.error || !Array.isArray(response.data) || response.data.length !== texts.length || response.data.some(v => typeof v !== 'string')) throw new Error('Invalid render response');
    return response.data;
  }

  private async call(request: ReturnType<HttpClient['get']>): Promise<TriggerLookState> {
    try {
      const response = await firstValueFrom(request) as ApiEnvelope<TriggerLookState>;
      if (response.error || !response.data) throw new TriggerLookError(response.message || 'Request failed', response.status ?? 500, null);
      const data = response.data;
      // `revision` is the trigger's counter; older API builds only had it on the look.
      const revision = Number.isSafeInteger(data.revision) ? data.revision : data.look?.revision ?? 0;
      return { look: data.look ?? null, volume: Number.isFinite(Number(data.volume)) ? Number(data.volume) : 100, revision };
    } catch (error) {
      if (error instanceof TriggerLookError) throw error;
      const http = error as HttpErrorResponse;
      const body = http?.error && typeof http.error === 'object' ? http.error as { message?: string; code?: string } : null;
      const code = http?.status === 413 ? 'too_large' : (body?.code as TriggerLookErrorCode | undefined) ?? null;
      throw new TriggerLookError(body?.message || http?.message || 'Request failed', http?.status ?? 0, code);
    }
  }
}
