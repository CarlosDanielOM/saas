import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject, untracked } from '@angular/core';
import { firstValueFrom, type Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import { SessionAuthService } from '../../services/session-auth.service';
import { SseParser, type SseFrame } from './assistant-sse';
import type {
  ApiEnvelope,
  ApprovalState,
  ChangeView,
  DisplayItem,
  InputMode,
  LimitsView,
  PageContext,
  SessionMeta,
  PersonaView,
  StatusView,
  TurnSnapshot,
  TurnStatus,
} from './assistant.types';

export interface SessionSnapshot {
  session: SessionMeta;
  items: DisplayItem[];
  activeTurn: TurnSnapshot | null;
}

export interface SendMessageBody {
  sessionId?: string;
  text: string;
  mode: InputMode;
  page: PageContext;
  clientRequestId: string;
}

export interface SendMessageResult {
  sessionId: string;
  turnId: string;
  limits: LimitsView;
}

/** API failure with the HTTP status and the error code (`turn_active`, `undo_conflict`, …). */
export class AssistantApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly data: unknown = null,
  ) {
    super(message || code);
    this.name = 'AssistantApiError';
  }
}

/** Error code from an envelope: top-level `code`, `data.code`, or a snake_case `message`. */
function codeOf(body: unknown, status: number): { code: string; message: string; data: unknown } {
  const envelope = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const data = envelope['data'] ?? null;
  const dataCode = data && typeof data === 'object' ? (data as Record<string, unknown>)['code'] : undefined;
  const message = typeof envelope['message'] === 'string' ? (envelope['message'] as string) : '';
  const code =
    (typeof envelope['code'] === 'string' && envelope['code']) ||
    (typeof dataCode === 'string' && dataCode) ||
    (/^[a-z][a-z0-9_]*$/.test(message) ? message : '') ||
    (status === 0 ? 'network' : status === 429 ? 'rate_limited' : status >= 500 ? 'unavailable' : 'request_failed');
  return { code: code as string, message, data };
}

