import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { LinksService } from './links.service';

/** One Expert answer of the site assistant that the safety filter declined (Standard answered instead). */
export interface AssistantRefusal {
  id: string;
  at: string;
  channelId: string;
  channelLogin: string;
  userId: string;
  userLogin: string;
  sessionId: string;
  turnId: string;
  step: number;
  plan: 'free' | 'premium' | 'pro';
  level: 'standard' | 'expert';
  model: string;
  fallbackModel: string;
  /** 'reply': the model started and stopped with a refusal; 'error': the request itself was refused (403). */
  source: 'reply' | 'error';
  finishReason: string | null;
  nativeFinishReason: string | null;
  refusal: string | null;
  detail: { errorType?: string; reasons?: string[]; flaggedInput?: string; providerName?: string } | null;
  message: string;
  steers: string[];
  recent: { role: string; name?: string; text: string }[];
  partial: string | null;
}

export interface AssistantRefusalPage {
  rows: AssistantRefusal[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
  counts: { week: number; total: number };
}

@Injectable({ providedIn: 'root' })
export class AssistantRefusalsApiService {
  private readonly http = inject(HttpClient);
  private readonly links = inject(LinksService);

  list(page: number, channel: string | null): Observable<{ data: AssistantRefusalPage }> {
    const query = new URLSearchParams({ page: String(page), limit: '20', ...(channel ? { channel } : {}) });
    return this.http.get<{ data: AssistantRefusalPage }>(`${this.links.getApiUrl()}/admin-site/assistant-refusals?${query}`);
  }
}
