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

type MediaFilter = 'all' | MediaType;

@Component({
  selector: 'app-public-library-modal',
  imports: [LucideAngularModule, LoadingIndicatorComponent],
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

  readonly assets = signal<MediaAsset[]>([]);
  readonly isLoading = signal(true);
  readonly errorMessage = signal<string | null>(null);
  readonly searchQuery = signal('');
  readonly mediaFilter = signal<MediaFilter>('all');
  readonly addingAssetIds = signal<string[]>([]);

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
