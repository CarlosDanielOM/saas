import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ApiEnvelope, RedisKeyDetail, RedisScanResult, RedisTreeResult } from './api.types';

@Injectable({ providedIn: 'root' })
export class RedisService {
  private readonly http = inject(HttpClient);

  tree(connectionId: string, prefix = '', query = '', cursor = '0'): Promise<RedisTreeResult> {
    return this.unwrap(
      this.http.get<ApiEnvelope<RedisTreeResult>>(`/api/redis/${connectionId}/tree`, {
        params: { prefix, query, cursor },
      }),
      'Tree scan failed',
    );
  }

  scan(connectionId: string, cursor = '0', match = '*'): Promise<RedisScanResult> {
    return this.unwrap(
      this.http.get<ApiEnvelope<RedisScanResult>>(`/api/redis/${connectionId}/keys`, {
        params: { cursor, match, count: 50 },
      }),
      'Scan failed',
    );
  }

  inspect(connectionId: string, key: string): Promise<RedisKeyDetail> {
    return this.unwrap(
      this.http.get<ApiEnvelope<RedisKeyDetail>>(`/api/redis/${connectionId}/key`, {
        params: { key },
      }),
      'Failed to load key',
    );
  }

  saveString(connectionId: string, key: string, value: string): Promise<RedisKeyDetail> {
    return this.unwrap(
      this.http.put<ApiEnvelope<RedisKeyDetail>>(`/api/redis/${connectionId}/key`, { key, value }),
      'Save failed',
    );
  }

  remove(connectionId: string, key: string): Promise<{ deleted: number }> {
    return this.unwrap(
      this.http.delete<ApiEnvelope<{ deleted: number }>>(`/api/redis/${connectionId}/key`, {
        params: { key },
      }),
      'Delete failed',
    );
  }

  async command(connectionId: string, command: string, confirm = false): Promise<unknown> {
    const data = await this.unwrap<{ result: unknown }>(
      this.http.post<ApiEnvelope<{ result: unknown }>>(`/api/redis/${connectionId}/command`, {
        command,
        confirm,
      }),
      'Command failed',
    );
    return data.result;
  }

  private async unwrap<T>(source: Parameters<typeof firstValueFrom>[0], fallback: string): Promise<T> {
    const response = await firstValueFrom(source) as ApiEnvelope<T>;
    if (response.error || response.data === undefined) {
      throw Object.assign(new Error(response.message || fallback), { status: response.status });
    }
    return response.data;
  }
}
