import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';

import { LpCopy } from './lp-copy';
import { LpLive } from './lp-live.service';

/** Real channels live with the bot right now. Renders nothing when nobody is live. */
@Component({
  selector: 'app-lp-live-strip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./lp-ui.css'],
  styles: `
    .strip { display: grid; gap: 0.6rem; }
    .strip__head { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem 0.75rem; }
    .strip__head p { margin: 0; font-weight: 750; font-size: 0.92rem; }
    .strip__head span { color: var(--muted); font-size: 0.84rem; }
    .strip ul { display: flex; gap: 0.5rem; margin: 0; padding: 0 0 2px; list-style: none; overflow-x: auto; scrollbar-width: none; }
    .strip li {
      display: flex; align-items: center; gap: 0.5rem; flex: 0 0 auto; padding: 0.35rem 0.8rem 0.35rem 0.35rem;
      border-radius: 999px; background: var(--btn); font-size: 0.84rem;
    }
    .strip li strong { font-weight: 750; }
    .strip li small { color: var(--muted); font-size: 0.78rem; }
    .lp-avatar { box-shadow: 0 0 0 2px var(--live); }
    .plain { padding: 0; background: none; border: 0; box-shadow: none; }
  `,
  template: `
    @if (live.channels().length > 0) {
      <section class="lp-tile strip" [class.plain]="plain()" [attr.aria-label]="c.t('common.liveNow')">
        <div class="strip__head">
          <span class="lp-dot" aria-hidden="true"></span>
          <p>{{ c.t('common.liveNow') }}</p>
          <span>{{ c.t('common.liveCount', { channels: live.channels().length, viewers: c.number(live.viewers()) }) }}</span>
        </div>
        <ul>
          @for (ch of live.channels().slice(0, 8); track ch.channelID) {
            <li>
              <span class="lp-avatar">
                @if (ch.profileImageUrl) {
                  <img [src]="ch.profileImageUrl" alt="" width="32" height="32" loading="lazy" />
                } @else {
                  {{ ch.channel.charAt(0).toUpperCase() }}
                }
              </span>
              <strong>{{ ch.channel }}</strong>
              <small>{{ c.t('common.viewers', { n: c.number(ch.viewers) }) }}</small>
            </li>
          }
        </ul>
      </section>
    }
  `
})
export class LpLiveStripComponent {
  readonly plain = input(false);
  readonly c = inject(LpCopy);
  readonly live = inject(LpLive);
}
