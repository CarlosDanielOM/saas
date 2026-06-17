import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { catchError, map, throwError } from 'rxjs';

import {
  AiPersonalityResponse,
  UpdateAiPersonalityRequest
} from '../models/ai-personality.model';
import { LinksService } from './links.service';

@Injectable({
  providedIn: 'root'
})
export class AiPersonalityApiService {
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
    return this.http
      .get<AiPersonalityResponse>(`${this.linksService.getApiUrl()}/ai-personality/${channelID.trim()}`)
      .pipe(
        map((response) => {
          if (response.error || !response.data) {
            throw new Error(response.message || 'Failed to load AI personality settings');
          }

          return response.data;
        }),
        catchError((error) =>
          throwError(() => this.toRequestError(error, 'Failed to load AI personality settings'))
        )
      );
  }

  updateSettings(channelID: string, payload: UpdateAiPersonalityRequest) {
    return this.http
      .put<AiPersonalityResponse>(`${this.linksService.getApiUrl()}/ai-personality/${channelID.trim()}`, payload)
      .pipe(
        map((response) => {
          if (response.error || !response.data) {
            throw new Error(response.message || 'Failed to update AI personality settings');
          }

          return response.data;
        }),
        catchError((error) =>
          throwError(() => this.toRequestError(error, 'Failed to update AI personality settings'))
        )
      );
  }
}
