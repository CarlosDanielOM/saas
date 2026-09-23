import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { map } from 'rxjs';

import type { TwitchAccountRef } from '../models/permission-expression.model';
import { LinksService } from './links.service';

interface LookupResponse {
  error: boolean;
  data?: { id?: unknown; username?: unknown };
}

@Injectable({ providedIn: 'root' })
export class TwitchAccountLookupService {
  private readonly http = inject(HttpClient);
  private readonly links = inject(LinksService);

  lookup(rawLogin: string) {
    const login = rawLogin.trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_]{1,25}$/.test(login)) {
      throw new Error('invalid-login');
    }

    return this.http.get<LookupResponse>(
      `${this.links.getApiUrl()}/users?username=${encodeURIComponent(login)}`
    ).pipe(map((response): TwitchAccountRef => {
      const id = response.data?.id;
      const resolvedLogin = response.data?.username;
      if (response.error || typeof id !== 'string' || !/^\d{1,20}$/.test(id) ||
        typeof resolvedLogin !== 'string' || !/^[a-zA-Z0-9_]{1,25}$/.test(resolvedLogin)) {
        throw new Error('account-not-found');
      }
      return { id, login: resolvedLogin.toLowerCase() };
    }));
  }
}
