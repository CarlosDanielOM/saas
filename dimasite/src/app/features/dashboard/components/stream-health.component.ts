import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  signal
} from '@angular/core';
import { LucideAngularModule, Activity, Zap, ChevronDown, ChevronUp } from 'lucide-angular';
import { LanguageService } from '../../../services/language.service';

export interface StreamHealthStatus {
  isConnected: boolean;
  responseTimeMs: number;
  lastChecked: string;
}

@Component({
  selector: 'app-stream-health',
  imports: [LucideAngularModule],
  template: `
    <article class="stream-health" [attr.aria-label]="t('dashboard.health.title')">
      <button 
        type="button"
        class="stream-health__header"
        (click)="toggleExpanded()"
        [attr.aria-expanded]="isExpanded()"
      >
        <div class="stream-health__header-left">
          <div 
            class="stream-health__status-dot"
            [class.stream-health__status-dot--connected]="health().isConnected"
            [class.stream-health__status-dot--disconnected]="!health().isConnected"
            aria-hidden="true"
          ></div>
          <h3 class="stream-health__title">{{ t('dashboard.health.title') }}</h3>
        </div>
        <lucide-icon 
          [name]="isExpanded() ? chevronUpIcon : chevronDownIcon" 
          class="stream-health__toggle-icon"
        ></lucide-icon>
      </button>

      @if (isExpanded()) {
        <div class="stream-health__content">
          <div class="stream-health__metrics">
            <div class="stream-health__metric">
              <div class="stream-health__metric-icon-wrapper">
                <lucide-icon [name]="activityIcon" class="stream-health__metric-icon"></lucide-icon>
              </div>
              <div class="stream-health__metric-info">
                <span class="stream-health__metric-label">{{ t('dashboard.health.connection') }}</span>
                <span 
                  class="stream-health__metric-value"
                  [class.stream-health__metric-value--good]="health().isConnected"
                  [class.stream-health__metric-value--bad]="!health().isConnected"
                >
                  {{ health().isConnected ? t('dashboard.health.connected') : t('dashboard.health.disconnected') }}
                </span>
              </div>
            </div>

            <div class="stream-health__metric">
              <div class="stream-health__metric-icon-wrapper">
                <lucide-icon [name]="zapIcon" class="stream-health__metric-icon"></lucide-icon>
              </div>
              <div class="stream-health__metric-info">
                <span class="stream-health__metric-label">{{ t('dashboard.health.responseTime') }}</span>
                <span 
                  class="stream-health__metric-value"
                  [class.stream-health__metric-value--good]="isResponseTimeGood()"
                  [class.stream-health__metric-value--warning]="isResponseTimeWarning()"
                  [class.stream-health__metric-value--bad]="isResponseTimeBad()"
                >
                  {{ health().responseTimeMs }}ms
                </span>
              </div>
            </div>
          </div>

          <div class="stream-health__footer">
            <span class="stream-health__last-checked">
              {{ t('dashboard.health.lastChecked') }}: {{ formatTime(health().lastChecked) }}
            </span>
          </div>
        </div>
      }
    </article>
  `,
  styles: `
    .stream-health {
      background: rgba(30, 41, 59, 0.5);
      border: 1px solid rgba(148, 163, 184, 0.1);
      border-radius: 12px;
      overflow: hidden;
    }

    .stream-health__header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      padding: 16px;
      background: transparent;
      border: none;
      cursor: pointer;
      transition: background 0.2s ease;
    }

    .stream-health__header:hover {
      background: rgba(255, 255, 255, 0.05);
    }

    .stream-health__header-left {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .stream-health__status-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      transition: all 0.3s ease;
    }

    .stream-health__status-dot--connected {
      background: #10b981;
      box-shadow: 0 0 10px rgba(16, 185, 129, 0.5);
    }

    .stream-health__status-dot--disconnected {
      background: #ef4444;
      box-shadow: 0 0 10px rgba(239, 68, 68, 0.5);
    }

    .stream-health__title {
      font-size: 14px;
      font-weight: 600;
      color: #f8fafc;
      margin: 0;
    }

    .stream-health__toggle-icon {
      width: 20px;
      height: 20px;
      color: #94a3b8;
    }

    .stream-health__content {
      padding: 0 16px 16px 16px;
      animation: slideDown 0.2s ease;
    }

    @keyframes slideDown {
      from {
        opacity: 0;
        transform: translateY(-10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .stream-health__metrics {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .stream-health__metric {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px;
      background: rgba(255, 255, 255, 0.03);
      border-radius: 8px;
    }

    .stream-health__metric-icon-wrapper {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 40px;
      background: rgba(99, 102, 241, 0.15);
      border-radius: 10px;
      flex-shrink: 0;
    }

    .stream-health__metric-icon {
      width: 20px;
      height: 20px;
      color: #818cf8;
    }

    .stream-health__metric-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .stream-health__metric-label {
      font-size: 12px;
      color: #64748b;
    }

    .stream-health__metric-value {
      font-size: 15px;
      font-weight: 600;
      color: #f8fafc;
    }

    .stream-health__metric-value--good {
      color: #34d399;
    }

    .stream-health__metric-value--warning {
      color: #fbbf24;
    }

    .stream-health__metric-value--bad {
      color: #f87171;
    }

    .stream-health__footer {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid rgba(148, 163, 184, 0.1);
    }

    .stream-health__last-checked {
      font-size: 12px;
      color: #64748b;
    }

    /* Light mode */
    :host-context(:not(.dark)) .stream-health {
      background: rgba(255, 255, 255, 0.7);
      border-color: rgba(148, 163, 184, 0.2);
    }

    :host-context(:not(.dark)) .stream-health__title {
      color: #0f172a;
    }

    :host-context(:not(.dark)) .stream-health__metric-value {
      color: #0f172a;
    }

    :host-context(:not(.dark)) .stream-health__metric {
      background: rgba(0, 0, 0, 0.02);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class StreamHealthComponent {
  private readonly languageService = inject(LanguageService);

  readonly health = input<StreamHealthStatus>({
    isConnected: false,
    responseTimeMs: 0,
    lastChecked: new Date().toISOString()
  });

  readonly isExpanded = signal<boolean>(false);

  readonly activityIcon = Activity;
  readonly zapIcon = Zap;
  readonly chevronDownIcon = ChevronDown;
  readonly chevronUpIcon = ChevronUp;

  toggleExpanded(): void {
    this.isExpanded.update(v => !v);
  }

  isResponseTimeGood(): boolean {
    return this.health().responseTimeMs < 100;
  }

  isResponseTimeWarning(): boolean {
    const ms = this.health().responseTimeMs;
    return ms >= 100 && ms < 300;
  }

  isResponseTimeBad(): boolean {
    return this.health().responseTimeMs >= 300;
  }

  t(key: string): string {
    return this.languageService.translate(key);
  }

  formatTime(isoString: string): string {
    const date = new Date(isoString);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
}
