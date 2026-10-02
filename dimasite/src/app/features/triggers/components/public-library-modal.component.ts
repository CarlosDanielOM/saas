import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
  type OnDestroy,
  type OnInit
} from '@angular/core';

import { LanguageService } from '../../../services/language.service';
import { ToastService } from '../../../services/toast.service';
import {
  MediaAsset,
  MediaLibraryMutationResult,
  MediaType
} from '../triggers.model';
import { TriggersService } from '../triggers.service';
import { LazyVideoFrameDirective } from '../lazy-video-frame.directive';
import {
  Check,
  Image as ImageIcon,
  LucideAngularModule,
  Music,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  X,
  Zap,
  type LucideIconData
} from 'lucide-angular';

type MediaFilter = 'all' | MediaType;

@Component({
  selector: 'app-public-library-modal',
  imports: [LucideAngularModule, LazyVideoFrameDirective],
  styleUrl: './public-library-modal.component.css',
  templateUrl: './public-library-modal.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown.escape)': 'requestClose()'
  }
})
export class PublicLibraryModalComponent implements OnInit, OnDestroy {
  private readonly languageService = inject(LanguageService);
  private readonly toastService = inject(ToastService);
  private readonly triggersService = inject(TriggersService);

  private searchDebounceTimer: number | null = null;
  private activeRequestId = 0;

  readonly channelId = input.required<string>();
  readonly ownedAssetIds = input.required<string[]>();
  readonly canAttach = input(false);

  readonly close = output<void>();
  readonly assetAdded = output<MediaLibraryMutationResult>();
  /** Asset ID of an added, trigger-ready asset the streamer wants to turn into a trigger. */
  readonly createTrigger = output<string>();

  readonly assets = signal<MediaAsset[]>([]);
  readonly isLoading = signal(true);
  readonly errorMessage = signal<string | null>(null);
  readonly searchQuery = signal('');
  readonly mediaFilter = signal<MediaFilter>('all');
  readonly addingAssetIds = signal<string[]>([]);
  readonly activePreviewAsset = signal<MediaAsset | null>(null);
  readonly playingId = signal<string | null>(null);
  private previewAudio: HTMLAudioElement | null = null;

  readonly filterOptions: MediaFilter[] = ['all', 'video', 'audio', 'image', 'gif'];
  readonly ownedAssetIdSet = computed(() => new Set(this.ownedAssetIds()));

  ngOnInit(): void {
    this.loadAssets();
  }

