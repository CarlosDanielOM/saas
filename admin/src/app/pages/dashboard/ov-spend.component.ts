import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { AdminOverview, SpendFeature } from '../../services/overview-api.service';
import { creditsToUSD, formatCreditValue, formatCredits, formatNumber, formatUSD } from '../../shared/format';
import { IconComponent } from '../../shared/icon/icon.component';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';

const FEATURE: Record<SpendFeature, { name: string; one: string; many: string; link: string; category?: string }> = {
  voice: { name: 'Voice', one: 'request', many: 'requests', link: '/ai/usage', category: 'tts' },
  ai_chat: { name: 'Chat AI replies', one: 'request', many: 'requests', link: '/ai/usage', category: 'ai_chat' },
  memory: { name: 'Stream memory', one: 'request', many: 'requests', link: '/ai/usage', category: 'memory' },
  protection: { name: 'Chat protection', one: 'review', many: 'reviews', link: '/ai/decisions' },
  assistant: { name: 'Dima assistant', one: 'message', many: 'messages', link: '/ai/assistant' },
  docs: { name: 'Docs AI', one: 'question', many: 'questions', link: '/ai/docs' },
  other: { name: 'Other', one: 'request', many: 'requests', link: '/ai/usage', category: 'other' },
};

/** "AI spend, last 7 days": one row per feature with what channels were charged and what providers charged us. */
@Component({
  selector: 'app-ov-spend',
  template: `
    <section class="lf-tile lf-tile--flush" aria-labelledby="ovs-heading" [attr.aria-busy]="!features() || null">
      <div class="lf-tile__head">
        <h2 class="lf-h2" id="ovs-heading"><app-icon name="dollar" />AI spend, last 7 days</h2>
        <a class="ovs-all" routerLink="/ai">All AI<app-icon name="chevron" /></a>
      </div>
      @if (!features()) {
        <div class="ovs-skel">
          @for (item of [1, 2, 3, 4]; track item) {
            <app-skeleton height="2.9rem" />
          }
        </div>
      } @else if (rows().length) {
        <ul class="lf-bars">
          @for (row of rows(); track row.feature) {
            <li>
              <a class="lf-bars__row" [routerLink]="row.link" [queryParams]="row.query" [attr.data-feature]="row.feature">
                <span class="lf-bars__name"
                  >{{ row.name }}
                  <small
                    >{{ row.count }}
                    @if (row.failed) {
                      · <span class="ovs-failed">{{ row.failed }}</span>
                    }
                  </small>
                  <small data-provider>Provider cost: {{ row.provider }}</small>
                </span>
                <span class="lf-bars__value">{{ row.credits }}<small>{{ row.creditValue }}</small></span>
                <span class="lf-bar" aria-hidden="true"><span [style.width.%]="row.share"></span></span>
              </a>
            </li>
          }
        </ul>
        <p class="ovs-total" data-spend-total>{{ total() }}</p>
      } @else {
        <p class="lf-empty ovs-empty"><span>No AI was used in the last 7 days.</span></p>
      }
    </section>
  `,
  styleUrl: './ov-spend.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent, SkeletonComponent],
})
export class OvSpendComponent {
  /** Null while loading. */
  readonly features = input<AdminOverview['features'] | null>(null);

  readonly rows = computed(() => {
    const features = (this.features() ?? []).filter((row) => row.count > 0 || row.credits > 0 || (row.providerUSD ?? 0) > 0);
    // A feature's weight is what it was worth in money: the credits charged plus what the provider charged us.
    const worth = (row: AdminOverview['features'][number]) => creditsToUSD(row.credits) + (row.providerUSD ?? 0);
    const sum = features.reduce((total, row) => total + worth(row), 0);
    return [...features]
      .sort((a, b) => worth(b) - worth(a))
      .map((row) => {
        const meta = FEATURE[row.feature] ?? FEATURE.other;
        return {
          feature: row.feature,
          name: meta.name,
          link: meta.link,
          query: meta.category ? { category: meta.category, range: '7d' } : null,
          count: `${formatNumber(row.count)} ${row.count === 1 ? meta.one : meta.many}`,
          failed: row.failed > 0 ? `${formatNumber(row.failed)} failed` : null,
          credits: row.credits > 0 ? formatCredits(row.credits) : 'No credits',
          creditValue: row.credits > 0 ? formatCreditValue(row.credits) : 'free to streamers',
          provider: row.providerUSD === null ? 'not recorded' : formatUSD(row.providerUSD),
          share: sum > 0 ? Math.max(0.5, (worth(row) / sum) * 100) : 0,
        };
      });
  });

  readonly total = computed(() => {
    const features = this.features() ?? [];
    const credits = features.reduce((sum, row) => sum + row.credits, 0);
    const recorded = features.filter((row) => row.providerUSD !== null);
    const provider = recorded.reduce((sum, row) => sum + (row.providerUSD ?? 0), 0);
    const partial = recorded.length < features.length ? ' where recorded' : '';
    return `In all: ${formatCredits(credits)} charged (${formatCreditValue(credits)}) · ${formatUSD(provider)} provider cost${partial}`;
  });
}
