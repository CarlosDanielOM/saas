import { ChangeDetectionStrategy, Component, computed, inject, OnInit, OnDestroy, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { getRouteParam } from '../../shared/utils/route-param.util';
import { MediaAsset } from '../triggers/triggers.model';
import { TriggersService } from '../triggers/triggers.service';
import { ChannelExtensionItem, DimafxCategory } from './dimafx.model';
import { DimafxService } from './dimafx.service';

interface AssetOption {
  id: string;
  label: string;
  mediaType: string;
  playbackUrl: string;
  source: 'library' | 'public';
}

@Component({
  selector: 'app-dimafx-page',
  imports: [RouterLink],
  templateUrl: './dimafx-page.component.html',
  styleUrl: './dimafx-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DimafxPageComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly dimafxService = inject(DimafxService);
  private readonly triggersService = inject(TriggersService);
  private readonly toastService = inject(ToastService);
  private readonly languageService = inject(LanguageService);

  readonly modalViewMode = signal<'grid' | 'list'>('grid');

  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly items = signal<ChannelExtensionItem[]>([]);
  readonly allowedBitPrices = signal<number[]>([5, 10, 25, 50, 100]);
  readonly assetOptions = signal<AssetOption[]>([]);
  readonly selectedItemId = signal<string | null>(null);
  readonly isMediaModalOpen = signal(false);
  readonly mediaSearchQuery = signal('');
  readonly mediaFilter = signal<string>('all');

  readonly selectedAssetID = signal('');
  readonly name = signal('');
  readonly description = signal('');
  readonly category = signal<DimafxCategory>('video');
  readonly thumbnailUrl = signal('');
  readonly durationMs = signal(0);
  readonly bitsPrice = signal(5);
  readonly volume = signal(100);
  readonly isEnabled = signal(true);
  readonly sortOrder = signal(0);

  readonly streamer = computed(() => getRouteParam(this.route, 'streamer') || this.sessionAuth.session()?.appUser.name || '');
  readonly channelID = signal('');
  readonly isEditing = computed(() => Boolean(this.selectedItemId()));
  readonly canSubmit = computed(() => Boolean(this.channelID() && this.selectedAssetID() && this.name().trim() && this.bitsPrice() >= 0));
  readonly enabledCount = computed(() => this.items().filter((item) => item.isEnabled).length);
  /** Image/GIF only — visibility length. Video/audio duration comes from media metadata. */
  readonly showVisibilityDuration = computed(() => {
    const mediaType = this.getSelectedAssetMediaType();
    if (mediaType === 'image') return true;
    if (mediaType === 'video' || mediaType === 'audio') return false;
    // Fallback when editing without asset list match: category gif
    return this.category() === 'gif';
  });

  readonly filteredAssetOptions = computed(() => {
    const query = this.mediaSearchQuery().toLowerCase().trim();
    const filter = this.mediaFilter();
    return this.assetOptions().filter((asset) => {
      const matchesSearch = asset.label.toLowerCase().includes(query);
      const matchesFilter = filter === 'all' || asset.mediaType === filter;
      return matchesSearch && matchesFilter;
    });
  });

  readonly playingAssetId = signal<string | null>(null);
  private audioPlayer: HTMLAudioElement | null = null;

  readonly activePreviewAsset = signal<AssetOption | null>(null);
  readonly isAudioPlaying = signal(false);
  private previewAudio: HTMLAudioElement | null = null;

  openMediaModal(): void {
    this.mediaSearchQuery.set('');
    this.mediaFilter.set('all');
    this.isMediaModalOpen.set(true);
  }

  closeMediaModal(): void {
    this.stopPreview();
    this.isMediaModalOpen.set(false);
  }

  togglePreview(event: MouseEvent, asset: AssetOption): void {
    event.stopPropagation();
    if (this.playingAssetId() === asset.id) {
      this.stopPreview();
      return;
    }
    this.stopPreview();
    if (!asset.playbackUrl) {
      this.toastService.error('Preview error', 'No playback URL available for this asset.');
      return;
    }
    try {
      this.audioPlayer = new Audio(asset.playbackUrl);
      this.audioPlayer.volume = 0.5;
      this.audioPlayer.addEventListener('ended', () => {
        this.playingAssetId.set(null);
      });
      this.audioPlayer.addEventListener('error', () => {
        this.playingAssetId.set(null);
        this.toastService.error('Preview error', 'Failed to play audio asset.');
      });
      this.playingAssetId.set(asset.id);
      this.audioPlayer.play();
    } catch (err) {
      this.playingAssetId.set(null);
      this.toastService.error('Preview error', 'Failed to play audio asset.');
    }
  }

  openPreviewModal(event: MouseEvent, asset: { label: string; mediaType: string; playbackUrl: string; source?: string }): void {
    event.stopPropagation();
    this.stopPreview();
    const option: AssetOption = {
      id: 'preview',
      label: asset.label,
      mediaType: asset.mediaType,
      playbackUrl: asset.playbackUrl,
      source: (asset.source as any) || 'item'
    };
    this.activePreviewAsset.set(option);
    if (asset.mediaType === 'audio' && asset.playbackUrl) {
      this.playAudioPreview(asset.playbackUrl);
    }
  }

  closePreviewModal(): void {
    this.stopPreview();
    this.activePreviewAsset.set(null);
  }

  private playAudioPreview(url: string): void {
    try {
      this.previewAudio = new Audio(url);
      this.previewAudio.volume = 0.5;
      this.previewAudio.addEventListener('play', () => this.isAudioPlaying.set(true));
      this.previewAudio.addEventListener('pause', () => this.isAudioPlaying.set(false));
      this.previewAudio.addEventListener('ended', () => {
        this.isAudioPlaying.set(false);
        this.previewAudio = null;
      });
      this.previewAudio.addEventListener('error', () => {
        this.isAudioPlaying.set(false);
        this.previewAudio = null;
        this.toastService.error('Preview error', 'Failed to play audio asset.');
      });
      this.previewAudio.play();
    } catch (err) {
      this.isAudioPlaying.set(false);
      this.toastService.error('Preview error', 'Failed to play audio asset.');
    }
  }

  toggleAudioPlayPause(): void {
    if (!this.previewAudio) {
      const asset = this.activePreviewAsset();
      if (asset && asset.playbackUrl) {
        this.playAudioPreview(asset.playbackUrl);
      }
      return;
    }
    if (this.previewAudio.paused) {
      this.previewAudio.play();
    } else {
      this.previewAudio.pause();
    }
  }

  stopPreview(): void {
    if (this.audioPlayer) {
      this.audioPlayer.pause();
      this.audioPlayer = null;
    }
    this.playingAssetId.set(null);

    if (this.previewAudio) {
      this.previewAudio.pause();
      this.previewAudio = null;
    }
    this.isAudioPlaying.set(false);
  }

  ngOnDestroy(): void {
    this.stopPreview();
  }

  selectAssetFromModal(asset: AssetOption): void {
    this.selectedAssetID.set(asset.id);
    if (!this.name().trim()) {
      this.name.set(asset.label);
    }
    
    // Auto populate duration based on media type
    if (asset.mediaType === 'audio') {
      try {
        const audio = new Audio(asset.playbackUrl);
        audio.addEventListener('loadedmetadata', () => {
          if (audio.duration && !isNaN(audio.duration)) {
            this.durationMs.set(Math.round(audio.duration * 1000));
          }
        });
      } catch (err) {
        console.warn('Failed to load audio duration metadata', err);
      }
    } else if (asset.mediaType === 'video') {
      try {
        const video = document.createElement('video');
        video.src = asset.playbackUrl;
        video.addEventListener('loadedmetadata', () => {
          if (video.duration && !isNaN(video.duration)) {
            this.durationMs.set(Math.round(video.duration * 1000));
          }
        });
      } catch (err) {
        console.warn('Failed to load video duration metadata', err);
      }
    } else {
      // image / gif - default to 3s (3000ms)
      this.durationMs.set(3000);
    }

    this.isMediaModalOpen.set(false);
  }

  getSelectedAssetLabel(): string {
    const asset = this.assetOptions().find(a => a.id === this.selectedAssetID());
    return asset ? asset.label : '';
  }

  getSelectedAssetMediaType(): string {
    const asset = this.assetOptions().find(a => a.id === this.selectedAssetID());
    return asset ? asset.mediaType : '';
  }

  getSelectedAssetSource(): string {
    const asset = this.assetOptions().find(a => a.id === this.selectedAssetID());
    return asset ? asset.source : '';
  }

  async ngOnInit(): Promise<void> {
    await this.resolveChannel();
    await this.load();
  }

  protected t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  async load(): Promise<void> {
    if (!this.channelID()) return;
    this.loading.set(true);
    this.error.set(null);
    try {
      const [itemsResponse, library, publicAssets] = await Promise.all([
        firstValueFrom(this.dimafxService.getItems(this.channelID())),
        firstValueFrom(this.triggersService.getLibrary(this.channelID())),
        firstValueFrom(this.triggersService.getPublicAssets())
      ]);
      this.items.set(itemsResponse.items);
      this.allowedBitPrices.set(itemsResponse.allowedBitPrices);
      if (!itemsResponse.allowedBitPrices.includes(this.bitsPrice())) {
        this.bitsPrice.set(itemsResponse.allowedBitPrices[0] || 5);
      }
      this.assetOptions.set(this.buildAssetOptions(
        library.items.map((item) => item.asset).filter((asset): asset is MediaAsset => Boolean(asset)),
        publicAssets
      ));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load DimaFX settings';
      this.error.set(message);
      this.toastService.error('DimaFX load failed', message);
    } finally {
      this.loading.set(false);
    }
  }

  selectItem(item: ChannelExtensionItem): void {
    this.selectedItemId.set(item.id);
    this.selectedAssetID.set(item.assetID);
    this.name.set(item.name);
    this.description.set(item.description || '');
    this.category.set(item.category);
    this.thumbnailUrl.set(item.thumbnailUrl || '');
    this.durationMs.set(item.durationMs || 0);
    this.bitsPrice.set(item.bitsPrice);
    this.volume.set(item.volume);
    this.isEnabled.set(item.isEnabled);
    this.sortOrder.set(item.sortOrder);
  }

  resetForm(): void {
    this.selectedItemId.set(null);
    this.selectedAssetID.set('');
    this.name.set('');
    this.description.set('');
    this.category.set('video');
    this.thumbnailUrl.set('');
    this.durationMs.set(0);
    this.bitsPrice.set(this.allowedBitPrices()[0] || 5);
    this.volume.set(100);
    this.isEnabled.set(true);
    this.sortOrder.set(0);
  }

  async save(): Promise<void> {
    if (!this.canSubmit() || this.saving()) return;
    this.saving.set(true);
    try {
      const payload = {
        assetID: this.selectedAssetID(),
        channelName: this.streamer(),
        name: this.name().trim(),
        description: this.description().trim(),
        category: this.category(),
        thumbnailUrl: this.thumbnailUrl().trim(),
        durationMs: Number(this.durationMs() || 0),
        bitsPrice: Number(this.bitsPrice()),
        volume: Number(this.volume()),
        isEnabled: this.isEnabled(),
        sortOrder: Number(this.sortOrder() || 0)
      };

      if (this.selectedItemId()) {
        const updated = await firstValueFrom(this.dimafxService.updateItem(this.channelID(), this.selectedItemId()!, payload));
        this.items.update((items) => items.map((item) => (item.id === updated.id ? updated : item)));
        this.toastService.success('DimaFX item updated', updated.name);
      } else {
        const created = await firstValueFrom(this.dimafxService.createItem(this.channelID(), payload));
        this.items.update((items) => [created, ...items]);
        this.toastService.success('DimaFX item created', created.name);
      }

      this.resetForm();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to save DimaFX item';
      this.toastService.error('Save failed', message);
    } finally {
      this.saving.set(false);
    }
  }

  async deleteItem(item: ChannelExtensionItem, refundSaved: boolean): Promise<void> {
    try {
      await firstValueFrom(this.dimafxService.deleteItem(this.channelID(), item.id, refundSaved));
      this.items.update((items) => items.filter((candidate) => candidate.id !== item.id));
      this.toastService.success('DimaFX item removed', refundSaved ? 'Saved copies were refunded as credits.' : item.name);
      if (this.selectedItemId() === item.id) this.resetForm();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to delete DimaFX item';
      this.toastService.error('Delete failed', message);
    }
  }

  onAssetChange(value: string): void {
    this.selectedAssetID.set(value);
    const asset = this.assetOptions().find((option) => option.id === value);
    if (asset && !this.name().trim()) {
      this.name.set(asset.label);
    }
  }

  onNumberInput(target: EventTarget | null, setter: (value: number) => void): void {
    const input = target as HTMLInputElement | null;
    setter(Number(input?.value || 0));
  }

  onTextInput(target: EventTarget | null, setter: (value: string) => void): void {
    const input = target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
    setter(input?.value || '');
  }

  onCategoryInput(target: EventTarget | null): void {
    const input = target as HTMLSelectElement | null;
    this.category.set((input?.value as DimafxCategory) || 'video');
  }

  setName(value: string): void { this.name.set(value); }
  setDescription(value: string): void { this.description.set(value); }
  setThumbnailUrl(value: string): void { this.thumbnailUrl.set(value); }
  setDurationMs(value: number): void { this.durationMs.set(value); }
  setBitsPrice(value: number): void { this.bitsPrice.set(value); }
  setVolume(value: number): void { this.volume.set(value); }
  setSortOrder(value: number): void { this.sortOrder.set(value); }

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
    const seen = new Set<string>();
    const options: AssetOption[] = [];
    for (const asset of [...libraryAssets, ...publicAssets]) {
      if (seen.has(asset._id)) continue;
      seen.add(asset._id);
      options.push({
        id: asset._id,
        label: asset.displayName,
        mediaType: asset.mediaType,
        playbackUrl: asset.playbackUrl,
        source: libraryAssets.some((candidate) => candidate._id === asset._id) ? 'library' : 'public'
      });
    }
    return options.sort((a, b) => a.label.localeCompare(b.label));
  }
}
