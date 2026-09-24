import { HttpErrorResponse, HttpHeaders, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { catchError, map, throwError } from 'rxjs';

import { FishVoiceResults, FishVoiceFilters, FishVoiceFavorite, TtsSettings, TtsSettingsResponse } from '../models/tts-settings.model';
import { ApiEnvelope } from '../models/admin.model';
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

  searchVoices(channelID: string, filters: FishVoiceFilters) {
    return this.http.get<ApiEnvelope<FishVoiceResults>>(`${this.linksService.getApiUrl()}/speech/voices/${channelID}`, {
      params: { ...filters }
    }).pipe(map(response => {
      if (response.error || !response.data) throw new Error('catalog_unavailable');
      return response.data;
    }));
  }

  getFavorites(channelID: string) {
    return this.http.get<ApiEnvelope<FishVoiceFavorite[]>>(`${this.linksService.getApiUrl()}/speech/favorites/${channelID}`)
      .pipe(map(response => response.data ?? []));
  }

  addFavorite(channelID: string, id: string) {
    return this.http.post<ApiEnvelope<FishVoiceFavorite>>(`${this.linksService.getApiUrl()}/speech/favorites/${channelID}`, { id })
      .pipe(map(response => {
        if (!response.data) throw new Error('favorite_save_failed');
        return response.data;
      }));
  }

  renameFavorite(channelID: string, id: string, alias: string) {
    return this.http.patch<ApiEnvelope<FishVoiceFavorite>>(`${this.linksService.getApiUrl()}/speech/favorites/${channelID}/${id}`, { alias })
      .pipe(
        map(response => {
          if (!response.data) throw new Error('favorite_rename_failed');
          return response.data;
        }),
        catchError(error => {
          const requestError = this.toRequestError(error, 'Could not rename favorite voice');
          if (error instanceof HttpErrorResponse && typeof error.error?.code === 'string') {
            Object.assign(requestError, { code: error.error.code });
          }
          return throwError(() => requestError);
        })
      );
  }

  removeFavorite(channelID: string, id: string) {
    return this.http.delete<ApiEnvelope<FishVoiceFavorite[]>>(`${this.linksService.getApiUrl()}/speech/favorites/${channelID}/${id}`)
      .pipe(map(response => response.data ?? []));
  }

  createPreviewSession(channelID: string) {
    return this.http.post<ApiEnvelope<{ ticket: string }>>(`${this.linksService.getApiUrl()}/speech/preview-session/${channelID}`, {}).pipe(map(response => {
      if (response.error || !response.data) throw new Error('preview_unavailable');
      return response.data;
    }));
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
