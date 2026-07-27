import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { distinctUntilChanged, map, of, shareReplay, startWith, switchMap } from 'rxjs';

import { DisplayNamePipe } from '../../pipes/display-name.pipe';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { ConfirmationModalComponent } from '../../shared/confirmation-modal/confirmation-modal.component';
import { getRouteParam } from '../../shared/utils/route-param.util';
import {
  MediaLibraryItem,
  MediaLibraryMeta,
  MediaScope,
  PlanTier
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

const SAFE_NAME_REGEX = /^[A-Za-z][A-Za-z0-9]*(_[A-Za-z0-9]+)*$/;
const SAFE_NAME_MAX_LENGTH = 60;

@Component({
  selector: 'app-media-library-page',
  imports: [RouterLink, ConfirmationModalComponent, DisplayNamePipe],
  templateUrl: './media-library-page.component.html',
  styleUrl: './media-library-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class MediaLibraryPageComponent {
  private readonly triggersService = inject(TriggersService);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly toast = inject(ToastService);
  private readonly route = inject(ActivatedRoute);

  readonly loading = signal(false);
  readonly items = signal<MediaLibraryItem[]>([]);
  readonly libraryMeta = signal<MediaLibraryMeta>({
    planTier: 'free',
    quotaBytesUsed: 0,
    quotaBytesLimit: 50 * 1024 * 1024
  });

  readonly isUploadModalOpen = signal(false);
  readonly isUploadingMedia = signal(false);
  readonly isDraggingUpload = signal(false);
  readonly uploadForm = signal<UploadFormState>({ name: '', scope: 'private', file: null });
  readonly makePublicConfirm = signal<MediaLibraryItem | null>(null);

  readonly makePublicDisplayName = computed(() => {
    const item = this.makePublicConfirm();
    if (!item) return '';
    const raw = item.localAlias || item.asset?.displayName || '';
    return raw.replace(/_+/g, ' ').trim();
  });

  readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('uploadFileInput');

  readonly planTier = computed<PlanTier>(() => {
    const metaTier = this.libraryMeta().planTier;
    if (metaTier === 'premium' || metaTier === 'pro' || metaTier === 'free') {
      return metaTier;
    }
    const sessionTier = this.sessionAuth.session()?.appUser.plan_tier || 'free';
    if (sessionTier === 'premium' || sessionTier === 'pro') {
      return sessionTier;
    }
    return 'free';
  });

  readonly planTierLabel = computed(() => {
    const tier = this.planTier();
    if (tier === 'pro') return this.t('navbar.planPro');
    if (tier === 'premium') return this.t('navbar.planPremium');
    return this.t('navbar.planFree');
  });

  readonly quotaPercent = computed(() => {
    const meta = this.libraryMeta();
    if (!meta.quotaBytesLimit) return 0;
    return Math.max(0, Math.min(100, Math.round((meta.quotaBytesUsed / meta.quotaBytesLimit) * 100)));
  });

  readonly privateCount = computed(
    () => this.items().filter((item) => item.assetScope === 'private').length
  );
  readonly publicCount = computed(
    () => this.items().filter((item) => item.assetScope === 'public').length
  );

  readonly uploadLimitLabel = computed(() => this.formatBytes(this.getUploadLimitBytes(this.planTier())));

  readonly uploadValidationError = computed<string | null>(() => {
    const form = this.uploadForm();
    if (!form.file) return null;
    const limit = this.getUploadLimitBytes(this.planTier());
    if (form.file.size > limit) {
      return this.t('modules.library.upload.fileTooLarge', { size: this.formatBytes(limit) });
    }
    if (form.scope === 'private') {
      const meta = this.libraryMeta();
      if (meta.quotaBytesLimit && form.file.size + meta.quotaBytesUsed > meta.quotaBytesLimit) {
        return this.t('modules.library.upload.quotaExceeded', {
          quota: this.formatBytes(meta.quotaBytesLimit)
        });
      }
    }
    return null;
  });

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

  constructor() {
    effect(() => {
      const channelId = this.channelID();
      if (channelId) {
        this.loadLibrary(channelId);
      }
    });
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / 1024 ** exponent;
    return `${value.toFixed(value < 10 ? 1 : 0)} ${units[exponent]}`;
  }

  loadLibrary(channelId?: string): void {
    const id = channelId ?? this.channelID();
    if (!id) return;
    this.loading.set(true);
    this.triggersService.getLibrary(id).subscribe({
      next: (res) => {
        this.items.set(res.items || []);
        if (res.meta) this.libraryMeta.set(res.meta);
        this.loading.set(false);
      },
      error: () => {
        this.toast.error(
          this.t('modules.library.upload.errorTitle'),
          this.t('modules.library.errors.loadFailed')
        );
        this.loading.set(false);
      }
    });
  }

  refresh(): void {
    this.loadLibrary();
  }

  openUploadModal(): void {
    const canPrivate = this.planTier() !== 'free';
    this.isDraggingUpload.set(false);
    this.uploadForm.set({
      name: '',
      scope: canPrivate ? 'private' : 'public',
      file: null
    });
    this.isUploadModalOpen.set(true);
  }

  closeUploadModal(): void {
    if (this.isUploadingMedia()) return;
    this.isUploadModalOpen.set(false);
    this.isDraggingUpload.set(false);
    const canPrivate = this.planTier() !== 'free';
    this.uploadForm.set({
      name: '',
      scope: canPrivate ? 'private' : 'public',
      file: null
    });
    this.resetFileInput();
  }

  onUploadBackdropClick(event: Event): void {
    if (event.target === event.currentTarget) {
      this.closeUploadModal();
    }
  }

  onUploadFileChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    this.applyUploadFile(file);
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
    if (!file) return;
    this.applyUploadFile(file);
  }

  updateUploadName(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.uploadForm.update((state) => ({
      ...state,
      name: this.sanitizeSafeName(input.value)
    }));
  }

  updateUploadScope(scope: MediaScope): void {
    if (this.planTier() === 'free' && scope === 'private') return;
    this.uploadForm.update((state) => ({ ...state, scope }));
  }

  submitUpload(): void {
    const channelId = this.channelID();
    if (!channelId) return;
    const form = this.uploadForm();
    if (!form.file || !form.name.trim() || !SAFE_NAME_REGEX.test(form.name)) {
      this.toast.error(
        this.t('modules.library.upload.errorTitle'),
        this.t('modules.library.upload.validationMessage')
      );
      return;
    }
    const validation = this.uploadValidationError();
    if (validation) {
      this.toast.error(this.t('modules.library.upload.errorTitle'), validation);
      return;
    }

    this.isUploadingMedia.set(true);
    this.triggersService
      .uploadMedia(channelId, {
        file: form.file,
        name: form.name.trim(),
        scope: form.scope
      })
      .subscribe({
        next: () => {
          this.toast.success(
            this.t('modules.library.upload.successTitle'),
            this.t('modules.library.upload.successMessage')
          );
          this.isUploadingMedia.set(false);
          this.closeUploadModal();
          this.loadLibrary();
        },
        error: (err: unknown) => {
          const message =
            err instanceof Error ? err.message : this.t('modules.library.upload.errorMessage');
          this.toast.error(this.t('modules.library.upload.errorTitle'), message);
          this.isUploadingMedia.set(false);
        }
      });
  }

  deleteItem(item: MediaLibraryItem): void {
    const id = this.channelID();
    if (!id) return;
    if (!confirm(this.t('modules.library.confirm.delete'))) return;
    this.triggersService.removeLibraryItem(id, item._id).subscribe({
      next: () => {
        this.toast.success(
          this.t('modules.library.upload.successTitle'),
          this.t('modules.library.toasts.deleted')
        );
        this.loadLibrary();
      },
      error: () => {
        this.toast.error(
          this.t('modules.library.upload.errorTitle'),
          this.t('modules.library.errors.deleteFailed')
        );
      }
    });
  }

  confirmMakePublic(item: MediaLibraryItem): void {
    this.makePublicConfirm.set(item);
  }

  cancelMakePublic(): void {
    this.makePublicConfirm.set(null);
  }

  commitMakePublic(item: MediaLibraryItem): void {
    const id = this.channelID();
    if (!id) {
      this.makePublicConfirm.set(null);
      return;
    }
    this.makePublicConfirm.set(null);
    this.triggersService.changeLibraryItemScope(id, item._id, 'public', this.planTier()).subscribe({
      next: (res) => {
        if (res.meta) this.libraryMeta.set(res.meta);
        this.toast.success(
          this.t('modules.library.makePublic.successTitle'),
          this.t('modules.library.makePublic.successMessage')
        );
        this.loadLibrary();
      },
      error: (err: unknown) => {
        const message =
          err instanceof Error ? err.message : this.t('modules.library.makePublic.errorMessage');
        this.toast.error(this.t('modules.library.makePublic.errorTitle'), message);
      }
    });
  }

  private applyUploadFile(file: File | null): void {
    this.uploadForm.update((state) => ({
      ...state,
      file,
      name: state.name || (file ? this.sanitizeSafeName(file.name.replace(/\.[^.]+$/, '')) : '')
    }));
  }

  private sanitizeSafeName(value: string): string {
    return value
      .replace(/[^A-Za-z0-9_]/g, '')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/^\d+/, '')
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

  private resetFileInput(): void {
    const input = this.fileInput()?.nativeElement;
    if (input) input.value = '';
  }
}
