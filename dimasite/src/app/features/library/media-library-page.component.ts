import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
  viewChild
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  Check,
  Globe,
  ImageIcon,
  Lock,
  LucideAngularModule,
  LucideIconData,
  Music,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X
} from 'lucide-angular';
import { catchError, distinctUntilChanged, forkJoin, map, of, shareReplay, startWith, switchMap } from 'rxjs';

import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';
import { getRouteParam } from '../../shared/utils/route-param.util';
import { ChannelExtensionItem } from '../dimafx/dimafx.model';
import { DimafxService } from '../dimafx/dimafx.service';
import { PublicLibraryModalComponent } from '../triggers/components/public-library-modal.component';
import { LazyVideoFrameDirective } from '../triggers/lazy-video-frame.directive';
import {
  MediaAsset,
  MediaLibraryItem,
  MediaLibraryMeta,
  MediaLibraryMutationResult,
  MediaScope,
  MediaType,
  PlanTier,
  TriggerRecord
} from '../triggers/triggers.model';
import { TriggersService } from '../triggers/triggers.service';

interface ChannelResolutionState {
  streamer: string;
  channelID: string | null;
  status: 'idle' | 'loading' | 'resolved';
}

interface UploadFormState {
  name: string;
  scope: MediaScope;
  file: File | null;
}

interface ItemUsage {
  triggers: string[];
  fx: string[];
}

type TypeFilter = 'all' | MediaType;
type ScopeFilter = 'all' | MediaScope;

const SAFE_NAME_REGEX = /^[A-Za-z][A-Za-z0-9]*(_[A-Za-z0-9]+)*$/;
const SAFE_NAME_MAX_LENGTH = 60;
const NO_USAGE: ItemUsage = { triggers: [], fx: [] };

@Component({
  selector: 'app-media-library-page',
  imports: [
    RouterLink,
    NgTemplateOutlet,
    LucideAngularModule,
    LfIconComponent,
    LazyVideoFrameDirective,
    PublicLibraryModalComponent
  ],
  templateUrl: './media-library-page.component.html',
  styleUrl: './media-library-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown.escape)': 'handleEscape()'
  }
})
export class MediaLibraryPageComponent implements OnDestroy {
  private readonly triggersService = inject(TriggersService);
  private readonly dimafxService = inject(DimafxService);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly toast = inject(ToastService);
  private readonly route = inject(ActivatedRoute);

  readonly uploadIcon = Upload;
  readonly globeIcon = Globe;
  readonly refreshIcon = RefreshCw;
  readonly searchIcon = Search;
  readonly closeIcon = X;
  readonly playIcon = Play;
  readonly pauseIcon = Pause;
  readonly pencilIcon = Pencil;
  readonly trashIcon = Trash2;
  readonly lockIcon = Lock;
  readonly checkIcon = Check;
  readonly plusIcon = Plus;

  readonly typeFilters: TypeFilter[] = ['all', 'video', 'audio', 'image', 'gif'];
  readonly scopeFilters: ScopeFilter[] = ['all', 'private', 'public'];
  readonly waveformBars = Array.from({ length: 16 }, (_, index) => index + 1);

  readonly loading = signal(false);
  readonly loadError = signal(false);
  readonly items = signal<MediaLibraryItem[]>([]);
  readonly libraryMeta = signal<MediaLibraryMeta>({
    planTier: 'free',
    quotaBytesUsed: 0,
    quotaBytesLimit: 0
  });
  /** null = not loaded or no permission; usage for that source is then unknown. */
  readonly triggers = signal<TriggerRecord[] | null>(null);
  readonly fxItems = signal<ChannelExtensionItem[] | null>(null);

  readonly search = signal('');
  readonly typeFilter = signal<TypeFilter>('all');
  readonly scopeFilter = signal<ScopeFilter>('all');

