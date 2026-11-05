import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { Download, FileUp, LucideAngularModule, Puzzle } from 'lucide-angular';
import { LanguageService } from '../../services/language.service';
import { EXPORT_FILE_NAMES, PACKAGE_FILES, buildWidgetIni, groupFields, isStreamElementsHost, resolveFieldData, type JsonObject } from './custom-widget-format.generated';
import { writeZip } from './custom-widget-zip';
import { CustomWidgetsService, message } from './custom-widgets.service';
import { OverlayCustomWidgetImportComponent } from './overlay-custom-widget-import.component';
import type { OverlayWidget } from './overlay.model';
import type { WidgetSettingsContext } from './overlay-widget-module';

/** Settings-section block for a custom widget layer: which widget it is, replacing its files and exporting it. */
@Component({
  selector: 'app-overlay-custom-widget-settings',
  imports: [LucideAngularModule, OverlayCustomWidgetImportComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host { display:grid; gap:.75rem; min-width:0 }
    .cw-source { display:grid; grid-template-columns:auto minmax(0,1fr); align-items:center; gap:.65rem; padding:.7rem; border:1px solid var(--line); border-radius:.9rem; background:var(--input-bg) }
    .cw-source__icon { display:grid; place-items:center; width:2.25rem; height:2.25rem; border-radius:.7rem; background:var(--accent-soft); color:var(--accent) }
    .cw-source strong { display:block; overflow:hidden; color:var(--fg); font-size:.88rem; font-weight:800; text-overflow:ellipsis; white-space:nowrap }
    .cw-source small { display:block; color:var(--muted); font-size:.75rem; font-weight:600; line-height:1.4 }
    .cw-actions { display:flex; flex-wrap:wrap; gap:.5rem }
    .lf-btn { display:inline-flex; align-items:center; justify-content:center; gap:.4rem; min-height:44px; padding:.5rem .9rem; border:1px solid var(--btn-border); border-radius:999px; color:var(--fg); background:var(--btn); font:inherit; font-size:.82rem; font-weight:750; cursor:pointer }
    .lf-btn:hover:not(:disabled) { border-color:color-mix(in srgb, var(--accent) 45%, transparent) }
    .lf-btn:disabled { opacity:.55; cursor:not-allowed }
    .lf-btn:focus-visible { outline:2px solid var(--accent); outline-offset:2px }
    .lf-note { margin:0; color:var(--muted); font-size:.78rem; line-height:1.5; font-weight:500 }
    .lf-note--warn { color:var(--warn) }
    .lf-note--danger { color:var(--danger); font-weight:700 }
  `,
  template: `
    @if (source(); as widget) {
      <div class="cw-source" data-cw-source>
        <span class="cw-source__icon" aria-hidden="true"><lucide-icon [img]="icons.Puzzle" [size]="18" /></span>
        <span><strong>{{ widget.name }}</strong><small>{{ details() }}</small></span>
      </div>
      <div class="cw-actions">
        <button type="button" class="lf-btn" (click)="replaceOpen.set(true)" data-cw-replace><lucide-icon [img]="icons.FileUp" [size]="16" aria-hidden="true" />{{ t('customReplaceFiles') }}</button>
        <button type="button" class="lf-btn" [disabled]="exporting()" (click)="exportZip()" data-cw-export><lucide-icon [img]="icons.Download" [size]="16" aria-hidden="true" />{{ exporting() ? t('customExporting') : t('customExport') }}</button>
      </div>
      @if (exportError()) { <p class="lf-note lf-note--danger" role="alert">{{ exportError() }}</p> }
      @if (remoteCount()) { <p class="lf-note lf-note--warn">{{ n('customRemoteShort', remoteCount()) }}</p> }
      <p class="lf-note">{{ t('customEngineNote') }}</p>
      @if (replaceOpen()) { <app-overlay-custom-widget-import mode="replace" [widget]="widget" (closed)="replaceOpen.set(false)" /> }
    } @else if (listLoaded()) {
      <p class="lf-note lf-note--warn" role="alert">{{ t('customMissing') }}</p>
    }
  `
})
export class OverlayCustomWidgetSettingsComponent {
  readonly context = input.required<WidgetSettingsContext>();
  readonly configChange = output<Partial<OverlayWidget>>();
  readonly previewChange = output<string>();
  private readonly widgets = inject(CustomWidgetsService);
  private readonly language = inject(LanguageService);
  readonly icons = { Download, FileUp, Puzzle };
  readonly replaceOpen = signal(false);
  readonly exporting = signal(false);
  readonly exportError = signal('');
  readonly listLoaded = computed(() => this.widgets.list() !== null);
  readonly source = computed(() => this.widgets.widget(this.context().widget.config?.['widgetId']));
  readonly remoteCount = computed(() => this.source()?.externalMedia.filter(item => isStreamElementsHost(item.host)).length ?? 0);
  readonly details = computed(() => {
    const widget = this.source(); if (!widget) return '';
    const settings = groupFields(widget.fields).reduce((sum, group) => sum + group.fields.length, 0);
    return [this.t('customVersion', { revision: widget.revision }), widget.author ? this.t('customByAuthor', { author: widget.author }) : '', this.n('customSettingsCount', settings)].filter(Boolean).join(' · ');
  });
  t(key: string, params?: Record<string, string | number>): string { return this.language.translate('overlayStudio.' + key, params); }
  /** Counted strings have a `…One` variant for 1. */
  n(key: string, count: number, params: Record<string, string | number> = {}): string { return this.t(count === 1 ? key + 'One' : key, { count, ...params }); }


  /** A StreamElements-compatible zip: the original files plus this layer's settings as data.txt. */
  async exportZip(): Promise<void> {
    const widget = this.source(); if (!widget || this.exporting()) return;
    this.exporting.set(true); this.exportError.set('');
    try {
      const [html, css, js, fields] = await Promise.all((['html', 'css', 'js', 'fields'] as const).map(file => this.widgets.file(widget.id, file, widget.revision)));
      const values = this.context().widget.config?.['values'];
      const data = resolveFieldData(widget.fields, widget.data, values && typeof values === 'object' && !Array.isArray(values) ? values as JsonObject : {});
      const texts = { html, css, js, fields, data: JSON.stringify(data, null, 2) };
      const zip = writeZip([{ name: 'widget.ini', text: buildWidgetIni() }, ...PACKAGE_FILES.map(file => ({ name: EXPORT_FILE_NAMES[file], text: texts[file] }))]);
      const url = URL.createObjectURL(zip), link = document.createElement('a');
      link.href = url; link.download = `${(this.context().widget.name || widget.name).replace(/[^\p{L}\p{N} _.-]+/gu, '').trim() || 'widget'}.zip`;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) { this.exportError.set(message(error) || this.t('customExportFailed')); }
    finally { this.exporting.set(false); }
  }
}
