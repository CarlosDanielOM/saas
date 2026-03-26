import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal
} from '@angular/core';
import { LucideAngularModule, Radio, Users, Clock, Gamepad2 } from 'lucide-angular';
import { TwitchStream } from '../../../models/dashboard.model';
import { LanguageService } from '../../../services/language.service';

@Component({
  selector: 'app-live-stream-card',
  imports: [LucideAngularModule],
  template: `
    @if (isLive()) {
      <article class="live-stream-card" role="status" [attr.aria-label]="t('dashboard.liveStream.statusLive')">
        <div class="live-stream-card__header">
          <div class="live-stream-card__badge">
            <span class="live-stream-card__pulse" aria-hidden="true"></span>
            <lucide-icon [name]="radioIcon" class="live-stream-card__icon"></lucide-icon>
            <span class="live-stream-card__live-text">{{ t('dashboard.liveStream.live') }}</span>
          </div>
          <div class="live-stream-card__viewers">
            <lucide-icon [name]="usersIcon" class="live-stream-card__viewers-icon"></lucide-icon>
            <span class="live-stream-card__viewers-count">{{ formatNumber(stream()?.viewer_count || 0) }}</span>
          </div>
        </div>

        @if (stream()?.thumbnail_url) {
          <div class="live-stream-card__thumbnail">
            <img 
              [src]="getThumbnailUrl(stream()!.thumbnail_url)" 
              [alt]="t('dashboard.liveStream.thumbnailAlt')"
              loading="lazy"
            />
          </div>
        }

        <div class="live-stream-card__info">
          <h3 class="live-stream-card__title">{{ stream()?.title || t('dashboard.liveStream.noTitle') }}</h3>
          
          @if (stream()?.game_name) {
            <div class="live-stream-card__game">
              <lucide-icon [name]="gameIcon" class="live-stream-card__game-icon"></lucide-icon>
              <span>{{ stream()?.game_name }}</span>
            </div>
          }

          <div class="live-stream-card__duration">
            <lucide-icon [name]="clockIcon" class="live-stream-card__duration-icon"></lucide-icon>
            <span>{{ durationText() }}</span>
          </div>
        </div>
      </article>
    } @else {
      <article class="live-stream-card live-stream-card--offline" role="status" [attr.aria-label]="t('dashboard.liveStream.statusOffline')">
        <div class="live-stream-card__offline-content">
          <lucide-icon [name]="radioIcon" class="live-stream-card__offline-icon"></lucide-icon>
          <p class="live-stream-card__offline-text">{{ t('dashboard.liveStream.offline') }}</p>
          <p class="live-stream-card__offline-hint">{{ t('dashboard.liveStream.offlineHint') }}</p>
        </div>
      </article>
    }
  `,
  styles: `
    .live-stream-card {
      background: color-mix(in srgb, #ef4444 8%, var(--dash-panel));
      border: 1px solid color-mix(in srgb, #ef4444 35%, var(--dash-border));
      border-radius: 16px;
      padding: 20px;
      position: relative;
      overflow: hidden;
    }

    .live-stream-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: linear-gradient(90deg, #ef4444, #f87171, #ef4444);
      background-size: 200% 100%;
      animation: shimmer 2s linear infinite;
    }

    @keyframes shimmer {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }

    .live-stream-card--offline {
      background: color-mix(in srgb, var(--dash-panel-2) 60%, var(--dash-panel));
      border-color: color-mix(in srgb, var(--dash-border) 75%, transparent);
    }

    .live-stream-card--offline::before {
      background: linear-gradient(90deg, var(--dash-text-soft), color-mix(in srgb, var(--dash-text-soft) 70%, var(--dash-text)), var(--dash-text-soft));
      animation: none;
    }

    .live-stream-card__header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }

    .live-stream-card__badge {
      display: flex;
      align-items: center;
      gap: 8px;
      background: color-mix(in srgb, #ef4444 18%, transparent);
      padding: 6px 12px;
      border-radius: 20px;
    }

    .live-stream-card__pulse {
      width: 8px;
      height: 8px;
      background: #ef4444;
      border-radius: 50%;
      animation: pulse 2s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { 
        transform: scale(1);
        opacity: 1;
      }
      50% { 
        transform: scale(1.3);
        opacity: 0.7;
      }
    }

    .live-stream-card__icon {
      width: 16px;
      height: 16px;
      color: #ef4444;
    }

    .live-stream-card__live-text {
      font-size: 14px;
      font-weight: 600;
      color: #ef4444;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .live-stream-card__viewers {
      display: flex;
      align-items: center;
      gap: 6px;
      background: color-mix(in srgb, var(--dash-panel-2) 70%, transparent);
      border: 1px solid color-mix(in srgb, var(--dash-border) 50%, transparent);
      padding: 6px 12px;
      border-radius: 20px;
    }

    .live-stream-card__viewers-icon {
      width: 16px;
      height: 16px;
      color: #fbbf24;
    }

    .live-stream-card__viewers-count {
      font-size: 14px;
      font-weight: 600;
      color: #fbbf24;
    }

    .live-stream-card__thumbnail {
      width: 100%;
      aspect-ratio: 16/9;
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 16px;
    }

    .live-stream-card__thumbnail img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .live-stream-card__info {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .live-stream-card__title {
      font-size: 16px;
      font-weight: 600;
      color: var(--dash-text);
      margin: 0;
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .live-stream-card__game,
    .live-stream-card__duration {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      color: var(--dash-text-soft);
    }

    .live-stream-card__game-icon,
    .live-stream-card__duration-icon {
      width: 14px;
      height: 14px;
      color: var(--dash-text-soft);
    }

    .live-stream-card__offline-content {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      padding: 24px;
      gap: 8px;
    }

    .live-stream-card__offline-icon {
      width: 32px;
      height: 32px;
      color: var(--dash-text-soft);
    }

    .live-stream-card__offline-text {
      font-size: 16px;
      font-weight: 600;
      color: var(--dash-text);
      margin: 0;
    }

    .live-stream-card__offline-hint {
      font-size: 13px;
      color: var(--dash-text-soft);
      margin: 0;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LiveStreamCardComponent {
  private readonly languageService = inject(LanguageService);

  readonly stream = input<TwitchStream | null>(null);
  readonly isLive = input<boolean>(false);

  readonly radioIcon = Radio;
  readonly usersIcon = Users;
  readonly clockIcon = Clock;
  readonly gameIcon = Gamepad2;

  private readonly startTime = signal<Date | null>(null);
  private readonly duration = signal<string>('0:00');

  constructor() {
    setInterval(() => {
      this.updateDuration();
    }, 1000);
  }

  private updateDuration(): void {
    const stream = this.stream();
    if (!stream?.started_at || !this.isLive()) {
      this.duration.set('0:00');
      return;
    }

    const start = new Date(stream.started_at);
    const now = new Date();
    const diff = now.getTime() - start.getTime();

    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

    if (hours > 0) {
      this.duration.set(`${hours}:${minutes.toString().padStart(2, '0')}`);
    } else {
      this.duration.set(`${minutes}m`);
    }
  }

  readonly durationText = computed(() => {
    const stream = this.stream();
    if (!stream?.started_at || !this.isLive()) {
      return this.t('dashboard.liveStream.notStarted');
    }
    return `${this.t('dashboard.liveStream.duration')}: ${this.duration()}`;
  });

  t(key: string): string {
    return this.languageService.translate(key);
  }

  formatNumber(value: number): string {
    return value.toLocaleString();
  }

  getThumbnailUrl(template: string): string {
    return template
      .replace('{width}', '320')
      .replace('{height}', '180');
  }
}
