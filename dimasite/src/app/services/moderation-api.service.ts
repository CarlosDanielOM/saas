import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { LinksService } from './links.service';
import type {
  ModerationLogsResponse,
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

  getLogs(channelID: string, page = 1, limit = 20): Observable<ModerationLogsResponse> {
    const skip = Math.max(0, (page - 1) * limit);
    const params = new HttpParams().set('limit', limit.toString()).set('skip', skip.toString());

    return this.http.get<ModerationLogsResponse>(
      `${this.getApiUrl()}/moderation/${encodeURIComponent(channelID)}/logs`,
      { params }
    );
  }
}
