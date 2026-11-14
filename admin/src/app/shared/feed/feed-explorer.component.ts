import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { NgTemplateOutlet } from '@angular/common';
import { ActivatedRoute, ParamMap, Router, RouterLink } from '@angular/router';
import { Subscription, combineLatest } from 'rxjs';

import { AdminApiService } from '../../services/admin-api.service';
import { apiErrorMessage } from '../../services/api-util';
import { FEED_KINDS, FeedApiService, FeedItem, FeedKind, FeedQuery, FeedSummary } from '../../services/feed-api.service';
import { ChannelPickerComponent, PickedChannel } from '../channel-picker/channel-picker.component';
import { RANGES, RangeKey, dateTime, formatNumber, hoursAgo, isRangeKey, plural, rangeHours } from '../format';
import { IconComponent } from '../icon/icon.component';
import { SkeletonComponent } from '../skeleton/skeleton.component';
import { EventDetailComponent } from './event-detail.component';
import { FEED_KIND_LABEL } from './feed-format';
import { FeedListComponent } from './feed-list.component';

type Outcome = 'problems' | 'failed';
interface Filters {
  range: RangeKey;
  kinds: FeedKind[];
  outcome: Outcome | null;
  channel: string | null;
  actor: string | null;
  actorLogin: string | null;
}
interface Draft {
  channel: PickedChannel | null;
  actor: string | null;
  viewer: string;
  outcome: Outcome | null;
}

const PAGE_SIZE = 40;
const LIVE_EVERY_MS = 15_000;
const ID = /^\d{1,20}$/;
const LOGIN = /^[a-z0-9_]{1,25}$/;
const DEFAULTS: Filters = { range: '24h', kinds: [], outcome: null, channel: null, actor: null, actorLogin: null };
const SPAN: Record<RangeKey, string> = { '1h': 'the last hour', '24h': 'the last 24 hours', '7d': 'the last 7 days', '30d': 'the last 30 days' };
/** Kinds recorded only since the console shipped: older ranges have none, which is not "nothing ran". */
const RECENT_KINDS: FeedKind[] = ['command', 'bot_message'];

