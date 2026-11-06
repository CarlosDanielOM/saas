import { InjectionToken } from '@angular/core';
import type { JsonObject, WidgetField, WidgetManifest } from '../custom-widget-format.generated';
import type { DimaEvent, DimaSession } from './dima-events';
import { DIMA_SDK_SOURCE } from './dima-sdk';
import { SE_SHIM_SCRIPT } from './se-shim';
import type { FrameScripts } from './frame-document';

/** Mirrors `WidgetBundle` in dimabot/src/custom_widgets/store.ts. */
export interface RuntimeBundle {
  widgetId: string; revision: number; engine: WidgetManifest['engine']; manifest: WidgetManifest;
  html: string; css: string; js: string; fields: WidgetField[]; data: JsonObject; media: Record<string, string>;
  channel: { id: string; login: string; name: string };
  /** The owner's "Block outside connections" choice. */
  network?: 'open' | 'restricted';
}
export interface WidgetLogEntry { at: number; level: 'info' | 'warn' | 'error' | 'debug'; text: string }
export type WidgetStatus = 'loading' | 'running' | 'error' | 'stopped';
export interface WidgetTarget { layerId: string; widgetId: string; revision: number; engine: WidgetManifest['engine']; uses: readonly string[] }

/**
 * What a custom widget frame can reach. Studio provides an editor environment (owner bundles, test events,
 * preview-only store writes); the OBS page provides a live one (public bundles, socket feed, real store).
 */
export interface CustomWidgetEnv {
  readonly mode: 'editor' | 'live';
  bundle(widgetId: string, revision?: number): Promise<RuntimeBundle>;
  /** Events for every custom layer, or one layer when `layerId` is set (buttons). */
  subscribe(listener: (event: DimaEvent, layerId?: string) => void): () => void;
  rpc(target: WidgetTarget, method: string, params: Record<string, unknown>): Promise<unknown>;
  session(): DimaSession | null;
  /** Latest live state by name (polls, goals) for frames that start later. */
  states(): Record<string, unknown>;
  /** Recent events a frame that starts later should still get (OBS: roulette spins and results from the last 2 minutes). */
  recent?(): DimaEvent[];
  /** OBS: the owner changed how a widget may load (Block outside connections); its layers load it again. */
  onReload?(listener: (widgetId: string) => void): () => void;
  report(layerId: string, update: { status?: WidgetStatus; entry?: WidgetLogEntry }): void;
}
export const CUSTOM_WIDGET_ENV = new InjectionToken<CustomWidgetEnv>('CUSTOM_WIDGET_ENV');
/** StreamElements widgets share one store (`se`, like SE's kvstore); each Dima widget has its own. */
export const storeNamespace = (target: Pick<WidgetTarget, 'engine' | 'widgetId'>) => target.engine === 'streamelements' ? 'se' : target.widgetId;

/** A tiny event fan-out shared by both environments. */
export class WidgetEventBus {
  private readonly listeners = new Set<(event: DimaEvent, layerId?: string) => void>();
  subscribe(listener: (event: DimaEvent, layerId?: string) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  emit(event: DimaEvent, layerId?: string): void { for (const listener of [...this.listeners]) listener(event, layerId); }
}

let scripts: Promise<FrameScripts> | null = null;
/** SDK and SE layer ship in the app bundle; jQuery is a pinned static file loaded once. */
export function frameScripts(): Promise<FrameScripts> {
  scripts ??= fetch(new URL('assets/widget-runtime/jquery-3.7.1.min.js', document.baseURI).href)
    .then(response => { if (!response.ok) throw new Error('jQuery unavailable'); return response.text(); })
    .then(jquery => ({ sdk: DIMA_SDK_SOURCE, shim: SE_SHIM_SCRIPT, jquery }))
    .catch(error => { scripts = null; throw error; });
  return scripts;
}