  readonly isUploadModalOpen = signal(false);
  readonly isUploadingMedia = signal(false);
  readonly isDraggingUpload = signal(false);
  readonly uploadSubmitAttempted = signal(false);
  readonly uploadForm = signal<UploadFormState>({ name: '', scope: 'private', file: null });
  readonly uploadPreviewUrl = signal<string | null>(null);

  readonly renameTarget = signal<MediaLibraryItem | null>(null);
  readonly renameDraft = signal('');
  readonly renameSaving = signal(false);
  readonly renameAttempted = signal(false);

  readonly publicTarget = signal<MediaLibraryItem | null>(null);
  readonly publicSaving = signal(false);

  readonly deleteTarget = signal<MediaLibraryItem | null>(null);
  readonly deleting = signal(false);

  readonly isPublicLibraryOpen = signal(false);

  readonly activePreviewAsset = signal<MediaAsset | null>(null);
  readonly isAudioPlaying = signal(false);
  private previewAudio: HTMLAudioElement | null = null;

  readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('uploadFileInput');

  readonly planTier = computed<PlanTier>(() => {
    const metaTier = this.libraryMeta().planTier;
    if (metaTier === 'premium' || metaTier === 'pro' || metaTier === 'free') {
      return metaTier;
    }
    return this.sessionAuth.getPlanTierForStreamer(this.streamer());
  });

  readonly canKeepPrivate = computed(() => this.planTier() !== 'free');

  readonly quotaPercent = computed(() => {
    const meta = this.libraryMeta();
    if (!meta.quotaBytesLimit) return 0;
    return Math.max(0, Math.min(100, Math.round((meta.quotaBytesUsed / meta.quotaBytesLimit) * 100)));
  });

  readonly quotaLeftBytes = computed(() => {
    const meta = this.libraryMeta();
    return Math.max(0, meta.quotaBytesLimit - meta.quotaBytesUsed);
  });

  readonly quotaTone = computed(() => {
    const percent = this.quotaPercent();
    if (percent >= 95) return 'danger';
    if (percent >= 80) return 'warn';
    return 'ok';
  });

  readonly privateCount = computed(() => this.items().filter((item) => item.assetScope === 'private').length);
  readonly publicCount = computed(() => this.items().filter((item) => item.assetScope === 'public').length);

  readonly typeCounts = computed(() => {
    const counts: Record<string, number> = { all: this.items().length };
    for (const item of this.items()) {
      const type = this.itemType(item);
      counts[type] = (counts[type] ?? 0) + 1;
    }
    return counts;
  });

  readonly visibleTypeFilters = computed(() =>
    this.typeFilters.filter((filter) => filter === 'all' || (this.typeCounts()[filter] ?? 0) > 0)
  );

  readonly showScopeFilter = computed(() => this.privateCount() > 0 && this.publicCount() > 0);

  readonly filteredItems = computed(() => {
    const query = this.search().trim().toLowerCase();
    const type = this.typeFilter();
    const scope = this.scopeFilter();
    return this.items().filter((item) => {
      if (type !== 'all' && this.itemType(item) !== type) return false;
      if (scope !== 'all' && item.assetScope !== scope) return false;
      if (query && !this.itemName(item).toLowerCase().includes(query)) return false;
      return true;
    });
  });

  readonly hasActiveFilters = computed(
    () => !!this.search().trim() || this.typeFilter() !== 'all' || this.scopeFilter() !== 'all'
  );

  readonly usage = computed(() => {
    const result = new Map<string, ItemUsage>();
    const items = this.items();
    const byId = new Map(items.map((item) => [item._id, item]));
    const byAsset = new Map(items.map((item) => [item.assetID, item]));
    const entry = (item: MediaLibraryItem) => {
      let current = result.get(item._id);
      if (!current) {
        current = { triggers: [], fx: [] };
        result.set(item._id, current);
      }
      return current;
    };
    for (const trigger of this.triggers() ?? []) {
      const item = (trigger.libraryItemID && byId.get(trigger.libraryItemID))
        || (trigger.assetID && byAsset.get(trigger.assetID));
      if (item) entry(item).triggers.push(trigger.name);
    }
    for (const fx of this.fxItems() ?? []) {
      const item = fx.assetID ? byAsset.get(fx.assetID) : undefined;
      if (item) entry(item).fx.push(fx.name);
    }
    return result;
  });

