import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { Check, Film, Image, LockKeyhole, Search, Trash2, Upload, X, LucideAngularModule } from 'lucide-angular';
import { LanguageService } from '../../services/language.service';
import { AssetLibraryService, AssetLibrary, DesignAsset, assetSize } from './asset-library.service';
import { AssetPreviewComponent } from './asset-preview.component';

type AssetFilter = 'all' | 'image' | 'video';

/** Search only earns its space once the library is long enough to scan. */
const SEARCH_THRESHOLD = 6;

@Component({
  selector: 'app-asset-library-dialog', imports: [LucideAngularModule, AssetPreviewComponent, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './asset-library-dialog.component.html', styleUrl: './asset-library-dialog.component.css'
})
export class AssetLibraryDialogComponent {
  readonly owner = input.required<string>();
  readonly kind = input<'image' | 'video' | 'all'>('all');
  readonly selectable = input(true);
  readonly selected = output<DesignAsset>();
  readonly closed = output<void>();
  readonly language = inject(LanguageService);
  private readonly api = inject(AssetLibraryService);
  readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  readonly library = signal<AssetLibrary | null>(null);
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly uploading = signal('');
  readonly dragging = signal(false);
  /** Desktop shows the selected asset beside the grid; phones dock it above the footer. */
  readonly wide = signal(false);
  readonly error = signal('');
  readonly query = signal('');
  readonly filter = signal<AssetFilter>('all');
  readonly chosen = signal<DesignAsset | null>(null);
  readonly confirming = signal(false);
  readonly pageSize = signal(24);
  readonly icons = { Check, Film, Image, LockKeyhole, Search, Trash2, Upload, X };
  readonly size = assetSize;
  private generation = 0;
  private disposed = false;
  private returnFocus: HTMLElement | null = null;
  /** Assets this dialog can offer at all (a video layer only accepts videos). */
  readonly pool = computed(() => (this.library()?.assets ?? []).filter(a => this.kind() === 'all' || a.kind === this.kind()));
  readonly counts = computed(() => {
    const pool = this.pool();
    return { all: pool.length, image: pool.filter(a => a.kind === 'image').length, video: pool.filter(a => a.kind === 'video').length };
  });
  readonly filtered = computed(() => this.pool().filter(a => (this.filter() === 'all' || a.kind === this.filter()) && a.name.toLowerCase().includes(this.query().trim().toLowerCase())));
  readonly visible = computed(() => this.filtered().slice(0, this.pageSize()));
  readonly showSearch = computed(() => this.pool().length > SEARCH_THRESHOLD || this.query().length > 0);
  readonly showFilters = computed(() => this.kind() === 'all' && this.counts().image > 0 && this.counts().video > 0);
  readonly full = computed(() => !!this.library() && this.library()!.usedBytes >= this.library()!.quotaBytes);
  readonly usage = computed(() => Math.min(100, (this.library()?.usedBytes ?? 0) / (this.library()?.quotaBytes || 1) * 100));
  readonly freeBytes = computed(() => Math.max(0, (this.library()?.quotaBytes ?? 0) - (this.library()?.usedBytes ?? 0)));
  readonly nearlyFull = computed(() => !this.full() && this.usage() >= 80);
  readonly canUse = computed(() => {
    const asset = this.chosen();
    return !!asset && !this.busy() && (this.kind() === 'all' || asset.kind === this.kind());
  });
  constructor() {
    let media: MediaQueryList | null = null;
    const syncWide = () => this.wide.set(!!media?.matches);
    afterNextRender(() => {
      this.returnFocus = document.activeElement as HTMLElement; this.dialog().nativeElement.showModal();
      media = window.matchMedia('(min-width: 900px)'); syncWide(); media.addEventListener('change', syncWide);
    });
    effect(() => { const owner = this.owner(); void this.load(owner); });
    inject(DestroyRef).onDestroy(() => { this.disposed = true; this.generation++; media?.removeEventListener('change', syncWide); this.returnFocus?.focus(); });
  }
  t(key: string, params?: Record<string, string | number>) { this.language.currentLanguage(); return this.language.translate(`assetLibrary.${key}`, params); }
  private async load(owner = this.owner()) {
    const generation = ++this.generation;
    this.loading.set(true); this.error.set(''); this.chosen.set(null); this.confirming.set(false); this.library.set(null);
    try { const result = await this.api.list(owner); if (generation === this.generation && !this.disposed) this.library.set(result); }
    catch { if (generation === this.generation && !this.disposed) this.error.set('loadFailed'); }
    finally { if (generation === this.generation && !this.disposed) this.loading.set(false); }
  }
  retry() { void this.load(); }
  showMore() { this.pageSize.update(count => count + 24); }
  trapFocus(event: KeyboardEvent) {
    if (event.key !== 'Tab') return;
    const elements = [...this.dialog().nativeElement.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([hidden]), select:not(:disabled), video[controls]')].filter(element => element.getClientRects().length);
    const first = elements[0], last = elements.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  choose(asset: DesignAsset) { this.chosen.set(this.chosen()?.id === asset.id && !this.selectable() ? null : asset); this.confirming.set(false); }
  search(event: Event) { this.query.set((event.target as HTMLInputElement).value); this.pageSize.set(24); }
  clearSearch() { this.query.set(''); this.pageSize.set(24); }
  setFilter(filter: AssetFilter) { this.filter.set(filter); this.pageSize.set(24); }
  close(event?: Event) { if (this.busy()) { event?.preventDefault(); return; } this.closed.emit(); }
  use() { const asset = this.chosen(); if (asset && this.canUse()) this.selected.emit(asset); }
  dimensions(asset: DesignAsset) { return asset.width && asset.height ? `${asset.width} × ${asset.height}` : ''; }
  private report(error: unknown) {
    const code = (error as { error?: { code?: string } })?.error?.code;
    this.error.set(({ quota_exceeded: 'quotaExceeded', file_size: 'fileSize', unsupported_type: 'unsupported', invalid_media: 'unsupported', in_use: 'inUse', upload_busy: 'uploadBusy' } as Record<string, string>)[code ?? ''] ?? 'operationFailed');
  }
  upload(event: Event) {
    const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = '';
    if (file) void this.uploadFile(file);
  }
  dragOver(event: DragEvent) {
    if (!this.library() || this.busy() || this.full() || !event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; this.dragging.set(true);
  }
  dragLeave(event: DragEvent) {
    const next = event.relatedTarget as Node | null;
    if (!next || !(event.currentTarget as HTMLElement).contains(next)) this.dragging.set(false);
  }
  drop(event: DragEvent) {
    event.preventDefault(); this.dragging.set(false);
    const file = event.dataTransfer?.files?.[0];
    if (file && !this.full()) void this.uploadFile(file);
  }
  private async uploadFile(file: File) {
    const library = this.library(); if (!library || this.busy()) return;
    this.error.set('');
    if (file.type && !/^(image\/(png|jpeg|gif|webp)|video\/(mp4|webm))$/.test(file.type)) { this.error.set('unsupported'); return; }
    if (!file.size || file.size > library.maxFileBytes) { this.error.set('fileSize'); return; }
    if (file.size + library.usedBytes > library.quotaBytes) { this.error.set('quotaExceeded'); return; }
    this.busy.set(true); this.uploading.set(file.name);
    try { const asset = await this.api.upload(this.owner(), file); await this.load(); if (!this.disposed) { this.query.set(''); this.filter.set('all'); this.chosen.set(asset); } }
    catch (e) { if (!this.disposed) this.report(e); }
    finally { if (!this.disposed) { this.busy.set(false); this.uploading.set(''); } }
  }
  async remove() {
    const asset = this.chosen(); if (!asset || this.busy()) return;
    if (!this.confirming()) { this.confirming.set(true); return; }
    this.busy.set(true); this.error.set('');
    try { await this.api.delete(this.owner(), asset.id); await this.load(); }
    catch (e) { if (!this.disposed) { this.report(e); this.confirming.set(false); } }
    finally { if (!this.disposed) this.busy.set(false); }
  }
}
