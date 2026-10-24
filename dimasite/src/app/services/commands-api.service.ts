import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, catchError, map, of, tap } from 'rxjs';

import { Command, CreateCommandRequest, UpdateCommandRequest } from '../models/command.model';
import type { RootNode } from '../features/commands/blocks/blocks.model';
import { LanguageService } from './language.service';
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

/** Why a save failed, so the block editor can point at the block or offer an upgrade. */
export interface CommandSaveError {
  status: number;
  code: string | null;
  message: string;
  blockId: string | null;
}

export type CommandSaveResult = { command: Command; error: null } | { command: null; error: CommandSaveError };

export interface BlocksImportResult {
  root: RootNode;
  advancedCount: number;
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
  private readonly languageService = inject(LanguageService);
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

  private getCacheKey(channelID: string, language: string): string {
    return `commands:${channelID}:${language}`;
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
    const cachePrefix = `commands:${channelID}:`;

    for (const [cacheKey] of this.cache.entries()) {
      if (!cacheKey.startsWith(cachePrefix)) {
        continue;
      }

      const cached = this.getFromCache<Command[]>(cacheKey);
      if (!cached) {
        continue;
      }

      this.setCache(cacheKey, updater(cached));
    }
  }

  /**
   * Get commands for a channel with pagination support.
   * By default loads up to 100 commands for client-side filtering.
   */
  getCommands(channelID: string, options: { limit?: number; skip?: number; skipCache?: boolean; activation?: 'command' | 'keyword' | 'all' } = {}) {
    const { limit = 100, skip = 0, skipCache = false, activation = 'command' } = options;
    const language = this.languageService.getCurrentLanguage();
    const cacheKey = `${this.getCacheKey(channelID, language)}:${activation}:${skip}:${limit}`;

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
        `${this.linksService.getApiUrl()}/commands/${channelID}?language=${encodeURIComponent(language)}&limit=${limit}&skip=${skip}&activation=${activation}`
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
          // A new keyword must not enter cached public !command lists.
          this.clearAllCache();
        }),
        catchError(() => of(null))
      );
  }

  updateCommand(channelID: string, commandID: string, updates: UpdateCommandRequest) {
    const language = this.languageService.getCurrentLanguage();

    return this.http
      .put<ApiEnvelope<{ command: Command }> & LegacyCommandsResponse>(
        `${this.linksService.getApiUrl()}/commands/${channelID}/${commandID}?language=${encodeURIComponent(language)}`,
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

  /** Create with error details (block saves keep the dialog open on failure). */
  createCommandDetailed(channelID: string, command: CreateCommandRequest): Observable<CommandSaveResult> {
    return this.http
      .post<ApiEnvelope<{ command: Command }> & LegacyCommandsResponse>(`${this.linksService.getApiUrl()}/commands/${channelID}`, command)
      .pipe(
        map((response): CommandSaveResult => ({ command: this.extractCommand(response, 'Failed to create command'), error: null })),
        tap(() => this.clearAllCache()),
        catchError((err: unknown) => of<CommandSaveResult>({ command: null, error: this.saveError(err) }))
      );
  }

  /** Update with error details (block saves keep the dialog open on failure). */
  updateCommandDetailed(channelID: string, commandID: string, updates: UpdateCommandRequest): Observable<CommandSaveResult> {
    const language = this.languageService.getCurrentLanguage();
    return this.http
      .put<ApiEnvelope<{ command: Command }> & LegacyCommandsResponse>(
        `${this.linksService.getApiUrl()}/commands/${channelID}/${commandID}?language=${encodeURIComponent(language)}`,
        updates
      )
      .pipe(
        map((response): CommandSaveResult => ({ command: this.extractCommand(response, 'Failed to update command'), error: null })),
        tap((result) => {
          if (!result.command) return;
          this.updateCachedCommands(channelID, (commands) =>
            commands.map((command) => (command.id === commandID || command._id === commandID ? result.command! : command)));
        }),
        catchError((err: unknown) => of<CommandSaveResult>({ command: null, error: this.saveError(err) }))
      );
  }

  /** Command text → blocks for the editor's import box (never saves anything). */
  importBlocks(channelID: string, text: string): Observable<{ result: BlocksImportResult | null; error: CommandSaveError | null }> {
    return this.http
      .post<{ error: boolean; root?: RootNode; advancedCount?: number; message?: string }>(
        `${this.linksService.getApiUrl()}/commands/${channelID}/blocks/import`,
        { text }
      )
      .pipe(
        map((response) => response.root
          ? { result: { root: response.root, advancedCount: response.advancedCount ?? 0 }, error: null }
          : { result: null, error: { status: 400, code: null, message: response.message ?? '', blockId: null } }),
        catchError((err: unknown) => of({ result: null, error: this.saveError(err) }))
      );
  }

  private saveError(err: unknown): CommandSaveError {
    const body = err instanceof HttpErrorResponse ? (err.error as Record<string, unknown> | null) : null;
    return {
      status: err instanceof HttpErrorResponse ? err.status : 0,
      code: typeof body?.['code'] === 'string' ? body['code'] : null,
      message: typeof body?.['message'] === 'string' ? body['message'] : '',
      blockId: typeof body?.['blockId'] === 'string' ? body['blockId'] : null
    };
  }

  enableCommand(channelID: string, commandID: string) {
    return this.updateCommand(channelID, commandID, { enabled: true });
  }

  disableCommand(channelID: string, commandID: string) {
    return this.updateCommand(channelID, commandID, { enabled: false });
  }

  refreshCommands(channelID: string) {
    return this.getCommands(channelID, { skipCache: true });
  }

  clearAllCache(): void {
    this.cache.clear();
  }
}