  readonly usageKnown = computed(() => this.triggers() !== null);

  readonly uploadLimitBytes = computed(() => this.getUploadLimitBytes(this.planTier()));
  readonly uploadLimitLabel = computed(() => this.formatBytes(this.uploadLimitBytes()));

  readonly uploadNameError = computed<string | null>(() => {
    const name = this.finalName(this.uploadForm().name);
    if (!name) return this.uploadSubmitAttempted() ? this.t('modules.library.upload.nameRequired') : null;
    if (!SAFE_NAME_REGEX.test(name)) return this.t('modules.library.upload.nameInvalid');
    return null;
  });

  readonly uploadFileError = computed<string | null>(() => {
    const form = this.uploadForm();
    if (!form.file) return this.uploadSubmitAttempted() ? this.t('modules.library.upload.fileRequired') : null;
    const limit = this.uploadLimitBytes();
    if (form.file.size > limit) {
      return this.t('modules.library.upload.fileTooLarge', { size: this.formatBytes(limit) });
    }
    if (form.scope === 'private') {
      const meta = this.libraryMeta();
      if (meta.quotaBytesLimit && form.file.size + meta.quotaBytesUsed > meta.quotaBytesLimit) {
        return this.t('modules.library.upload.quotaExceeded', {
          left: this.formatBytes(this.quotaLeftBytes())
        });
      }
    }
    return null;
  });

  readonly uploadFileType = computed<MediaType | null>(() => {
    const file = this.uploadForm().file;
    if (!file) return null;
    if (file.type === 'image/gif') return 'gif';
    if (file.type.startsWith('image/')) return 'image';
    if (file.type.startsWith('video/')) return 'video';
    if (file.type.startsWith('audio/')) return 'audio';
    return null;
  });

  readonly renameError = computed<string | null>(() => {
    const name = this.finalName(this.renameDraft());
    if (!name) return this.renameAttempted() ? this.t('modules.library.upload.nameRequired') : null;
    if (!SAFE_NAME_REGEX.test(name)) return this.t('modules.library.upload.nameInvalid');
    return null;
  });

  readonly deleteUsage = computed(() => {
    const item = this.deleteTarget();
    return item ? this.usageFor(item) : NO_USAGE;
  });
  readonly deleteBlocked = computed(() => {
    const usage = this.deleteUsage();
    return usage.triggers.length > 0 || usage.fx.length > 0;
  });

  readonly libraryAssetIds = computed(() => this.items().map((item) => item.assetID));

