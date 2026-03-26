import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { catchError, map, of, tap, throwError } from 'rxjs';

import { AdminCandidate, AdminListResponse, AdminRecord, ApiEnvelope } from '../models/admin.model';
import { LinksService } from './links.service';

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

@Injectable({
  providedIn: 'root'
})
export class AdminApiService {
  private readonly http = inject(HttpClient);
  private readonly linksService = inject(LinksService);
  private readonly CACHE_TTL_MS = 5 * 60 * 1000;
  private readonly adminCache = new Map<string, CacheEntry<AdminRecord[]>>();
  private readonly candidateCache = new Map<string, CacheEntry<AdminCandidate[]>>();

  private getAdminsCacheKey(channelID: string): string {
    return `admins:${channelID}`;
  }

  private getCandidatesCacheKey(channelID: string): string {
    return `admin-candidates:${channelID}`;
  }

  private isCacheValid<T>(cache: Map<string, CacheEntry<T>>, key: string): boolean {
    const entry = cache.get(key);
    if (!entry) {
      return false;
    }

    return Date.now() - entry.timestamp < this.CACHE_TTL_MS;
  }

  private getFromCache<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
    if (!this.isCacheValid(cache, key)) {
      return null;
    }

    return cache.get(key)?.data ?? null;
  }

  private setCache<T>(cache: Map<string, CacheEntry<T>>, key: string, data: T): void {
    cache.set(key, {
      data,
      timestamp: Date.now()
    });
  }

  private normalizeAdminRecord(source: Partial<AdminRecord>): AdminRecord {
    const rawPermissions = source.permissions;
    let permissions: string[] = [];

    if (Array.isArray(rawPermissions)) {
      permissions = rawPermissions.filter((value): value is string => typeof value === 'string');
    } else if (typeof rawPermissions === 'string') {
      try {
        const parsed = JSON.parse(rawPermissions);
        if (Array.isArray(parsed)) {
          permissions = parsed.filter((value): value is string => typeof value === 'string');
        }
      } catch {
        permissions = [];
      }
    }

    return {
      _id: typeof source._id === 'string' ? source._id : undefined,
      adminName: String(source.adminName || '').trim(),
      adminID: String(source.adminID || '').trim(),
      channelName: String(source.channelName || '').trim(),
      channelID: String(source.channelID || '').trim(),
      actived: source.actived !== false,
      permissions,
      createdAt: typeof source.createdAt === 'string' ? source.createdAt : undefined,
      updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : undefined
    };
  }

  private normalizeCandidate(source: Partial<AdminCandidate>): AdminCandidate | null {
    const id = String(source.id || '').trim();
    const login = String(source.login || '').trim();
    const displayName = String(source.display_name || source.login || '').trim();

    if (!id || !login) {
      return null;
    }

    return {
      id,
      login,
      display_name: displayName || login
    };
  }

  private sortAdmins(admins: AdminRecord[]): AdminRecord[] {
    return [...admins].sort((left, right) => left.adminName.localeCompare(right.adminName));
  }

  private sortCandidates(candidates: AdminCandidate[]): AdminCandidate[] {
    return [...candidates].sort((left, right) => left.login.localeCompare(right.login));
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

  getAdmins(channelID: string, skipCache = false) {
    const normalizedChannelID = channelID.trim();
    const cacheKey = this.getAdminsCacheKey(normalizedChannelID);

    if (!skipCache) {
      const cached = this.getFromCache(this.adminCache, cacheKey);
      if (cached) {
        return of(cached);
      }
    }

    return this.http
      .get<AdminListResponse>(
        `${this.linksService.getApiUrl()}/admins/${normalizedChannelID}?page=1&limit=1000&sort=updatedAt&order=desc`
      )
      .pipe(
        map((response) => {
          if (response.error) {
            throw new Error(response.message || 'Failed to load admins');
          }

          return this.sortAdmins((response.data || []).map((entry) => this.normalizeAdminRecord(entry)));
        }),
        tap((admins) => {
          this.setCache(this.adminCache, cacheKey, admins);
        }),
        catchError((error) => throwError(() => this.toRequestError(error, 'Failed to load admins')))
      );
  }

  getCandidates(channelID: string, skipCache = false) {
    const normalizedChannelID = channelID.trim();
    const cacheKey = this.getCandidatesCacheKey(normalizedChannelID);

    if (!skipCache) {
      const cached = this.getFromCache(this.candidateCache, cacheKey);
      if (cached) {
        return of(cached);
      }
    }

    return this.http
      .get<ApiEnvelope<AdminCandidate[]>>(`${this.linksService.getApiUrl()}/admins/${normalizedChannelID}/candidates`)
      .pipe(
        map((response) => {
          if (response.error) {
            throw new Error(response.message || 'Failed to load admin candidates');
          }

          return this.sortCandidates(
            (response.data || [])
              .map((entry) => this.normalizeCandidate(entry))
              .filter((entry): entry is AdminCandidate => entry !== null)
          );
        }),
        tap((candidates) => {
          this.setCache(this.candidateCache, cacheKey, candidates);
        }),
        catchError((error) => throwError(() => this.toRequestError(error, 'Failed to load admin candidates')))
      );
  }

  addAdmin(channelID: string, channelName: string, candidate: AdminCandidate) {
    const normalizedChannelID = channelID.trim();

    return this.http
      .post<ApiEnvelope<void>>(`${this.linksService.getApiUrl()}/admins/${normalizedChannelID}`, {
        channelName,
        adminName: candidate.login
      })
      .pipe(
        map((response) => {
          if (response.error) {
            throw new Error(response.message || 'Failed to add admin');
          }

          return true;
        }),
        tap(() => {
          const nextAdmin: AdminRecord = {
            adminName: candidate.login,
            adminID: candidate.id,
            channelName,
            channelID: normalizedChannelID,
            actived: true,
            permissions: ['*']
          };

          const adminsKey = this.getAdminsCacheKey(normalizedChannelID);
          const cachedAdmins = this.getFromCache(this.adminCache, adminsKey);
          if (cachedAdmins) {
            const deduped = cachedAdmins.filter((entry) => entry.adminID !== candidate.id);
            this.setCache(this.adminCache, adminsKey, this.sortAdmins([...deduped, nextAdmin]));
          }

          const candidatesKey = this.getCandidatesCacheKey(normalizedChannelID);
          const cachedCandidates = this.getFromCache(this.candidateCache, candidatesKey);
          if (cachedCandidates) {
            this.setCache(
              this.candidateCache,
              candidatesKey,
              cachedCandidates.filter((entry) => entry.id !== candidate.id)
            );
          }
        }),
        catchError((error) => throwError(() => this.toRequestError(error, 'Failed to add admin')))
      );
  }

  deleteAdmin(channelID: string, admin: AdminRecord) {
    const normalizedChannelID = channelID.trim();

    return this.http
      .delete<ApiEnvelope<void>>(`${this.linksService.getApiUrl()}/admins/${normalizedChannelID}/${admin.adminID}`)
      .pipe(
        map((response) => {
          if (response.error) {
            throw new Error(response.message || 'Failed to delete admin');
          }

          return true;
        }),
        tap(() => {
          const adminsKey = this.getAdminsCacheKey(normalizedChannelID);
          const cachedAdmins = this.getFromCache(this.adminCache, adminsKey);
          if (cachedAdmins) {
            this.setCache(
              this.adminCache,
              adminsKey,
              cachedAdmins.filter((entry) => entry.adminID !== admin.adminID)
            );
          }

          const candidatesKey = this.getCandidatesCacheKey(normalizedChannelID);
          const cachedCandidates = this.getFromCache(this.candidateCache, candidatesKey);
          if (cachedCandidates) {
            const restoredCandidate: AdminCandidate = {
              id: admin.adminID,
              login: admin.adminName,
              display_name: admin.adminName
            };

            const deduped = cachedCandidates.filter((entry) => entry.id !== restoredCandidate.id);
            this.setCache(this.candidateCache, candidatesKey, this.sortCandidates([...deduped, restoredCandidate]));
          }
        }),
        catchError((error) => throwError(() => this.toRequestError(error, 'Failed to delete admin')))
      );
  }

  clearCache(channelID?: string): void {
    if (!channelID) {
      this.adminCache.clear();
      this.candidateCache.clear();
      return;
    }

    const normalizedChannelID = channelID.trim();
    this.adminCache.delete(this.getAdminsCacheKey(normalizedChannelID));
    this.candidateCache.delete(this.getCandidatesCacheKey(normalizedChannelID));
  }
}
