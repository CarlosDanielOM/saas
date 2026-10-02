import { ChangeDetectionStrategy, Component, computed, inject, OnInit, OnDestroy, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, firstValueFrom, forkJoin, map, of, switchMap } from 'rxjs';

import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { getRouteParam } from '../../shared/utils/route-param.util';
import { MediaAsset } from '../triggers/triggers.model';
import { TriggersService } from '../triggers/triggers.service';
import { LazyVideoFrameDirective } from '../triggers/lazy-video-frame.directive';
import { ChannelExtensionItem, DimafxCategory, DimafxTtsLanguage, DimafxTtsMode } from './dimafx.model';
import { DimafxService } from './dimafx.service';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';

interface AssetOption {
  id: string;
  label: string;
  mediaType: string;
  playbackUrl: string;
  source: 'library' | 'public';
  owner: string;
}

type ItemKind = 'media' | 'tts';
type MediaFilter = 'all' | 'audio' | 'video' | 'image';

const PIPER_VOICE_OPTIONS: { value: string; label: string }[] = [
  { value: 'en_US-ryan-medium', label: 'Ryan · US English' },
  { value: 'es_MX-ald-medium', label: 'Ald · Mexican Spanish' }
];

/** The extension panel filters and renders thumbnails by category, so it follows the media type. */
function categoryForMedia(mediaType: string): DimafxCategory {
  if (mediaType === 'audio') return 'audio';
  if (mediaType === 'video') return 'video';
  return 'gif';
}

