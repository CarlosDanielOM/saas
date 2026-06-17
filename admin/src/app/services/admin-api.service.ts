import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { LinksService } from './links.service';

export interface AdminUserRow {
  channelID: string;
  channel: string;
  email: string;
  plan_tier: 'free' | 'premium' | 'pro';
  actived: boolean;
  chat_enabled: boolean;
  has_permissions: boolean;
  up_to_date_permissions: boolean;
  reminder_sent_at?: string | Date | null;
  created_at?: Date;
  updated_at?: Date;
  isLive: boolean;
  liveViewers: number;
  commandsCount: number;
  eventsubsActiveCount: number;
  eventsubsDisabledCount: number;
}

export interface AdminUsersSummary {
  totalChannels: number;
  activeBots: number;
  inactiveBots: number;
  withPermissions: number;
  permissionsNeedUpdate: number;
  liveChannels: number;
  liveViewers: number;
  totalCommands: number;
  totalEventsubsActive: number;
  totalEventsubsDisabled: number;
}

export interface AdminUsersResponse {
  rows: AdminUserRow[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  summary: AdminUsersSummary;
}

export interface AdminUsersParams {
  page?: number;
  limit?: number;
  search?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

@Injectable({
  providedIn: 'root'
})
export class AdminApiService {
  private readonly http = inject(HttpClient);
  private readonly linksService = inject(LinksService);

  getUsers(params: AdminUsersParams = {}): Observable<{ data: AdminUsersResponse }> {
    const queryParams = new URLSearchParams();

    if (params.page) queryParams.set('page', String(params.page));
    if (params.limit) queryParams.set('limit', String(params.limit));
    if (params.search) queryParams.set('search', params.search);
    if (params.sortBy) queryParams.set('sortBy', params.sortBy);
    if (params.sortOrder) queryParams.set('sortOrder', params.sortOrder);

    const query = queryParams.toString();
    const url = `${this.linksService.getApiUrl()}/admin-site/users${query ? `?${query}` : ''}`;

    return this.http.get<{ data: AdminUsersResponse }>(url);
  }

  sendReminder(channelID: string): Observable<{ data: { message: string } }> {
    const url = `${this.linksService.getApiUrl()}/admin-site/users/${encodeURIComponent(channelID)}/send-reminder`;
    return this.http.post<{ data: { message: string } }>(url, {});
  }
}