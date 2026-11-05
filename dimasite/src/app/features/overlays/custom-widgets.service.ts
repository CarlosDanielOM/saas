import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom, map, timeout } from 'rxjs';
import { OverlayApi } from './overlay-api.service';
import type { CustomWidgetPlan, ExternalMedia, FieldIssue, JsonObject, PackageFile, PackageSource, WidgetField } from './custom-widget-format.generated';

export interface WidgetUse { sceneId: string; sceneName: string; draft: boolean; published: boolean }
/** Mirrors `CustomWidgetView` in dimabot/src/custom_widgets/store.ts. */
export interface CustomWidgetView {
  id: string; name: string; engine: 'streamelements'; revision: number; author?: string;
  fields: WidgetField[]; data: JsonObject; externalMedia: ExternalMedia[];
  files: Record<PackageFile, { bytes: number; sha256: string }>;
  createdAt: string; updatedAt: string; usedIn: WidgetUse[];
}
export interface CustomWidgetList { enabled: boolean; planTier: CustomWidgetPlan; limit: number; used: number; widgets: CustomWidgetView[] }
export interface ImportResult { widget: CustomWidgetView; issues: FieldIssue[] }

/** The channel's imported widgets, shared by the Add panel, layer settings and import dialog. */
@Injectable({ providedIn: 'root' })
export class CustomWidgetsService {
  private readonly api = inject(OverlayApi);
  private readonly http = inject(HttpClient);
  private channel = '';
  readonly list = signal<CustomWidgetList | null>(null);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly enabled = computed(() => this.list()?.enabled === true);
  readonly widgets = computed(() => this.list()?.widgets ?? []);
  readonly atLimit = computed(() => { const list = this.list(); return !!list && list.used >= list.limit; });

  widget(id: unknown): CustomWidgetView | undefined { return typeof id === 'string' ? this.widgets().find(widget => widget.id === id) : undefined; }

  async load(channel: string): Promise<void> {
    if (!channel) return;
    if (channel !== this.channel) { this.channel = channel; this.list.set(null); }
    this.loading.set(true); this.error.set('');
    try { const list = await this.api.request<CustomWidgetList>('GET', `${channel}/custom-widgets`); if (channel === this.channel) this.list.set(list); }
    catch (error) { if (channel === this.channel) this.error.set(message(error)); }
    finally { if (channel === this.channel) this.loading.set(false); }
  }
  async create(name: string, files: PackageSource): Promise<ImportResult> {
    const result = await this.api.request<ImportResult>('POST', `${this.channel}/custom-widgets`, { name, files }, 60000);
    this.patchList(list => ({ ...list, used: list.used + 1, widgets: [...list.widgets, result.widget] }));
    return result;
  }
  async replace(id: string, files: PackageSource): Promise<ImportResult> {
    const result = await this.api.request<ImportResult>('PUT', `${this.channel}/custom-widgets/${id}/files`, { files }, 60000);
    this.patchList(list => ({ ...list, widgets: list.widgets.map(widget => widget.id === id ? result.widget : widget) }));
    return result;
  }
  async rename(id: string, name: string): Promise<CustomWidgetView> {
    const widget = await this.api.request<CustomWidgetView>('PATCH', `${this.channel}/custom-widgets/${id}`, { name });
    this.patchList(list => ({ ...list, widgets: list.widgets.map(item => item.id === id ? widget : item) }));
    return widget;
  }
  async remove(id: string): Promise<void> {
    await this.api.request<{ deleted: true }>('DELETE', `${this.channel}/custom-widgets/${id}`);
    this.patchList(list => ({ ...list, used: Math.max(0, list.used - 1), widgets: list.widgets.filter(widget => widget.id !== id) }));
  }
  /** Original file text (latest revision unless one is given). */
  file(id: string, file: PackageFile, revision?: number): Promise<string> {
    const query = revision === undefined ? '' : `?revision=${revision}`;
    return firstValueFrom(this.http.get(`${this.api.base}/overlay-studio/${this.channel}/custom-widgets/${id}/files/${file}${query}`, { responseType: 'text' }).pipe(timeout(30000), map(text => text)));
  }
  private patchList(change: (list: CustomWidgetList) => CustomWidgetList): void { const list = this.list(); if (list) this.list.set(change(list)); }
}

export function message(error: unknown): string {
  const body = (error as { error?: { message?: unknown } })?.error;
  if (body && typeof body.message === 'string') return body.message;
  return error instanceof Error ? error.message : '';
}
export function errorCode(error: unknown): string {
  const code = (error as { error?: { code?: unknown } })?.error?.code;
  return typeof code === 'string' ? code : '';
}