  private readonly streamerParam$ = this.route.paramMap.pipe(
    map(() => (getRouteParam(this.route, 'streamer') ?? '').trim().toLowerCase()),
    distinctUntilChanged(),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  private readonly channelID$ = this.streamerParam$.pipe(
    switchMap((streamer) => {
      if (!streamer) {
        return of<ChannelResolutionState>({ streamer, channelID: null, status: 'idle' });
      }

      return this.sessionAuth.resolveChannelID(streamer).pipe(
        map((channelID) => ({ streamer, channelID, status: 'resolved' as const })),
        startWith({ streamer, channelID: null, status: 'loading' as const })
      );
    }),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  readonly streamer = toSignal(this.streamerParam$, {
    initialValue: (getRouteParam(this.route, 'streamer') ?? '').trim().toLowerCase()
  });

  readonly channelResolution = toSignal(this.channelID$, {
    initialValue: {
      streamer: (getRouteParam(this.route, 'streamer') ?? '').trim().toLowerCase(),
      channelID: null,
      status: 'loading'
    } satisfies ChannelResolutionState
  });

  readonly channelID = computed(() => this.channelResolution().channelID);
  private readonly mutationAccess = toSignal(toObservable(this.channelID).pipe(
    switchMap((channelID) => channelID
      ? forkJoin({
          upload: this.sessionAuth.checkPermission(channelID, 'triggers:upload').pipe(catchError(() => of(false))),
          attach: this.sessionAuth.checkPermission(channelID, 'triggers:attach').pipe(catchError(() => of(false))),
          edit: this.sessionAuth.checkPermission(channelID, 'triggers:edit').pipe(catchError(() => of(false))),
          delete: this.sessionAuth.checkPermission(channelID, 'triggers:delete').pipe(catchError(() => of(false)))
        }).pipe(map((grants) => ({ channelID, ...grants })))
      : of({ channelID: null, upload: false, attach: false, edit: false, delete: false }))
  ), { initialValue: { channelID: null as string | null, upload: false, attach: false, edit: false, delete: false } });
  private readonly accessReady = computed(() => this.mutationAccess().channelID === this.channelID());
  readonly canUpload = computed(() => this.accessReady() && this.mutationAccess().upload);
  readonly canAttach = computed(() => this.accessReady() && this.mutationAccess().attach);
  readonly canEdit = computed(() => this.accessReady() && this.mutationAccess().edit);
  readonly canDelete = computed(() => this.accessReady() && this.mutationAccess().delete);

  constructor() {
    effect(() => {
      const channelId = this.channelID();
      if (channelId) {
        this.loadAll(channelId);
      }
    });
  }

  ngOnDestroy(): void {
    this.stopPreview();
    this.setUploadPreview(null);
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / 1024 ** exponent;
    return `${value.toFixed(value < 10 && exponent > 0 ? 1 : 0)} ${units[exponent]}`;
  }

  itemName(item: MediaLibraryItem): string {
    return (item.localAlias || item.asset?.displayName || item.asset?.fileName || '').replace(/_+/g, ' ').trim();
  }

  assetName(asset: MediaAsset): string {
    return (asset.displayName || asset.fileName || '').replace(/_+/g, ' ').trim();
  }

  itemType(item: MediaLibraryItem): MediaType {
    return item.asset?.mediaType || item.mediaType || 'video';
  }

  mediaIcon(type: MediaType | string): LucideIconData {
    if (type === 'audio') return Music;
    if (type === 'image' || type === 'gif') return ImageIcon;
    return Play;
  }

  isOwnUpload(item: MediaLibraryItem): boolean {
    return item.relationType === 'owner_upload';
  }

  usageFor(item: MediaLibraryItem): ItemUsage {
    return this.usage().get(item._id) ?? NO_USAGE;
  }

  usageTags(item: MediaLibraryItem): string[] {
    const usage = this.usageFor(item);
    const tags: string[] = [];
    if (usage.triggers.length) {
      tags.push(this.t(usage.triggers.length === 1 ? 'modules.library.row.oneTrigger' : 'modules.library.row.triggers', { count: usage.triggers.length }));
    }
    if (usage.fx.length) {
      tags.push(this.t(usage.fx.length === 1 ? 'modules.library.row.oneFx' : 'modules.library.row.fx', { count: usage.fx.length }));
    }
    return tags;
  }

  loadAll(channelId?: string): void {
    const id = channelId ?? this.channelID();
    if (!id) return;
    this.loading.set(true);
    this.loadError.set(false);
    forkJoin({
      library: this.triggersService.getLibrary(id),
      triggers: this.triggersService.getTriggers(id).pipe(catchError(() => of(null))),
      fx: this.dimafxService.getItems(id).pipe(map((res) => res.items), catchError(() => of(null)))
    }).subscribe({
      next: ({ library, triggers, fx }) => {
        if (id !== this.channelID()) return;
        this.items.set(library.items || []);
        if (library.meta) this.libraryMeta.set(library.meta);
        this.triggers.set(triggers);
        this.fxItems.set(fx);
        this.loading.set(false);
      },
      error: () => {
        if (id !== this.channelID()) return;
        this.loadError.set(true);
        this.loading.set(false);
      }
    });
  }

  updateSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }

  setTypeFilter(filter: TypeFilter): void {
    this.typeFilter.set(filter);
  }

  setScopeFilter(filter: ScopeFilter): void {
    this.scopeFilter.set(filter);
  }

  clearFilters(): void {
    this.search.set('');
    this.typeFilter.set('all');
    this.scopeFilter.set('all');
  }

  // ── Upload ──────────────────────────────────────────────

  openUploadModal(): void {
    if (!this.canUpload()) return;
    this.resetUploadForm();
    this.isUploadModalOpen.set(true);
  }

  closeUploadModal(): void {
    if (this.isUploadingMedia()) return;
    this.isUploadModalOpen.set(false);
    this.resetUploadForm();
  }

  onUploadFileChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.applyUploadFile(input.files?.[0] ?? null);
  }

