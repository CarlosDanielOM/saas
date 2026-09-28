import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';

import { ReferralCodeCreateResponse, ReferralPeopleResponse, ReferralStatsResponse, ReferralTimelineResponse } from '../models/referrals.model';
import { LinksService } from './links.service';

@Injectable({
  providedIn: 'root'
})
export class ReferralsApiService {
  private readonly http = inject(HttpClient);
  private readonly linksService = inject(LinksService);

  getStats(channelID: string) {
    const normalizedChannelID = channelID.trim();

    return this.http
      .get<ReferralStatsResponse>(
        `${this.linksService.getApiUrl()}/referrals/stats?channelID=${encodeURIComponent(normalizedChannelID)}`
      )
      .pipe(catchError((error) => throwError(() => this.toRequestError(error, 'Failed to load referral stats'))));
  }

  getPeople(channelID: string, page: number) {
    return this.http.get<ReferralPeopleResponse>(
      `${this.linksService.getApiUrl()}/referrals/ledger?channelID=${encodeURIComponent(channelID.trim())}&view=people&page=${page}`
    ).pipe(catchError((error) => throwError(() => this.toRequestError(error, 'Failed to load referred users'))));
  }

  getTimeline(channelID: string, page: number) {
    return this.http.get<ReferralTimelineResponse>(
      `${this.linksService.getApiUrl()}/referrals/ledger?channelID=${encodeURIComponent(channelID.trim())}&view=timeline&page=${page}`
    ).pipe(catchError((error) => throwError(() => this.toRequestError(error, 'Failed to load referral timeline'))));
  }

  createCode(channelID: string, request: { code: string; label?: string }) {
    return this.http
      .post<ReferralCodeCreateResponse>(`${this.linksService.getApiUrl()}/referrals/codes`, {
        channelID: channelID.trim(),
        code: request.code,
        label: request.label
      })
      .pipe(catchError((error) => throwError(() => this.toRequestError(error, 'Failed to create referral code'))));
  }

  deleteCode(channelID: string, codeId: string) {
    const normalizedChannelID = channelID.trim();
    const normalizedCodeID = codeId.trim();

    return this.http
      .delete<{ error: boolean; message?: string; status?: number }>(
        `${this.linksService.getApiUrl()}/referrals/codes/${encodeURIComponent(normalizedCodeID)}?channelID=${encodeURIComponent(normalizedChannelID)}`
      )
      .pipe(catchError((error) => throwError(() => this.toRequestError(error, 'Failed to delete referral code'))));
  }

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
}
