import { HttpErrorResponse, HttpHeaders, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { catchError, map, throwError } from 'rxjs';

import { TtsSettings, TtsSettingsResponse } from '../models/tts-settings.model';
import { LinksService } from './links.service';
import { HttpClient } from '@angular/common/http';

@Injectable({
  providedIn: 'root'
})
export class TtsSettingsApiService {
  private readonly http = inject(HttpClient);
  private readonly linksService = inject(LinksService);

  private toRequestError(error: unknown, fallbackMessage: string): Error {
    if (error instanceof HttpErrorResponse) {
      const serverMessage = typeof error.error?.message === 'string' ? error.error.message : null;
      return new Error(serverMessage || error.message || fallbackMessage);
    }

    if (error instanceof Error) {
      return error;
    }

    return new Error(fallbackMessage);
  }

  getSettings(channelID: string) {
    const cacheBuster = Date.now().toString();
    const headers = new HttpHeaders({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache'
    });
    const params = new HttpParams().set('_', cacheBuster);

    return this.http
      .get<TtsSettingsResponse>(`${this.linksService.getApiUrl()}/speech/settings/${channelID.trim()}`, {
        headers,
        params
      })
      .pipe(
        map((response) => {
          if (response.error || !response.data) {
            throw new Error(response.message || 'Failed to load TTS settings');
          }

          return response.data;
        }),
        catchError((error) => throwError(() => this.toRequestError(error, 'Failed to load TTS settings')))
      );
  }

  updateSettings(channelID: string, settings: TtsSettings) {
    return this.http
      .put<TtsSettingsResponse>(`${this.linksService.getApiUrl()}/speech/settings/${channelID.trim()}`, settings)
      .pipe(
        map((response) => {
          if (response.error || !response.data) {
            throw new Error(response.message || 'Failed to update TTS settings');
          }

          return response.data;
        }),
        catchError((error) => throwError(() => this.toRequestError(error, 'Failed to update TTS settings')))
      );
  }
}
