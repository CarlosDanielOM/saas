import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { map } from 'rxjs';
import { PetConfiguration, PetSettings } from '../models/pet-settings.model';
import { LinksService } from './links.service';

interface PetEnvelope { error: boolean; message?: string; data?: PetConfiguration }

@Injectable({ providedIn: 'root' })
export class PetSettingsApiService {
  private readonly http = inject(HttpClient);
  private readonly links = inject(LinksService);
  private url(channelID: string) { return `${this.links.getApiUrl()}/pets/${encodeURIComponent(channelID)}/settings`; }
  private unwrap(response: PetEnvelope): PetConfiguration {
    if (response.error || !response.data) throw new Error(response.message || 'temporarily_unavailable');
    return response.data;
  }
  get(channelID: string) { return this.http.get<PetEnvelope>(this.url(channelID)).pipe(map(response => this.unwrap(response))); }
  save(channelID: string, revision: number, settings: PetSettings) {
    return this.http.put<PetEnvelope>(this.url(channelID), { revision, settings }).pipe(map(response => this.unwrap(response)));
  }
}