  handleUploadDragOver(event: DragEvent): void {
    event.preventDefault();
    this.isDraggingUpload.set(true);
  }

  handleUploadDragLeave(event: DragEvent): void {
    event.preventDefault();
    const currentTarget = event.currentTarget as HTMLElement | null;
    const relatedTarget = event.relatedTarget as Node | null;
    if (currentTarget && relatedTarget && currentTarget.contains(relatedTarget)) {
      return;
    }
    this.isDraggingUpload.set(false);
  }

  handleUploadDrop(event: DragEvent): void {
    event.preventDefault();
    this.isDraggingUpload.set(false);
    const file = event.dataTransfer?.files?.[0] ?? null;
    if (file) this.applyUploadFile(file);
  }

  updateUploadName(event: Event): void {
    const input = event.target as HTMLInputElement;
    const name = this.sanitizeSafeName(input.value);
    input.value = name;
    this.uploadForm.update((state) => ({ ...state, name }));
  }

  updateUploadScope(scope: MediaScope): void {
    if (!this.canKeepPrivate() && scope === 'private') return;
    this.uploadForm.update((state) => ({ ...state, scope }));
  }

  submitUpload(): void {
    if (!this.canUpload() || this.isUploadingMedia()) return;
    const channelId = this.channelID();
    if (!channelId) return;
    this.uploadSubmitAttempted.set(true);
    const form = this.uploadForm();
    if (this.uploadNameError() || this.uploadFileError() || !form.file) return;

    this.isUploadingMedia.set(true);
    this.triggersService
      .uploadMedia(channelId, { file: form.file, name: this.finalName(form.name), scope: form.scope })
      .subscribe({
        next: () => {
          this.toast.success(
            this.t('modules.library.upload.successTitle'),
            this.t('modules.library.upload.successMessage', { name: form.name.replace(/_+/g, ' ') })
          );
          this.isUploadingMedia.set(false);
          this.closeUploadModal();
          this.loadAll();
        },
        error: (err: unknown) => {
          const message = err instanceof Error ? err.message : this.t('modules.library.upload.errorMessage');
          this.toast.error(this.t('modules.library.upload.errorTitle'), message);
          this.isUploadingMedia.set(false);
        }
      });
  }

  // ── Rename ──────────────────────────────────────────────

  openRename(item: MediaLibraryItem): void {
    if (!this.canEdit()) return;
    this.renameAttempted.set(false);
    this.renameDraft.set(item.localAlias || item.asset?.displayName || '');
    this.renameTarget.set(item);
  }

  closeRename(): void {
    if (this.renameSaving()) return;
    this.renameTarget.set(null);
  }

  updateRenameDraft(event: Event): void {
    const input = event.target as HTMLInputElement;
    const name = this.sanitizeSafeName(input.value);
    input.value = name;
    this.renameDraft.set(name);
  }

