import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  input,
  output,
  signal
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { ArrowRight, Gift, LucideAngularModule, X } from 'lucide-angular';

export interface ReferralPromoReward {
  plan: 'premium' | 'pro';
  label: string;
  amount: string;
}

@Component({
  selector: 'app-referral-promo-banner',
  imports: [LucideAngularModule, RouterLink],
  styleUrl: './referral-promo-banner.component.css',
  template: `
    <article
      class="lf-promo"
      [class.lf-promo--exiting]="isExiting()"
      role="status"
      aria-live="polite"
    >
      <div class="lf-promo__art" aria-hidden="true">
        <span class="lf-promo__spark lf-promo__spark--a"></span>
        <span class="lf-promo__spark lf-promo__spark--b"></span>
        <lucide-icon [name]="giftIcon" class="lf-promo__gift"></lucide-icon>
      </div>

      <div class="lf-promo__body">
        <p class="lf-promo__kicker">{{ kicker() }}</p>
        <p class="lf-promo__title">{{ title() }}</p>
        <p class="lf-promo__copy">{{ message() }}</p>
      </div>

      @if (rewards().length) {
        <ul class="lf-promo__rewards">
          @for (reward of rewards(); track reward.plan) {
            <li class="lf-promo__reward" [class.lf-promo__reward--pro]="reward.plan === 'pro'">
              <span class="lf-promo__reward-plan">{{ reward.label }} </span>
              <strong class="lf-promo__reward-amount">{{ reward.amount }}</strong>
            </li>
          }
          @if (rewardsNote()) {
            <li class="lf-promo__note">{{ rewardsNote() }}</li>
          }
        </ul>
      }

      <a [routerLink]="ctaLink()" class="lf-promo__cta">
        <span>{{ cta() }}</span>
        <lucide-icon [name]="arrowIcon" class="lf-promo__cta-icon" aria-hidden="true"></lucide-icon>
      </a>

      <button
        type="button"
        class="lf-promo__close"
        (click)="onDismiss()"
        [attr.aria-label]="dismissLabel()"
      >
        <lucide-icon [name]="closeIcon" class="lf-promo__close-icon"></lucide-icon>
      </button>
    </article>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ReferralPromoBannerComponent implements OnDestroy {
  protected readonly giftIcon = Gift;
  protected readonly arrowIcon = ArrowRight;
  protected readonly closeIcon = X;
  protected readonly isExiting = signal(false);

  private exitTimerId: number | null = null;
  private isDestroyed = false;

  kicker = input('');
  title = input.required<string>();
  message = input.required<string>();
  rewards = input<ReferralPromoReward[]>([]);
  rewardsNote = input('');
  cta = input.required<string>();
  ctaLink = input.required<string>();
  dismissLabel = input.required<string>();
  dismissed = output<void>();

  ngOnDestroy(): void {
    this.isDestroyed = true;
    this.clearExitTimer();
  }

  protected onDismiss(): void {
    if (this.isDestroyed || this.isExiting()) {
      return;
    }

    this.isExiting.set(true);
    this.exitTimerId = window.setTimeout(() => {
      if (!this.isDestroyed) {
        this.dismissed.emit();
      }
    }, 220);
  }

  private clearExitTimer(): void {
    if (this.exitTimerId !== null) {
      window.clearTimeout(this.exitTimerId);
      this.exitTimerId = null;
    }
  }
}
