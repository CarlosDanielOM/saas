import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { map, timeout } from 'rxjs';
import type { PetOverlayToken, PetOwnerRuntime } from '../features/pet/pet-runtime.model';
import { PetConfiguration, PetSettings } from '../models/pet-settings.model';
import { LinksService } from './links.service';

interface PetEnvelope<T> { error: boolean; message?: string; data?: T }

@Injectable({ providedIn: 'root' })
export class PetSettingsApiService {
  private readonly http = inject(HttpClient);
  private readonly links = inject(LinksService);
  private url(channelID: string) { return `${this.links.getApiUrl()}/pets/${encodeURIComponent(channelID)}/settings`; }
  private unwrap<T>(response: PetEnvelope<T>): T {
    if (response.error || !response.data) throw new Error(response.message || 'temporarily_unavailable');
    return response.data;
  }
  private root(channelID: string) { return `${this.links.getApiUrl()}/pets/${encodeURIComponent(channelID)}`; }
  runtime(channelID: string) { return this.http.get<PetEnvelope<PetOwnerRuntime>>(`${this.root(channelID)}/runtime`).pipe(timeout(15_000), map(response => this.unwrap(response))); }
  overlayToken(channelID: string) { return this.http.get<PetEnvelope<PetOverlayToken>>(`${this.root(channelID)}/overlay-token`).pipe(timeout(15_000), map(response => this.unwrap(response))); }
  issueOverlayToken(channelID: string, body: { rotate: true; version: string | null } | { token: string } | Record<string, never> = {}) {
    return this.http.post<PetEnvelope<PetOverlayToken>>(`${this.root(channelID)}/overlay-token`, body).pipe(timeout(15_000), map(response => this.unwrap(response)));
  }
  get(channelID: string) { return this.http.get<PetEnvelope<PetConfiguration>>(this.url(channelID)).pipe(timeout(15_000), map(response => this.unwrap(response))); }
  save(channelID: string, revision: number, settings: PetSettings) {
    return this.http.put<PetEnvelope<PetConfiguration>>(this.url(channelID), { revision, settings }).pipe(timeout(15_000), map(response => this.unwrap(response)));
  }
}
