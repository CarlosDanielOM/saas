import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { LinksService } from './links.service';
import type {
  VariationMode,
  VariationResponse,
  ModerationLogsResponse,
  ModerationDecisionsResponse,
  ModerationSettingsPayload,
  ModerationSettingsResponse
} from '../models/moderation.model';

@Injectable({
  providedIn: 'root'
})
export class ModerationApiService {
  private readonly http = inject(HttpClient);
  private readonly linksService = inject(LinksService);

  private getApiUrl(): string {
    return this.linksService.getApiUrl();
  }

  getSettings(channelID: string): Observable<ModerationSettingsResponse> {
    return this.http.get<ModerationSettingsResponse>(
      `${this.getApiUrl()}/moderation/${encodeURIComponent(channelID)}/settings`
    );
  }

  updateSettings(
    channelID: string,
    payload: ModerationSettingsPayload
  ): Observable<ModerationSettingsResponse> {
    return this.http.put<ModerationSettingsResponse>(
      `${this.getApiUrl()}/moderation/${encodeURIComponent(channelID)}/settings`,
      payload
    );
  }

  prepareVariations(channelID: string, terms: string[], mode: VariationMode, allowSpaces = false): Observable<VariationResponse> {
    return this.http.post<VariationResponse>(`${this.getApiUrl()}/moderation/${encodeURIComponent(channelID)}/variations`, { terms, mode, allowSpaces });
  }

  getVariationJob(channelID: string, jobID: string, allowSpaces = false): Observable<VariationResponse> {
    return this.http.get<VariationResponse>(`${this.getApiUrl()}/moderation/${encodeURIComponent(channelID)}/variations/${encodeURIComponent(jobID)}`, { params: { allowSpaces } });
  }

  getLogs(channelID: string, page = 1, limit = 20): Observable<ModerationLogsResponse> {
    const skip = Math.max(0, (page - 1) * limit);
    const params = new HttpParams().set('limit', limit.toString()).set('skip', skip.toString());

    return this.http.get<ModerationLogsResponse>(
      `${this.getApiUrl()}/moderation/${encodeURIComponent(channelID)}/logs`,
      { params }
    );
  }

  getDecisions(channelID: string, page = 1, limit = 10): Observable<ModerationDecisionsResponse> {
    const params = new HttpParams().set('limit', limit).set('skip', Math.max(0, (page - 1) * limit));
    return this.http.get<ModerationDecisionsResponse>(`${this.getApiUrl()}/moderation/${encodeURIComponent(channelID)}/decisions`, { params });
  }
}