/** "mossy_fern" from "@Mossy_Fern "; null when it cannot be a Twitch login. */
export function cleanLogin(value: string | null | undefined): string | null {
  const login = (value ?? '').trim().replace(/^@/, '').toLowerCase();
  return LOGIN.test(login) ? login : null;
}
/** "commands and chat alerts" from kind labels, keeping "AI" capitalised. */
function listKinds(kinds: FeedKind[]): string {
  const names = kinds.map((kind) => {
    const label = FEED_KIND_LABEL[kind].many;
    return /^[A-Z][a-z]/.test(label) ? label[0].toLowerCase() + label.slice(1) : label;
  });
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * The activity feed with its filters: the answer line, range, kind chips, a Filters sheet (streamer, viewer,
 * problems), the rows, "Load more", a Live mode and the Twitch event sheet. Every filter lives in the URL.
 * Used by `/activity` (with `pageHeader`) and by a channel's Activity tab (with a fixed `channelID`).
 */
@Component({
  selector: 'app-feed-explorer',
  templateUrl: './feed-explorer.component.html',
  styleUrl: './feed-explorer.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChannelPickerComponent, EventDetailComponent, FeedListComponent, IconComponent, NgTemplateOutlet, RouterLink, SkeletonComponent],
  host: { '[style.--feed-sticky-top]': 'stickyTop()' },
})
export class FeedExplorerComponent {
  private readonly api = inject(FeedApiService);
  private readonly users = inject(AdminApiService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly sheet = viewChild<ElementRef<HTMLDialogElement>>('sheet');
  private readonly bar = viewChild<ElementRef<HTMLElement>>('bar');
  private readonly listTile = viewChild<ElementRef<HTMLElement>>('listTile');

  /** A channel the feed is fixed to (the channel workspace): no streamer filter, no channel names in rows. */
  readonly channelID = input<string | null>(null);
  /** Draw the page header with the `h1` (the Activity page). Without it, the feed starts at the answer line. */
  readonly pageHeader = input(false);

  readonly ranges = RANGES;
  readonly filters = signal<Filters>(DEFAULTS);
  readonly eventKey = signal<string | null>(null);

  readonly items = signal<FeedItem[]>([]);
  readonly nextCursor = signal<string | null>(null);
  readonly listPartial = signal<FeedKind[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly loadingMore = signal(false);
  readonly moreFailed = signal(false);
  /** Pages on screen: live rows go straight in only while this is 1. */
  private readonly pages = signal(1);
  /** Start of the range the rows on screen were read with (ms). */
  private readonly listFrom = signal(0);

  readonly summary = signal<FeedSummary | null>(null);
  readonly summaryFailed = signal(false);

  readonly live = signal(false);
  /** New rows that arrived while inserting them would move the list under the reader's finger. */
  readonly pending = signal<FeedItem[]>([]);
  readonly announce = signal('');

  readonly sheetOpen = signal(false);
  readonly draft = signal<Draft>({ channel: null, actor: null, viewer: '', outcome: null });
  readonly draftTried = signal(false);

  private readonly channelNames = signal<Record<string, string>>({});
  private readonly actorNames = signal<Record<string, string>>({});
  readonly stickyTop = signal<string | null>(null);

  private listKey = '';
  private summaryKey = '';
  private readonly lookedUp = new Set<string>();
  private listRequest?: Subscription;
  private moreRequest?: Subscription;
  private summaryRequest?: Subscription;
  private liveRequest?: Subscription;
  private readonly subscriptions = new Subscription();

  /** The streamer the rows are narrowed to: the fixed channel or the picked one. */
  readonly channel = computed(() => this.channelID() ?? this.filters().channel);
  readonly channelName = computed(() => {
    const id = this.filters().channel;
    return id ? (this.channelNames()[id] ?? null) : null;
  });
  readonly hasViewer = computed(() => !!(this.filters().actor || this.filters().actorLogin));
  readonly viewerName = computed(() => {
    const { actor, actorLogin } = this.filters();
    if (actor) return this.actorNames()[actor] ?? null;
    return actorLogin ? (this.actorNames()['login:' + actorLogin] ?? actorLogin) : null;
  });
  readonly sheetCount = computed(() => {
    const f = this.filters();
    return (f.channel && !this.channelID() ? 1 : 0) + (this.hasViewer() ? 1 : 0) + (f.outcome ? 1 : 0);
  });
  readonly span = computed(() => SPAN[this.filters().range]);
  readonly widerRange = computed(() => {
    const index = RANGES.findIndex((range) => range.key === this.filters().range);
    const key = index >= 0 && index < RANGES.length - 1 ? RANGES[index + 1].key : null;
    return key ? { key, span: SPAN[key] } : null;
  });
  readonly outcomeOptions: Array<{ value: Outcome | null; title: string; copy: string }> = [
    { value: null, title: 'Everything', copy: 'Every row, however it went.' },
    { value: 'problems', title: 'Something went wrong', copy: "Failed, or refused by Twitch. Turned off, cooldowns and other skips on purpose aren't problems." },
    { value: 'failed', title: 'Failed only', copy: "It should have happened and didn't." },
  ];
  readonly pendingLabel = computed(() => `${formatNumber(this.pending().length)} new, tap to show`);
  /** Anything narrowed beyond the range (kinds, problems, streamer, viewer). */
  readonly narrowed = computed(() => {
    const f = this.filters();
    return !!(f.kinds.length || f.outcome || (f.channel && !this.channelID()) || f.actor || f.actorLogin);
  });

  readonly heading = computed(() => {
    const channel = this.filters().channel ? (this.channelName() ?? 'One streamer') : null;
    const viewer = this.hasViewer() ? (this.viewerName() ?? 'this viewer') : null;
    if (viewer && channel) return { kicker: 'Activity', title: `${viewer} in ${channel}`, sub: 'What this viewer did or caused in this channel, newest first.' };
    if (viewer) return { kicker: 'Activity', title: `Everything from ${viewer}`, sub: 'What this viewer did or caused, in every channel, newest first.' };
    if (channel) return { kicker: 'Activity', title: `${channel} only`, sub: 'Everything that happened in this channel, newest first.' };
    return { kicker: null, title: 'Activity', sub: 'Everything the bot did and heard, newest first. Tap a row to see why.' };
  });

  /** Counts for the kinds in view (all kinds when none is picked). */
  private readonly totals = computed(() => {
    const summary = this.summary();
    if (!summary) return null;
    const picked = this.filters().kinds;
    const rows = picked.length ? summary.kinds.filter((row) => picked.includes(row.kind)) : summary.kinds;
    return rows.reduce((sum, row) => ({ total: sum.total + row.total, problems: sum.problems + row.problems, failed: sum.failed + row.failed }), { total: 0, problems: 0, failed: 0 });
  });

  readonly answer = computed(() => {
    const totals = this.totals();
    if (!totals) return null;
    const span = this.span();
    const picked = this.filters().kinds;
    const note = picked.length ? `Counting ${listKinds(picked)} only.` : null;
    if (!totals.total) {
      return { tone: 'muted', icon: 'info', title: `Nothing was recorded in ${span}.`, note, problems: 0 };
    }
    const head = `${formatNumber(totals.total)} ${totals.total === 1 ? 'thing' : 'things'} happened in ${span}.`;
    if (!totals.problems) return { tone: 'ok', icon: 'ok', title: `${head} All went as planned.`, note, problems: 0 };
    const failed = totals.failed ? ` (${formatNumber(totals.failed)} failed)` : '';
    return { tone: 'warn', icon: 'alert', title: `${head} ${formatNumber(totals.problems)} didn't go as planned${failed}.`, note, problems: totals.problems };
  });

  readonly problemCount = computed(() => {
    const totals = this.totals();
    if (!totals) return null;
    return formatNumber(this.filters().outcome === 'failed' ? totals.failed : totals.problems);
  });

  readonly kindChips = computed(() => {
    const { kinds: picked, outcome } = this.filters();
    const summary = this.summary();
    const byKind = new Map(summary?.kinds.map((row) => [row.kind, row]) ?? []);
    return FEED_KINDS.filter((kind) => {
      if (picked.includes(kind)) return true;
      if (summary) return (byKind.get(kind)?.total ?? 0) > 0;
      // Counts not here yet: show every kind after a failed count, only the picked ones while loading.
      return this.summaryFailed();
    }).map((kind) => {
      const row = byKind.get(kind);
      const count = row ? (outcome === 'failed' ? row.failed : outcome === 'problems' ? row.problems : row.total) : null;
      return { kind, label: FEED_KIND_LABEL[kind].many, icon: FEED_KIND_LABEL[kind].icon, pressed: picked.includes(kind), count: count === null ? null : formatNumber(count) };
    });
  });

  readonly partialText = computed(() => {
    const kinds = [...new Set([...this.listPartial(), ...(this.summary()?.partial ?? [])])].filter((kind) => kind in FEED_KIND_LABEL);
    if (!kinds.length) return null;
    const names = kinds.map((kind) => FEED_KIND_LABEL[kind].one);
    const list = names.length < 2 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
    return `${list} rows couldn't be loaded right now; the rest is complete.`;
  });

  readonly emptyText = computed(() => {
    const { outcome, kinds, range } = this.filters();
    const span = this.span();
    const title = outcome === 'failed' ? `Nothing failed in ${span}.` : outcome === 'problems' ? `Nothing went wrong in ${span}.` : `Nothing recorded in ${span}.`;
    const recent = kinds.length ? kinds.some((kind) => RECENT_KINDS.includes(kind)) : range === '7d' || range === '30d';
    const what = kinds.length === 1 && kinds[0] === 'command' ? 'Command runs are' : 'Command runs and bot messages are';
    return {
      title,
      text: this.narrowed() ? 'Widen the range or clear the filters.' : this.widerRange() ? 'Try a wider range.' : null,
      note: recent ? `${what} recorded from the day this console went live; anything earlier is not here.` : null,
    };
  });

  /** Under the last row: say the list is complete, and where command records begin when that is inside the range. */
  readonly endNote = computed(() => {
    const items = this.items();
    if (!items.length || this.nextCursor() || this.loading()) return null;
    const { kinds } = this.filters();
    let text = `That's everything in ${this.span()}.`;
    if (!kinds.length || kinds.some((kind) => RECENT_KINDS.includes(kind))) {
      const oldest = [...items].reverse().find((item) => RECENT_KINDS.includes(item.kind));
      if (oldest && Date.parse(oldest.at) - this.listFrom() > 86_400_000) {
        text += ` The first command run recorded here is from ${dateTime(oldest.at)}; earlier ones were not recorded.`;
      }
    }
    return text;
  });

  readonly logsLink = computed(() => {
    const channel = this.channelID();
    return channel ? { channel, tab: 'logs' } : null;
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    this.subscriptions.add(
      combineLatest([toObservable(this.channelID), this.route.queryParamMap]).subscribe(([fixed, params]) => this.fromUrl(params, fixed)),
    );
    const timer = setInterval(() => this.tick(), LIVE_EVERY_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') this.tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    let observer: ResizeObserver | undefined;
    afterNextRender(() => {
      const bar = this.bar()?.nativeElement;
      if (!bar || typeof ResizeObserver === 'undefined') return;
      // Day headings in the list stick just under this bar.
      observer = new ResizeObserver(() => this.stickyTop.set(`calc(var(--fx-sticky-top, var(--nav-h)) + ${Math.round(bar.offsetHeight)}px)`));
      observer.observe(bar);
    });
    destroyRef.onDestroy(() => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      observer?.disconnect();
      this.subscriptions.unsubscribe();
      for (const request of [this.listRequest, this.moreRequest, this.summaryRequest, this.liveRequest]) request?.unsubscribe();
    });
  }

  // ---------- URL state ----------

  private fromUrl(params: ParamMap, fixed: string | null): void {
    const range = params.get('range');
    const kinds = new Set((params.get('kinds') || '').split(','));
    const outcome = params.get('outcome');
    const channel = params.get('channel');
    const actor = params.get('actor');
    const filters: Filters = {
      range: isRangeKey(range) ? range : '24h',
      // Old links can name kinds this build does not know: those are ignored.
      kinds: FEED_KINDS.filter((kind) => kinds.has(kind)),
      outcome: outcome === 'problems' || outcome === 'failed' ? outcome : null,
      channel: !fixed && channel && ID.test(channel) ? channel : null,
      actor: actor && ID.test(actor) ? actor : null,
      actorLogin: actor && ID.test(actor) ? null : cleanLogin(params.get('actorLogin')),
    };
    this.filters.set(filters);
    this.eventKey.set(params.get('event') || null);

    const listKey = JSON.stringify([fixed, filters]);
    if (listKey !== this.listKey) {
      // Another channel's rows must never show under this channel's tab.
      if (this.listKey && JSON.parse(this.listKey)[0] !== fixed) this.items.set([]);
      this.listKey = listKey;
      this.load();
    }
    const summaryKey = JSON.stringify([fixed, filters.range, filters.channel, filters.actor, filters.actorLogin]);
    if (summaryKey !== this.summaryKey) {
      this.summaryKey = summaryKey;
      this.loadSummary();
    }
  }

  go(change: Partial<Filters>): void {
    const next = { ...this.filters(), ...change };
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParamsHandling: 'merge',
      queryParams: {
        range: next.range === DEFAULTS.range ? null : next.range,
        kinds: next.kinds.length ? next.kinds.join(',') : null,
        outcome: next.outcome,
        channel: this.channelID() ? null : next.channel,
        actor: next.actor,
        actorLogin: next.actor ? null : next.actorLogin,
      },
    });
  }

  setRange(range: RangeKey): void {
    this.go({ range });
  }
  toggleKind(kind: FeedKind): void {
    const picked = this.filters().kinds;
    const next = picked.includes(kind) ? picked.filter((item) => item !== kind) : [...picked, kind];
    this.go({ kinds: FEED_KINDS.filter((item) => next.includes(item)) });
  }
  toggleProblems(): void {
    this.go({ outcome: this.filters().outcome ? null : 'problems' });
  }
  clearAll(): void {
    this.go({ kinds: [], outcome: null, channel: null, actor: null, actorLogin: null });
  }

  // ---------- Loading ----------

  private query(): FeedQuery {
    const f = this.filters();
    return {
      channel: this.channel(),
      actor: f.actor,
      actorLogin: f.actorLogin,
      kinds: f.kinds,
      outcome: f.outcome,
      from: hoursAgo(rangeHours(f.range)),
      limit: PAGE_SIZE,
    };
  }

  load(): void {
    this.listRequest?.unsubscribe();
    this.moreRequest?.unsubscribe();
    this.liveRequest?.unsubscribe();
    this.loading.set(true);
    this.loadingMore.set(false);
    this.moreFailed.set(false);
    this.error.set(null);
    const query = this.query();
    this.listRequest = this.api.list(query).subscribe({
      next: ({ data }) => {
        this.items.set(data.items);
        this.nextCursor.set(data.nextCursor);
        this.listPartial.set(data.partial ?? []);
        this.listFrom.set(Date.parse(query.from!));
        this.pages.set(1);
        this.pending.set([]);
        this.loading.set(false);
        this.remember(data.items);
      },
      error: (error: unknown) => {
        this.loading.set(false);
        this.error.set(apiErrorMessage(error, 'Check your connection and try again. Your filters are kept.'));
      },
    });
  }

  loadSummary(): void {
    this.summaryRequest?.unsubscribe();
    this.summaryFailed.set(false);
    const query = this.query();
    this.summaryRequest = this.api
      .summary({ channel: query.channel, actor: query.actor, actorLogin: query.actorLogin, from: query.from })
      .subscribe({
        next: ({ data }) => this.summary.set(data),
        error: () => {
          this.summary.set(null);
          this.summaryFailed.set(true);
        },
      });
  }

  retry(): void {
    this.load();
    if (this.summaryFailed()) this.loadSummary();
  }

  loadMore(): void {
    const cursor = this.nextCursor();
    if (!cursor || this.loadingMore()) return;
    this.loadingMore.set(true);
    this.moreFailed.set(false);
    const query = { ...this.query(), from: new Date(this.listFrom()).toISOString(), cursor };
    this.moreRequest = this.api.list(query).subscribe({
      next: ({ data }) => {
        const seen = new Set(this.items().map((item) => item.id));
        this.items.update((items) => [...items, ...data.items.filter((item) => !seen.has(item.id))]);
        this.nextCursor.set(data.nextCursor);
        this.listPartial.update((kinds) => [...new Set([...kinds, ...(data.partial ?? [])])]);
        this.pages.update((pages) => pages + 1);
        this.loadingMore.set(false);
        this.remember(data.items);
      },
      error: () => {
        this.loadingMore.set(false);
        this.moreFailed.set(true);
      },
    });
  }

  // ---------- Live ----------

  toggleLive(): void {
    this.live.update((on) => !on);
    this.announce.set(this.live() ? 'Live: new rows appear every 15 seconds.' : 'Live updates paused.');
    if (this.live()) this.tick();
  }

  /** A row is open in the list: inserting above it would move it. */
  private rowOpen(): boolean {
    return !!this.host.nativeElement.querySelector('app-feed-list details[open]');
  }

  private tick(): void {
    if (!this.live() || document.visibilityState !== 'visible') return;
    if (this.loading() || this.loadingMore() || this.error() || this.eventKey() || this.sheetOpen()) return;
    this.liveRequest?.unsubscribe();
    const listKey = this.listKey;
    this.liveRequest = this.api.list(this.query()).subscribe({
      next: ({ data }) => {
        if (listKey !== this.listKey) return;
        const known = new Set([...this.items(), ...this.pending()].map((item) => item.id));
        const fresh = data.items.filter((item) => !known.has(item.id));
        if (!fresh.length) return;
        this.remember(fresh);
        if (this.pages() > 1 || this.rowOpen()) {
          this.pending.update((rows) => [...fresh, ...rows]);
          this.announce.set(`${plural(this.pending().length, 'new row')}. Use the button above the list to show them.`);
        } else {
          this.items.update((rows) => this.merge(fresh, rows));
          this.announce.set(`${plural(fresh.length, 'new row')} added at the top.`);
        }
      },
      error: () => undefined,
    });
    // Counts follow the rows; a failed count keeps the last one.
    const query = this.query();
    this.subscriptions.add(
      this.api.summary({ channel: query.channel, actor: query.actor, actorLogin: query.actorLogin, from: query.from }).subscribe({
        next: ({ data }) => {
          if (listKey === this.listKey) this.summary.set(data);
        },
        error: () => undefined,
      }),
    );
  }

  showPending(): void {
    const rows = this.pending();
    if (!rows.length) return;
    this.items.update((items) => this.merge(rows, items));
    this.pending.set([]);
    const tile = this.listTile()?.nativeElement;
    const bar = this.bar()?.nativeElement;
    if (tile) {
      const offset = (bar?.getBoundingClientRect().bottom ?? 0) + 8;
      window.scrollTo({ top: Math.max(0, tile.getBoundingClientRect().top + window.scrollY - offset) });
    }
  }

  private merge(fresh: FeedItem[], rows: FeedItem[]): FeedItem[] {
    return [...fresh, ...rows].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }

  // ---------- Names ----------

  private remember(items: FeedItem[]): void {
    const channels: Record<string, string> = {};
    const actors: Record<string, string> = {};
    for (const item of items) {
      if (item.channelID && item.channel) channels[item.channelID] = item.channel;
      const name = item.actor?.name || item.actor?.login;
      if (name && item.actor?.id) actors[item.actor.id] = name;
      if (name && item.actor?.login) actors['login:' + item.actor.login.toLowerCase()] = name;
    }
    if (Object.keys(channels).length) this.channelNames.update((names) => ({ ...names, ...channels }));
    if (Object.keys(actors).length) this.actorNames.update((names) => ({ ...names, ...actors }));
    this.lookUpChannel();
  }

  /** A deep link with only a channel id and no rows to name it: ask the directory once. */
  private lookUpChannel(): void {
    const id = this.filters().channel;
    if (!id || this.channelNames()[id] || this.lookedUp.has(id)) return;
    this.lookedUp.add(id);
    this.subscriptions.add(
      this.users.getUsers({ search: id, limit: 5 }).subscribe({
        next: ({ data }) => {
          const row = data.rows?.find((item) => item.channelID === id);
          if (row) this.channelNames.update((names) => ({ ...names, [id]: row.channel }));
        },
        error: () => undefined,
      }),
    );
  }

  // ---------- Filters sheet ----------

  openSheet(): void {
    const f = this.filters();
    this.draft.set({
      channel: f.channel ? { channelID: f.channel, channel: this.channelName() ?? f.channel } : null,
      actor: f.actor,
      viewer: f.actorLogin ?? '',
      outcome: f.outcome,
    });
    this.draftTried.set(false);
    this.sheetOpen.set(true);
    this.sheet()?.nativeElement.showModal();
  }

  closeSheet(): void {
    const dialog = this.sheet()?.nativeElement;
    if (dialog?.open) dialog.close();
    this.sheetOpen.set(false);
  }

  onSheetBackdrop(event: MouseEvent): void {
    const dialog = this.sheet()?.nativeElement;
    if (!dialog || event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) this.closeSheet();
  }

  patchDraft(change: Partial<Draft>): void {
    this.draft.update((draft) => ({ ...draft, ...change }));
  }

  readonly draftViewerError = computed(() => {
    const viewer = this.draft().viewer.trim();
    return viewer && !cleanLogin(viewer) ? 'A Twitch name uses only letters, numbers and _.' : null;
  });
  readonly draftActorName = computed(() => {
    const actor = this.draft().actor;
    return actor ? (this.actorNames()[actor] ?? 'This viewer') : null;
  });

  applySheet(): void {
    this.draftTried.set(true);
    if (this.draftViewerError()) return;
    const draft = this.draft();
    const login = cleanLogin(draft.viewer);
    if (draft.channel) this.channelNames.update((names) => ({ ...names, [draft.channel!.channelID]: draft.channel!.channel }));
    this.closeSheet();
    this.go({
      channel: draft.channel?.channelID ?? null,
      actor: login ? null : draft.actor,
      actorLogin: login,
      outcome: draft.outcome,
    });
  }

  clearSheet(): void {
    this.draft.set({ channel: null, actor: null, viewer: '', outcome: null });
  }

  // ---------- Event sheet ----------

  closeEvent(): void {
    void this.router.navigate([], { relativeTo: this.route, queryParamsHandling: 'merge', queryParams: { event: null }, replaceUrl: true });
  }
}
