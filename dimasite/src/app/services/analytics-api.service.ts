import { StreamTimeline, TimelineResponse, TimelineStreamList } from '../models/stream-timeline.model';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';

import { FollowLedgerQuery, FollowLedgerResponse } from '../models/follow-ledger.model';
import { LinksService } from './links.service';

@Injectable({
  providedIn: 'root'
})
export class AnalyticsApiService {
  private readonly http = inject(HttpClient);
  private readonly linksService = inject(LinksService);

  getFollowLedger(channelID: string, query: FollowLedgerQuery = {}) {
    const params = new URLSearchParams();

    if (query.status) {
      params.set('status', query.status);
    }
    if (query.mutual && query.mutual !== 'all') {
      params.set('mutual', query.mutual);
    }
    if (query.order) {
      params.set('order', query.order);
    }
    if (query.search?.trim()) {
      params.set('search', query.search.trim());
    }
    if (query.page) {
      params.set('page', String(query.page));
    }
    if (query.limit) {
      params.set('limit', String(query.limit));
    }

    const search = params.toString();
    const url = `${this.linksService.getApiUrl()}/analytics/follows/${encodeURIComponent(channelID.trim())}`;

    return this.http
      .get<FollowLedgerResponse>(search ? `${url}?${search}` : url)
      .pipe(catchError((error) => throwError(() => this.toRequestError(error))));
  }

  private timelineUrl(channel: string): string { return `${this.linksService.getApiUrl()}/analytics/streams/${encodeURIComponent(channel)}`; }
  getTimelineStreams(channel: string, page: number) { return this.http.get<TimelineResponse<TimelineStreamList>>(`${this.timelineUrl(channel)}?page=${page}`); }
  getStreamTimeline(channel: string, session: string) { return this.http.get<TimelineResponse<StreamTimeline>>(`${this.timelineUrl(channel)}/${encodeURIComponent(session)}`); }
  saveTimelineMarker(channel: string, session: string, key: string, body: { label: string; offsetSeconds: number }) {
    return this.http.put<TimelineResponse<unknown>>(`${this.timelineUrl(channel)}/${encodeURIComponent(session)}/markers/${encodeURIComponent(key)}`, body);
  }
  deleteTimelineMarker(channel: string, session: string, id: string) {
    return this.http.delete<TimelineResponse<unknown>>(`${this.timelineUrl(channel)}/${encodeURIComponent(session)}/markers/${encodeURIComponent(id)}`);
  }

  private toRequestError(error: unknown): Error {
    if (error instanceof HttpErrorResponse) {
      const serverMessage = typeof error.error?.message === 'string' ? error.error.message : null;
      return new Error(serverMessage || error.message || 'Failed to load analytics data');
    }

    if (error instanceof Error) {
      return error;
    }

    return new Error('Failed to load analytics data');
  }
}
