import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal, type Signal } from '@angular/core';

import { LinksService } from './links.service';

/** Twitch profile images by login, fetched once per session (letter fallback on failure). */
@Injectable({ providedIn: 'root' })
export class AvatarService {
  private readonly http = inject(HttpClient);
  private readonly links = inject(LinksService);
  private readonly cache = new Map<string, Signal<string | null>>();

  get(login: string): Signal<string | null> {
    const key = login.trim().toLowerCase();
    const cached = this.cache.get(key);
    if (cached) return cached;
    const url = signal<string | null>(null);
    this.cache.set(key, url);
    if (key) {
      this.http
        .get<{ data?: { profile_image_url?: string } }>(
          `${this.links.getApiUrl()}/users?username=${encodeURIComponent(key)}`,
        )
        .subscribe({
          next: (response) => url.set(response?.data?.profile_image_url || null),
          error: () => url.set(null),
        });
    }
    return url;
  }
}
