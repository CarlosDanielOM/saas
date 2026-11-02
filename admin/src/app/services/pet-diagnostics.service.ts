import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { LinksService } from './links.service';
export interface PetComputer {
  selectedSessionId: string | null;
  session: { name: string; authorization: 'valid' | 'revoked' | 'expired' | 'insufficient_scope' | 'client_disabled'; lastUsedAt: string; expiresAt: string; idleExpiresAt: string } | null;
  connected: boolean; reportedReady: boolean; ready: boolean;
}
export interface PetDiagnostics {
  observedAt: string; configured: boolean; enabled: boolean; appearance: 'png' | 'vts' | null; playbackTarget: 'browser' | 'desktop' | null;
  vts: PetComputer & { projection: { status: 'fresh' | 'stale' | 'missing'; lastValidatedAt: string | null; expiresAt: string | null } };
  audio: PetComputer;
  failures: { requestId: string; status: string; errorCode: string; createdAt: string }[];
}
@Injectable({ providedIn: 'root' })
export class PetDiagnosticsService {
  private readonly http = inject(HttpClient);
  private readonly links = inject(LinksService);
  get(channelID: string) {
    return this.http.get<{ data: PetDiagnostics }>(`${this.links.getApiUrl()}/admin-site/users/${encodeURIComponent(channelID)}/pet-diagnostics`);
  }
}
