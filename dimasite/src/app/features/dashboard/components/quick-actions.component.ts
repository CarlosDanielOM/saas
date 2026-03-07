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
      background: rgba(30, 41, 59, 0.5);
      border: 1px solid rgba(148, 163, 184, 0.1);
      border-radius: 12px;
      padding: 16px;
    }

    .quick-actions__title {
      font-size: 14px;
      font-weight: 600;
      color: #f8fafc;
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
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      color: white;
    }

    .quick-actions__btn--join:hover:not(:disabled) {
      background: linear-gradient(135deg, #34d399 0%, #10b981 100%);
      transform: translateY(-1px);
    }

    .quick-actions__btn--leave {
      background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
      color: white;
    }

    .quick-actions__btn--leave:hover:not(:disabled) {
      background: linear-gradient(135deg, #f87171 0%, #ef4444 100%);
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
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.3);
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
      border-top: 1px solid rgba(148, 163, 184, 0.1);
    }

    .quick-actions__status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #64748b;
      transition: background 0.3s ease;
    }

    .quick-actions__status-dot--active {
      background: #10b981;
      box-shadow: 0 0 8px rgba(16, 185, 129, 0.5);
    }

    .quick-actions__status-text {
      font-size: 13px;
      color: #94a3b8;
    }

    /* Light mode */
    :host-context(:not(.dark)) .quick-actions {
      background: rgba(255, 255, 255, 0.7);
      border-color: rgba(148, 163, 184, 0.2);
    }

    :host-context(:not(.dark)) .quick-actions__title {
      color: #0f172a;
    }

    :host-context(:not(.dark)) .quick-actions__status-text {
      color: #64748b;
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