  ngOnDestroy(): void {
    this.stopPreview();
    if (this.searchDebounceTimer !== null) {
      window.clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = null;
    }
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  requestClose(): void {
    // Escape closes the media preview first, then the library.
    if (this.activePreviewAsset()) {
      this.closePreviewModal();
      return;
    }
    this.close.emit();
  }

  /** Audio plays inline in its row; video and images open the preview dialog. */
  previewAsset(event: MouseEvent, asset: MediaAsset): void {
    event.stopPropagation();
    if (asset.mediaType !== 'audio') {
      this.stopPreview();
      this.activePreviewAsset.set(asset);
      return;
    }
    const wasPlaying = this.playingId() === asset._id;
    this.stopPreview();
    if (!wasPlaying && asset.playbackUrl) {
      this.playAudioPreview(asset);
    }
  }

  closePreviewModal(): void {
    this.activePreviewAsset.set(null);
  }

  stopPreview(): void {
    if (this.previewAudio) {
      this.previewAudio.pause();
      this.previewAudio = null;
    }
    this.playingId.set(null);
  }

  private playAudioPreview(asset: MediaAsset): void {
    const audio = new Audio(asset.playbackUrl);
    audio.volume = 0.5;
    const stop = () => {
      if (this.previewAudio === audio) {
        this.previewAudio = null;
        this.playingId.set(null);
      }
    };
    audio.addEventListener('ended', stop);
    audio.addEventListener('error', () => {
      stop();
      this.toastService.error(this.t('triggers.marketplace.errorTitle'), this.t('triggers.marketplace.playError'));
    });
    this.previewAudio = audio;
    this.playingId.set(asset._id);
    audio.play().catch(() => stop());
  }

  displayName(asset: MediaAsset): string {
    return (asset.displayName || asset.fileName || '').replace(/_+/g, ' ').trim();
  }

  isTriggerReady(asset: MediaAsset): boolean {
    return asset.mediaType === 'audio' || asset.mediaType === 'video';
  }

  refreshAssets(): void {
    this.loadAssets();
  }

  updateSearchQuery(event: Event): void {
    this.searchQuery.set((event.target as HTMLInputElement).value);
    this.scheduleAssetRefresh();
  }

  setMediaFilter(filter: MediaFilter): void {
    if (filter === this.mediaFilter()) {
      return;
    }

    this.mediaFilter.set(filter);
    this.scheduleAssetRefresh();
  }

  isAssetAdded(assetId: string): boolean {
    return this.ownedAssetIdSet().has(assetId);
  }

  isAddingAsset(assetId: string): boolean {
    return this.addingAssetIds().includes(assetId);
  }

  addAsset(asset: MediaAsset): void {
    if (!this.canAttach()) return;
    const channelId = this.channelId();
    if (!channelId || this.isAssetAdded(asset._id) || this.isAddingAsset(asset._id)) {
      return;
    }

    this.addingAssetIds.update((ids) => [...ids, asset._id]);
    this.triggersService.addPublicAssetToLibrary(channelId, asset._id).subscribe({
      next: (result) => {
        this.addingAssetIds.update((ids) => ids.filter((id) => id !== asset._id));
        this.assetAdded.emit(result);
        this.toastService.success(this.t('triggers.marketplace.addTitle'), this.t('triggers.marketplace.addMessage'));
      },
      error: (error) => {
        this.addingAssetIds.update((ids) => ids.filter((id) => id !== asset._id));
        this.toastService.error(
          this.t('triggers.marketplace.errorTitle'),
          this.resolveErrorMessage(error, this.t('triggers.marketplace.errorMessage'))
        );
      }
    });
  }

  readonly closeIcon = X;
  readonly refreshIcon = RefreshCw;
  readonly checkIcon = Check;
  readonly pauseIcon = Pause;
  readonly plusIcon = Plus;
  readonly searchIcon = Search;
  readonly zapIcon = Zap;

  private readonly mediaIcons: Record<string, LucideIconData> = {
    audio: Music,
    image: ImageIcon,
    gif: ImageIcon,
    video: Play
  };

  mediaIcon(type: MediaType | string): LucideIconData {
    return this.mediaIcons[type] ?? Play;
  }

  formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return '0 B';
    }

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / 1024 ** exponent;
    return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
  }

  private scheduleAssetRefresh(): void {
    if (this.searchDebounceTimer !== null) {
      window.clearTimeout(this.searchDebounceTimer);
    }

    this.searchDebounceTimer = window.setTimeout(() => {
      this.loadAssets();
    }, 220);
  }

  private loadAssets(): void {
    const requestId = ++this.activeRequestId;
    this.isLoading.set(true);
    this.errorMessage.set(null);

    this.triggersService.getPublicAssets({
      q: this.searchQuery(),
      mediaType: this.mediaFilter()
    }).subscribe({
      next: (assets) => {
        if (requestId !== this.activeRequestId) {
          return;
        }

        this.assets.set(assets);
        this.isLoading.set(false);
      },
      error: (error) => {
        if (requestId !== this.activeRequestId) {
          return;
        }

        this.errorMessage.set(this.resolveErrorMessage(error, this.t('triggers.marketplace.errorMessage')));
        this.isLoading.set(false);
      }
    });
  }

  private resolveErrorMessage(error: unknown, fallback: string): string {
    if (typeof error === 'object' && error && 'error' in error) {
      const nested = (error as { error?: { message?: string } }).error?.message;
      if (nested) {
        return nested;
      }
    }

    if (error instanceof Error && error.message) {
      return error.message;
    }

    return fallback;
  }
}
