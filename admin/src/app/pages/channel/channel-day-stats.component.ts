import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { FEED_KINDS, type FeedKind, type FeedKindCount } from '../../services/feed-api.service';
import { FEED_KIND_LABEL } from '../../shared/feed/feed-format';
import { formatNumber } from '../../shared/format';
import { IconComponent } from '../../shared/icon/icon.component';
import { ChannelWorkspaceService } from './channel-workspace.service';

/** What a problem row of each kind means, as a count: "96 didn't answer". */
const PROBLEM: Partial<Record<FeedKind, string>> = {
  command: "didn't answer",
  bot_message: 'not sent',
  alert: 'not sent',
  twitch_event: 'not handled',
  protection: "couldn't be reviewed",
  voice: 'not spoken',
  assistant: 'not answered',
  docs: 'not answered',
};

interface DayStat {
  kind: FeedKind;
  label: string;
  icon: string;
  value: string;
  note: string;
  tone: 'muted' | 'warn' | 'danger';
}

/** Overview's "Last 24 hours": the channel's feed summary as shortcuts into the Activity tab. */
@Component({
  selector: 'app-channel-day-stats',
  template: `
    <section class="day" aria-labelledby="day-title">
      <div class="day__head">
        <h2 class="lf-h2" id="day-title"><app-icon name="pulse" />Last 24 hours</h2>
        <a class="lf-btn lf-btn--sm lf-btn--ghost" [routerLink]="['/channels', ws.channelID(), 'activity']" [queryParams]="{ range: '24h' }"
          >All activity<app-icon name="chevron"
        /></a>
      </div>
      @if (ws.summaryError() && !ws.summary()) {
        <div class="lf-notice" role="alert">
          <span>{{ ws.summaryError() }}.</span>
          <button type="button" class="lf-btn lf-btn--sm" (click)="ws.loadSummary()"><app-icon name="refresh" />Retry</button>
        </div>
      } @else if (!ws.summary()) {
        <div class="lf-stats" role="status" aria-busy="true" aria-label="Loading the last 24 hours">
          @for (i of [1, 2, 3, 4]; track i) {
            <div class="lf-stat day__skel"></div>
          }
        </div>
      } @else {
        @if (stats().length) {
          <div class="lf-stats">
            @for (stat of stats(); track stat.kind) {
              <a class="lf-stat" [routerLink]="['/channels', ws.channelID(), 'activity']" [queryParams]="{ kinds: stat.kind, range: '24h' }" [attr.data-kind]="stat.kind">
                <span class="lf-stat__label"><app-icon [name]="stat.icon" />{{ stat.label }}</span>
                <span class="lf-stat__value">{{ stat.value }}</span>
                <span class="lf-stat__note" [class.lf-stat__note--warn]="stat.tone === 'warn'" [class.lf-stat__note--danger]="stat.tone === 'danger'">{{ stat.note }}</span>
              </a>
            }
          </div>
        } @else {
          <p class="lf-note">Nothing recorded for this channel in the last 24 hours.</p>
        }
        @if (partial()) {
          <p class="lf-notice" role="status">{{ partial() }}</p>
        }
      }
    </section>
  `,
  styles: `
    .day { display: grid; gap: 0.6rem; }
    .day__head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
    .day__head .lf-btn { margin-right: -0.4rem; }
    .day__skel { background: var(--btn); border-style: dashed; }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
})
export class ChannelDayStatsComponent {
  readonly ws = inject(ChannelWorkspaceService);

  readonly stats = computed<DayStat[]>(() => {
    const byKind = new Map<FeedKind, FeedKindCount>((this.ws.summary()?.kinds ?? []).map((row) => [row.kind, row]));
    return FEED_KINDS.flatMap((kind) => {
      const row = byKind.get(kind);
      if (!row || row.total <= 0) return [];
      return [{ kind, label: FEED_KIND_LABEL[kind].many, icon: FEED_KIND_LABEL[kind].icon, value: formatNumber(row.total), ...this.note(row) }];
    });
  });

  readonly partial = computed(() => {
    const missing = this.ws.summary()?.partial ?? [];
    if (!missing.length) return null;
    const names = missing.map((kind) => FEED_KIND_LABEL[kind]?.many.toLowerCase() ?? kind).join(', ');
    return `Couldn't count ${names} in time, so ${missing.length === 1 ? 'it is' : 'they are'} missing above.`;
  });

  private note(row: FeedKindCount): Pick<DayStat, 'note' | 'tone'> {
    if (row.problems <= 0) return { note: 'No problems', tone: 'muted' };
    const phrase = PROBLEM[row.kind];
    if (!phrase || row.failed >= row.problems) {
      return row.failed > 0
        ? { note: `${formatNumber(row.failed)} failed`, tone: 'danger' }
        : { note: `${formatNumber(row.problems)} had problems`, tone: 'warn' };
    }
    const failed = row.failed > 0 ? ` (${formatNumber(row.failed)} failed)` : '';
    return { note: `${formatNumber(row.problems)} ${phrase}${failed}`, tone: row.failed > 0 ? 'danger' : 'warn' };
  }
}
