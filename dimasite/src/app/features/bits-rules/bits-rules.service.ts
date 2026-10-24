import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom, map, timeout } from 'rxjs';
import { LinksService } from '../../services/links.service';
import type { BitsRuleInput, BitsRulesView } from './bits-rules.model';

/** One live copy of a channel's Bits rules, shared by Chat events and Overlay Studio. */
@Injectable({ providedIn: 'root' })
export class BitsRulesService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(LinksService).getApiUrl();
  readonly channel = signal<string | null>(null);
  readonly view = signal<BitsRulesView | null>(null);
  readonly loading = signal(false);
  readonly loadFailed = signal(false);

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return firstValueFrom(this.http.request<{ data: T }>(method, `${this.base}/bits-rules/${path}`, { body })
      .pipe(timeout(20000), map(response => response.data)));
  }

  async load(channel: string): Promise<void> {
    if (this.channel() !== channel) { this.view.set(null); this.channel.set(channel); }
    this.loading.set(true); this.loadFailed.set(false);
    try {
      const view = await this.request<BitsRulesView>('GET', encodeURIComponent(channel));
      if (!Array.isArray(view?.rules)) throw new Error('Unexpected Bits rules response');
      if (this.channel() === channel) this.view.set(view);
    } catch {
      if (this.channel() === channel) this.loadFailed.set(true);
    } finally { this.loading.set(false); }
  }

  /** Resolves to the new rule's id. */
  async create(input: BitsRuleInput): Promise<string> {
    const view = await this.request<BitsRulesView & { created: string }>('POST', `${this.path()}/rules`, input);
    this.view.set(view);
    return view.created;
  }

  async update(id: string, patch: Partial<BitsRuleInput>): Promise<void> {
    this.view.set(await this.request<BitsRulesView>('PATCH', `${this.path()}/rules/${encodeURIComponent(id)}`, patch));
  }

  async remove(id: string): Promise<void> {
    this.view.set(await this.request<BitsRulesView>('DELETE', `${this.path()}/rules/${encodeURIComponent(id)}`));
  }

  /** Shows a look count change made in Overlay Studio without another request. */
  setLooks(looks: Record<string, number>): void {
    this.view.update(view => view ? { ...view, looks } : view);
  }

  private path(): string {
    const channel = this.channel();
    if (!channel) throw new Error('Bits rules are not loaded');
    return encodeURIComponent(channel);
  }
}

/** i18n key suffix (under `bitsRules.errors.`) for a failed request. */
export function bitsRuleErrorKey(error: unknown): 'deleted' | 'conflict' | 'limit' | 'forbidden' | 'invalid' | 'generic' {
  if (!(error instanceof HttpErrorResponse)) return 'generic';
  const message = String((error.error as { message?: unknown } | null)?.message ?? '');
  if (error.status === 404) return 'deleted';
  if (error.status === 409) return /up to/i.test(message) ? 'limit' : 'conflict';
  if (error.status === 403 || error.status === 401) return 'forbidden';
  if (error.status === 400) return 'invalid';
  return 'generic';
}
