import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { FeedKind } from '../../services/feed-api.service';
import type { AdminOverview } from '../../services/overview-api.service';
import { FEED_KIND_LABEL } from '../../shared/feed/feed-format';
import { formatCreditValue, formatNumber, formatUSD, plural } from '../../shared/format';
import { IconComponent } from '../../shared/icon/icon.component';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';

/** The kinds the 24-hour grid shows, in this order, with how "did not go as planned" reads for each. */
const KINDS: Array<{ kind: FeedKind; problem: string; always?: boolean }> = [
  { kind: 'command', problem: "didn't answer", always: true },
  { kind: 'bot_message', problem: 'not sent' },
  { kind: 'twitch_event', problem: 'not handled', always: true },
  { kind: 'alert', problem: 'not sent' },
  { kind: 'protection', problem: "couldn't be reviewed", always: true },
  { kind: 'voice', problem: 'not spoken' },
  { kind: 'ai', problem: "didn't finish" },
  { kind: 'assistant', problem: "didn't finish" },
  { kind: 'mcp', problem: 'refused or failed' },
  { kind: 'docs', problem: 'not answered' },
];

interface DayStat {
  kind: FeedKind;
  label: string;
  icon: string;
  value: string;
  note: string | null;
  tone: 'warn' | 'danger' | 'muted' | null;
  query: Record<string, string>;
}

/** "Last 24 hours": one line of channels and money, then a number per kind that opens that slice of the feed. */
@Component({
  selector: 'app-ov-day',
  template: `
    <section class="ovd" aria-labelledby="ovd-heading" [attr.aria-busy]="!day() || null">
      <h2 class="lf-h2" id="ovd-heading"><app-icon name="pulse" />Last 24 hours</h2>
      @if (day(); as d) {
        <p class="ovd-line" data-ov-day-line>{{ line() }}</p>
        <ul class="lf-stats ovd-stats">
          @for (stat of stats(); track stat.kind) {
            <li>
              <a class="lf-stat" routerLink="/activity" [queryParams]="stat.query" [attr.data-kind]="stat.kind">
                <span class="lf-stat__label"><app-icon [name]="stat.icon" />{{ stat.label }}</span>
                <span class="lf-stat__value">{{ stat.value }}</span>
                @if (stat.note) {
                  <span
                    class="lf-stat__note"
                    [class.lf-stat__note--warn]="stat.tone === 'warn'"
                    [class.lf-stat__note--danger]="stat.tone === 'danger'"
                    >{{ stat.note }}</span
                  >
                }
              </a>
            </li>
          }
        </ul>
      } @else {
        <app-skeleton width="80%" height="0.95rem" />
        <div class="lf-stats ovd-stats">
          @for (item of [1, 2, 3, 4, 5, 6]; track item) {
            <app-skeleton height="4.25rem" />
          }
        </div>
      }
    </section>
  `,
  styleUrl: './ov-day.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent, SkeletonComponent],
})
export class OvDayComponent {
  /** Null while loading. */
  readonly day = input<AdminOverview['day'] | null>(null);

  readonly line = computed(() => {
    const day = this.day();
    if (!day) return '';
    const credits = day.credits > 0 ? `${formatNumber(day.credits)} credits used (${formatCreditValue(day.credits)})` : 'no credits used';
    return `${plural(day.activeChannels, 'channel')} active · ${credits} · ${formatUSD(day.providerUSD)} paid to AI providers`;
  });

  readonly stats = computed<DayStat[]>(() => {
    const day = this.day();
    if (!day) return [];
    const counts = new Map(day.kinds.map((count) => [count.kind, count]));
    const stats: DayStat[] = [];
    for (const { kind, problem, always } of KINDS) {
      const count = counts.get(kind) ?? { kind, total: 0, problems: 0, failed: 0 };
      if (!count.total && !always) continue;
      const label = FEED_KIND_LABEL[kind];
      const query: Record<string, string> = { kinds: kind, range: '24h' };
      let note: string | null = null;
      let tone: DayStat['tone'] = null;
      if (!count.total) {
        note = 'None yet';
        tone = 'muted';
      } else if (count.problems > 0) {
        // When every problem is a failure say so plainly; otherwise name what the owner would notice.
        const allFailed = count.failed >= count.problems;
        note = `${formatNumber(count.problems)} ${allFailed ? 'failed' : problem}`;
        tone = allFailed ? 'danger' : 'warn';
        query['outcome'] = 'problems';
      }
      stats.push({ kind, label: label.many, icon: label.icon, value: formatNumber(count.total), note, tone, query });
    }
    return stats;
  });
}
