import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { AssistantSummary } from '../../services/assistants-api.service';
import { IconComponent } from '../../shared/icon/icon.component';
import { formatDuration, formatNumber, formatShare, formatUSD, plural, relativeTime } from '../../shared/format';
import { errorLabel, modelName, toolLabel } from './assistants-format';

/** Rows shown before a block folds the rest into "Show all". */
const FOLD = 5;
/** A channel "near its limit" has used this share of today's daily messages. */
export const NEAR_LIMIT = 0.8;

/**
 * The Dima assistant breakdowns as dense rows: levels and models, channels (tap to filter the list), today's
 * daily limit, tools, errors, ratings. Every block hides itself when it has nothing to say.
 */
@Component({
  selector: 'app-assistant-blocks',
  templateUrl: './assistant-blocks.component.html',
  styleUrl: './assistant-blocks.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
})
export class AssistantBlocksComponent {
  readonly summary = input.required<AssistantSummary>();
  /** The channel the page is filtered to. */
  readonly channel = input<string | null>(null);
  readonly pick = output<string | null>();

  readonly fold = FOLD;
  /** Blocks the owner unfolded ("Show all"). */
  readonly unfolded = signal<ReadonlySet<string>>(new Set());

  shown<T>(block: string, rows: T[]): T[] {
    return this.unfolded().has(block) ? rows : rows.slice(0, FOLD);
  }

  unfold(block: string): void {
    this.unfolded.set(new Set([...this.unfolded(), block]));
  }

  readonly levels = computed(() => {
    const rows = this.summary().byLevel;
    const max = Math.max(1, ...rows.map((row) => row.turns));
    return [...rows]
      .sort((a, b) => (a.level === 'standard' ? -1 : 1) - (b.level === 'standard' ? -1 : 1))
      .map((row) => ({ ...row, name: row.level === 'expert' ? 'Expert' : 'Standard', share: (row.turns / max) * 100 }));
  });
  readonly models = computed(() => {
    const rows = this.summary().byModel;
    const max = Math.max(1, ...rows.map((row) => row.turns));
    return rows.map((row) => ({ ...row, name: modelName(row.model), share: (row.turns / max) * 100 }));
  });
  readonly channels = computed(() => this.summary().byChannel);
  readonly limits = computed(() => this.summary().limitsToday.map((row) => ({ ...row, share: row.limit ? Math.min(100, (row.used / row.limit) * 100) : 0 })));
  readonly nearLimit = computed(() => this.limits().filter((row) => row.limit > 0 && row.used / row.limit >= NEAR_LIMIT));
  readonly busiest = computed(() => this.limits()[0] ?? null);
  readonly tools = computed(() => {
    const rows = [...this.summary().byTool].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
    const max = Math.max(1, ...rows.map((row) => row.calls));
    return rows.map((row) => ({ ...row, label: toolLabel(row.name), share: (row.calls / max) * 100 }));
  });
  readonly errors = computed(() => this.summary().errors.map((row) => ({ ...row, label: errorLabel(row.code) })));
  readonly ratings = computed(() => {
    const { helpful, unhelpful } = this.summary().totals;
    return helpful + unhelpful > 0 ? { helpful, unhelpful, total: helpful + unhelpful } : null;
  });

  planLabel(plan: string): string {
    return plan === 'pro' ? 'Pro' : plan === 'premium' ? 'Premium' : 'Free';
  }

  readonly formatDuration = formatDuration;
  readonly formatNumber = formatNumber;
  readonly formatShare = formatShare;
  readonly formatUSD = formatUSD;
  readonly plural = plural;
  readonly relativeTime = relativeTime;
}
