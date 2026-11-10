import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import { BotAccessService } from '../../services/bot-access.service';
import { LanguageService } from '../../services/language.service';
import { LfIconComponent } from '../lf-icon/lf-icon.component';

/**
 * Calm "this needs full access" strip for features that only work after the long Twitch
 * approval (activation). Not a warning: nothing is broken, it's the next optional step.
 * The owner gets the button; people managing someone else's channel get a plain note.
 */
@Component({
  selector: 'app-full-access-note',
  imports: [LfIconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="fa" [class.fa--compact]="compact()" [attr.aria-label]="title()">
      <span class="fa__icon" aria-hidden="true"><app-lf-icon name="lock" [size]="16"></app-lf-icon></span>
      <div class="fa__copy">
        <p class="fa__title">{{ title() }}</p>
        @if (hint()) {
          <p class="fa__hint">{{ hint() }}</p>
        }
        @if (!isOwner()) {
          <p class="fa__hint">{{ t('botAccess.fullAccess.ownerOnly') }}</p>
        }
      </div>
      @if (isOwner()) {
        <button type="button" class="fa__btn" (click)="give()">
          <app-lf-icon name="zap" [size]="15"></app-lf-icon>{{ t('botAccess.fullAccess.cta') }}
        </button>
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
      --fa-fg: #14151a;
      --fa-muted: #596273;
      --fa-tile: #ffffff;
      --fa-line: rgba(124, 58, 237, 0.22);
      --fa-wash: rgba(124, 58, 237, 0.07);
      --fa-accent: #6d28d9;
      font-family: 'Plus Jakarta Sans', 'Segoe UI', system-ui, sans-serif;
    }
    :host-context(html.dark) {
      --fa-fg: #f5f7fb;
      --fa-muted: #a7b0c2;
      --fa-tile: #171a21;
      --fa-line: rgba(167, 139, 250, 0.26);
      --fa-wash: rgba(139, 92, 246, 0.1);
      --fa-accent: #c4b5fd;
    }
    .fa {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 0.65rem 0.75rem;
      align-items: start;
      padding: 0.85rem 0.95rem;
      border: 1px dashed var(--fa-line);
      border-radius: 1rem;
      background: linear-gradient(var(--fa-wash), var(--fa-wash)), var(--fa-tile);
      color: var(--fa-fg);
    }
    .fa__icon {
      display: inline-grid;
      place-items: center;
      width: 2rem;
      height: 2rem;
      border-radius: 999px;
      color: var(--fa-accent);
      background: var(--fa-wash);
    }
    .fa__copy { min-width: 0; }
    .fa__title { margin: 0; font-size: 0.92rem; font-weight: 750; line-height: 1.35; }
    .fa__hint { margin: 0.2rem 0 0; font-size: 0.84rem; line-height: 1.45; color: var(--fa-muted); }
    .fa__btn {
      grid-column: 1 / -1;
      justify-self: start;
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      min-height: 44px;
      padding: 0.55rem 1rem;
      border: 0;
      border-radius: 999px;
      background: #7c3aed;
      color: #fff;
      font: inherit;
      font-size: 0.86rem;
      font-weight: 750;
      cursor: pointer;
    }
    .fa__btn:hover { filter: brightness(1.06); }
    .fa__btn:focus-visible { outline: 2px solid #a78bfa; outline-offset: 2px; }
    .fa--compact { padding: 0.7rem 0.8rem; }
    @media (min-width: 640px) {
      .fa { grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; }
      .fa__btn { grid-column: auto; justify-self: end; }
    }
  `
})
export class FullAccessNoteComponent {
  private readonly botAccess = inject(BotAccessService);
  private readonly language = inject(LanguageService);

  readonly title = input.required<string>();
  readonly hint = input<string>('');
  /** Channel the page shows; the button only appears for its owner. */
  readonly channelID = input<string | null>(null);
  /** Analytics label for where the click came from. */
  readonly source = input<string>('unknown');
  readonly compact = input(false);

  readonly isOwner = computed(() => {
    const channelID = this.channelID();
    return channelID ? this.botAccess.isOwnChannel(channelID) : true;
  });

  give(): void {
    this.botAccess.startFullAccess(this.source());
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.language.translate(key, params);
  }
}
