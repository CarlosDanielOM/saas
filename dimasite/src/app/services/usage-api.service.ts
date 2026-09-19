import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';

import {
  AiUsageSummaryResponse,
  AiUsageTransactionsResponse
} from '../models/usage.model';
import { LinksService } from './links.service';

export interface UsageRangeQuery {
  from?: string;
  to?: string;
  timeZone?: string;
}

export interface UsageTransactionsQuery extends UsageRangeQuery {
  category?: string;
  cursor?: string;
  limit?: number;
}

@Injectable({
  providedIn: 'root'
})
export class UsageApiService {
  private readonly http = inject(HttpClient);
  private readonly linksService = inject(LinksService);

  getSummary(channelID: string, query: UsageRangeQuery = {}) {
    return this.http.get<AiUsageSummaryResponse>(
      `${this.linksService.getApiUrl()}/billing/ai-usage/summary`,
      { params: this.buildParams(channelID, query) }
    );
  }

  getTransactions(channelID: string, query: UsageTransactionsQuery = {}) {
    return this.http.get<AiUsageTransactionsResponse>(
      `${this.linksService.getApiUrl()}/billing/ai-usage/transactions`,
      { params: this.buildParams(channelID, query) }
    );
  }

  private buildParams(
    channelID: string,
    query: UsageRangeQuery & { category?: string; cursor?: string; limit?: number }
  ): HttpParams {
    let params = new HttpParams().set('channelID', channelID);

    if (query.from) {
      params = params.set('from', query.from);
    }
    if (query.to) {
      params = params.set('to', query.to);
    }
    if (query.timeZone) {
      params = params.set('timezone', query.timeZone);
    }
    if (query.category) {
      params = params.set('category', query.category);
    }
    if (query.cursor) {
      params = params.set('cursor', query.cursor);
    }
    if (typeof query.limit === 'number') {
      params = params.set('limit', String(query.limit));
    }

    return params;
  }
}
