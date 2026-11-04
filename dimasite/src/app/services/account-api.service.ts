import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { LinksService } from './links.service';

interface ApiEnvelope<T> {
  error: boolean;
  message?: string;
  status?: number;
  data?: T;
}

/** Per-collection counts returned by the API; only used for logging/debugging. */
export type AccountCleanupCounts = Record<string, number>;

/** Account-level actions for the signed-in user (the token owner), not the viewed channel. */
@Injectable({
  providedIn: 'root'
})
export class AccountApiService {
  private readonly http = inject(HttpClient);
  private readonly links = inject(LinksService);

  /** Clears commands, redemptions, triggers, media and team; re-creates Twitch events and default commands. */
  factoryReset(): Observable<ApiEnvelope<AccountCleanupCounts>> {
    return this.http.post<ApiEnvelope<AccountCleanupCounts>>(`${this.links.getApiUrl()}/auth/factory-reset`, {});
  }

  /** Permanently deletes the account: revokes bot access, removes Twitch events and all channel data. */
  deleteAccount(): Observable<ApiEnvelope<AccountCleanupCounts>> {
    return this.http.delete<ApiEnvelope<AccountCleanupCounts>>(`${this.links.getApiUrl()}/auth/account`);
  }
}