  submitRename(): void {
    const item = this.renameTarget();
    const channelId = this.channelID();
    if (!item || !channelId || !this.canEdit() || this.renameSaving()) return;
    this.renameAttempted.set(true);
    if (this.renameError()) return;
    const name = this.finalName(this.renameDraft());
    // Typing the original asset name back clears the alias.
    const alias = name === item.asset?.displayName ? '' : name;

    this.renameSaving.set(true);
    this.triggersService.renameLibraryItem(channelId, item._id, alias).subscribe({
      next: (updated) => {
        this.items.update((items) => items.map((entry) => entry._id === item._id ? { ...entry, localAlias: updated.localAlias } : entry));
        this.renameSaving.set(false);
        this.renameTarget.set(null);
        this.toast.success(this.t('modules.library.rename.successTitle'), this.t('modules.library.rename.successMessage', { name: name.replace(/_+/g, ' ') }));
      },
      error: (err: unknown) => {
        this.renameSaving.set(false);
        this.toast.error(this.t('modules.library.rename.errorTitle'), err instanceof Error ? err.message : this.t('modules.library.rename.errorMessage'));
      }
    });
  }

  // ── Make public ─────────────────────────────────────────

  openMakePublic(item: MediaLibraryItem): void {
    if (!this.canEdit() || item.assetScope !== 'private') return;
    this.publicTarget.set(item);
  }

  closeMakePublic(): void {
    if (this.publicSaving()) return;
    this.publicTarget.set(null);
  }

  confirmMakePublic(): void {
    const item = this.publicTarget();
    const channelId = this.channelID();
    if (!item || !channelId || !this.canEdit() || this.publicSaving()) return;
    this.publicSaving.set(true);
    this.triggersService.changeLibraryItemScope(channelId, item._id, 'public', this.planTier()).subscribe({
      next: (res: MediaLibraryMutationResult) => {
        if (res.meta) this.libraryMeta.set(res.meta);
        this.items.update((items) => items.map((entry) => entry._id === item._id ? { ...entry, ...res.item, localAlias: res.item.localAlias ?? entry.localAlias } : entry));
        this.publicSaving.set(false);
        this.publicTarget.set(null);
        this.toast.success(this.t('modules.library.makePublic.successTitle'), this.t('modules.library.makePublic.successMessage'));
      },
      error: (err: unknown) => {
        this.publicSaving.set(false);
        this.toast.error(
          this.t('modules.library.makePublic.errorTitle'),
          err instanceof Error ? err.message : this.t('modules.library.makePublic.errorMessage')
        );
      }
    });
  }

  // ── Delete ──────────────────────────────────────────────

  openDelete(item: MediaLibraryItem): void {
    if (!this.canDelete()) return;
    this.deleteTarget.set(item);
  }

  closeDelete(): void {
    if (this.deleting()) return;
    this.deleteTarget.set(null);
  }

  confirmDelete(): void {
    const item = this.deleteTarget();
    const channelId = this.channelID();
    if (!item || !channelId || !this.canDelete() || this.deleting() || this.deleteBlocked()) return;
    this.deleting.set(true);
    this.triggersService.removeLibraryItem(channelId, item._id).subscribe({
      next: () => {
        this.deleting.set(false);
        this.deleteTarget.set(null);
        if (this.activePreviewAsset()?._id === item.asset?._id) this.closePreviewModal();
        this.toast.success(this.t('modules.library.delete.successTitle'), this.t('modules.library.delete.successMessage', { name: this.itemName(item) }));
        this.loadAll();
      },
      error: (err: unknown) => {
        this.deleting.set(false);
        this.toast.error(this.t('modules.library.delete.errorTitle'), err instanceof Error ? err.message : this.t('modules.library.delete.errorMessage'));
      }
    });
  }

  // ── Public library ──────────────────────────────────────

  openPublicLibrary(): void {
    if (!this.canAttach()) return;
    this.stopPreview();
    this.isPublicLibraryOpen.set(true);
  }

  closePublicLibrary(): void {
    this.isPublicLibraryOpen.set(false);
  }

  handlePublicAssetAdded(result: MediaLibraryMutationResult): void {
    this.items.update((items) =>
      items.some((item) => item._id === result.item._id || item.assetID === result.item.assetID)
        ? items
        : [result.item, ...items]
    );
    if (result.meta) this.libraryMeta.set(result.meta);
  }

