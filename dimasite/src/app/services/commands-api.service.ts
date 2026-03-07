import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { catchError, map, of, tap } from 'rxjs';

import { Command, CreateCommandRequest, UpdateCommandRequest } from '../models/command.model';
import { LinksService } from './links.service';

interface ApiEnvelope<T> {
  error: boolean;
  message?: string;
  status?: number;
  data?: T;
}

interface CommandsListResponse {
  commands: Command[];
}

interface LegacyCommandsResponse {
  commands?: Command[];
  command?: Command;
}

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

@Injectable({
  providedIn: 'root'
})
export class CommandsApiService {
  private readonly http = inject(HttpClient);
  private readonly linksService = inject(LinksService);
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  private readonly cache = new Map<string, CacheEntry<unknown>>();

  readonly listLoading = signal(false);
  readonly listError = signal<string | null>(null);

  private extractCommands(response: ApiEnvelope<CommandsListResponse> & LegacyCommandsResponse): Command[] {
    if (response.error) {
      throw new Error(response.message || 'Failed to load commands');
    }

    if (Array.isArray(response.data?.commands)) {
      return response.data.commands;
    }

    if (Array.isArray(response.commands)) {
      return response.commands;
    }

    return [];
  }

  private extractCommand(response: ApiEnvelope<{ command: Command }> & LegacyCommandsResponse, fallbackMessage: string): Command {
    if (response.error) {
      throw new Error(response.message || fallbackMessage);
    }

    const command = response.data?.command ?? response.command;

    if (!command) {
      throw new Error(response.message || fallbackMessage);
    }

    return command;
  }

  private getCacheKey(channelID: string): string {
    return `commands:${channelID}`;
  }

  private isCacheValid(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    return Date.now() - entry.timestamp < this.CACHE_TTL_MS;
  }

  private getFromCache<T>(key: string): T | null {
    if (this.isCacheValid(key)) {
      return this.cache.get(key)?.data as T;
    }
    return null;
  }

  private setCache<T>(key: string, data: T): void {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  private updateCachedCommands(channelID: string, updater: (commands: Command[]) => Command[]): void {
    const cacheKey = this.getCacheKey(channelID);
    const cached = this.getFromCache<Command[]>(cacheKey);

    if (!cached) {
      return;
    }

    this.setCache(cacheKey, updater(cached));
  }

  getCommands(channelID: string, skipCache = false) {
    const cacheKey = this.getCacheKey(channelID);

    if (!skipCache) {
      const cached = this.getFromCache<Command[]>(cacheKey);
      if (cached) {
        return of(cached);
      }
    }

    this.listLoading.set(true);
    this.listError.set(null);

    return this.http
      .get<ApiEnvelope<CommandsListResponse> & LegacyCommandsResponse>(
        `${this.linksService.getApiUrl()}/commands/${channelID}`
      )
      .pipe(
        map((response) => this.extractCommands(response)),
        tap((commands) => {
          this.setCache(cacheKey, commands);
          this.listLoading.set(false);
        }),
        catchError((err) => {
          this.listLoading.set(false);
          this.listError.set(err.message || 'Failed to load commands');
          return of([]);
        })
      );
  }

  createCommand(channelID: string, command: CreateCommandRequest) {
    return this.http
      .post<ApiEnvelope<{ command: Command }> & LegacyCommandsResponse>(
        `${this.linksService.getApiUrl()}/commands/${channelID}`,
        command
      )
      .pipe(
        map((response) => this.extractCommand(response, 'Failed to create command')),
        tap((createdCommand) => {
          this.updateCachedCommands(channelID, (commands) => [...commands, createdCommand]);
        }),
        catchError(() => of(null))
      );
  }

  updateCommand(channelID: string, commandID: string, updates: UpdateCommandRequest) {
    return this.http
      .put<ApiEnvelope<{ command: Command }> & LegacyCommandsResponse>(
        `${this.linksService.getApiUrl()}/commands/${channelID}/${commandID}`,
        updates
      )
      .pipe(
        map((response) => this.extractCommand(response, 'Failed to update command')),
        tap((updatedCommand) => {
          this.updateCachedCommands(channelID, (commands) =>
            commands.map((command) =>
              command.id === commandID || command._id === commandID ? updatedCommand : command
            )
          );
        }),
        catchError(() => of(null))
      );
  }

  deleteCommand(channelID: string, commandID: string) {
    return this.http
      .delete<ApiEnvelope<{ success: boolean }>>(
        `${this.linksService.getApiUrl()}/commands/${channelID}/${commandID}`
      )
      .pipe(
        map((response) => {
          if (response.error) {
            throw new Error(response.message || 'Failed to delete command');
          }
          return true;
        }),
        tap(() => {
          this.updateCachedCommands(channelID, (commands) =>
            commands.filter((command) => command.id !== commandID && command._id !== commandID)
          );
        }),
        catchError(() => of(false))
      );
  }

  enableCommand(channelID: string, commandID: string) {
    return this.updateCommand(channelID, commandID, { enabled: true });
  }

  disableCommand(channelID: string, commandID: string) {
    return this.updateCommand(channelID, commandID, { enabled: false });
  }

  refreshCommands(channelID: string) {
    return this.getCommands(channelID, true);
  }

  clearAllCache(): void {
    this.cache.clear();
  }
}
