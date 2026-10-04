import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, map, timeout } from 'rxjs';
import { LinksService } from '../../services/links.service';

export interface DesignAsset {
  id: string; name: string; kind: 'image' | 'video' | 'audio'; mime: string;
  bytes: number; width: number; height: number; duration?: number; createdAt: string;
}
export interface AssetLibrary {
  assets: DesignAsset[]; usedBytes: number; quotaBytes: number;
  maxFileBytes: number; planTier: 'free' | 'premium' | 'pro';
}
/** Shared by design editors; IDs are durable, access URLs are temporary. */
@Injectable({ providedIn: 'root' })
export class AssetLibraryService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(LinksService).getApiUrl();
  private request<T>(method: string, path: string, body?: unknown) {
    return firstValueFrom(this.http.request<{ data: T }>(method, `${this.base}/asset-library/${path}`, { body }).pipe(timeout(120_000), map(r => r.data)));
  }
  list(owner: string) { return this.request<AssetLibrary>('GET', encodeURIComponent(owner)); }
  upload(owner: string, file: File) { const data = new FormData(); data.append('file', file); return this.request<DesignAsset>('POST', encodeURIComponent(owner), data); }
  delete(owner: string, id: string) { return this.request('DELETE', `${encodeURIComponent(owner)}/${encodeURIComponent(id)}`); }
  async preview(owner: string, id: string) {
    const access = await this.request<{ path: string }>('GET', `${encodeURIComponent(owner)}/${encodeURIComponent(id)}/access`);
    return this.base + access.path;
  }
}

export function assetSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${+(bytes / 1_000_000_000).toFixed(2)} GB`;
  if (bytes >= 1_000_000) return `${+(bytes / 1_000_000).toFixed(2)} MB`;
  return `${+(bytes / 1000).toFixed(1)} KB`;
}
