import { ChangeDetectionStrategy, Component, ElementRef, afterNextRender, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { Check, FileUp, FolderOpen, LucideAngularModule, Star, X } from 'lucide-angular';
import { LanguageService } from '../../services/language.service';
import { UpgradeService } from '../../services/upgrade.service';
import { CustomWidgetsService, copyableMedia, errorCode, message, type CustomWidgetView, type MediaCopyResult, type MediaPlan } from './custom-widgets.service';
import { experimentEnabled } from '../../shared/utils/experiments';
import { droppedFiles, pickedFromInput, readImport, type ImportDraft, type PickedFile } from './custom-widget-import';

/**
 * Import a StreamElements widget package, replace an imported widget's files, or (mode `media`, also the step
 * after an import) copy its StreamElements-hosted files into the channel's storage.
 */
@Component({
  selector: 'app-overlay-custom-widget-import',
  imports: [LucideAngularModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './overlay-custom-widget-import.component.html',
  styleUrl: './overlay-custom-widget-import.component.css'
})
export class OverlayCustomWidgetImportComponent {
  readonly mode = input<'create' | 'replace' | 'media'>('create');
  readonly widget = input<CustomWidgetView | null>(null);
  readonly done = output<CustomWidgetView>();
  readonly closed = output<void>();
  readonly widgets = inject(CustomWidgetsService);
  /** Experiment: list values the settings panel doesn't show (`?experiments=widget-built-in-values`). */
  readonly showBuiltIn = experimentEnabled('widget-built-in-values');
  private readonly language = inject(LanguageService);
  private readonly upgrades = inject(UpgradeService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  readonly icons = { Check, FileUp, FolderOpen, Star, X };

  readonly draft = signal<ImportDraft | null>(null);
  readonly reading = signal(false);
  readonly busy = signal(false);
  readonly dragOver = signal(false);
  readonly name = signal('');
  readonly serverError = signal('');
  readonly limitReached = signal(false);
  private returnFocus: HTMLElement | null = null;
  /** `files`: choose and import; `media`: offer to copy StreamElements files. */
  readonly phase = signal<'files' | 'media'>('files');
  readonly mediaWidget = signal<CustomWidgetView | null>(null);
  readonly plan = signal<MediaPlan | null>(null);
  readonly planError = signal('');
  readonly copying = signal(false);
  readonly copyResult = signal<MediaCopyResult | null>(null);
  /** Images StreamElements no longer serves fall back to a label instead of a broken image. */
  readonly brokenThumbs = signal<ReadonlySet<string>>(new Set());
  thumbFailed(url: string): void { this.brokenThumbs.update(set => new Set(set).add(url)); }
  readonly pendingFiles = computed(() => this.plan()?.files.filter(file => !file.copied) ?? []);
  readonly freeBytes = computed(() => { const plan = this.plan(); return plan ? Math.max(0, plan.quota.quotaBytes - plan.quota.usedBytes) : 0; });
  readonly noRoom = computed(() => { const plan = this.plan(); return !!plan && plan.totalBytes > this.freeBytes(); });

  readonly list = this.widgets.list;
  readonly blockedByLimit = computed(() => this.mode() === 'create' && (this.widgets.atLimit() || this.limitReached()));
  readonly canUpgrade = computed(() => this.list()?.planTier !== 'pro');
  readonly ready = computed(() => { const draft = this.draft(); return !!draft?.source && !draft.error && !this.busy() && !this.blockedByLimit(); });
  readonly usage = computed(() => { const list = this.list(); return list ? this.t('customUsage', { used: Math.min(list.used + 1, list.limit), limit: list.limit, plan: this.t('customPlan_' + list.planTier) }) : ''; });

  constructor() {
    afterNextRender(() => {
      this.returnFocus = document.activeElement as HTMLElement | null; this.dialog().nativeElement.showModal();
      if (this.mode() === 'media' && this.widget()) void this.openMedia(this.widget()!);
    });
  }
  t(key: string, params?: Record<string, string | number>): string { return this.language.translate('overlayStudio.' + key, params); }
  /** Counted strings have a `…One` variant for 1. */
  n(key: string, count: number, params: Record<string, string | number> = {}): string { return this.t(count === 1 ? key + 'One' : key, { count, ...params }); }

  usesText(uses: readonly string[]): string { return uses.map(use => this.t('customUse_' + use)).join(', '); }
  size(bytes: number): string { return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB` : this.kb(bytes); }
  fileName(url: string): string { try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || url); } catch { return url; } }
  kb(bytes: number): string { return bytes < 1000 ? `${bytes} B` : `${(bytes / 1000).toFixed(bytes < 10_000 ? 1 : 0)} KB`; }
  errorText(draft: ImportDraft): string { return draft.error === 'format' ? `${this.t('customImportError_format')} ${draft.errorDetail}` : this.t('customImportError_' + draft.error); }

  async pick(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = pickedFromInput(input.files); input.value = '';
    await this.read(files);
  }
  onDragOver(event: DragEvent): void { event.preventDefault(); this.dragOver.set(true); }
  async onDrop(event: DragEvent): Promise<void> {
    event.preventDefault(); this.dragOver.set(false);
    if (event.dataTransfer) await this.read(await droppedFiles(event.dataTransfer));
  }
  private async read(files: PickedFile[]): Promise<void> {
    if (!files.length || this.busy()) return;
    this.reading.set(true); this.serverError.set('');
    try {
      const draft = await readImport(files);
      this.draft.set(draft);
      if (this.mode() === 'create' && !this.name().trim()) this.name.set(draft.suggestedName);
    } finally { this.reading.set(false); }
  }
  async submit(): Promise<void> {
    const draft = this.draft(); if (!draft?.source || !this.ready()) return;
    this.busy.set(true); this.serverError.set('');
    try {
      const result = this.mode() === 'replace' && this.widget()
        ? await this.widgets.replace(this.widget()!.id, draft.source)
        : await this.widgets.create(this.name().trim(), draft.source);
      this.busy.set(false);
      this.done.emit(result.widget);
      // Offer to copy StreamElements-hosted files right away; otherwise we're done.
      if (copyableMedia(result.widget)) await this.openMedia(result.widget); else this.close();
    } catch (error) {
      const code = errorCode(error);
      if (code === 'plan_limit' || code === 'limit') this.limitReached.set(true);
      this.serverError.set(message(error) || this.t('customImportFailed'));
    } finally { this.busy.set(false); }
  }
  async openMedia(widget: CustomWidgetView): Promise<void> {
    this.phase.set('media'); this.mediaWidget.set(widget); this.plan.set(null); this.planError.set(''); this.copyResult.set(null);
    try { this.plan.set(await this.widgets.mediaPlan(widget.id)); }
    catch (error) { this.planError.set(message(error) || this.t('customMediaPlanFailed')); }
  }
  async copy(): Promise<void> {
    const widget = this.mediaWidget(), files = this.pendingFiles();
    if (!widget || !files.length || this.copying()) return;
    this.copying.set(true); this.planError.set('');
    try { this.copyResult.set(await this.widgets.copyMedia(widget.id, files.map(file => file.url))); }
    catch (error) { this.planError.set(message(error) || this.t('customMediaCopyFailed')); }
    finally { this.copying.set(false); }
  }
  copiedCount(): number { return Object.keys(this.copyResult()?.copied ?? {}).length; }
  upgrade(): void { void this.upgrades.promptUpgradeForAnyPlan('custom_widgets'); }
  onCancel(event: Event): void { if (this.busy() || this.copying()) event.preventDefault(); }
  close(): void { if (this.busy() || this.copying()) return; this.dialog().nativeElement.close(); }
  onClosed(): void { this.returnFocus?.focus?.(); this.closed.emit(); }
}
