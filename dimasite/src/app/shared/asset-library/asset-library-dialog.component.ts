import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { Image, LockKeyhole, Search, Upload, X, LucideAngularModule } from 'lucide-angular';
import { LanguageService } from '../../services/language.service';
import { AssetLibraryService, AssetLibrary, DesignAsset, assetSize } from './asset-library.service';
import { AssetPreviewComponent } from './asset-preview.component';

@Component({
  selector: 'app-asset-library-dialog', imports: [LucideAngularModule, AssetPreviewComponent],
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
  readonly error = signal('');
  readonly query = signal('');
  readonly filter = signal<'all' | 'image' | 'video'>('all');
  readonly chosen = signal<DesignAsset | null>(null);
  readonly confirming = signal(false);
  readonly pageSize = signal(24);
  readonly icons = { Image, LockKeyhole, Search, Upload, X };
  readonly size = assetSize;
  private generation = 0;
  private disposed = false;
  private returnFocus: HTMLElement | null = null;
  readonly filtered = computed(() => (this.library()?.assets ?? []).filter(a => (this.kind() === 'all' || a.kind === this.kind()) && (this.filter() === 'all' || a.kind === this.filter()) && a.name.toLowerCase().includes(this.query().trim().toLowerCase())));
  readonly visible = computed(() => this.filtered().slice(0, this.pageSize()));
  readonly full = computed(() => !!this.library() && this.library()!.usedBytes >= this.library()!.quotaBytes);
  readonly usage = computed(() => Math.min(100, (this.library()?.usedBytes ?? 0) / (this.library()?.quotaBytes || 1) * 100));
  constructor() {
    afterNextRender(() => { this.returnFocus = document.activeElement as HTMLElement; this.dialog().nativeElement.showModal(); });
    effect(() => { const owner = this.owner(); void this.load(owner); });
    inject(DestroyRef).onDestroy(() => { this.disposed = true; this.generation++; this.returnFocus?.focus(); });
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
  choose(asset: DesignAsset) { this.chosen.set(asset); this.confirming.set(false); }
  search(event: Event) { this.query.set((event.target as HTMLInputElement).value); this.pageSize.set(24); }
  setFilter(event: Event) { this.filter.set((event.target as HTMLSelectElement).value as 'all' | 'image' | 'video'); this.pageSize.set(24); }
  close(event?: Event) { if (this.busy()) { event?.preventDefault(); return; } this.closed.emit(); }
  use() { const asset = this.chosen(); if (asset && !this.busy()) this.selected.emit(asset); }
  private report(error: unknown) {
    const code = (error as { error?: { code?: string } })?.error?.code;
    this.error.set(({ quota_exceeded: 'quotaExceeded', file_size: 'fileSize', unsupported_type: 'unsupported', invalid_media: 'unsupported', in_use: 'inUse', upload_busy: 'uploadBusy' } as Record<string, string>)[code ?? ''] ?? 'operationFailed');
  }
  async upload(event: Event) {
    const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = '';
    const library = this.library(); if (!file || !library || this.busy()) return;
    this.error.set('');
    if (!file.size || file.size > library.maxFileBytes) { this.error.set('fileSize'); return; }
    if (file.size + library.usedBytes > library.quotaBytes) { this.error.set('quotaExceeded'); return; }
    this.busy.set(true);
    try { const asset = await this.api.upload(this.owner(), file); await this.load(); if (!this.disposed) { this.query.set(''); this.filter.set('all'); this.chosen.set(asset); } }
    catch (e) { if (!this.disposed) this.report(e); }
    finally { if (!this.disposed) this.busy.set(false); }
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
