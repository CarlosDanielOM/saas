import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';

import { GiftsApiService, type GiftFilter, type GiftList, type GiftQuery, type GiftRow } from '../../services/gifts-api.service';
import { ChannelPickerComponent, type PickedChannel } from '../../shared/channel-picker/channel-picker.component';
import { formatNumber, plural } from '../../shared/format';
import { IconComponent } from '../../shared/icon/icon.component';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';
import { GiftSheetComponent } from './gift-sheet.component';
import { FILTERS, type Tone, giftChips, giftMeta, giftState, isFilter } from './gifts-format';

const PAGE_SIZE = 25;
const GIFT_ID = /^[a-f0-9]{64}$/;
/** A Twitch channel id, or a login (the API takes either). */
const CHANNEL = /^(\d{1,20}|[a-z0-9_]{1,25})$/;

interface Change {
  status?: GiftFilter;
  channel?: string | null;
}

interface Answer {
  tone: Tone;
  icon: string;
  title: string;
  text: string;
  /** A chip worth jumping to from the answer. */
  show: { filter: GiftFilter; label: string } | null;
}

/**
 * `/gifts`: credit packs people bought for another channel. Answers "did everyone who paid get their credits?",
 * worst first, then lists every gift with its stage. A gift opens in a sheet (`?gift=`) with each stage, the
 * Polar references and "Try again now" for a paid gift that hasn't arrived. Filters live in the URL.
 */
