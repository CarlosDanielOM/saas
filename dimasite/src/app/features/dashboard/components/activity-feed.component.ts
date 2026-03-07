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
      background: rgba(30, 41, 59, 0.5);
      border: 1px solid rgba(148, 163, 184, 0.1);
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
      background: rgba(255, 255, 255, 0.05);
    }

    .activity-feed__title {
      font-size: 14px;
      font-weight: 600;
      color: #f8fafc;
      margin: 0;
    }

    .activity-feed__toggle-icon {
      width: 20px;
      height: 20px;
      color: #94a3b8;
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
      background: rgba(255, 255, 255, 0.03);
      border-radius: 8px;
      transition: background 0.2s ease;
    }

    .activity-feed__item:hover {
      background: rgba(255, 255, 255, 0.06);
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
      background: rgba(59, 130, 246, 0.15);
      color: #60a5fa;
    }

    .activity-feed__icon-wrapper--subs {
      background: rgba(245, 158, 11, 0.15);
      color: #fbbf24;
    }

    .activity-feed__icon-wrapper--bits {
      background: rgba(168, 85, 247, 0.15);
      color: #c084fc;
    }

    .activity-feed__icon-wrapper--donations {
      background: rgba(236, 72, 153, 0.15);
      color: #f472b6;
    }

    .activity-feed__icon-wrapper--messages {
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
    }

    .activity-feed__icon-wrapper--commands {
      background: rgba(99, 102, 241, 0.15);
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
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .activity-feed__count {
      font-size: 18px;
      font-weight: 700;
      color: #f8fafc;
      line-height: 1.2;
    }

    /* Light mode */
    :host-context(:not(.dark)) .activity-feed {
      background: rgba(255, 255, 255, 0.7);
      border-color: rgba(148, 163, 184, 0.2);
    }

    :host-context(:not(.dark)) .activity-feed__title {
      color: #0f172a;
    }

    :host-context(:not(.dark)) .activity-feed__count {
      color: #0f172a;
    }

    :host-context(:not(.dark)) .activity-feed__item {
      background: rgba(0, 0, 0, 0.02);
    }

    :host-context(:not(.dark)) .activity-feed__item:hover {
      background: rgba(0, 0, 0, 0.04);
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
