import { Component, ChangeDetectionStrategy, inject, signal, computed, effect, viewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { LucideAngularModule, HardDrive, Upload, Trash2, Edit2, Eye, Lock, Globe, X, Info, AlertTriangle, CheckCircle2 } from 'lucide-angular';
import { map, distinctUntilChanged, shareReplay, switchMap, startWith, of } from 'rxjs';
import { toSignal } from '@angular/core/rxjs-interop';
import { TriggersService } from '../triggers/triggers.service';
import { MediaLibraryItem, MediaLibraryMeta, MediaScope, PlanTier } from '../triggers/triggers.model';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { ConfirmationModalComponent } from '../../shared/confirmation-modal/confirmation-modal.component';
import { getRouteParam } from '../../shared/utils/route-param.util';

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

const SAFE_NAME_REGEX = /^[A-Za-z0-9_]+$/;
const SAFE_NAME_MAX_LENGTH = 60;

@Component({
  selector: 'app-media-library-page',
  standalone: true,
  imports: [CommonModule, RouterLink, LucideAngularModule, ConfirmationModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="media-library-page">
      <section class="media-hero">
        <div class="media-hero__content">
          <a routerLink=".." class="media-back-link">
            <lucide-icon [img]="storageIcon" class="media-back-link__icon"></lucide-icon>
            <span>{{ t('modules.library.backToModules') }}</span>
          </a>

          <div class="media-hero__chips">
            <span class="media-chip">
              <lucide-icon [img]="storageIcon" class="media-chip__icon"></lucide-icon>
              {{ t('modules.library.heroBadge') }}
            </span>
            <span class="media-chip media-chip--tier">{{ planTierLabel() }}</span>
          </div>

          <div class="media-hero__body">
            <div class="media-hero__copy">
              <p class="media-hero__eyebrow">{{ t('modules.library.eyebrow') }}</p>
              <h1 class="media-hero__title">{{ t('modules.library.title') }}</h1>
              <p class="media-hero__subtitle">{{ t('modules.library.subtitle') }}</p>
            </div>
          </div>
        </div>
      </section>

      @if (libraryMeta(); as meta) {
        <section class="media-quota-card">
          <div class="media-quota-card__header">
            <div>
              <p class="media-quota-card__label">{{ t('modules.library.quota.label') }}</p>
              <strong class="media-quota-card__value">{{ formatBytes(meta.quotaBytesUsed) }} / {{ formatBytes(meta.quotaBytesLimit) }}</strong>
            </div>
            <div class="media-quota-card__percent">{{ quotaPercent() }}%</div>
          </div>
          <div class="media-quota-card__bar">
            <div class="media-quota-card__bar-fill" [style.width.%]="quotaPercent()"></div>
          </div>
          <p class="media-quota-card__hint">{{ t('modules.library.quota.hint') }}</p>
        </section>
      }

      <section class="media-actions">
        <button type="button" class="media-button media-button--primary" (click)="openUploadModal()">
          <lucide-icon [img]="uploadIcon" class="media-button__icon"></lucide-icon>
          <span>{{ t('modules.library.actions.upload') }}</span>
        </button>
        <button type="button" class="media-button media-button--ghost" (click)="refresh()">
          <span>{{ t('common.refresh') }}</span>
        </button>
      </section>

      @if (loading()) {
        <div class="media-loading">{{ t('modules.library.states.loading') }}</div>
      } @else if (items().length === 0) {
        <div class="media-empty">
          <lucide-icon [img]="storageIcon" class="media-empty__icon"></lucide-icon>
          <p>{{ t('modules.library.states.empty') }}</p>
        </div>
      } @else {
        <div class="media-grid">
          @for (item of items(); track item._id) {
            <article class="media-card" [class.media-card--public]="item.assetScope === 'public'">
              <div class="media-card__header">
                <span class="media-card__scope" [class.media-card__scope--public]="item.assetScope === 'public'">
                  <lucide-icon [img]="item.assetScope === 'public' ? globeIcon : lockIcon" class="media-card__scope-icon"></lucide-icon>
                  {{ t('modules.library.scope.' + item.assetScope) }}
                </span>
                <span class="media-card__type">{{ item.mediaType }}</span>
              </div>
              <div class="media-card__body">
                <h3 class="media-card__name">{{ item.localAlias || item.asset?.displayName }}</h3>
                <p class="media-card__meta">
                  {{ formatBytes(item.quotaBytesCharged) }}
                  @if (item.assetScope === 'private') {
                    · {{ t('modules.library.card.chargesQuota') }}
                  } @else {
                    · {{ t('modules.library.card.freeQuota') }}
                  }
                </p>
              </div>
              <div class="media-card__actions">
                @if (item.assetScope === 'private') {
                  <button type="button" class="media-card__action media-card__action--promote" [title]="t('modules.library.actions.makePublic')" (click)="confirmMakePublic(item)">
                    <lucide-icon [img]="globeIcon"></lucide-icon>
                  </button>
                }
                <button type="button" class="media-card__action" [title]="t('common.delete')" (click)="deleteItem(item)">
                  <lucide-icon [img]="trashIcon"></lucide-icon>
                </button>
              </div>
            </article>
          }
        </div>
      }
    </div>

    @if (isUploadModalOpen()) {
      <div class="media-modal-backdrop" (click)="closeUploadModal()">
        <section class="media-modal" (click)="$event.stopPropagation()">
          <header class="media-modal__head">
            <div>
              <p class="media-modal__eyebrow">{{ t('modules.library.upload.kicker') }}</p>
              <h2 class="media-modal__title">{{ t('modules.library.upload.title') }}</h2>
            </div>
            <button type="button" class="media-modal__close" (click)="closeUploadModal()">
              <lucide-icon [img]="closeIcon" class="media-modal__close-icon"></lucide-icon>
            </button>
          </header>

          <div class="media-upload-note">
            <lucide-icon [img]="infoIcon" class="media-upload-note__icon"></lucide-icon>
            <div>
              <strong>{{ t('modules.library.upload.limitTitle') }}</strong>
              <p>{{ t('modules.library.upload.limitMessage', { size: uploadLimitLabel() }) }}</p>
            </div>
          </div>

          @if (planTier() !== 'free') {
            <div class="media-scope-toggle">
              <button
                type="button"
                class="media-scope-toggle__option"
                [class.media-scope-toggle__option--active]="uploadForm().scope === 'private'"
                (click)="updateUploadScope('private')"
              >
                <lucide-icon [img]="lockIcon" class="media-scope-toggle__icon"></lucide-icon>
                {{ t('modules.library.scope.private') }}
              </button>
              <button
                type="button"
                class="media-scope-toggle__option"
                [class.media-scope-toggle__option--active]="uploadForm().scope === 'public'"
                (click)="updateUploadScope('public')"
              >
                <lucide-icon [img]="globeIcon" class="media-scope-toggle__icon"></lucide-icon>
                {{ t('modules.library.scope.public') }}
              </button>
            </div>
          }

          <div class="media-info-note" [class.media-info-note--public]="uploadForm().scope === 'public'">
            <lucide-icon [img]="uploadForm().scope === 'public' ? alertIcon : infoIcon" class="media-info-note__icon"></lucide-icon>
            @if (uploadForm().scope === 'private') {
              <p>{{ t('modules.library.upload.privateInfo', { quota: formatBytes(libraryMeta().quotaBytesLimit) }) }}</p>
            } @else {
              <p>{{ t('modules.library.upload.publicInfo') }}</p>
            }
          </div>

          <label class="media-field media-field--full">
            <span class="media-field__label">{{ t('modules.library.upload.nameLabel') }}</span>
            <input
              type="text"
              class="media-field__input"
              [value]="uploadForm().name"
              (input)="updateUploadName($event)"
              [placeholder]="t('modules.library.upload.namePlaceholder')"
              pattern="[A-Za-z0-9_]+"
              [attr.maxlength]="60"
              autocapitalize="off"
              autocomplete="off"
              spellcheck="false"
            />
          </label>

          <label
            class="media-file-drop"
            [class.media-file-drop--dragging]="isDraggingUpload()"
            (dragover)="handleUploadDragOver($event)"
            (dragleave)="handleUploadDragLeave($event)"
            (drop)="handleUploadDrop($event)"
          >
            <input #uploadFileInput type="file" class="media-file-drop__input" accept="video/*,audio/*,image/*,image/gif" (change)="onUploadFileChange($event)">
            <div class="media-file-drop__content">
              <lucide-icon [img]="uploadIcon" class="media-file-drop__icon"></lucide-icon>
              <strong>{{ uploadForm().file?.name || t('modules.library.upload.pickFile') }}</strong>
              <span>
                @if (isDraggingUpload() && !uploadForm().file) {
                  {{ t('modules.library.upload.dropNow') }}
                } @else if (uploadForm().file) {
                  {{ formatBytes(uploadForm().file?.size || 0) }}
                } @else {
                  {{ t('modules.library.upload.fileHint') }}
                }
              </span>
            </div>
          </label>

          @if (uploadValidationError(); as err) {
            <div class="media-upload-error" role="alert">
              <lucide-icon [img]="alertIcon" class="media-upload-error__icon"></lucide-icon>
              <span>{{ err }}</span>
            </div>
          }

          <div class="media-modal__actions">
            <button type="button" class="media-modal__action media-modal__action--ghost" (click)="closeUploadModal()">
              {{ t('common.cancel') }}
            </button>
            <button
              type="button"
              class="media-modal__action media-modal__action--primary"
              [disabled]="isUploadingMedia()"
              (click)="submitUpload()"
            >
              @if (isUploadingMedia()) {
                <span class="media-modal__action-spinner"></span>
                {{ t('modules.library.upload.uploading') }}
              } @else {
                {{ t('modules.library.upload.submit') }}
              }
            </button>
          </div>
        </section>
      </div>
    }

    @if (makePublicConfirm(); as item) {
      <app-confirmation-modal
        [isOpen]="true"
        variant="warning"
        [title]="t('modules.library.makePublic.confirmTitle')"
        [message]="t('modules.library.makePublic.confirmMessage', { name: (item.localAlias || item.asset?.displayName || '') })"
        [confirmText]="t('modules.library.actions.makePublic')"
        [cancelText]="t('common.cancel')"
        (confirm)="commitMakePublic(item)"
        (cancel)="cancelMakePublic()"
      />
    }
  `,
  styleUrl: './media-library-page.component.css'
})
export class MediaLibraryPageComponent {
  private readonly triggersService = inject(TriggersService);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly toast = inject(ToastService);
  private readonly route = inject(ActivatedRoute);

  readonly storageIcon = HardDrive;
  readonly uploadIcon = Upload;
  readonly trashIcon = Trash2;
  readonly editIcon = Edit2;
  readonly eyeIcon = Eye;
  readonly lockIcon = Lock;
  readonly globeIcon = Globe;
  readonly closeIcon = X;
  readonly infoIcon = Info;
  readonly alertIcon = AlertTriangle;
  readonly successIcon = CheckCircle2;

  readonly loading = signal(false);
  readonly items = signal<MediaLibraryItem[]>([]);
  readonly libraryMeta = signal<MediaLibraryMeta>({
    planTier: 'free',
    quotaBytesUsed: 0,
    quotaBytesLimit: 100 * 1024 * 1024
  });

  // Upload state
  readonly isUploadModalOpen = signal(false);
  readonly isUploadingMedia = signal(false);
  readonly isDraggingUpload = signal(false);
  readonly uploadForm = signal<UploadFormState>({ name: '', scope: 'private', file: null });
  readonly makePublicConfirm = signal<MediaLibraryItem | null>(null);
  readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('uploadFileInput');

  readonly planTier = computed<PlanTier>(() => {
    const metaTier = this.libraryMeta().planTier;
    if (metaTier) return metaTier;
    return (this.sessionAuth.session()?.appUser.plan_tier || 'free') as PlanTier;
  });
  readonly planTierLabel = computed(() => this.planTier().toUpperCase());
  readonly quotaPercent = computed(() => {
    const meta = this.libraryMeta();
    if (!meta.quotaBytesLimit) return 0;
    return Math.max(0, Math.min(100, Math.round((meta.quotaBytesUsed / meta.quotaBytesLimit) * 100)));
  });

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
        return this.t('modules.library.upload.quotaExceeded', { quota: this.formatBytes(meta.quotaBytesLimit) });
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
        this.toast.error(this.t('common.error'), this.t('modules.library.errors.loadFailed'));
        this.loading.set(false);
      }
    });
  }

  refresh(): void {
    this.loadLibrary();
  }

  // === Upload modal ===

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

  private applyUploadFile(file: File | null): void {
    this.uploadForm.update((state) => ({
      ...state,
      file,
      name: state.name || (file ? this.sanitizeSafeName(file.name.replace(/\.[^.]+$/, '')) : '')
    }));
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
      this.toast.error(this.t('common.error'), this.t('modules.library.upload.validationMessage'));
      return;
    }
    const validation = this.uploadValidationError();
    if (validation) {
      this.toast.error(this.t('common.error'), validation);
      return;
    }

    this.isUploadingMedia.set(true);
    this.triggersService.uploadMedia(channelId, {
      file: form.file,
      name: form.name.trim(),
      scope: form.scope
    }).subscribe({
      next: () => {
        this.toast.success(
          this.t('modules.library.upload.successTitle'),
          this.t('modules.library.upload.successMessage')
        );
        this.isUploadingMedia.set(false);
        this.closeUploadModal();
        this.loadLibrary();
      },
      error: (err) => {
        const message = err instanceof Error ? err.message : this.t('modules.library.upload.errorMessage');
        this.toast.error(this.t('modules.library.upload.errorTitle'), message);
        this.isUploadingMedia.set(false);
      }
    });
  }

  // === Delete ===

  deleteItem(item: MediaLibraryItem): void {
    const id = this.channelID();
    if (!id) return;
    if (!confirm(this.t('modules.library.confirm.delete'))) return;
    this.triggersService.removeLibraryItem(id, item._id).subscribe({
      next: () => {
        this.toast.success(this.t('common.success'), this.t('modules.library.toasts.deleted'));
        this.loadLibrary();
      },
      error: () => {
        this.toast.error(this.t('common.error'), this.t('modules.library.errors.deleteFailed'));
      }
    });
  }

  // === Make Public (one-way scope change) ===

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
      error: (err) => {
        const message = err instanceof Error ? err.message : this.t('modules.library.makePublic.errorMessage');
        this.toast.error(this.t('modules.library.makePublic.errorTitle'), message);
      }
    });
  }

  // === Helpers ===

  private sanitizeSafeName(value: string): string {
    return value
      .replace(/[^A-Za-z0-9_]/g, '')
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
