import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { LinksService } from './links.service';
import type {
  ApiEnvelope,
  FollowDefenseSettings,
  FollowDefenseSettingsResponse,
  FollowDefenseStatusResponse,
  FollowDefenseAttackLogsResponse,
  FollowDefenseHateRaidSourcesResponse,
  FollowDefenseActivateResponse,
  FollowDefenseResetResponse,
  FollowDefenseStatus,
  FollowDefenseAttackLogEntry,
  FollowDefenseHateRaidSource
} from '../models/follow-defense.model';

@Injectable({
  providedIn: 'root'
})
export class FollowDefenseApiService {
  private readonly http = inject(HttpClient);
  private readonly linksService = inject(LinksService);

  private getApiUrl(): string {
    return this.linksService.getApiUrl();
  }

  getSettings(channelID: string): Observable<FollowDefenseSettingsResponse> {
    return this.http.get<FollowDefenseSettingsResponse>(
      `${this.getApiUrl()}/follow-defense/${encodeURIComponent(channelID)}/settings`
    );
  }

  updateSettings(
    channelID: string,
    patch: Partial<FollowDefenseSettings>
  ): Observable<FollowDefenseSettingsResponse> {
    return this.http.patch<FollowDefenseSettingsResponse>(
      `${this.getApiUrl()}/follow-defense/${encodeURIComponent(channelID)}/settings`,
      patch
    );
  }

  getStatus(channelID: string): Observable<FollowDefenseStatusResponse> {
    return this.http.get<FollowDefenseStatusResponse>(
      `${this.getApiUrl()}/follow-defense/${encodeURIComponent(channelID)}/status`
    );
  }

  activateAttackMode(channelID: string): Observable<FollowDefenseActivateResponse> {
    return this.http.post<FollowDefenseActivateResponse>(
      `${this.getApiUrl()}/follow-defense/${encodeURIComponent(channelID)}/attack`,
      {}
    );
  }

  resetMode(channelID: string): Observable<FollowDefenseResetResponse> {
    return this.http.post<FollowDefenseResetResponse>(
      `${this.getApiUrl()}/follow-defense/${encodeURIComponent(channelID)}/reset`,
      {}
    );
  }

  getAttackLogs(
    channelID: string,
    page = 1,
    limit = 20
  ): Observable<FollowDefenseAttackLogsResponse> {
    const params = new HttpParams()
      .set('page', page.toString())
      .set('limit', limit.toString());

    return this.http.get<FollowDefenseAttackLogsResponse>(
      `${this.getApiUrl()}/follow-defense/${encodeURIComponent(channelID)}/attacks`,
      { params }
    );
  }

  getHateRaidSources(
    channelID: string,
    page = 1,
    limit = 20
  ): Observable<FollowDefenseHateRaidSourcesResponse> {
    const params = new HttpParams()
      .set('page', page.toString())
      .set('limit', limit.toString());

    return this.http.get<FollowDefenseHateRaidSourcesResponse>(
      `${this.getApiUrl()}/follow-defense/${encodeURIComponent(channelID)}/hate-raids`,
      { params }
    );
  }
}
