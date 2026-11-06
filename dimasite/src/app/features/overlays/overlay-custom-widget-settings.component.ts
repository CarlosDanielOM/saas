import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Code2, Copy, Download, ExternalLink, FileUp, LucideAngularModule, Puzzle } from 'lucide-angular';
import { LanguageService } from '../../services/language.service';
import { EXPORT_FILE_NAMES, MANIFEST_FILE, PACKAGE_FILES, buildWidgetIni, groupFields, resolveFieldData, type JsonObject } from './custom-widget-format.generated';
import { writeZip } from './custom-widget-zip';
import { CustomWidgetsService, canTarget, copyableMedia, message, signalSnippet, signalValueKind } from './custom-widgets.service';
import { EditorWidgetEnv } from './widget-runtime/editor-env';
import { OverlayInteractionSetupComponent } from './overlay-interaction-setup.component';
import { OverlayCustomWidgetCodeComponent } from './overlay-custom-widget-code.component';
import { OverlayCustomWidgetImportComponent } from './overlay-custom-widget-import.component';
import type { OverlayWidget } from './overlay.model';
import type { WidgetSettingsContext } from './overlay-widget-module';

/** Settings-section block for a custom widget layer: which widget it is, replacing its files and exporting it. */
@Component({
  selector: 'app-overlay-custom-widget-settings',
  imports: [LucideAngularModule, RouterLink, OverlayCustomWidgetImportComponent, OverlayCustomWidgetCodeComponent, OverlayInteractionSetupComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host { display:grid; gap:.75rem; min-width:0 }
    .cw-source { display:grid; grid-template-columns:auto minmax(0,1fr); align-items:center; gap:.65rem; padding:.7rem; border:1px solid var(--line); border-radius:.9rem; background:var(--input-bg) }
    .cw-source__icon { display:grid; place-items:center; width:2.25rem; height:2.25rem; border-radius:.7rem; background:var(--accent-soft); color:var(--accent) }
    .cw-source strong { display:block; overflow:hidden; color:var(--fg); font-size:.88rem; font-weight:800; text-overflow:ellipsis; white-space:nowrap }
    .cw-source small { display:block; color:var(--muted); font-size:.75rem; font-weight:600; line-height:1.4 }
    .cw-actions { display:flex; flex-wrap:wrap; gap:.5rem }
    .cw-remote { display:grid; gap:.4rem; justify-items:start }
    .lf-btn { display:inline-flex; align-items:center; justify-content:center; gap:.4rem; min-height:44px; padding:.5rem .9rem; border:1px solid var(--btn-border); border-radius:999px; color:var(--fg); background:var(--btn); font:inherit; font-size:.82rem; font-weight:750; cursor:pointer }
    .lf-btn:hover:not(:disabled) { border-color:color-mix(in srgb, var(--accent) 45%, transparent) }
    .lf-btn:disabled { opacity:.55; cursor:not-allowed }
    .lf-btn:focus-visible { outline:2px solid var(--accent); outline-offset:2px }
    .lf-note { margin:0; color:var(--muted); font-size:.78rem; line-height:1.5; font-weight:500 }
    .lf-note--warn { color:var(--warn) }
    .lf-note--danger { color:var(--danger); font-weight:700 }
    .cw-uses { display:flex; flex-wrap:wrap; gap:.35rem; margin:0; padding:0; list-style:none }
    .cw-network { display:grid; gap:.35rem; padding:.7rem; border:1px solid var(--line); border-radius:.9rem; background:var(--input-bg) }
    .cw-network__row { display:flex; align-items:center; gap:.6rem }
    .cw-network__row label { color:var(--fg); font-size:.86rem; font-weight:800; cursor:pointer }
    .lf-switch { position:relative; display:inline-flex; align-items:center; flex-shrink:0; width:3rem; height:2.75rem }
    .lf-switch input { position:absolute; inset:0; z-index:1; width:100%; height:100%; margin:0; opacity:0; cursor:pointer }
    .lf-switch input:disabled { cursor:progress }
    .lf-switch input:focus-visible + .lf-switch__track { outline:2px solid var(--accent); outline-offset:3px }
    .lf-switch__track { position:relative; width:100%; height:1.75rem; border:1px solid var(--line); border-radius:999px; background:var(--btn); transition:background 160ms ease }
    .lf-switch__track::after { content:''; position:absolute; top:.17rem; left:.17rem; width:1.25rem; height:1.25rem; border-radius:999px; background:var(--fg); transition:transform 160ms ease }
    .lf-switch input:checked + .lf-switch__track { border-color:#7c3aed; background:#7c3aed }
    .lf-switch input:checked + .lf-switch__track::after { transform:translateX(1.2rem); background:#fff }
    @media (prefers-reduced-motion: reduce) { .lf-switch__track, .lf-switch__track::after { transition:none } }
    .cw-uses li { padding:.2rem .55rem; border:1px solid var(--line); border-radius:999px; background:var(--btn); color:var(--fg); font-size:.74rem; font-weight:700 }
    .cw-status { display:flex; align-items:center; gap:.5rem; margin:0; color:var(--fg); font-size:.8rem; font-weight:750 }
    .cw-status__dot { flex:none; width:.55rem; height:.55rem; border-radius:999px; background:var(--muted) }
    .cw-status[data-status='running'] .cw-status__dot { background:#22c55e; box-shadow:0 0 0 3px rgba(34,197,94,.2) }
    .cw-status[data-status='error'] .cw-status__dot, .cw-status[data-status='stopped'] .cw-status__dot { background:#ef4444; box-shadow:0 0 0 3px rgba(239,68,68,.2) }
    .cw-log { border:1px solid var(--line); border-radius:.8rem; background:var(--input-bg) }
    .cw-log > summary { display:flex; align-items:center; gap:.5rem; min-height:44px; padding:0 .75rem; color:var(--fg); font-size:.8rem; font-weight:800; cursor:pointer }
    .cw-log > summary:focus-visible { outline:2px solid var(--accent); outline-offset:2px }
    .cw-log__count { padding:.05rem .45rem; border-radius:999px; background:var(--btn); color:var(--muted); font-size:.7rem }
    .cw-log__count--error { background:rgba(239,68,68,.16); color:var(--danger) }
    .cw-log ol { display:grid; gap:.25rem; max-height:14rem; margin:0; padding:0 .75rem .5rem; overflow:auto; list-style:none; font:500 .72rem/1.45 var(--mono, ui-monospace, monospace) }
    .cw-log li { color:var(--muted); overflow-wrap:anywhere; white-space:pre-wrap }
    .cw-log li[data-level='error'] { color:var(--danger) }
    .cw-log li[data-level='warn'] { color:var(--warn) }
    .cw-log__foot { display:flex; justify-content:flex-end; padding:0 .5rem .5rem }
    .cw-goal-data { display:grid; gap:.5rem; padding:0 .75rem .75rem }
    .cw-goal-data ul { display:grid; gap:.2rem; margin:0; padding:0; list-style:none; color:var(--muted); font-size:.8rem }
    .cw-goal-data strong { color:var(--fg); font-weight:700 }
    .cw-commands { display:grid; gap:.6rem; padding:.75rem; border:1px solid var(--line); border-radius:.9rem; background:var(--input-bg) }
    .cw-commands h4 { margin:0; color:var(--fg); font-size:.86rem; font-weight:800 }
    .cw-signal { display:grid; gap:.4rem; padding-top:.6rem; border-top:1px solid var(--line) }
    .cw-signal__head { display:flex; flex-wrap:wrap; align-items:baseline; gap:.15rem .5rem }
    .cw-signal__head strong { color:var(--fg); font-size:.84rem; font-weight:800 }
    .cw-signal__head span { color:var(--muted); font-size:.76rem }
    .cw-snippet { display:block; padding:.45rem .6rem; border:1px solid var(--line); border-radius:.6rem; background:var(--tile, transparent); color:var(--fg); font:600 .76rem/1.5 var(--mono, ui-monospace, monospace); white-space:pre-wrap; overflow-wrap:anywhere; user-select:all }
    a.lf-btn { text-decoration:none }
  `,
  template: `
    @if (source(); as widget) {
      <div class="cw-source" data-cw-source>
        <span class="cw-source__icon" aria-hidden="true"><lucide-icon [img]="icons.Puzzle" [size]="18" /></span>
        <span><strong>{{ widget.name }}</strong><small>{{ details() }}</small></span>
      </div>
      <div class="cw-actions">
        <button type="button" class="lf-btn" (click)="codeOpen.set(true)" data-cw-edit-code><lucide-icon [img]="icons.Code2" [size]="16" aria-hidden="true" />{{ t('customEditCode') }}</button>
        <button type="button" class="lf-btn" (click)="replaceOpen.set(true)" data-cw-replace><lucide-icon [img]="icons.FileUp" [size]="16" aria-hidden="true" />{{ t('customReplaceFiles') }}</button>
        <button type="button" class="lf-btn" [disabled]="exporting()" (click)="exportZip()" data-cw-export><lucide-icon [img]="icons.Download" [size]="16" aria-hidden="true" />{{ exporting() ? t('customExporting') : t('customExport') }}</button>
      </div>
      @if (exportError()) { <p class="lf-note lf-note--danger" role="alert">{{ exportError() }}</p> }
      @if (uses().length) {
        <div><p class="lf-note">{{ t(widget.manifest?.engine === 'dima' ? 'customEngineDima' : 'customEngineSe') }} · {{ t('customReads') }}</p>
        <ul class="cw-uses" data-cw-uses>@for (use of uses(); track use) { <li>{{ t('customUse_' + use) }}</li> }</ul></div>
      } @else { <p class="lf-note">{{ t(widget.manifest?.engine === 'dima' ? 'customEngineDima' : 'customEngineSe') }} · {{ t('customReadsNothing') }}</p> }
      <section class="cw-network" data-cw-network>
        <div class="cw-network__row">
          <span class="lf-switch"><input type="checkbox" role="switch" id="cw-network-switch" [checked]="widget.network === 'restricted'" [disabled]="networkSaving()"
            (change)="setNetwork(widget.id, $event)" aria-describedby="cw-network-hint" data-cw-network-switch /><span class="lf-switch__track" aria-hidden="true"></span></span>
          <label for="cw-network-switch">{{ t('customNetworkTitle') }}</label>
        </div>
        <p class="lf-note" id="cw-network-hint" data-cw-network-hint>{{ t(widget.network === 'restricted' ? 'customNetworkOn' : 'customNetworkOff') }}</p>
        @if (widget.outsideCode?.length) { <p class="lf-note lf-note--warn" data-cw-outside-code>{{ t('customOutsideCode', { hosts: widget.outsideCode!.join(', ') }) }}</p> }
        @if (networkError()) { <p class="lf-note lf-note--danger" role="alert">{{ networkError() }}</p> }
      </section>
      @if (uses().includes('polls')) {
        <div data-cw-polls-setup><p class="lf-note">{{ t('customPollsSetup') }}</p><app-overlay-interaction-setup [channel]="channelId()" [streamer]="streamer()" /></div>
      }
      @if (uses().includes('session') || uses().includes('goals')) {
        <details class="cw-log" data-cw-goal-data>
          <summary>{{ t('customGoalData') }}</summary>
          <div class="cw-goal-data">
            <p class="lf-note">{{ t('customGoalDataManual') }}</p>
            @if (goalSources(); as sources) {
              <ul>@for (kind of goalKinds; track kind) { <li [attr.data-cw-goal-source]="kind">{{ t('customGoalKind_' + kind) }}: <strong>{{ sources[kind + '-goal']?.name ?? t('customGoalDataNone') }}</strong></li> }</ul>
            }
            <p class="lf-note">{{ t('customGoalDataTotals') }}</p>
            <a class="lf-btn" [routerLink]="['/', streamer(), 'dashboard']" fragment="goals" target="_blank" rel="noopener" data-cw-goals-link><lucide-icon [img]="icons.ExternalLink" [size]="16" aria-hidden="true" />{{ t('customGoalDataOpen') }}</a>
          </div>
        </details>
      }
      @if (uses().includes('signals')) {
        <section class="cw-commands" aria-labelledby="cw-commands-title" data-cw-commands>
          <h4 id="cw-commands-title">{{ t('customCommandsTitle') }}</h4>
          <p class="lf-note">{{ t('customCommandsIntro') }}</p>
          @if (targeted()) { <p class="lf-note" data-cw-targeted>{{ t('customCommandsTargeted', { name: layerName() }) }}</p> }
          @else if (othersListen()) { <p class="lf-note lf-note--warn" data-cw-untargetable>{{ t('customCommandsUntargetable') }}</p> }
          @if (sameName()) { <p class="lf-note lf-note--warn" data-cw-same-name>{{ t('customCommandsSameName', { name: layerName() }) }}</p> }
          @for (item of commandItems(); track item.name) {
            <div class="cw-signal" [attr.data-cw-signal]="item.name || 'any'">
              <div class="cw-signal__head">
                <strong>{{ item.name ? '!' + item.name : t('customCommandsAny') }}</strong>
                @if (item.description) { <span>{{ item.description }}</span> }
                @if (item.values.length) { <span>{{ t('customCommandsValues', { values: item.values.join(' · ') }) }}</span> }
              </div>
              <code class="cw-snippet" data-cw-snippet>{{ item.snippet }}</code>
              <div class="cw-actions">
                <button type="button" class="lf-btn" (click)="copy(item.snippet, item.name)" data-cw-copy><lucide-icon [img]="icons.Copy" [size]="16" aria-hidden="true" />{{ copied() === item.name ? t('customCommandsCopied') : t('customCommandsCopy') }}</button>
                <a class="lf-btn" [href]="item.link" target="_blank" rel="noopener" [attr.aria-label]="t('customCommandsMakeLabel', { name: item.name || '…' })" data-cw-make><lucide-icon [img]="icons.ExternalLink" [size]="16" aria-hidden="true" />{{ t('customCommandsMake') }}</a>
              </div>
            </div>
          }
          @if (skipped(); as count) { <p class="lf-note lf-note--warn" data-cw-skipped>{{ n('customCommandsSkipped', count) }}</p> }
        </section>
      }
      @if (remoteCount()) {
        <div class="cw-remote"><p class="lf-note lf-note--warn">{{ n('customRemoteShort', remoteCount()) }}</p>
        <button type="button" class="lf-btn" (click)="mediaOpen.set(true)" data-cw-copy-media>{{ t('customMediaButton') }}</button></div>
      }
      @if (log(); as current) {
        <p class="cw-status" role="status" [attr.data-status]="current.status" data-cw-status><span class="cw-status__dot" aria-hidden="true"></span>{{ t('customStatus_' + current.status) }}</p>
        <details class="cw-log" [open]="logOpen()" (toggle)="logOpen.set($any($event.target).open)" data-cw-log>
          <summary>{{ t('customLog') }} <span class="cw-log__count" [class.cw-log__count--error]="current.errors > 0">{{ current.errors ? n('customLogErrors', current.errors) : current.entries.length }}</span></summary>
          @if (current.entries.length) {
            <ol>@for (entry of current.entries; track $index) { <li [attr.data-level]="entry.level">{{ time(entry.at) }} {{ entry.text }}</li> }</ol>
            <div class="cw-log__foot"><button type="button" class="lf-btn" (click)="clearLog()">{{ t('customLogClear') }}</button></div>
          } @else { <p class="lf-note" style="padding:0 .75rem .6rem">{{ t('customLogEmpty') }}</p> }
        </details>
      }
      @if (replaceOpen()) { <app-overlay-custom-widget-import mode="replace" [widget]="widget" (closed)="replaceOpen.set(false)" /> }
      @if (mediaOpen()) { <app-overlay-custom-widget-import mode="media" [widget]="widget" (closed)="mediaOpen.set(false)" /> }
      @if (codeOpen()) { <app-overlay-custom-widget-code [widget]="widget" [layer]="context().widget" (renamed)="layerRenamed($event)" (closed)="codeOpen.set(false)" /> }
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
  private readonly env = inject(EditorWidgetEnv, { optional: true });
  readonly logOpen = signal(false);
  readonly log = computed(() => this.env?.logs()[this.context().widget.id] ?? null);
  readonly uses = computed(() => this.source()?.manifest?.uses ?? []);
  time(at: number): string { return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  clearLog(): void { this.env?.clearLog(this.context().widget.id); }
  readonly icons = { Code2, Copy, Download, ExternalLink, FileUp, Puzzle };
  readonly replaceOpen = signal(false);
  readonly codeOpen = signal(false);
  readonly mediaOpen = signal(false);
  readonly exporting = signal(false);
  readonly exportError = signal('');
  readonly networkSaving = signal(false);
  readonly networkError = signal('');
  /** "Block outside connections": saved right away; the preview restarts with it (OBS on its next load). */
  async setNetwork(id: string, event: Event): Promise<void> {
    const input = event.target as HTMLInputElement, network = input.checked ? 'restricted' : 'open';
    this.networkSaving.set(true); this.networkError.set('');
    try { await this.widgets.setNetwork(id, network); }
    catch (error) { input.checked = !input.checked; this.networkError.set(message(error) || this.t('customNetworkFailed')); }
    finally { this.networkSaving.set(false); }
  }
  readonly listLoaded = computed(() => this.widgets.list() !== null);
  private readonly router = inject(Router);
  readonly goalKinds = ['follower', 'subscriber', 'cheer', 'tip'] as const;
  readonly channelId = computed(() => this.widgets.channelId);
  readonly goalSources = computed(() => this.env?.goalSources() ?? null);
  readonly streamer = computed(() => this.router.url.split(/[/?#]/)[1] ?? '');
  readonly copied = signal<string | null>(null);
  readonly skipped = signal(0);
  // The server matches .to against the layer's own name: no fallback to the widget's name (an unnamed layer can't be targeted).
  readonly layerName = computed(() => (this.context().widget.name ?? '').trim());
  private readonly listening = computed(() => (this.env?.sceneLayers() ?? []).filter(layer => layer.kind === 'custom' && layer.visible !== false
    && this.widgets.widget(layer.config?.['widgetId'])?.manifest?.uses.includes('signals')));
  /** Other widgets here also listen: this layer's commands name it (when the name can be quoted safely). */
  readonly othersListen = computed(() => this.listening().some(layer => layer.id !== this.context().widget.id));
  readonly targeted = computed(() => this.othersListen() && canTarget(this.layerName()));
  readonly sameName = computed(() => this.targeted() && this.listening().some(layer => layer.id !== this.context().widget.id
    && (layer.name ?? '').trim().toLocaleLowerCase() === this.layerName().toLocaleLowerCase()));
  /** Declared signals (or one generic entry) with the response to paste and a pre-filled "Make a command" link. */
  readonly commandItems = computed(() => {
    const declared = this.source()?.manifest?.signals ?? [], target = this.targeted() ? this.layerName() : null;
    const streamer = this.streamer();
    const items = declared.length ? declared.map(signal => ({ name: signal.name, description: signal.description ?? '', values: signal.values ?? [] }))
      : [{ name: '', description: this.t('customCommandsGeneric'), values: [] as string[] }];
    return items.map(item => {
      const snippet = signalSnippet(item.name || 'name', item.name ? signalValueKind(item.values) : 'word', target);
      const query = new URLSearchParams({ new: 'command', cmd: item.name, name: item.name ? item.name[0].toUpperCase() + item.name.slice(1).replace(/_/g, ' ') : '', message: snippet, description: item.name ? item.description : '' });
      return { ...item, snippet, link: `/${encodeURIComponent(streamer)}/commands?${query.toString()}` };
    });
  });
  private readonly loadSkipped = effect(() => {
    if (!this.uses().includes('signals')) return;
    untracked(() => void this.widgets.signalStatus().then(status => this.skipped.set(status.skipped)).catch(() => {}));
  });
  async copy(text: string, name: string): Promise<void> {
    try { await navigator.clipboard.writeText(text); this.copied.set(name); setTimeout(() => { if (this.copied() === name) this.copied.set(null); }, 2000); } catch { /* clipboard blocked: the text stays selectable */ }
  }
  readonly source = computed(() => this.widgets.widget(this.context().widget.config?.['widgetId']));
  /** StreamElements-hosted images, videos and sounds not copied yet. */
  readonly remoteCount = computed(() => { const source = this.source(); return source ? copyableMedia(source) : 0; });
  readonly details = computed(() => {
    const widget = this.source(); if (!widget) return '';
    const settings = groupFields(widget.fields).reduce((sum, group) => sum + group.fields.length, 0);
    return [this.t('customVersion', { revision: widget.revision }), widget.author ? this.t('customByAuthor', { author: widget.author }) : '', this.n('customSettingsCount', settings)].filter(Boolean).join(' · ');
  });
  t(key: string, params?: Record<string, string | number>): string { return this.language.translate('overlayStudio.' + key, params); }
  /** Counted strings have a `…One` variant for 1. */
  n(key: string, count: number, params: Record<string, string | number> = {}): string { return this.t(count === 1 ? key + 'One' : key, { count, ...params }); }


  /** This layer still shows the widget's old name: it follows the rename (a custom layer name stays). */
  layerRenamed(change: { from: string; to: string }): void {
    if (this.context().widget.name === change.from) this.configChange.emit({ name: change.to });
  }
  /** A StreamElements-compatible zip: the original files plus this layer's settings as data.txt. */
  async exportZip(): Promise<void> {
    const widget = this.source(); if (!widget || this.exporting()) return;
    this.exporting.set(true); this.exportError.set('');
    try {
      const [html, css, js, fields] = await Promise.all((['html', 'css', 'js', 'fields'] as const).map(file => this.widgets.file(widget.id, file, widget.revision)));
      const values = this.context().widget.config?.['values'];
      const data = resolveFieldData(widget.fields, widget.data, values && typeof values === 'object' && !Array.isArray(values) ? values as JsonObject : {});
      const texts = { html, css, js, fields, data: JSON.stringify(data, null, 2) };
      // widget.json travels along when the widget has one (StreamElements ignores it).
      const manifest = await this.widgets.file(widget.id, 'manifest', widget.revision).catch(() => null);
      const zip = writeZip([{ name: 'widget.ini', text: buildWidgetIni() }, ...PACKAGE_FILES.map(file => ({ name: EXPORT_FILE_NAMES[file], text: texts[file] })),
        ...(manifest ? [{ name: MANIFEST_FILE, text: manifest }] : [])]);
      const url = URL.createObjectURL(zip), link = document.createElement('a');
      link.href = url; link.download = `${(this.context().widget.name || widget.name).replace(/[^\p{L}\p{N} _.-]+/gu, '').trim() || 'widget'}.zip`;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) { this.exportError.set(message(error) || this.t('customExportFailed')); }
    finally { this.exporting.set(false); }
  }
}
