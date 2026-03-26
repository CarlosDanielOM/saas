import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, of, throwError } from 'rxjs';
import { map, tap, shareReplay, catchError } from 'rxjs/operators';

import { LinksService } from '../../services/links.service';
import { ToastService } from '../../services/toast.service';
import {
  Redemption,
  TwitchRedemption,
  RedemptionCreateRequest,
  RedemptionUpdateRequest,
  ApiResponse,
  REDEMPTIONS_CACHE_TTL_MS,
} from './redemptions.model';

@Injectable({
  providedIn: 'root',
})
export class RedemptionsService {
  private readonly http = inject(HttpClient);
  private readonly linksService = inject(LinksService);
  private readonly toastService = inject(ToastService);
  private readonly cacheVersion = 'v2';

  private readonly redemptionsCache = new Map<string, Observable<Redemption[]>>();
  private readonly twitchCache = new Map<string, Observable<TwitchRedemption[]>>();

  readonly isLoading = signal(false);

  getRedemptions(channelId: string, forceRefresh = false): Observable<Redemption[]> {
    const normalizedId = channelId.trim();
    if (!normalizedId) {
      return throwError(() => new Error('No channel ID found'));
    }

    if (!forceRefresh) {
      const cached = this.redemptionsCache.get(normalizedId);
      if (cached) return cached;

      const sessionKey = this.getRedemptionsCacheKey(normalizedId);
      const sessionData = sessionStorage.getItem(sessionKey);
      if (sessionData) {
        const parsed = (JSON.parse(sessionData) as Redemption[]).map((item) => this.normalizeRedemption(item));
        const hydrated = of(parsed);
        this.redemptionsCache.set(normalizedId, hydrated);
        return hydrated;
      }
    }

    const redemptions$ = this.http
      .get<ApiResponse<Redemption[]>>(`${this.linksService.getApiUrl()}/rewards/${normalizedId}`)
      .pipe(
        map((res) => (res.data || []).map((item) => this.normalizeRedemption(item))),
        tap((redemptions) => {
          sessionStorage.setItem(this.getRedemptionsCacheKey(normalizedId), JSON.stringify(redemptions));
        }),
        shareReplay(1)
      );

    this.redemptionsCache.set(normalizedId, redemptions$);
    return redemptions$;
  }

  getTwitchRedemptions(channelId: string, forceRefresh = false): Observable<TwitchRedemption[]> {
    const normalizedId = channelId.trim();
    if (!normalizedId) {
      return throwError(() => new Error('No channel ID found'));
    }

    if (!forceRefresh) {
      const cached = this.twitchCache.get(normalizedId);
      if (cached) return cached;

      const sessionKey = this.getTwitchCacheKey(normalizedId);
      const sessionData = sessionStorage.getItem(sessionKey);
      if (sessionData) {
        const parsed = (JSON.parse(sessionData) as TwitchRedemption[]).map((item) => this.normalizeTwitchRedemption(item));
        const hydrated = of(parsed);
        this.twitchCache.set(normalizedId, hydrated);
        return hydrated;
      }
    }

    const twitch$ = this.http
      .get<ApiResponse<TwitchRedemption[]>>(
        `${this.linksService.getApiUrl()}/rewards/twitch/${normalizedId}`
      )
      .pipe(
        map((res) => (res.data || []).map((item) => this.normalizeTwitchRedemption(item))),
        tap((redemptions) => {
          sessionStorage.setItem(this.getTwitchCacheKey(normalizedId), JSON.stringify(redemptions));
        }),
        shareReplay(1)
      );

    this.twitchCache.set(normalizedId, twitch$);
    return twitch$;
  }

  createRedemption(
    channelId: string,
    data: RedemptionCreateRequest
  ): Observable<Redemption> {
    const normalizedId = channelId.trim();
    if (!normalizedId) {
      return throwError(() => new Error('No channel ID found'));
    }

    this.isLoading.set(true);
    return this.http
      .post<ApiResponse<Redemption>>(
        `${this.linksService.getApiUrl()}/rewards/${normalizedId}`,
        data
      )
      .pipe(
        map((res) => {
          if (res.error || !res.data) {
            throw new Error(res.message || 'Failed to create redemption');
          }
          return res.data;
        }),
        tap(() => {
          this.clearCache(normalizedId);
          this.isLoading.set(false);
        }),
        catchError((error) => {
          this.isLoading.set(false);
          const msg = error.error?.message || error.message || 'Failed to create redemption';
          this.toastService.error('Error', msg);
          return throwError(() => error);
        })
      );
  }

