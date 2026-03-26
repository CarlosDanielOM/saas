import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  signal
} from '@angular/core';
import { 
  LucideAngularModule, 
  Users, 
  Star, 
  Gem, 
  Heart, 
  MessageSquare, 
  Command,
  ChevronDown,
  ChevronUp
} from 'lucide-angular';
import { ActivityCounters } from '../../../models/activity.model';
import { LanguageService } from '../../../services/language.service';
import { CountUpDirective } from '../../../shared/directives/count-up.directive';

@Component({
  selector: 'app-activity-feed',
  imports: [LucideAngularModule, CountUpDirective],
  template: `
    <article class="activity-feed" [attr.aria-label]="t('dashboard.activity.title')">
      <button 
        type="button"
        class="activity-feed__header"
        (click)="toggleExpanded()"
        [attr.aria-expanded]="isExpanded()"
      >
        <h3 class="activity-feed__title">{{ t('dashboard.activity.title') }}</h3>
        <lucide-icon 
          [name]="isExpanded() ? chevronUpIcon : chevronDownIcon" 
          class="activity-feed__toggle-icon"
        ></lucide-icon>
      </button>

      @if (isExpanded()) {
        <div class="activity-feed__content">
          <div class="activity-feed__grid">
            <div class="activity-feed__item">
              <div class="activity-feed__icon-wrapper activity-feed__icon-wrapper--follows">
                <lucide-icon [name]="usersIcon" class="activity-feed__icon"></lucide-icon>
              </div>
              <div class="activity-feed__info">
                <span class="activity-feed__label">{{ t('dashboard.activity.follows') }}</span>
                <span class="activity-feed__count" [countUp]="counters().follows">0</span>
              </div>
            </div>

            <div class="activity-feed__item">
              <div class="activity-feed__icon-wrapper activity-feed__icon-wrapper--subs">
                <lucide-icon [name]="starIcon" class="activity-feed__icon"></lucide-icon>
              </div>
              <div class="activity-feed__info">
                <span class="activity-feed__label">{{ t('dashboard.activity.subs') }}</span>
                <span class="activity-feed__count" [countUp]="counters().subs">0</span>
              </div>
            </div>

            <div class="activity-feed__item">
              <div class="activity-feed__icon-wrapper activity-feed__icon-wrapper--bits">
                <lucide-icon [name]="gemIcon" class="activity-feed__icon"></lucide-icon>
              </div>
              <div class="activity-feed__info">
                <span class="activity-feed__label">{{ t('dashboard.activity.bits') }}</span>
                <span class="activity-feed__count" [countUp]="counters().bits">0</span>
              </div>
            </div>

            <div class="activity-feed__item">
              <div class="activity-feed__icon-wrapper activity-feed__icon-wrapper--donations">
                <lucide-icon [name]="heartIcon" class="activity-feed__icon"></lucide-icon>
              </div>
              <div class="activity-feed__info">
                <span class="activity-feed__label">{{ t('dashboard.activity.donations') }}</span>
                <span class="activity-feed__count" [countUp]="counters().donations">0</span>
              </div>
            </div>

            <div class="activity-feed__item">
              <div class="activity-feed__icon-wrapper activity-feed__icon-wrapper--messages">
                <lucide-icon [name]="messageIcon" class="activity-feed__icon"></lucide-icon>
              </div>
              <div class="activity-feed__info">
                <span class="activity-feed__label">{{ t('dashboard.activity.messages') }}</span>
                <span class="activity-feed__count" [countUp]="counters().messages">0</span>
              </div>
            </div>

            <div class="activity-feed__item">
              <div class="activity-feed__icon-wrapper activity-feed__icon-wrapper--commands">
                <lucide-icon [name]="commandIcon" class="activity-feed__icon"></lucide-icon>
              </div>
              <div class="activity-feed__info">
                <span class="activity-feed__label">{{ t('dashboard.activity.commands') }}</span>
                <span class="activity-feed__count" [countUp]="counters().commands">0</span>
              </div>
            </div>
          </div>
        </div>
      }
    </article>
  `,
  styles: `
    .activity-feed {
      background: color-mix(in srgb, var(--dash-panel) 90%, transparent);
      border: 1px solid color-mix(in srgb, var(--dash-border) 55%, transparent);
      border-radius: 12px;
      overflow: hidden;
    }

    .activity-feed__header {
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

    .activity-feed__header:hover {
      background: color-mix(in srgb, var(--dash-panel-2) 60%, transparent);
    }

    .activity-feed__title {
      font-size: 14px;
      font-weight: 600;
      color: var(--dash-text);
      margin: 0;
    }

    .activity-feed__toggle-icon {
      width: 20px;
      height: 20px;
      color: var(--dash-text-soft);
      transition: transform 0.2s ease;
    }

    .activity-feed__content {
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

    .activity-feed__grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
    }

    @media (max-width: 640px) {
      .activity-feed__grid {
        grid-template-columns: repeat(2, 1fr);
      }
    }

    .activity-feed__item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px;
      background: color-mix(in srgb, var(--dash-panel-2) 95%, transparent);
      border: 1px solid color-mix(in srgb, var(--dash-border) 65%, transparent);
      border-radius: 8px;
      transition: all 0.2s ease;
    }

    .activity-feed__item:hover {
      background: color-mix(in srgb, var(--dash-panel-2) 100%, transparent);
      border-color: color-mix(in srgb, var(--dash-border) 85%, transparent);
      transform: translateY(-1px);
    }

    .activity-feed__icon-wrapper {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      border-radius: 8px;
      flex-shrink: 0;
    }

    .activity-feed__icon-wrapper--follows {
      background: color-mix(in srgb, #3b82f6 28%, var(--dash-panel));
      color: #60a5fa;
    }

    .activity-feed__icon-wrapper--subs {
      background: color-mix(in srgb, #f59e0b 28%, var(--dash-panel));
      color: #fbbf24;
    }

    .activity-feed__icon-wrapper--bits {
      background: color-mix(in srgb, #a855f7 28%, var(--dash-panel));
      color: #c084fc;
    }

    .activity-feed__icon-wrapper--donations {
      background: color-mix(in srgb, #ec4899 28%, var(--dash-panel));
      color: #f472b6;
    }

    .activity-feed__icon-wrapper--messages {
      background: color-mix(in srgb, #10b981 28%, var(--dash-panel));
      color: #34d399;
    }

    .activity-feed__icon-wrapper--commands {
      background: color-mix(in srgb, #6366f1 28%, var(--dash-panel));
      color: #818cf8;
    }

    .activity-feed__icon {
      width: 18px;
      height: 18px;
    }

    .activity-feed__info {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }

    .activity-feed__label {
      font-size: 11px;
      color: var(--dash-text-soft);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .activity-feed__count {
      font-size: 18px;
      font-weight: 700;
      color: var(--dash-text);
      line-height: 1.2;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ActivityFeedComponent {
  private readonly languageService = inject(LanguageService);

  readonly counters = input<ActivityCounters>({
    follows: 0,
    subs: 0,
    bits: 0,
    donations: 0,
    messages: 0,
    commands: 0
  });

  readonly isLive = input<boolean>(false);
  readonly isExpanded = signal<boolean>(false);

  constructor() {
    effect(() => {
      // On mobile, expand if live, collapse if offline
      // On desktop, always keep expanded
      const isMobile = typeof window !== 'undefined' && window.innerWidth <= 720;
      if (isMobile) {
        this.isExpanded.set(this.isLive());
      } else {
        this.isExpanded.set(true);
      }
    });
  }

  readonly usersIcon = Users;
  readonly starIcon = Star;
  readonly gemIcon = Gem;
  readonly heartIcon = Heart;
  readonly messageIcon = MessageSquare;
  readonly commandIcon = Command;
  readonly chevronDownIcon = ChevronDown;
  readonly chevronUpIcon = ChevronUp;

  toggleExpanded(): void {
    this.isExpanded.update(v => !v);
  }

  t(key: string): string {
    return this.languageService.translate(key);
  }
}
