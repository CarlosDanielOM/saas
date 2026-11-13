import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { FeedItem } from '../../services/feed-api.service';
import { IconComponent } from '../icon/icon.component';
import { clockTime, dateTime, dayLabel, localDayKey, relativeTime } from '../format';
import { FEED_KIND_LABEL, FeedLine, feedFacts, feedLine } from './feed-format';

interface FeedRow {
  item: FeedItem;
  line: FeedLine;
  kind: string;
  time: string;
  fullTime: string;
}

/**
 * The activity feed as dense rows: one plain sentence per thing that happened, newest first, grouped by
 * day. Tap a row for what was said, the facts behind it and where to go next. Pages own loading, empty
 * and error states and the "load more" button; this only draws rows.
 */
@Component({
  selector: 'app-feed-list',
  templateUrl: './feed-list.component.html',
  styleUrl: './feed-list.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, RouterLink],
})
export class FeedListComponent {
  readonly items = input.required<FeedItem[]>();
  /** Hide the channel name when the whole list is one channel. */
  readonly showChannel = input(true);
  /** Day headings between rows. Off for short previews. */
  readonly groupByDay = input(true);
  /** Rows cannot be opened (short previews that link to the full feed instead). */
  readonly preview = input(false);

  private readonly opened = signal<ReadonlySet<string>>(new Set());

  readonly groups = computed(() => {
    const now = Date.now();
    const groups: Array<{ key: string; label: string; rows: FeedRow[] }> = [];
    for (const item of this.items()) {
      const key = this.groupByDay() ? localDayKey(item.at) : 'all';
      let group = groups[groups.length - 1];
      if (!group || group.key !== key) {
        group = { key, label: dayLabel(item.at, now), rows: [] };
        groups.push(group);
      }
      const recent = now - new Date(item.at).getTime() < 3_600_000;
      group.rows.push({
        item,
        line: feedLine(item),
        kind: FEED_KIND_LABEL[item.kind]?.one ?? item.kind,
        // Under a day heading the clock time reads best; the last hour reads best as "4 min ago".
        time: recent || !this.groupByDay() ? relativeTime(item.at, now) : clockTime(item.at),
        fullTime: dateTime(item.at, now),
      });
    }
    return groups;
  });

  isOpen(id: string): boolean {
    return this.opened().has(id);
  }

  onToggle(id: string, event: Event): void {
    const open = (event.target as HTMLDetailsElement).open;
    const next = new Set(this.opened());
    if (open) next.add(id);
    else next.delete(id);
    this.opened.set(next);
  }

  facts(item: FeedItem) {
    return feedFacts(item);
  }

  /** Where the full record of a row lives in the admin, when it has one. */
  refLink(item: FeedItem): { label: string; commands: unknown[]; query: Record<string, string>; merge?: boolean } | null {
    const ref = item.ref;
    if (!ref) return null;
    switch (ref.type) {
      case 'decision':
        return { label: 'Open the decision', commands: ['/ai/decisions'], query: { open: ref.id } };
      case 'event':
        // Opens the event sheet on the page the list is on (Activity or a channel's Activity tab), keeping its filters.
        return { label: 'What the bot did with it', commands: [], query: { event: ref.id }, merge: true };
      case 'usage':
        return item.channelID ? { label: "This channel's usage", commands: ['/channels', item.channelID, 'usage'], query: {} } : null;
      case 'assistant_turn':
        return { label: 'Open the conversation', commands: ['/ai/assistant'], query: { open: ref.id } };
      case 'docs_answer':
        return { label: 'Docs AI answers', commands: ['/ai/docs'], query: {} };
      default:
        return null;
    }
  }

  /** Everything the same person did, across channels. */
  actorQuery(item: FeedItem): Record<string, string> | null {
    if (item.actor?.id) return { actor: item.actor.id };
    if (item.actor?.login) return { actorLogin: item.actor.login };
    return null;
  }
}
