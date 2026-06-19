import { Component, ChangeDetectionStrategy, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { LucideAngularModule, HardDrive, Upload, Trash2, Edit2, Eye, Lock, Globe } from 'lucide-angular';
import { TriggersService } from '../triggers/triggers.service';
import { MediaLibraryItem, MediaLibraryMeta, PlanTier } from '../triggers/triggers.model';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';

@Component({
  selector: 'app-media-library-page',
  standalone: true,
  imports: [CommonModule, RouterLink, LucideAngularModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="media-library-page">
      <section class="media-hero">
        <div class="media-hero__content">
          <a routerLink="../triggers" class="media-back-link">
            <lucide-icon [img]="storageIcon" class="media-back-link__icon"></lucide-icon>
            <span>{{ t('modules.library.backToTriggers') }}</span>
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
        <button type="button" class="media-button media-button--primary" (click)="triggerUpload()">
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
                  {{ item.assetScope }}
                </span>
                <span class="media-card__type">{{ item.mediaType }}</span>
              </div>
              <div class="media-card__body">
                <h3 class="media-card__name">{{ item.localAlias || item.asset?.displayName }}</h3>
                <p class="media-card__meta">{{ formatBytes(item.quotaBytesCharged) }}</p>
              </div>
              <div class="media-card__actions">
                <button type="button" class="media-card__action" (click)="deleteItem(item)">
                  <lucide-icon [img]="trashIcon"></lucide-icon>
                </button>
              </div>
            </article>
          }
        </div>
      }
    </div>
  `,
  styleUrl: './media-library-page.component.css'
})
export class MediaLibraryPageComponent {
  private readonly triggersService = inject(TriggersService);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly toast = inject(ToastService);

  readonly storageIcon = HardDrive;
  readonly uploadIcon = Upload;
  readonly trashIcon = Trash2;
  readonly editIcon = Edit2;
  readonly eyeIcon = Eye;
  readonly lockIcon = Lock;
  readonly globeIcon = Globe;

  readonly loading = signal(false);
  readonly items = signal<MediaLibraryItem[]>([]);
  readonly libraryMeta = signal<MediaLibraryMeta>({
    planTier: 'free',
    quotaBytesUsed: 0,
    quotaBytesLimit: 100 * 1024 * 1024
  });

  readonly planTier = computed<PlanTier>(() => this.libraryMeta().planTier || 'free');
  readonly planTierLabel = computed(() => this.planTier().toUpperCase());
  readonly quotaPercent = computed(() => {
    const meta = this.libraryMeta();
    if (!meta.quotaBytesLimit) return 0;
    return Math.max(0, Math.min(100, Math.round((meta.quotaBytesUsed / meta.quotaBytesLimit) * 100)));
  });

  private channelID: string | null = null;

  constructor() {
    // TODO: Resolve channelID from route/context via getRouteParam
    // For now leave empty; loadLibrary will be triggered after channelID is set
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

  loadLibrary(): void {
    if (!this.channelID) return;
    this.loading.set(true);
    this.triggersService.getLibrary(this.channelID).subscribe({
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

  triggerUpload(): void {
    // TODO: Implement file input + upload via TriggersService
    this.toast.info(this.t('common.info'), this.t('modules.library.actions.uploadComingSoon'));
  }

  deleteItem(item: MediaLibraryItem): void {
    if (!this.channelID) return;
    if (!confirm(this.t('modules.library.confirm.delete'))) return;
    this.triggersService.removeLibraryItem(this.channelID, item._id).subscribe({
      next: () => {
        this.toast.success(this.t('common.success'), this.t('modules.library.toasts.deleted'));
        this.loadLibrary();
      },
      error: () => {
        this.toast.error(this.t('common.error'), this.t('modules.library.errors.deleteFailed'));
      }
    });
  }

  refresh(): void {
    this.loadLibrary();
  }
}
