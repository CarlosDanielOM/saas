import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { LanguageService } from '../../services/language.service';
import { LfIconComponent } from '../lf-icon/lf-icon.component';
import { TWITCH_REWARD_LIMIT } from '../utils/twitch-reward-error.util';

const DISMISS_KEY_PREFIX = 'dimasite.rewardLimitNote.dismissed:';

function readDismissed(channelID: string): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY_PREFIX + channelID) === '1';
  } catch {
    return false;
  }
}

function writeDismissed(channelID: string, dismissed: boolean): void {
  try {
    if (dismissed) localStorage.setItem(DISMISS_KEY_PREFIX + channelID, '1');
    else localStorage.removeItem(DISMISS_KEY_PREFIX + channelID);
  } catch {
    // Private mode / blocked storage: the note simply comes back next visit.
  }
}

/**
 * Small amber note shown when a channel has every Twitch reward slot taken (50, counting
 * turned-off and paused rewards). Dismissible per channel; it comes back once the channel
 * drops below the limit and fills up again.
 */
@Component({
  selector: 'app-reward-limit-note',
  imports: [LfIconComponent, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Pages lay out with grid gaps: a hidden note must not leave an empty row behind.
  host: { '[style.display]': "visible() ? 'block' : 'none'" },
  template: `
    @if (visible()) {
      <section class="rl" role="note" aria-labelledby="reward-limit-note-title">
        <span class="rl__icon" aria-hidden="true"><app-lf-icon name="alert" [size]="16"></app-lf-icon></span>
        <div class="rl__copy">
          <p class="rl__title" id="reward-limit-note-title">{{ t('rewardLimit.noteTitle', { count: count() ?? limit, limit: limit }) }}</p>
          <p class="rl__hint">{{ t('rewardLimit.noteBody') }}</p>
          <div class="rl__actions">
            @if (showRewardsLink() && streamer()) {
              <a class="rl__link" [routerLink]="['/', streamer(), 'modules', 'redemptions']">{{ t('rewardLimit.openRewards') }}</a>
            }
            @if (streamer()) {
              <a class="rl__link" [href]="twitchDashboardUrl()" target="_blank" rel="noopener noreferrer">{{ t('rewardLimit.manageOnTwitch') }}</a>
            }
          </div>
        </div>
        <button type="button" class="rl__close" [attr.aria-label]="t('rewardLimit.dismiss')" [title]="t('rewardLimit.dismiss')" (click)="dismiss()">
          <app-lf-icon name="close" [size]="16"></app-lf-icon>
        </button>
      </section>
    }
  `,
  styles: `
    :host {
      display: block;
      --rl-fg: #14151a;
      --rl-muted: #596273;
      --rl-tile: #ffffff;
      --rl-line: rgba(180, 83, 9, 0.3);
      --rl-wash: rgba(180, 83, 9, 0.08);
      --rl-warn: #92400e;
      --rl-btn: #eef0f5;
      --rl-ring: #6d28d9;
      font-family: 'Plus Jakarta Sans', 'Segoe UI', system-ui, sans-serif;
    }
    :host-context(html.dark) {
      --rl-fg: #f5f7fb;
      --rl-muted: #a7b0c2;
      --rl-tile: #171a21;
      --rl-line: rgba(251, 191, 36, 0.3);
      --rl-wash: rgba(251, 191, 36, 0.08);
      --rl-warn: #fbbf24;
      --rl-btn: #1d2230;
      --rl-ring: #a78bfa;
    }
    .rl {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: 0.6rem 0.7rem;
      align-items: start;
      padding: 0.75rem 0.5rem 0.75rem 0.9rem;
      border: 1px solid var(--rl-line);
      border-radius: 1rem;
      background: linear-gradient(var(--rl-wash), var(--rl-wash)), var(--rl-tile);
      color: var(--rl-fg);
    }
    .rl__icon {
      display: inline-grid;
      place-items: center;
      width: 2rem;
      height: 2rem;
      border-radius: 999px;
      color: var(--rl-warn);
      background: var(--rl-wash);
    }
    .rl__copy { min-width: 0; }
    .rl__title { margin: 0; font-size: 0.92rem; font-weight: 750; line-height: 1.35; }
    .rl__hint { margin: 0.2rem 0 0; font-size: 0.84rem; line-height: 1.45; color: var(--rl-muted); }
    .rl__actions { display: flex; flex-wrap: wrap; gap: 0.15rem 1rem; margin-top: 0.15rem; }
    .rl__actions:empty { display: none; }
    .rl__link {
      display: inline-flex;
      align-items: center;
      min-height: 44px;
      font-size: 0.86rem;
      font-weight: 700;
      color: var(--rl-warn);
      text-decoration: underline;
      text-underline-offset: 3px;
    }
    .rl__link:focus-visible, .rl__close:focus-visible { outline: 2px solid var(--rl-ring); outline-offset: 2px; border-radius: 0.4rem; }
    .rl__close {
      display: inline-grid;
      place-items: center;
      width: 44px;
      height: 44px;
      margin: -0.45rem 0 -0.45rem 0;
      border: 0;
      border-radius: 999px;
      background: transparent;
      color: var(--rl-muted);
      cursor: pointer;
    }
    .rl__close:hover { background: var(--rl-btn); color: var(--rl-fg); }
    @media (min-width: 640px) {
      .rl { align-items: center; }
      .rl__actions { margin-top: 0; }
    }
  `
})
export class RewardLimitNoteComponent {
  private readonly language = inject(LanguageService);

  /** Rewards the channel has on Twitch right now (all apps). null = not known yet. */
  readonly count = input<number | null>(null);
  readonly channelID = input<string | null>(null);
  readonly streamer = input<string | null>(null);
  /** Adds a link to the Redemptions page (for pages other than Redemptions). */
  readonly showRewardsLink = input(false);

  readonly limit = TWITCH_REWARD_LIMIT;

  /** Bumped on dismiss so `visible` re-reads storage. */
  private readonly dismissVersion = signal(0);

  readonly visible = computed(() => {
    this.dismissVersion();
    const channelID = this.channelID();
    const count = this.count();
    if (!channelID || count === null || count < this.limit) return false;
    return !readDismissed(channelID);
  });

  readonly twitchDashboardUrl = computed(
    () => `https://dashboard.twitch.tv/u/${encodeURIComponent(this.streamer() || '')}/viewer-rewards/channel-points/rewards`,
  );

  constructor() {
    // Room again: forget the dismissal so the note returns if the channel fills up later.
    effect(() => {
      const channelID = this.channelID();
      const count = this.count();
      if (channelID && count !== null && count < this.limit) writeDismissed(channelID, false);
    });
  }

  dismiss(): void {
    const channelID = this.channelID();
    if (!channelID) return;
    writeDismissed(channelID, true);
    this.dismissVersion.update((v) => v + 1);
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.language.translate(key, params);
  }
}