export function newClientRequestId(): string {
  const crypto = globalThis.crypto as Crypto | undefined;
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * REST + event stream client for `/agent/:channelID` (see `dimabot/SITE_AGENT.md`, HTTP API).
 * HttpClient adds the Bearer token through the auth interceptor; the event stream uses fetch
 * (EventSource can't send headers) with the token from SessionAuthService.
 */
@Injectable({ providedIn: 'root' })
export class AssistantApiService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(SessionAuthService);

  private base(channelId: string): string {
    return `${environment.DIMA_API}/agent/${encodeURIComponent(channelId)}`;
  }

  status(channelId: string): Promise<StatusView> {
    return this.call(this.http.get<ApiEnvelope<StatusView>>(`${this.base(channelId)}/status`));
  }

  async setPersona(channelId: string, persona: boolean): Promise<PersonaView> {
    const data = await this.call(this.http.patch<ApiEnvelope<{ persona: PersonaView }>>(`${this.base(channelId)}/prefs`, { persona }));
    return data.persona;
  }

  async sessions(channelId: string): Promise<SessionMeta[]> {
    const data = await this.call(this.http.get<ApiEnvelope<{ sessions: SessionMeta[] }>>(`${this.base(channelId)}/sessions`));
    return Array.isArray(data?.sessions) ? data.sessions : [];
  }

  async session(channelId: string, sessionId: string): Promise<SessionSnapshot> {
    const data = await this.call(
      this.http.get<ApiEnvelope<SessionSnapshot>>(`${this.base(channelId)}/sessions/${encodeURIComponent(sessionId)}`),
    );
    return { session: data.session, items: Array.isArray(data.items) ? data.items : [], activeTurn: data.activeTurn ?? null };
  }

  async renameSession(channelId: string, sessionId: string, title: string): Promise<SessionMeta> {
    const data = await this.call(
      this.http.patch<ApiEnvelope<{ session: SessionMeta }>>(`${this.base(channelId)}/sessions/${encodeURIComponent(sessionId)}`, { title }),
    );
    return data.session;
  }

  async deleteSession(channelId: string, sessionId: string): Promise<void> {
    await this.call(this.http.delete<ApiEnvelope<{ deleted: boolean }>>(`${this.base(channelId)}/sessions/${encodeURIComponent(sessionId)}`));
  }

  send(channelId: string, body: SendMessageBody): Promise<SendMessageResult> {
    return this.call(this.http.post<ApiEnvelope<SendMessageResult>>(`${this.base(channelId)}/messages`, body));
  }

  turn(channelId: string, turnId: string): Promise<TurnSnapshot> {
    return this.call(this.http.get<ApiEnvelope<TurnSnapshot>>(`${this.base(channelId)}/turns/${encodeURIComponent(turnId)}`));
  }

  stop(channelId: string, turnId: string): Promise<{ status: TurnStatus }> {
    return this.call(
      this.http.post<ApiEnvelope<{ status: TurnStatus }>>(`${this.turnUrl(channelId, turnId)}/stop`, { clientRequestId: newClientRequestId() }),
    );
  }

  retry(channelId: string, turnId: string, clientRequestId: string): Promise<{ turnId: string }> {
    return this.call(this.http.post<ApiEnvelope<{ turnId: string }>>(`${this.turnUrl(channelId, turnId)}/retry`, { clientRequestId }));
  }

  decide(channelId: string, turnId: string, callId: string, decision: 'apply' | 'skip'): Promise<{ state: ApprovalState }> {
    return this.call(
      this.http.post<ApiEnvelope<{ state: ApprovalState }>>(`${this.turnUrl(channelId, turnId)}/approvals/${encodeURIComponent(callId)}`, {
        decision,
        clientRequestId: newClientRequestId(),
      }),
    );
  }

  submitUi(channelId: string, turnId: string, callId: string, values: unknown): Promise<{ state: string }> {
    return this.call(
      this.http.post<ApiEnvelope<{ state: string }>>(`${this.turnUrl(channelId, turnId)}/ui/${encodeURIComponent(callId)}`, {
        values,
        clientRequestId: newClientRequestId(),
      }),
    );
  }

  feedback(channelId: string, turnId: string, helpful: boolean): Promise<{ recorded: boolean }> {
    return this.call(
      this.http.post<ApiEnvelope<{ recorded: boolean }>>(`${this.turnUrl(channelId, turnId)}/feedback`, {
        helpful,
        clientRequestId: newClientRequestId(),
      }),
    );
  }

  async changes(channelId: string, before: string | null): Promise<{ changes: ChangeView[]; next: string | null }> {
    const query = before ? `?before=${encodeURIComponent(before)}` : '';
    const data = await this.call(this.http.get<ApiEnvelope<{ changes: ChangeView[]; next: string | null }>>(`${this.base(channelId)}/changes${query}`));
    return { changes: Array.isArray(data?.changes) ? data.changes : [], next: data?.next ?? null };
  }

  async undo(channelId: string, changeId: string): Promise<ChangeView> {
    const data = await this.call(
      this.http.post<ApiEnvelope<{ change: ChangeView }>>(`${this.base(channelId)}/changes/${encodeURIComponent(changeId)}/undo`, {
        clientRequestId: newClientRequestId(),
      }),
    );
    return data.change;
  }

  /**
   * Read a turn's event stream until the server closes it (resolves) or it fails (rejects with
   * AssistantApiError, or an AbortError/TypeError). `onActivity` fires on every chunk, pings
   * included, so the caller can run a stall watchdog.
   */
  async streamEvents(
    channelId: string,
    turnId: string,
    after: string | null,
    signal: AbortSignal,
    onFrame: (frame: SseFrame) => void,
    onActivity?: () => void,
  ): Promise<void> {
    const query = after ? `?after=${encodeURIComponent(after)}` : '';
    const token = untracked(() => this.auth.token());
    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const response = await fetch(`${this.turnUrl(channelId, turnId)}/events${query}`, { headers, signal, cache: 'no-store' });
    if (!response.ok || !response.body) {
      const payload: unknown = await response.json().catch(() => null);
      const { code, message, data } = codeOf(payload, response.status);
      throw new AssistantApiError(response.status, code, message, data);
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    const parser = new SseParser();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        onActivity?.();
        for (const frame of parser.feed(chunk.value).frames) onFrame(frame);
      }
    } finally {
      reader.cancel().catch(() => undefined);
    }
  }

  private turnUrl(channelId: string, turnId: string): string {
    return `${this.base(channelId)}/turns/${encodeURIComponent(turnId)}`;
  }

  private async call<T>(request: Observable<ApiEnvelope<T>>): Promise<T> {
    let body: ApiEnvelope<T>;
    try {
      body = await firstValueFrom(request);
    } catch (error) {
      if (error instanceof HttpErrorResponse) {
        const { code, message, data } = codeOf(error.error, error.status);
        throw new AssistantApiError(error.status, code, message, data);
      }
      throw new AssistantApiError(0, 'network', String(error));
    }
    if (body && typeof body === 'object' && body.error) {
      const { code, message, data } = codeOf(body, body.status ?? 400);
      throw new AssistantApiError(body.status ?? 400, code, message, data);
    }
    return (body?.data ?? null) as T;
  }
}
