import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, of } from 'rxjs';

import { LinksService } from './links.service';

export interface TimerRecord {
  name: string;
  frequency: number;
  minutes?: number;
  message: string;
  active: boolean;
}

interface ApiEnvelope<T> {
  error?: boolean;
  message?: string;
  status?: number;
  data?: T;
  timers?: T;
}

@Injectable({ providedIn: 'root' })
export class TimersApiService {
  private readonly http = inject(HttpClient);
  private readonly links = inject(LinksService);

  listTimers(channelID: string): Observable<TimerRecord[]> {
    return this.http
      .get<ApiEnvelope<TimerRecord[]>>(`${this.links.getApiUrl()}/timers/${encodeURIComponent(channelID)}`)
      .pipe(
        map((response) => {
          const rows = response.data ?? response.timers;
          return Array.isArray(rows) ? rows.map((row) => this.normalize(row)) : [];
        }),
        catchError(() => of([]))
      );
  }

  createTimer(
    channelID: string,
    name: string,
    frequency: number,
    message: string
  ): Observable<{ ok: boolean; message?: string; timer?: TimerRecord }> {
    return this.http
      .post<ApiEnvelope<TimerRecord>>(`${this.links.getApiUrl()}/timers/${encodeURIComponent(channelID)}`, {
        name,
        frequency,
        message
      })
      .pipe(
        map((response) => ({
          ok: !response.error && Boolean(response.data),
          message: response.message,
          timer: response.data ? this.normalize(response.data) : undefined
        })),
        catchError((error: { error?: { message?: string } }) =>
          of({ ok: false, message: error?.error?.message || 'Failed to create timer' })
        )
      );
  }

  updateTimer(
    channelID: string,
    timerName: string,
    patch: { frequency?: number; message?: string }
  ): Observable<{ ok: boolean; message?: string; timer?: TimerRecord }> {
    return this.http
      .patch<ApiEnvelope<TimerRecord>>(
        `${this.links.getApiUrl()}/timers/${encodeURIComponent(channelID)}/${encodeURIComponent(timerName)}`,
        patch
      )
      .pipe(
        map((response) => ({
          ok: !response.error && Boolean(response.data),
          message: response.message,
          timer: response.data ? this.normalize(response.data) : undefined
        })),
        catchError((error: { error?: { message?: string } }) =>
          of({ ok: false, message: error?.error?.message || 'Failed to update timer' })
        )
      );
  }

  deleteTimer(channelID: string, timerName: string): Observable<boolean> {
    return this.http
      .delete<ApiEnvelope<unknown>>(
        `${this.links.getApiUrl()}/timers/${encodeURIComponent(channelID)}/${encodeURIComponent(timerName)}`
      )
      .pipe(
        map((response) => !response.error),
        catchError(() => of(false))
      );
  }

  private normalize(row: Partial<TimerRecord> & { name?: string }): TimerRecord {
    const frequency = Number(row.frequency) || 0;
    const minutes = Number(row.minutes);
    return {
      name: String(row.name || '').toLowerCase(),
      frequency,
      minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : frequency,
      message: String(row.message || ''),
      active: row.active !== false
    };
  }
}