  // ── Preview ─────────────────────────────────────────────

  openPreview(item: MediaLibraryItem): void {
    const asset = item.asset;
    if (!asset?.playbackUrl) return;
    this.stopPreview();
    this.activePreviewAsset.set(asset);
    if (asset.mediaType === 'audio') this.playAudioPreview(asset.playbackUrl);
  }

  closePreviewModal(): void {
    this.stopPreview();
    this.activePreviewAsset.set(null);
  }

  toggleAudioPlayPause(): void {
    if (!this.previewAudio) {
      const asset = this.activePreviewAsset();
      if (asset?.playbackUrl) this.playAudioPreview(asset.playbackUrl);
      return;
    }
    if (this.previewAudio.paused) {
      void this.previewAudio.play();
    } else {
      this.previewAudio.pause();
    }
  }

  handleEscape(): void {
    if (this.isPublicLibraryOpen()) return; // the modal handles its own Escape
    if (this.activePreviewAsset()) this.closePreviewModal();
    else if (this.deleteTarget()) this.closeDelete();
    else if (this.publicTarget()) this.closeMakePublic();
    else if (this.renameTarget()) this.closeRename();
    else if (this.isUploadModalOpen()) this.closeUploadModal();
  }

  private stopPreview(): void {
    if (this.previewAudio) {
      this.previewAudio.pause();
      this.previewAudio = null;
    }
    this.isAudioPlaying.set(false);
  }

  private playAudioPreview(url: string): void {
    const audio = new Audio(url);
    audio.volume = 0.5;
    audio.addEventListener('play', () => this.isAudioPlaying.set(true));
    audio.addEventListener('pause', () => this.isAudioPlaying.set(false));
    audio.addEventListener('ended', () => {
      this.isAudioPlaying.set(false);
      this.previewAudio = null;
    });
    audio.addEventListener('error', () => {
      this.isAudioPlaying.set(false);
      this.previewAudio = null;
      this.toast.error(this.t('modules.library.preview.errorTitle'), this.t('modules.library.preview.errorMessage'));
    });
    this.previewAudio = audio;
    audio.play().catch(() => this.isAudioPlaying.set(false));
  }

  private resetUploadForm(): void {
    this.isDraggingUpload.set(false);
    this.uploadSubmitAttempted.set(false);
    this.uploadForm.set({ name: '', scope: this.canKeepPrivate() ? 'private' : 'public', file: null });
    this.setUploadPreview(null);
    const input = this.fileInput()?.nativeElement;
    if (input) input.value = '';
  }

  private applyUploadFile(file: File | null): void {
    this.uploadForm.update((state) => ({
      ...state,
      file,
      name: state.name || (file ? this.sanitizeSafeName(file.name.replace(/\.[^.]+$/, '')) : '')
    }));
    this.setUploadPreview(file && /^(image|video)\//.test(file.type) ? URL.createObjectURL(file) : null);
  }

  private setUploadPreview(url: string | null): void {
    const previous = this.uploadPreviewUrl();
    if (previous) URL.revokeObjectURL(previous);
    this.uploadPreviewUrl.set(url);
  }

  /** Names may end in "_" while typing; the saved name never does. */
  private finalName(value: string): string {
    return value.trim().replace(/_+$/, '');
  }

  private sanitizeSafeName(value: string): string {
    return value
      .replace(/[\s-]+/g, '_')
      .replace(/[^A-Za-z0-9_]/g, '')
      .replace(/_+/g, '_')
      .replace(/^[_\d]+/, '')
      .slice(0, SAFE_NAME_MAX_LENGTH);
  }

  private getUploadLimitBytes(planTier: PlanTier): number {
    switch (planTier) {
      case 'premium':
        return 25 * 1024 * 1024;
      case 'pro':
        return 100 * 1024 * 1024;
      case 'free':
      default:
        return 5 * 1024 * 1024;
    }
  }
}
