import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  input,
  output,
  signal
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideAngularModule, Gift, X } from 'lucide-angular';

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
      <div class="lf-promo__icon" aria-hidden="true">
        <lucide-icon [name]="giftIcon" class="lf-promo__icon-svg"></lucide-icon>
      </div>

      <div class="lf-promo__text">
        <p class="lf-promo__title">{{ title() }}</p>
        <p class="lf-promo__copy">{{ message() }}</p>
      </div>

      <a [routerLink]="ctaLink()" class="lf-promo__cta">
        {{ cta() }}
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
  protected readonly closeIcon = X;
  protected readonly isExiting = signal(false);

  private exitTimerId: number | null = null;
  private isDestroyed = false;

  title = input.required<string>();
  message = input.required<string>();
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
    }, 180);
  }

  private clearExitTimer(): void {
    if (this.exitTimerId !== null) {
      window.clearTimeout(this.exitTimerId);
      this.exitTimerId = null;
    }
  }
}
