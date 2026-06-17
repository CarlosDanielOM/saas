import { HttpClient, HttpParams, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { catchError, map, throwError, Observable } from 'rxjs';

import {
  StreamSummariesListResponse,
  StreamSummariesListResponseData,
  StreamSummaryDetailResponse,
  StreamSummary
} from '../models/stream-summary.model';
import { LinksService } from './links.service';

@Injectable({
  providedIn: 'root'
})
export class StreamSummaryApiService {
  private readonly http = inject(HttpClient);
  private readonly linksService = inject(LinksService);

  private getApiUrl(): string {
    return this.linksService.getApiUrl();
  }

  private handleError(error: any, fallbackMessage: string): Observable<never> {
    console.error('API Error in StreamSummaryApiService:', error);
    const message = error?.error?.message || error?.message || fallbackMessage;
    return throwError(() => new Error(message));
  }

  getSummaries(
    channelID: string,
    limit: number = 10,
    skip: number = 0,
    status?: string
  ): Observable<StreamSummariesListResponseData> {
    let params = new HttpParams()
      .set('limit', limit.toString())
      .set('skip', skip.toString());

    if (status) {
      params = params.set('status', status);
    }

    const headers = new HttpHeaders({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache'
    });

    return this.http
      .get<StreamSummariesListResponse>(`${this.getApiUrl()}/stream-summaries/${channelID.trim()}`, {
        headers,
        params
      })
      .pipe(
        map((response) => {
          if (response.error || !response.data) {
            throw new Error(response.message || 'Failed to fetch stream summaries');
          }
          return response.data;
        }),
        catchError((error) => this.handleError(error, 'Failed to fetch stream summaries'))
      );
  }

  getSummaryDetail(channelID: string, summaryID: string): Observable<StreamSummary> {
    const headers = new HttpHeaders({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache'
    });

    return this.http
      .get<StreamSummaryDetailResponse>(
        `${this.getApiUrl()}/stream-summaries/${channelID.trim()}/${summaryID.trim()}`,
        { headers }
      )
      .pipe(
        map((response) => {
          if (response.error || !response.data) {
            throw new Error(response.message || 'Failed to fetch stream summary details');
          }
          return response.data;
        }),
        catchError((error) => this.handleError(error, 'Failed to fetch stream summary details'))
      );
  }
}
