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
import {
  AudioLines,
  Check,
  Globe2,
  HardDrive,
  Image,
  LucideAngularModule,
  Plus,
  RefreshCw,
  Search,
  Video,
  X,
  LayoutGrid,
  List,
  Eye,
  Play,
  Pause,
  type LucideIconData
} from 'lucide-angular';

import { LoadingIndicatorComponent } from '../../../components/loading';
import { LanguageService } from '../../../services/language.service';
import { ToastService } from '../../../services/toast.service';
import {
  MediaAsset,
  MediaLibraryMeta,
  MediaLibraryMutationResult,
  MediaType
} from '../triggers.model';
import { TriggersService } from '../triggers.service';
import { DisplayNamePipe } from '../../../pipes/display-name.pipe';

type MediaFilter = 'all' | MediaType;

@Component({
  selector: 'app-public-library-modal',
  imports: [LucideAngularModule, LoadingIndicatorComponent, DisplayNamePipe],
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
  readonly libraryMeta = input.required<MediaLibraryMeta>();
  readonly ownedAssetIds = input.required<string[]>();

  readonly close = output<void>();
  readonly assetAdded = output<MediaLibraryMutationResult>();

  readonly closeIcon = X;
  readonly searchIcon = Search;
  readonly refreshIcon = RefreshCw;
  readonly marketplaceIcon = Globe2;
  readonly storageIcon = HardDrive;
  readonly plusIcon = Plus;
  readonly checkIcon = Check;
  readonly videoIcon = Video;
  readonly audioIcon = AudioLines;
  readonly imageIcon = Image;
  readonly layoutGridIcon = LayoutGrid;
  readonly listIcon = List;
  readonly previewIcon = Eye;
  readonly playIcon = Play;
  readonly pauseIcon = Pause;

  readonly assets = signal<MediaAsset[]>([]);
  readonly isLoading = signal(true);
  readonly errorMessage = signal<string | null>(null);
  readonly searchQuery = signal('');
  readonly mediaFilter = signal<MediaFilter>('all');
  readonly addingAssetIds = signal<string[]>([]);
  readonly modalViewMode = signal<'grid' | 'list'>('grid');
  readonly activePreviewAsset = signal<MediaAsset | null>(null);
  readonly isAudioPlaying = signal(false);
  private previewAudio: HTMLAudioElement | null = null;

  readonly filterOptions: MediaFilter[] = ['all', 'video', 'audio', 'image', 'gif'];
  readonly ownedAssetIdSet = computed(() => new Set(this.ownedAssetIds()));
  readonly quotaPercent = computed(() => {
    const meta = this.libraryMeta();
    if (!meta.quotaBytesLimit) {
      return 0;
    }

    return Math.max(0, Math.min(100, Math.round((meta.quotaBytesUsed / meta.quotaBytesLimit) * 100)));
  });
  readonly remainingQuotaBytes = computed(() => Math.max(0, this.libraryMeta().quotaBytesLimit - this.libraryMeta().quotaBytesUsed));

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
    this.close.emit();
  }

  openPreviewModal(event: MouseEvent, asset: MediaAsset): void {
    event.stopPropagation();
    this.stopPreview();
    this.activePreviewAsset.set(asset);
    if (asset.mediaType === 'audio' && asset.playbackUrl) {
      this.playAudioPreview(asset.playbackUrl);
    }
  }

  closePreviewModal(): void {
    this.stopPreview();
    this.activePreviewAsset.set(null);
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
    if (this.previewAudio) {
      this.previewAudio.pause();
      this.previewAudio = null;
    }
    this.isAudioPlaying.set(false);
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
        this.toastService.error(this.t('triggers.marketplace.errorTitle'), 'Failed to play audio asset.');
      });
      this.previewAudio.play();
    } catch (err) {
      this.isAudioPlaying.set(false);
      this.toastService.error(this.t('triggers.marketplace.errorTitle'), 'Failed to play audio asset.');
    }
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

  getMediaIcon(type: MediaType): LucideIconData {
    switch (type) {
      case 'audio':
        return this.audioIcon;
      case 'image':
      case 'gif':
        return this.imageIcon;
      case 'video':
      default:
        return this.videoIcon;
    }
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
