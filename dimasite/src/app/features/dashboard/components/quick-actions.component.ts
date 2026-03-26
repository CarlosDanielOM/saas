import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  output,
  signal
} from '@angular/core';
import { LucideAngularModule, LogIn, LogOut, Loader2 } from 'lucide-angular';
import { DashboardApiService } from '../../../services/dashboard-api.service';
import { LanguageService } from '../../../services/language.service';

@Component({
  selector: 'app-quick-actions',
  imports: [LucideAngularModule],
  template: `
    <article class="quick-actions" [attr.aria-label]="t('dashboard.quickActions.title')">
      <h3 class="quick-actions__title">{{ t('dashboard.quickActions.title') }}</h3>

      <div class="quick-actions__buttons">
        @if (!chatEnabled()) {
          <button
            type="button"
            class="quick-actions__btn quick-actions__btn--join"
            [disabled]="isLoading()"
            (click)="joinBot()"
            [attr.aria-label]="t('dashboard.quickActions.joinBot')"
          >
            @if (isLoading()) {
              <lucide-icon [name]="loaderIcon" class="quick-actions__icon quick-actions__icon--spin"></lucide-icon>
            } @else {
              <lucide-icon [name]="logInIcon" class="quick-actions__icon"></lucide-icon>
            }
            <span>{{ t('dashboard.quickActions.joinBot') }}</span>
          </button>
        } @else {
          <button
            type="button"
            class="quick-actions__btn quick-actions__btn--leave"
            [disabled]="isLoading()"
            (click)="leaveChat()"
            [attr.aria-label]="t('dashboard.quickActions.leaveChat')"
          >
            @if (isLoading()) {
              <lucide-icon [name]="loaderIcon" class="quick-actions__icon quick-actions__icon--spin"></lucide-icon>
            } @else {
              <lucide-icon [name]="logOutIcon" class="quick-actions__icon"></lucide-icon>
            }
            <span>{{ t('dashboard.quickActions.leaveChat') }}</span>
          </button>
        }
      </div>

      @if (errorMessage()) {
        <p class="quick-actions__error" role="alert">{{ errorMessage() }}</p>
      }

      <div class="quick-actions__status">
        <span 
          class="quick-actions__status-dot"
          [class.quick-actions__status-dot--active]="chatEnabled()"
          aria-hidden="true"
        ></span>
        <span class="quick-actions__status-text">
          {{ chatEnabled() ? t('dashboard.quickActions.statusActive') : t('dashboard.quickActions.statusInactive') }}
        </span>
      </div>
    </article>
  `,
  styles: `
    .quick-actions {
      background: color-mix(in srgb, var(--dash-panel) 90%, transparent);
      border: 1px solid color-mix(in srgb, var(--dash-border) 55%, transparent);
      border-radius: 12px;
      padding: 16px;
    }

    .quick-actions__title {
      font-size: 14px;
      font-weight: 600;
      color: var(--dash-text);
      margin: 0 0 12px 0;
    }

    .quick-actions__buttons {
      display: flex;
      gap: 8px;
    }

    .quick-actions__btn {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 16px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s ease;
      border: none;
      flex: 1;
      justify-content: center;
    }

    .quick-actions__btn--join {
      background: color-mix(in srgb, #10b981 22%, var(--dash-panel-2));
      border: 1px solid color-mix(in srgb, #10b981 45%, transparent);
      color: #34d399;
    }

    .quick-actions__btn--join:hover:not(:disabled) {
      background: color-mix(in srgb, #10b981 32%, var(--dash-panel-2));
      transform: translateY(-1px);
    }

    .quick-actions__btn--leave {
      background: color-mix(in srgb, #ef4444 22%, var(--dash-panel-2));
      border: 1px solid color-mix(in srgb, #ef4444 45%, transparent);
      color: #f87171;
    }

    .quick-actions__btn--leave:hover:not(:disabled) {
      background: color-mix(in srgb, #ef4444 32%, var(--dash-panel-2));
      transform: translateY(-1px);
    }

    .quick-actions__btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }

    .quick-actions__icon {
      width: 18px;
      height: 18px;
    }

    .quick-actions__icon--spin {
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .quick-actions__error {
      margin: 12px 0 0 0;
      padding: 8px 12px;
      background: color-mix(in srgb, #ef4444 10%, transparent);
      border: 1px solid color-mix(in srgb, #ef4444 30%, transparent);
      border-radius: 6px;
      font-size: 13px;
      color: #f87171;
    }

    .quick-actions__status {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid color-mix(in srgb, var(--dash-border) 50%, transparent);
    }

    .quick-actions__status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--dash-text-soft);
      transition: background 0.3s ease;
    }

    .quick-actions__status-dot--active {
      background: #10b981;
      box-shadow: 0 0 8px rgba(16, 185, 129, 0.5);
    }

    .quick-actions__status-text {
      font-size: 13px;
      color: var(--dash-text-soft);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class QuickActionsComponent {
  private readonly dashboardApi = inject(DashboardApiService);
  private readonly languageService = inject(LanguageService);

  readonly channelID = input.required<string>();
  readonly chatEnabled = input<boolean>(false);
  readonly chatEnabledChange = output<boolean>();

  readonly isLoading = signal<boolean>(false);
  readonly errorMessage = signal<string | null>(null);

  readonly logInIcon = LogIn;
  readonly logOutIcon = LogOut;
  readonly loaderIcon = Loader2;

  joinBot(): void {
    this.toggleChat(true);
  }

  leaveChat(): void {
    this.toggleChat(false);
  }

  private toggleChat(enabled: boolean): void {
    const channelID = this.channelID();
    if (!channelID) return;

    this.isLoading.set(true);
    this.errorMessage.set(null);

    this.dashboardApi.toggleChat(channelID, enabled).subscribe({
      next: (response) => {
        this.isLoading.set(false);
        if (response.error) {
          this.errorMessage.set(response.message || this.t('dashboard.quickActions.error'));
        } else {
          this.chatEnabledChange.emit(enabled);
        }
      },
      error: () => {
        this.isLoading.set(false);
        this.errorMessage.set(this.t('dashboard.quickActions.error'));
      }
    });
  }

  t(key: string): string {
    return this.languageService.translate(key);
  }
}
