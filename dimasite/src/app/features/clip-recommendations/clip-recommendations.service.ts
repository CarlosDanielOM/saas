import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { LinksService } from '../../services/links.service';
import {
  ApiEnvelope,
  ClipRecommendation,
  ClipRecommendationConfig,
  TwitchVodInfo
} from './clip-recommendations.model';

@Injectable({ providedIn: 'root' })
export class ClipRecommendationsService {
  private readonly http = inject(HttpClient);
  private readonly linksService = inject(LinksService);

  getConfig(channelID: string) {
    return this.http.get<ApiEnvelope<ClipRecommendationConfig>>(
      `${this.linksService.getApiUrl()}/clip-recommendations/${encodeURIComponent(channelID)}/config`
    );
  }

  updateConfig(channelID: string, autoAnalyzeEnabled: boolean) {
    return this.http.put<ApiEnvelope<unknown>>(
      `${this.linksService.getApiUrl()}/clip-recommendations/${encodeURIComponent(channelID)}/config`,
      { autoAnalyzeEnabled }
    );
  }

  list(channelID: string) {
    return this.http.get<ApiEnvelope<{ items: ClipRecommendation[]; total: number }>>(
      `${this.linksService.getApiUrl()}/clip-recommendations/${encodeURIComponent(channelID)}`
    );
  }

  listVods(channelID: string, days = 7) {
    return this.http.get<ApiEnvelope<{ days: number; vods: TwitchVodInfo[] }>>(
      `${this.linksService.getApiUrl()}/clip-recommendations/${encodeURIComponent(channelID)}/vods`,
      { params: { days: String(days) } }
    );
  }

  queue(channelID: string, vodId?: string) {
    return this.http.post<ApiEnvelope<{ estimatedCostCredits: number; vod?: TwitchVodInfo }>>(
      `${this.linksService.getApiUrl()}/clip-recommendations/${encodeURIComponent(channelID)}/queue`,
      vodId ? { vodId } : {}
    );
  }

  setCandidateStatus(channelID: string, recommendationID: string, candidateID: string, action: 'confirm' | 'deny') {
    return this.http.post<ApiEnvelope<ClipRecommendation>>(
      `${this.linksService.getApiUrl()}/clip-recommendations/${encodeURIComponent(channelID)}/${encodeURIComponent(recommendationID)}/candidates/${encodeURIComponent(candidateID)}/${action}`,
      {}
    );
  }
}