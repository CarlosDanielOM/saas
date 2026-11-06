import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom, map, timeout } from 'rxjs';
import { OverlayApi } from './overlay-api.service';
import type { CustomWidgetPlan, ExternalMedia, FieldIssue, JsonObject, PackageFile, PackageInput, WidgetField, WidgetManifest } from './custom-widget-format.generated';
import type { DimaChat, DimaSession } from './widget-runtime/dima-events';
import type { RuntimeBundle } from './widget-runtime/widget-env';

export interface WidgetUse { sceneId: string; sceneName: string; draft: boolean; published: boolean }
/** Mirrors `CustomWidgetView` in dimabot/src/custom_widgets/store.ts. */
export interface CustomWidgetView {
  id: string; name: string; engine: WidgetManifest['engine']; revision: number; author?: string;
  fields: WidgetField[]; data: JsonObject; externalMedia: ExternalMedia[]; manifest: WidgetManifest | null; media: Record<string, string>;
  files: Record<PackageFile, { bytes: number; sha256: string }>;
  createdAt: string; updatedAt: string; usedIn: WidgetUse[];
  /** Stored versions, newest first (latest, the 10 newest, and published ones). */
  history?: { revision: number; createdAt: string; published: boolean }[];
}
export interface CustomWidgetList { enabled: boolean; planTier: CustomWidgetPlan; limit: number; used: number; widgets: CustomWidgetView[] }
export interface ImportResult { widget: CustomWidgetView; issues: FieldIssue[] }
export interface MediaFile { url: string; kind: string; bytes: number | null; copied: boolean; assetId?: string }
export interface MediaPlan { files: MediaFile[]; totalBytes: number; unknownSizes: number; quota: { usedBytes: number; quotaBytes: number } }
export interface MediaCopyResult { copied: Record<string, string>; failed: { url: string; reason: string }[] }
/** Layer names the command parser reads back exactly inside quotes (no quotes, backslashes, $ or brackets). */
const QUOTABLE = /^[\p{L}\p{N}][\p{L}\p{N} _'.,!?-]{0,79}$/u;
/** A command response that sends this signal: to every listening widget, or (`target`) to layers with that name. */
/** What a command passes as the signal's value: nothing, one word (`&p1`) or all text after the command (`&t`). */
export type SignalValue = 'none' | 'word' | 'text';
/** Declared example values with spaces mean the signal takes free text; single words mean one word; none means no value. */
export const signalValueKind = (values: readonly string[]): SignalValue => !values.length ? 'none' : values.some(value => /\s/.test(value.trim())) ? 'text' : 'word';
export function signalSnippet(name: string, kind: SignalValue, target: string | null = null): string {
  const value = kind === 'text' ? ' &t' : kind === 'word' ? ' &p1' : '';
  return target && QUOTABLE.test(target) && target === target.trim() ? `$(widget.signal.to "${target}" ${name}${value})` : `$(widget.signal ${name}${value})`;
}
export const canTarget = (layerName: string) => QUOTABLE.test(layerName) && layerName === layerName.trim();
/** StreamElements-hosted images, videos and sounds not yet copied into the channel's storage. */
export function copyableMedia(widget: Pick<CustomWidgetView, 'externalMedia' | 'media'>): number {
  return widget.externalMedia.filter(item => ['image', 'video', 'audio'].includes(item.kind) && /^(cdn|static)\.streamelements\.com$/i.test(item.host) && !widget.media?.[item.url]).length;
}

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

  /** The channel this list belongs to (Studio's owner). */
  get channelId(): string { return this.channel; }
  widget(id: unknown): CustomWidgetView | undefined { return typeof id === 'string' ? this.widgets().find(widget => widget.id === id) : undefined; }

  async load(channel: string): Promise<void> {
    if (!channel) return;
    if (channel !== this.channel) { this.channel = channel; this.list.set(null); }
    this.loading.set(true); this.error.set('');
    try { const list = await this.api.request<CustomWidgetList>('GET', `${channel}/custom-widgets`); if (channel === this.channel) this.list.set(list); }
    catch (error) { if (channel === this.channel) this.error.set(message(error)); }
    finally { if (channel === this.channel) this.loading.set(false); }
  }
  async create(name: string, files: PackageInput): Promise<ImportResult> {
    const result = await this.api.request<ImportResult>('POST', `${this.channel}/custom-widgets`, { name, files }, 60000);
    this.patchList(list => ({ ...list, used: list.used + 1, widgets: [...list.widgets, result.widget] }));
    return result;
  }
  /** `baseRevision` (code editor): the server refuses with `stale` if the widget changed since. */
  async replace(id: string, files: PackageInput, baseRevision?: number): Promise<ImportResult> {
    const result = await this.api.request<ImportResult>('PUT', `${this.channel}/custom-widgets/${id}/files`, { files, ...(baseRevision === undefined ? {} : { baseRevision }) }, 60000);
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
  file(id: string, file: PackageFile | 'manifest', revision?: number): Promise<string> {
    const query = revision === undefined ? '' : `?revision=${revision}`;
    return firstValueFrom(this.http.get(`${this.api.base}/overlay-studio/${this.channel}/custom-widgets/${id}/files/${file}${query}`, { responseType: 'text' }).pipe(timeout(30000), map(text => text)));
  }
  /** Code and settings of one revision (latest unless given), for the editor preview. */
  bundle(id: string, revision?: number): Promise<RuntimeBundle> {
    return this.api.request<RuntimeBundle>('GET', `${this.channel}/custom-widgets/${id}/bundle${revision === undefined ? '' : `?revision=${revision}`}`, undefined, 30000);
  }
  /** Copied media load from short-lived links in the editor (frames can't send the login token). */
  async resolveMedia(bundle: RuntimeBundle): Promise<RuntimeBundle> {
    const entries = Object.entries(bundle.media ?? {});
    if (!entries.length) return bundle;
    const resolved = await Promise.all(entries.map(async ([url, assetId]) => {
      try { const access = await firstValueFrom(this.http.get<{ data: { path: string } }>(`${this.api.base}/asset-library/${this.channel}/${assetId}/access?for=custom-widget`)); return [url, this.api.base + access.data.path] as const; }
      catch { return [url, url] as const; }
    }));
    return { ...bundle, media: Object.fromEntries(resolved) };
  }
  storeGet(namespace: string, key: string): Promise<unknown> {
    return this.api.request<{ value: unknown }>('GET', `${this.channel}/custom-widgets/store/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`).then(result => result.value);
  }
  counter(name: string): Promise<number> {
    return this.api.request<{ value: number }>('GET', `${this.channel}/custom-widgets/counters/${encodeURIComponent(name)}`).then(result => result.value);
  }
  /** Signals dropped by the channel limits in the last 10 minutes. */
  /** The channel's live state for previews (null: that read failed). */
  liveState(): Promise<{ polls: unknown; goals: unknown }> { return this.api.request<{ polls: unknown; goals: unknown }>('GET', `${this.channel}/custom-widgets/state`); }
  /** The channel's last stored chat messages (oldest first, text only) for "Replay recent chat". */
  chatHistory(): Promise<{ messages: DimaChat[] }> { return this.api.request<{ messages: DimaChat[] }>('GET', `${this.channel}/custom-widgets/chat-history`); }
  signalStatus(): Promise<{ skipped: number }> { return this.api.request<{ skipped: number }>('GET', `${this.channel}/custom-widgets/signals`); }
  /** Session snapshot; `goalSources` (owner only) names the goal behind each StreamElements "manual" goal. */
  session(): Promise<DimaSession & { goalSources?: Record<string, { id: string; name: string; status: string }> }> { return this.api.request('GET', `${this.channel}/custom-widgets/session`); }
  mediaPlan(id: string): Promise<MediaPlan> { return this.api.request<MediaPlan>('GET', `${this.channel}/custom-widgets/${id}/media`, undefined, 60000); }
  async copyMedia(id: string, urls: string[]): Promise<MediaCopyResult> {
    const result = await this.api.request<MediaCopyResult>('POST', `${this.channel}/custom-widgets/${id}/media`, { urls }, 600000);
    if (Object.keys(result.copied).length) this.patchList(list => ({ ...list, widgets: list.widgets.map(widget => widget.id === id ? { ...widget, media: { ...widget.media, ...result.copied } } : widget) }));
    return result;
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