@Component({
  selector: 'app-gifts-page',
  templateUrl: './gifts-page.component.html',
  styleUrl: './gifts-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent, SkeletonComponent, ChannelPickerComponent, GiftSheetComponent],
})
export class GiftsPageComponent implements OnInit, OnDestroy {
  private readonly api = inject(GiftsApiService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly channelSheet = viewChild<ElementRef<HTMLDialogElement>>('channelSheet');
  private readonly subscriptions = new Subscription();
  private request?: Subscription;
  private listKey = '';
  /** The filters the rows on screen belong to. */
  private shownKey = '';

  readonly filters = FILTERS;

  readonly status = signal<GiftFilter>('all');
  readonly channel = signal<string | null>(null);
  /** The gift open in the sheet (`?gift=`). */
  readonly open = signal<string | null>(null);

  readonly rows = signal<GiftRow[]>([]);
  readonly next = signal<string | null>(null);
  readonly counts = signal<GiftList['counts'] | null>(null);
  readonly loading = signal(true);
  readonly failed = signal(false);
  readonly more = signal(false);
  readonly moreFailed = signal(false);
  /** Logins learnt from rows and the picker, so the channel chip never shows a bare id. */
  private readonly names = signal<ReadonlyMap<string, string>>(new Map());

  readonly heading = computed(() => (this.status() === 'all' ? 'Every gift' : (FILTERS.find((item) => item.key === this.status())?.label ?? 'Gifts')));
  readonly openRow = computed(() => this.rows().find((row) => row.id === this.open()) ?? null);
  readonly channelName = computed(() => {
    const channel = this.channel();
    if (!channel) return null;
    return /^\d+$/.test(channel) ? (this.names().get(channel) ?? 'this channel') : channel;
  });

  /** One line per row, worked out once per list. */
  readonly items = computed(() =>
    this.rows().map((row) => {
      const state = giftState(row);
      return { row, chips: giftChips(state), meta: giftMeta(row, state) };
    }),
  );

  /** The page's answer, worst first: paid and stuck, then on the way, then all good. */
  readonly answer = computed<Answer | null>(() => {
    const counts = this.counts();
    if (!counts) return null;
    const status = this.status();
    const scope = this.channelName();
    if (counts.needs_support > 0) {
      const n = counts.needs_support;
      return {
        tone: 'danger',
        icon: 'alert',
        title: n === 1 ? "1 paid gift didn't arrive" : `${formatNumber(n)} paid gifts didn't arrive`,
        text: 'Someone paid and the credits never reached the streamer. Open one to see where it stopped.',
        show: status === 'needs_support' ? null : { filter: 'needs_support', label: n === 1 ? 'Show it' : `Show the ${formatNumber(n)}` },
      };
    }
    const parts: string[] = [];
    if (counts.delivered) parts.push(`${formatNumber(counts.delivered)} delivered`);
    if (counts.expired) parts.push(`${formatNumber(counts.expired)} never paid (the checkout expired)`);
    if (counts.awaiting_payment) parts.push(`${formatNumber(counts.awaiting_payment)} waiting for payment`);
    const breakdown = parts.join(' · ');
    if (counts.in_progress > 0) {
      const n = counts.in_progress;
      return {
        tone: 'accent',
        icon: 'gift',
        title: n === 1 ? '1 gift is on its way' : `${formatNumber(n)} gifts are on their way`,
        text: `Paid; the bot is delivering the credits.${breakdown ? ` Also ${breakdown}.` : ''}`,
        show: status === 'in_progress' ? null : { filter: 'in_progress', label: n === 1 ? 'Show it' : 'Show them' },
      };
    }
    if (counts.delivered > 0) {
      return { tone: 'ok', icon: 'ok', title: 'Every paid gift was delivered', text: breakdown, show: null };
    }
    if (counts.all > 0) {
      // Open or unconfirmed checkouts may still turn out paid: only "nothing is owed" once every one expired.
      return counts.awaiting_payment
        ? { tone: 'muted', icon: 'info', title: 'No payment received yet', text: `${breakdown}.`, show: null }
        : { tone: 'muted', icon: 'info', title: 'No gift was paid', text: `${breakdown}. Nothing is owed.`, show: null };
    }
    return scope
      ? { tone: 'muted', icon: 'gift', title: `${scope} hasn't sent or received a gift`, text: 'Gifts this channel buys for others, or gets from others, show up here.', show: null }
      : { tone: 'muted', icon: 'gift', title: 'No gifted credits yet', text: 'When someone buys a credit pack for another channel, it shows up here.', show: null };
  });

  ngOnInit(): void {
    this.subscriptions.add(
      this.route.queryParamMap.subscribe((params) => {
        const status = params.get('status');
        this.status.set(isFilter(status) ? status : 'all');
        const channel = (params.get('channel') || '').trim().replace(/^@/, '').toLowerCase();
        this.channel.set(CHANNEL.test(channel) ? channel : null);
        const gift = params.get('gift');
        this.open.set(gift && GIFT_ID.test(gift) ? gift : null);
        this.load();
      }),
    );
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
    this.request?.unsubscribe();
  }

  /** Loads the list when its filters changed (opening a gift doesn't); `force` reloads (Refresh, Retry). */
  load(force = false): void {
    const key = `${this.status()}|${this.channel()}`;
    if (!force && key === this.listKey && !this.failed()) return;
    this.listKey = key;
    this.fetch(null);
  }

  loadMore(): void {
    const cursor = this.next();
    if (cursor && !this.loading()) this.fetch(cursor);
  }

  private fetch(cursor: string | null): void {
    this.request?.unsubscribe();
    this.loading.set(true);
    this.more.set(Boolean(cursor));
    if (cursor) this.moreFailed.set(false);
    else this.failed.set(false);
    const query: GiftQuery = { channel: this.channel() ?? undefined, limit: PAGE_SIZE };
    if (this.status() !== 'all') query.status = this.status();
    if (cursor) query.cursor = cursor;
    const key = this.listKey;
    this.request = this.api.list(query).subscribe({
      next: ({ data }) => {
        if (cursor) {
          const seen = new Set(this.rows().map((row) => row.id));
          this.rows.update((rows) => [...rows, ...data.rows.filter((row) => !seen.has(row.id))]);
        } else this.rows.set(data.rows);
        this.next.set(data.next);
        this.counts.set(data.counts);
        this.shownKey = key;
        this.remember(data.rows);
        this.loading.set(false);
        this.more.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.more.set(false);
        if (cursor) this.moreFailed.set(true);
        else {
          this.failed.set(true);
          // Rows and counts from other filters would answer the wrong question: drop them.
          if (this.shownKey !== key) {
            this.rows.set([]);
            this.next.set(null);
            this.counts.set(null);
          }
        }
      },
    });
  }

  private remember(rows: GiftRow[]): void {
    const names = new Map(this.names());
    for (const row of rows) {
      names.set(row.recipient.channelID, row.recipient.login);
      if (row.buyer.channelID) names.set(row.buyer.channelID, row.buyer.login);
    }
    this.names.set(names);
  }

  /** Filters change the URL (so Back restores them) and close any open gift. */
  go(change: Change): void {
    const status = change.status ?? this.status();
    const channel = change.channel !== undefined ? change.channel : this.channel();
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { status: status === 'all' ? null : status, channel: channel || null },
    });
  }

  pick(filter: GiftFilter): void {
    this.go({ status: this.status() === filter && filter !== 'all' ? 'all' : filter });
  }

  /** Opening keeps the filters; only `gift` changes. */
  openGift(row: GiftRow): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: { gift: row.id }, queryParamsHandling: 'merge' });
  }

  closeGift(): void {
    if (this.open()) void this.router.navigate([], { relativeTo: this.route, queryParams: { gift: null }, queryParamsHandling: 'merge' });
  }

  /** A fresher copy from the sheet (after a retry or reload) replaces the row on screen. */
  changed(gift: GiftRow): void {
    if (this.rows().some((row) => row.id === gift.id)) this.rows.update((rows) => rows.map((row) => (row.id === gift.id ? gift : row)));
    this.remember([gift]);
  }

  openChannels(): void {
    this.channelSheet()?.nativeElement.showModal();
  }

  closeChannels(): void {
    this.channelSheet()?.nativeElement.close();
  }

  picked(channel: PickedChannel): void {
    const names = new Map(this.names());
    names.set(channel.channelID, channel.channel);
    this.names.set(names);
    this.closeChannels();
    this.go({ channel: channel.channelID });
  }

  channelBackdrop(event: MouseEvent): void {
    if (event.target === this.channelSheet()?.nativeElement) this.closeChannels();
  }

  readonly plural = plural;
  readonly count = (filter: GiftFilter) => this.counts()?.[filter] ?? null;
}
