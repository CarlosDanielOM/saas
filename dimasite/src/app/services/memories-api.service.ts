import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, throwError } from 'rxjs';

import {
  Memory,
  ListMemoriesParams,
  ListMemoriesResponse,
  UpdateMemoryRequest,
  UpdateMemoryStatusRequest,
  MemoryStatus
} from '../models/memory.model';
import { LinksService } from './links.service';

@Injectable({
  providedIn: 'root'
})
export class MemoriesApiService {
  private readonly http = inject(HttpClient);
  private readonly linksService = inject(LinksService);

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

  listMemories(channelID: string, params?: ListMemoriesParams): Observable<ListMemoriesResponse> {
    const queryParams = new URLSearchParams();

    if (params?.statuses?.length) {
      queryParams.set('status', params.statuses.join(','));
    }
    if (params?.types?.length) {
      queryParams.set('type', params.types.join(','));
    }
    if (params?.risks?.length) {
      queryParams.set('risk', params.risks.join(','));
    }
    if (params?.limit) {
      queryParams.set('limit', String(params.limit));
    }
    if (params?.skip) {
      queryParams.set('skip', String(params.skip));
    }

    const query = queryParams.toString();
    const url = `${this.linksService.getApiUrl()}/memories/${channelID.trim()}${query ? `?${query}` : ''}`;

    return this.http.get<{ error: boolean; data?: ListMemoriesResponse; message?: string }>(url).pipe(
      map((response) => {
        if (response.error || !response.data) {
          throw new Error(response.message || 'Failed to load memories');
        }
        return response.data;
      }),
      catchError((error) =>
        throwError(() => this.toRequestError(error, 'Failed to load memories'))
      )
    );
  }

  getMemory(channelID: string, memoryId: string): Observable<Memory> {
    const url = `${this.linksService.getApiUrl()}/memories/${channelID.trim()}/${memoryId}`;

    return this.http.get<{ error: boolean; data?: Memory; message?: string }>(url).pipe(
      map((response) => {
        if (response.error || !response.data) {
          throw new Error(response.message || 'Failed to load memory');
        }
        return response.data;
      }),
      catchError((error) =>
        throwError(() => this.toRequestError(error, 'Failed to load memory'))
      )
    );
  }

  updateMemory(channelID: string, memoryId: string, data: UpdateMemoryRequest): Observable<Memory> {
    const url = `${this.linksService.getApiUrl()}/memories/${channelID.trim()}/${memoryId}`;

    return this.http.patch<{ error: boolean; data?: Memory; message?: string }>(url, data).pipe(
      map((response) => {
        if (response.error || !response.data) {
          throw new Error(response.message || 'Failed to update memory');
        }
        return response.data;
      }),
      catchError((error) =>
        throwError(() => this.toRequestError(error, 'Failed to update memory'))
      )
    );
  }

  updateMemoryStatus(
    channelID: string,
    memoryId: string,
    status: MemoryStatus,
    reason?: string
  ): Observable<Memory> {
    const url = `${this.linksService.getApiUrl()}/memories/${channelID.trim()}/${memoryId}/status`;
    const body: UpdateMemoryStatusRequest = { status, reason };

    return this.http.patch<{ error: boolean; data?: Memory; message?: string }>(url, body).pipe(
      map((response) => {
        if (response.error || !response.data) {
          throw new Error(response.message || 'Failed to update memory status');
        }
        return response.data;
      }),
      catchError((error) =>
        throwError(() => this.toRequestError(error, 'Failed to update memory status'))
      )
    );
  }

  deleteMemory(channelID: string, memoryId: string): Observable<void> {
    const url = `${this.linksService.getApiUrl()}/memories/${channelID.trim()}/${memoryId}`;

    return this.http.delete<{ error: boolean; message?: string }>(url).pipe(
      map((response) => {
        if (response.error) {
          throw new Error(response.message || 'Failed to delete memory');
        }
      }),
      catchError((error) =>
        throwError(() => this.toRequestError(error, 'Failed to delete memory'))
      )
    );
  }
}