  updateRedemption(
    channelId: string,
    rewardId: string,
    data: RedemptionUpdateRequest
  ): Observable<Redemption> {
    const normalizedId = channelId.trim();
    if (!normalizedId || !rewardId) {
      return throwError(() => new Error('Channel ID and Reward ID are required'));
    }

    return this.http
      .patch<ApiResponse<Redemption>>(
        `${this.linksService.getApiUrl()}/rewards/${normalizedId}/${rewardId}`,
        data
      )
      .pipe(
        map((res) => {
          if (res.error || !res.data) {
            throw new Error(res.message || 'Failed to update redemption');
          }
          return res.data;
        }),
        tap(() => {
          this.clearCache(normalizedId);
        }),
        catchError((error) => {
          const msg = error.error?.message || error.message || 'Failed to update redemption';
          this.toastService.error('Error', msg);
          return throwError(() => error);
        })
      );
  }

  updateRedemptionField(
    channelId: string,
    rewardId: string,
    field: string,
    value: unknown
  ): Observable<Redemption> {
    return this.updateRedemption(channelId, rewardId, { [field]: value } as RedemptionUpdateRequest);
  }

  deleteRedemption(channelId: string, rewardId: string): Observable<void> {
    const normalizedId = channelId.trim();
    if (!normalizedId || !rewardId) {
      return throwError(() => new Error('Channel ID and Reward ID are required'));
    }

    return this.http
      .delete<ApiResponse<void>>(
        `${this.linksService.getApiUrl()}/rewards/${normalizedId}/${rewardId}`
      )
      .pipe(
        map((res) => {
          if (res.error) {
            throw new Error(res.message || 'Failed to delete redemption');
          }
        }),
        tap(() => {
          this.clearCache(normalizedId);
        }),
        catchError((error) => {
          const msg = error.error?.message || error.message || 'Failed to delete redemption';
          this.toastService.error('Error', msg);
          return throwError(() => error);
        })
      );
  }

  clearCache(channelId?: string): void {
    if (channelId) {
      const normalizedId = channelId.trim();
      this.redemptionsCache.delete(normalizedId);
      this.twitchCache.delete(normalizedId);
      sessionStorage.removeItem(this.getRedemptionsCacheKey(normalizedId));
      sessionStorage.removeItem(this.getTwitchCacheKey(normalizedId));
    } else {
      this.redemptionsCache.clear();
      this.twitchCache.clear();
      // Clear all redemptions keys from sessionStorage
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const key = sessionStorage.key(i);
        if (key?.includes('redemptions:') || key?.includes('twitch-redemptions:')) {
          sessionStorage.removeItem(key);
        }
      }
    }
  }

  validateColor(color: string): boolean {
    if (!color || !color.trim()) return false;

    const trimmed = color.trim();

    // Hex: #RGB or #RRGGBB
    const hexPattern = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
    if (hexPattern.test(trimmed)) return true;

    // RGB: rgb(r, g, b)
    const rgbPattern = /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/;
    if (rgbPattern.test(trimmed)) return true;

    // RGBA: rgba(r, g, b, a)
    const rgbaPattern = /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*(0|0?\.\d+|1)\s*\)$/;
    if (rgbaPattern.test(trimmed)) return true;

    return false;
  }

  private getRedemptionsCacheKey(channelId: string): string {
    return `redemptions:${this.cacheVersion}:${channelId}`;
  }

  private getTwitchCacheKey(channelId: string): string {
    return `twitch-redemptions:${this.cacheVersion}:${channelId}`;
  }

  private normalizeRedemption(redemption: Redemption): Redemption {
    const stableId = redemption.id || redemption.rewardID || redemption.eventsubID || `${redemption.channelID}:${redemption.title}`;
    const redemptionWithAliases = redemption as Redemption & { backgroundColor?: string };

    return {
      ...redemption,
      id: stableId,
      rewardID: redemption.rewardID || stableId,
      prompt: redemption.prompt || '',
      message: redemption.message || '',
      duration: Number(redemption.duration || 0),
      userInput: Boolean(redemption.userInput),
      skipQueue: Boolean(redemption.skipQueue),
      background_color: redemption.background_color || redemptionWithAliases.backgroundColor || '#8b5cf6',
    };
  }

  private normalizeTwitchRedemption(redemption: TwitchRedemption): TwitchRedemption {
    return {
      ...redemption,
      id: redemption.id || `${redemption.broadcaster_id}:${redemption.title}`,
      prompt: redemption.prompt || '',
      background_color: redemption.background_color || '#9146ff',
    };
  }
}