@Component({
  selector: 'app-dimafx-page',
  imports: [RouterLink, LfIconComponent, LazyVideoFrameDirective, NgTemplateOutlet],
  templateUrl: './dimafx-page.component.html',
  styleUrl: './dimafx-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown.escape)': 'handleEscape()'
  }
})
export class DimafxPageComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly dimafxService = inject(DimafxService);
  private readonly triggersService = inject(TriggersService);
  private readonly toastService = inject(ToastService);
  private readonly languageService = inject(LanguageService);

  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly items = signal<ChannelExtensionItem[]>([]);
  readonly allowedBitPrices = signal<number[]>([5, 10, 25, 50, 100]);
  readonly assetOptions = signal<AssetOption[]>([]);

  // Editor dialog
  readonly editorOpen = signal(false);
  readonly selectedItemId = signal<string | null>(null);
  readonly submitAttempted = signal(false);
  readonly kind = signal<ItemKind>('media');
  readonly mediaSearchQuery = signal('');
  readonly mediaFilter = signal<MediaFilter>('all');
  readonly filterOptions: MediaFilter[] = ['all', 'audio', 'video', 'image'];

  readonly selectedAssetID = signal('');
  readonly name = signal('');
  readonly description = signal('');
  readonly category = signal<DimafxCategory>('video');
  readonly durationMs = signal(0);
  readonly bitsPrice = signal(5);
  readonly volume = signal(100);
  readonly isEnabled = signal(true);
  readonly sortOrder = signal(0);
  readonly ttsMode = signal<DimafxTtsMode>('custom');
  readonly ttsText = signal('');
  readonly ttsVoice = signal('');
  readonly ttsLanguage = signal<DimafxTtsLanguage>('en');
  private autoName = '';

  // Delete dialog
  readonly pendingDelete = signal<ChannelExtensionItem | null>(null);
  readonly deleting = signal(false);

  readonly overlayConnected = signal<boolean | null>(null);
  readonly overlayUrl = signal('');
  readonly overlayCopied = signal(false);
  private overlayStatusTimer?: ReturnType<typeof setInterval>;
  private destroyed = false;
  readonly testingItemId = signal<string | null>(null);
  readonly togglingItemId = signal<string | null>(null);

  readonly streamer = computed(() => getRouteParam(this.route, 'streamer') || this.sessionAuth.session()?.appUser.name || '');
  readonly channelID = signal('');
  private readonly mutationAccess = toSignal(toObservable(this.channelID).pipe(
    switchMap((channelID) => channelID
      ? forkJoin({
          edit: this.sessionAuth.checkPermission(channelID, 'dimafx:edit').pipe(catchError(() => of(false))),
          delete: this.sessionAuth.checkPermission(channelID, 'dimafx:delete').pipe(catchError(() => of(false)))
        }).pipe(map((grants) => ({ channelID, ...grants })))
      : of({ channelID, edit: false, delete: false }))
  ), { initialValue: { channelID: '', edit: false, delete: false } });
  readonly canEdit = computed(() => Boolean(this.channelID()) && this.mutationAccess().channelID === this.channelID() && this.mutationAccess().edit);
  readonly canDelete = computed(() => Boolean(this.channelID()) && this.mutationAccess().channelID === this.channelID() && this.mutationAccess().delete);
  readonly isEditing = computed(() => Boolean(this.selectedItemId()));
  readonly isTtsCategory = computed(() => this.kind() === 'tts');
  readonly enabledCount = computed(() => this.items().filter((item) => item.isEnabled).length);

  readonly selectedAsset = computed(() => this.assetOptions().find((asset) => asset.id === this.selectedAssetID()) ?? null);
  readonly editingItem = computed(() => this.items().find((item) => item.id === this.selectedItemId()) ?? null);

  readonly formErrors = computed(() => ({
    name: !this.name().trim(),
    media: !this.isTtsCategory() && !this.selectedAssetID(),
    ttsText: this.isTtsCategory() && this.ttsMode() === 'fixed' && !this.ttsText().trim()
  }));
  readonly canSubmit = computed(() => {
    const errors = this.formErrors();
    return Boolean(this.channelID()) && this.bitsPrice() >= 0 && !errors.name && !errors.media && !errors.ttsText;
  });

  readonly ttsVoiceOptions = computed(() => {
    const saved = this.ttsVoice();
    const options = [...PIPER_VOICE_OPTIONS];
    if (saved && !options.some((option) => option.value === saved)) {
      options.push({ value: saved, label: saved });
    }
    return options;
  });

  /** Image/GIF only — how long it stays on screen. Video/audio length comes from the file. */
  readonly showVisibilityDuration = computed(() => {
    if (this.isTtsCategory()) return false;
    const mediaType = this.selectedAsset()?.mediaType ?? this.editingItem()?.mediaType ?? '';
    if (mediaType === 'image' || mediaType === 'gif') return true;
    if (mediaType === 'video' || mediaType === 'audio') return false;
    return this.category() === 'gif';
  });

  readonly filteredAssetOptions = computed(() => {
    const query = this.mediaSearchQuery().toLowerCase().trim();
    const filter = this.mediaFilter();
    return this.assetOptions().filter((asset) => {
      const matchesSearch = !query || asset.label.toLowerCase().includes(query) || asset.owner.toLowerCase().includes(query);
      const matchesFilter = filter === 'all' || asset.mediaType === filter || (filter === 'image' && asset.mediaType === 'gif');
      return matchesSearch && matchesFilter;
    });
  });

  readonly playingAssetId = signal<string | null>(null);
  private audioPlayer: HTMLAudioElement | null = null;
  readonly activePreviewAsset = signal<{ label: string; mediaType: string; playbackUrl: string } | null>(null);

  async ngOnInit(): Promise<void> {
    await this.resolveChannel();
    await this.load();
    if (!this.destroyed) this.overlayStatusTimer = setInterval(() => { void this.refreshOverlayStatus(); }, 5000);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    clearInterval(this.overlayStatusTimer);
    this.stopAudio();
  }

  protected t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  handleEscape(): void {
    if (this.activePreviewAsset()) return this.closePreviewModal();
    if (this.pendingDelete()) return this.closeDelete();
    if (this.editorOpen()) this.closeEditor();
  }

  // ---- Media previews -----------------------------------------------------

  /** Audio plays inline (tap again to stop); video and images open the preview dialog. */
  previewMedia(event: MouseEvent, id: string, media: { label: string; mediaType: string; playbackUrl: string | null }): void {
    event.stopPropagation();
    if (!media.playbackUrl) return;
    if (media.mediaType !== 'audio') {
      this.stopAudio();
      this.activePreviewAsset.set({ label: media.label, mediaType: media.mediaType, playbackUrl: media.playbackUrl });
      return;
    }
    const wasPlaying = this.playingAssetId() === id;
    this.stopAudio();
    if (wasPlaying) return;
    const audio = new Audio(media.playbackUrl);
    audio.volume = 0.5;
    const stop = () => {
      if (this.audioPlayer === audio) {
        this.audioPlayer = null;
        this.playingAssetId.set(null);
      }
    };
    audio.addEventListener('ended', stop);
    audio.addEventListener('error', () => {
      stop();
      this.toastService.error(this.t('modules.dimafx.toasts.playErrorTitle'), this.t('modules.dimafx.toasts.playError'));
    });
    this.audioPlayer = audio;
    this.playingAssetId.set(id);
    audio.play().catch(stop);
  }

  closePreviewModal(): void {
    this.activePreviewAsset.set(null);
  }

  private stopAudio(): void {
    this.audioPlayer?.pause();
    this.audioPlayer = null;
    this.playingAssetId.set(null);
  }

  // ---- Overlay ------------------------------------------------------------

  private async refreshOverlayStatus(): Promise<void> {
    const channelID = this.channelID();
    if (!channelID) return;
    try {
      const status = await firstValueFrom(this.dimafxService.getOverlayStatus(channelID));
      if (this.destroyed || channelID !== this.channelID()) return;
      this.overlayConnected.set(status.connected);
      this.overlayUrl.set(status.overlayUrl);
    } catch { if (!this.destroyed) this.overlayConnected.set(null); }
  }

  async copyOverlayUrl(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.overlayUrl());
      this.overlayCopied.set(true);
      setTimeout(() => this.overlayCopied.set(false), 1800);
      this.toastService.success(this.t('modules.dimafx.overlayLinkCopied'), '');
    } catch {
      this.toastService.error(this.t('modules.dimafx.overlayCopyFailed'), '');
    }
  }

  // ---- Loading ------------------------------------------------------------

  async load(): Promise<void> {
    if (!this.channelID()) return;
    this.loading.set(true);
    this.error.set(null);
    try {
      const [itemsResponse, library, publicAssets, overlayStatus] = await Promise.all([
        firstValueFrom(this.dimafxService.getItems(this.channelID())),
        firstValueFrom(this.triggersService.getLibrary(this.channelID())).catch(() => null),
        firstValueFrom(this.triggersService.getPublicAssets()),
        firstValueFrom(this.dimafxService.getOverlayStatus(this.channelID())).catch(() => null)
      ]);
      this.items.set(itemsResponse.items);
      this.allowedBitPrices.set(itemsResponse.allowedBitPrices);
      if (!itemsResponse.allowedBitPrices.includes(this.bitsPrice())) {
        this.bitsPrice.set(this.defaultPrice());
      }
      this.overlayConnected.set(overlayStatus?.connected ?? null);
      this.overlayUrl.set(overlayStatus?.overlayUrl ?? '');
      this.assetOptions.set(this.buildAssetOptions(
        (library?.items ?? []).map((item) => item.asset).filter((asset): asset is MediaAsset => Boolean(asset)),
        publicAssets
      ));
    } catch (error) {
      const message = error instanceof Error ? error.message : this.t('modules.dimafx.toasts.loadFailed');
      this.error.set(message);
      this.toastService.error(this.t('modules.dimafx.toasts.loadFailedTitle'), message);
    } finally {
      this.loading.set(false);
    }
  }

  // ---- Editor -------------------------------------------------------------

  openCreate(): void {
    if (!this.canEdit()) return;
    this.selectedItemId.set(null);
    this.kind.set('media');
    this.selectedAssetID.set('');
    this.name.set('');
    this.autoName = '';
    this.description.set('');
    this.category.set('video');
    this.durationMs.set(0);
    this.bitsPrice.set(this.defaultPrice());
    this.volume.set(100);
    this.isEnabled.set(true);
    this.sortOrder.set(this.items().reduce((max, item) => Math.max(max, item.sortOrder), 0) + 1);
    this.ttsMode.set('custom');
    this.ttsText.set('');
    this.ttsVoice.set('');
    this.ttsLanguage.set('en');
    this.openEditor();
  }

  selectItem(item: ChannelExtensionItem): void {
    if (!this.canEdit()) return;
    this.selectedItemId.set(item.id);
    this.kind.set(item.category === 'tts' ? 'tts' : 'media');
    this.selectedAssetID.set(item.assetID || '');
    this.name.set(item.name);
    this.autoName = '';
    this.description.set(item.description || '');
    this.category.set(item.category);
    this.durationMs.set(item.durationMs || 0);
    this.bitsPrice.set(item.bitsPrice);
    this.volume.set(item.volume);
    this.isEnabled.set(item.isEnabled);
    this.sortOrder.set(item.sortOrder);
    this.ttsMode.set(item.tts?.mode === 'fixed' ? 'fixed' : 'custom');
    this.ttsText.set(item.tts?.text || '');
    this.ttsVoice.set(item.tts?.voice || '');
    this.ttsLanguage.set(item.tts?.language === 'es' ? 'es' : 'en');
    this.openEditor();
  }

  private openEditor(): void {
    this.submitAttempted.set(false);
    this.mediaSearchQuery.set('');
    this.mediaFilter.set('all');
    this.editorOpen.set(true);
  }

  closeEditor(): void {
    if (this.saving()) return;
    this.stopAudio();
    this.editorOpen.set(false);
    this.selectedItemId.set(null);
  }

  setKind(kind: ItemKind): void {
    // The server can't switch an existing item between TTS and media.
    if (this.isEditing()) return;
    this.kind.set(kind);
    this.category.set(kind === 'tts' ? 'tts' : categoryForMedia(this.selectedAsset()?.mediaType ?? 'video'));
  }

  selectAsset(asset: AssetOption): void {
    if (!this.canEdit() || this.isEditing()) return;
    this.selectedAssetID.set(asset.id);
    this.category.set(categoryForMedia(asset.mediaType));
    // The name follows the picked media until the streamer types their own.
    if (!this.name().trim() || this.name() === this.autoName) {
      this.autoName = asset.label;
      this.name.set(asset.label);
    }
    this.durationMs.set(asset.mediaType === 'image' || asset.mediaType === 'gif' ? 3000 : 0);
    if (asset.mediaType === 'audio' || asset.mediaType === 'video') this.readMediaDuration(asset);
  }

  private readMediaDuration(asset: AssetOption): void {
    const element = asset.mediaType === 'audio' ? new Audio() : document.createElement('video');
    element.preload = 'metadata';
    element.addEventListener('loadedmetadata', () => {
      if (this.selectedAssetID() === asset.id && Number.isFinite(element.duration) && element.duration > 0) {
        this.durationMs.set(Math.round(element.duration * 1000));
      }
    });
    element.src = asset.playbackUrl;
  }

  async save(): Promise<void> {
    if (!this.canEdit() || this.saving()) return;
    this.submitAttempted.set(true);
    if (!this.canSubmit()) return;
    this.saving.set(true);
    try {
      const isTts = this.isTtsCategory();
      const payload = {
        ...(isTts ? {} : { assetID: this.selectedAssetID() }),
        channelName: this.streamer(),
        name: this.name().trim(),
        description: this.description().trim(),
        category: this.category(),
        durationMs: isTts ? 0 : Number(this.durationMs() || 0),
        bitsPrice: Number(this.bitsPrice()),
        volume: Number(this.volume()),
        isEnabled: this.isEnabled(),
        sortOrder: Number(this.sortOrder() || 0),
        ...(isTts
          ? {
              tts: {
                mode: this.ttsMode(),
                text: this.ttsMode() === 'fixed' ? this.ttsText().trim() : '',
                voice: this.ttsVoice(),
                language: this.ttsLanguage()
              }
            }
          : {})
      };

      if (this.selectedItemId()) {
        const updated = await firstValueFrom(this.dimafxService.updateItem(this.channelID(), this.selectedItemId()!, payload));
        this.items.update((items) => this.sortItems(items.map((item) => (item.id === updated.id ? updated : item))));
        this.toastService.success(this.t('modules.dimafx.toasts.updated'), updated.name);
      } else {
        const created = await firstValueFrom(this.dimafxService.createItem(this.channelID(), payload));
        this.items.update((items) => this.sortItems([...items, created]));
        this.toastService.success(this.t('modules.dimafx.toasts.created'), created.name);
      }
      this.saving.set(false);
      this.closeEditor();
    } catch (error) {
      const message = error instanceof Error ? error.message : this.t('modules.dimafx.toasts.saveFailed');
      this.toastService.error(this.t('modules.dimafx.toasts.saveFailedTitle'), message);
    } finally {
      this.saving.set(false);
    }
  }

  // ---- Row actions --------------------------------------------------------

  async toggleEnabled(item: ChannelExtensionItem): Promise<void> {
    if (!this.canEdit() || this.togglingItemId()) return;
    const next = !item.isEnabled;
    this.togglingItemId.set(item.id);
    this.items.update((items) => items.map((entry) => entry.id === item.id ? { ...entry, isEnabled: next } : entry));
    try {
      const updated = await firstValueFrom(this.dimafxService.updateItem(this.channelID(), item.id, { isEnabled: next }));
      this.items.update((items) => items.map((entry) => entry.id === item.id ? updated : entry));
    } catch (error) {
      this.items.update((items) => items.map((entry) => entry.id === item.id ? { ...entry, isEnabled: item.isEnabled } : entry));
      const message = error instanceof Error ? error.message : this.t('modules.dimafx.toasts.saveFailed');
      this.toastService.error(this.t('modules.dimafx.toasts.saveFailedTitle'), message);
    } finally {
      this.togglingItemId.set(null);
    }
  }

  async testItem(item: ChannelExtensionItem): Promise<void> {
    if (!this.canEdit() || this.testingItemId()) return;
    this.testingItemId.set(item.id);
    try {
      const result = await firstValueFrom(this.dimafxService.testItem(this.channelID(), item.id));
      this.overlayConnected.set(true);
      this.toastService.success(
        this.t('modules.dimafx.testQueued'),
        this.t('modules.dimafx.testQueuedDesc', { name: item.name, position: result.queueLength })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : this.t('modules.dimafx.testFailed');
      if (message.toLowerCase().includes('overlay')) {
        this.overlayConnected.set(false);
      }
      this.toastService.error(this.t('modules.dimafx.testFailed'), message);
    } finally {
      this.testingItemId.set(null);
    }
  }

  askDelete(item: ChannelExtensionItem): void {
    if (this.canDelete()) this.pendingDelete.set(item);
  }

  closeDelete(): void {
    if (!this.deleting()) this.pendingDelete.set(null);
  }

  async confirmDelete(refundSaved: boolean): Promise<void> {
    const item = this.pendingDelete();
    if (!item || !this.canDelete() || this.deleting()) return;
    this.deleting.set(true);
    try {
      await firstValueFrom(this.dimafxService.deleteItem(this.channelID(), item.id, refundSaved));
      this.items.update((items) => items.filter((candidate) => candidate.id !== item.id));
      this.toastService.success(
        this.t('modules.dimafx.toasts.deleted'),
        refundSaved ? this.t('modules.dimafx.toasts.deletedRefunded') : item.name
      );
      this.deleting.set(false);
      this.pendingDelete.set(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : this.t('modules.dimafx.toasts.deleteFailed');
      this.toastService.error(this.t('modules.dimafx.toasts.deleteFailedTitle'), message);
    } finally {
      this.deleting.set(false);
    }
  }

  // ---- Form setters -------------------------------------------------------

  setName(value: string): void { this.name.set(value); }
  setDescription(value: string): void { this.description.set(value); }
  setDurationMs(value: number): void { this.durationMs.set(value); }
  setBitsPrice(value: number): void { this.bitsPrice.set(value); }
  setVolume(value: number): void { this.volume.set(Math.max(0, Math.min(100, value))); }
  setSortOrder(value: number): void { this.sortOrder.set(value); }
  setCategory(value: string): void {
    if (value === 'video' || value === 'gif' || value === 'audio') this.category.set(value);
  }
  setTtsMode(value: string): void { this.ttsMode.set(value === 'fixed' ? 'fixed' : 'custom'); }
  setTtsText(value: string): void { this.ttsText.set(value); }
  setTtsVoice(value: string): void { this.ttsVoice.set(value); }
  setTtsLanguage(value: string): void { this.ttsLanguage.set(value === 'es' ? 'es' : 'en'); }

  formatBitsPrice(price: number): string {
    if (Number(price) === 0) {
      return this.t('modules.dimafx.bitsPriceFree');
    }
    return this.t('modules.dimafx.bitsPriceBits', { price });
  }

  categoryLabel(category: string): string {
    return this.t(`modules.dimafx.categories.${category}`);
  }

  itemSummary(item: ChannelExtensionItem): string {
    if (item.category === 'tts') {
      return item.tts?.mode === 'fixed' ? `“${item.tts.text}”` : this.t('modules.dimafx.ttsModeCustom');
    }
    return item.description || '';
  }

  private defaultPrice(): number {
    const prices = this.allowedBitPrices();
    return prices.find((price) => price > 0) ?? prices[0] ?? 5;
  }

  private sortItems(items: ChannelExtensionItem[]): ChannelExtensionItem[] {
    return [...items].sort((a, b) => a.sortOrder - b.sortOrder);
  }

  private async resolveChannel(): Promise<void> {
    const streamer = this.streamer();
    if (/^\d+$/.test(streamer)) {
      this.channelID.set(streamer);
      return;
    }
    const channelID = await firstValueFrom(this.sessionAuth.resolveChannelID(streamer));
    this.channelID.set(channelID || this.sessionAuth.session()?.appUser.twitch_user_id || '');
  }

  private buildAssetOptions(libraryAssets: MediaAsset[], publicAssets: MediaAsset[]): AssetOption[] {
    const libraryIds = new Set(libraryAssets.map((asset) => asset._id));
    const seen = new Set<string>();
    const options: AssetOption[] = [];
    for (const asset of [...libraryAssets, ...publicAssets]) {
      if (seen.has(asset._id)) continue;
      seen.add(asset._id);
      options.push({
        id: asset._id,
        label: (asset.displayName || asset.fileName || '').replace(/_+/g, ' ').trim(),
        mediaType: asset.mediaType,
        playbackUrl: asset.playbackUrl,
        source: libraryIds.has(asset._id) ? 'library' : 'public',
        owner: asset.ownerChannelName || ''
      });
    }
    // Your own media first, then the public library.
    return options.sort((a, b) => (a.source === b.source ? a.label.localeCompare(b.label) : a.source === 'library' ? -1 : 1));
  }
}
